/**
 * Where this window's data lives, and moving data in and out of it:
 *
 * - `odoo.chooseDataStore`: this workspace's own file, or a shared store
 *   several workspaces use - for everyone, or for this workspace only;
 * - `odoo.exportData` / `odoo.importData`: a portable JSON copy.
 *
 * Changing the setting is all it takes to switch: the configuration listener
 * in extension.ts reopens the store and refreshes every view.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'jsonc-parser';
import type { CommandDeps } from './index';
import { SettingsStore } from '../settingsStore';
import type { DebuggerData } from '../utils';
import { logger, errorMessage } from '../services/logger';
import { showError, showInfo, showModalInfo, showModalWarning } from '../services/notifications';
import { readSetupState } from '../services/setupState';
import {
    DATA_FILE_NAME,
    DATA_STORE_SETTING,
    DataLocation,
    currentDataLocation,
    dataRootFor,
    storeKindOf
} from '../services/dataLocation';
import { openMainStore } from '../services/mainStore';
import { stripSelection } from '../services/workspaceSelection';
import { absolutizePaths, buildExport, describeMerge, mergeData, readImportFile } from '../services/dataImport';

const SHARED_STORE_FILE = 'odoo-devtools.db';

/** This window's data as the store holds it: no selection, absolute paths. */
async function portableCurrentData(): Promise<DebuggerData> {
    const location = currentDataLocation();
    const data = stripSelection(await SettingsStore.get());
    delete data.activeVersion;
    return location ? absolutizePaths(data, location.root) : data;
}

function describeLocation(location: DataLocation | undefined): string {
    if (!location) {
        return 'none';
    }
    return location.kind === 'sqlite' ? `shared store ${location.file}` : `this workspace's file ${location.file}`;
}

function hasData(data: DebuggerData): boolean {
    return (data.projects?.length ?? 0) > 0 || Object.keys(data.versions ?? {}).length > 0;
}

/**
 * Copies this window's data into the store at `file`, filling gaps and never
 * overwriting what it already holds. Returns false when the user backs out.
 */
async function offerToBringDataAlong(file: string): Promise<boolean> {
    const current = currentDataLocation();
    if (!current || path.resolve(current.file) === path.resolve(file)) {
        return true;
    }
    const mine = await portableCurrentData();
    if (!hasData(mine)) {
        return true;
    }

    const kind = storeKindOf(file) ?? 'json';
    const target = openMainStore({ file, kind, root: dataRootFor(file), pinned: true });
    if (!target) {
        void showError(`${file} needs node:sqlite, which this editor's runtime (Node ${process.versions.node}) does not provide.`);
        return false;
    }
    const targetRead = await target.read();
    const { data, summary } = mergeData(targetRead.data, mine);
    const lines = describeMerge(summary);

    const choice = await showModalInfo(
        `Bring this workspace's data into ${file}?\n\n`
        + (lines.length > 0 ? lines.map(line => `  ${line}`).join('\n') : '  Nothing is missing there.')
        + '\n\nNothing already in that store is overwritten. This workspace\'s own file is left as it is.',
        'Bring It Along',
        'Use What Is There'
    );
    if (!choice) {
        return false;
    }
    if (choice === 'Bring It Along' && lines.length > 0) {
        await target.commit(targetRead, data);
        logger.info(`[store] merged this workspace's data into ${file}: ${lines.join('; ')}`);
    }
    return true;
}

async function chooseDataStore(): Promise<void> {
    const current = currentDataLocation();
    const sharedDefault = path.join(readSetupState().provisioningRoot, SHARED_STORE_FILE);

    type Row = vscode.QuickPickItem & { action: 'shared' | 'pick' | 'workspace' };
    const picked = await vscode.window.showQuickPick<Row>([
        {
            label: '$(database) Shared store',
            description: sharedDefault,
            detail: 'One store several workspaces use at once - one per Odoo version, say. What is selected stays per window.',
            action: 'shared'
        },
        {
            label: '$(folder-opened) Choose a store file…',
            detail: 'A .db file anywhere: a separate store for one client, for instance.',
            action: 'pick'
        },
        {
            label: '$(file) This workspace only',
            description: `.vscode/${DATA_FILE_NAME}`,
            detail: 'The data lives with this workspace, as it always did.',
            action: 'workspace'
        }
    ], {
        title: 'Choose Data Store',
        placeHolder: `Now using ${describeLocation(current)}`
    });
    if (!picked) {
        return;
    }

    const config = vscode.workspace.getConfiguration('odooDebugger');
    const inspected = config.inspect<string>(DATA_STORE_SETTING);

    if (picked.action === 'workspace') {
        // With a shared store set for everyone, clearing this workspace's
        // value would fall through to it; naming the file keeps it here.
        const sharedForEveryone = inspected?.globalValue && storeKindOf(inspected.globalValue) === 'sqlite';
        await config.update(
            DATA_STORE_SETTING,
            sharedForEveryone ? `.vscode/${DATA_FILE_NAME}` : undefined,
            vscode.ConfigurationTarget.Workspace
        );
        void showInfo('This workspace now uses its own data file.');
        return;
    }

    let file = sharedDefault;
    if (picked.action === 'pick') {
        const uri = await vscode.window.showSaveDialog({
            title: 'Choose or create a data store',
            saveLabel: 'Use This Store',
            defaultUri: vscode.Uri.file(sharedDefault),
            filters: { 'Odoo DevTools data store': ['db'] }
        });
        if (!uri) {
            return;
        }
        file = uri.fsPath.toLowerCase().endsWith('.db') ? uri.fsPath : `${uri.fsPath}.db`;
    }

    type ScopeRow = vscode.QuickPickItem & { global: boolean };
    const scope = await vscode.window.showQuickPick<ScopeRow>([
        { label: 'All workspaces', detail: 'Every workspace uses this store unless it chooses otherwise.', global: true },
        { label: 'This workspace only', detail: 'Other workspaces keep whatever they use now.', global: false }
    ], { title: 'Use it where?' });
    if (!scope) {
        return;
    }

    if (!(await offerToBringDataAlong(file))) {
        return;
    }

    if (scope.global) {
        await config.update(DATA_STORE_SETTING, file, vscode.ConfigurationTarget.Global);
        if (inspected?.workspaceValue) {
            const clear = await showInfo(
                `This workspace has its own data store set (${inspected.workspaceValue}), which still wins here.`,
                'Use the Shared Store Here Too'
            );
            if (clear) {
                await config.update(DATA_STORE_SETTING, undefined, vscode.ConfigurationTarget.Workspace);
            }
        }
    } else {
        await config.update(DATA_STORE_SETTING, file, vscode.ConfigurationTarget.Workspace);
    }
    void showInfo(`Now using the shared store ${file}.`);
}

async function exportData(): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
        title: 'Export Odoo DevTools data',
        saveLabel: 'Export',
        defaultUri: vscode.Uri.file(path.join(os.homedir(), `odoo-devtools-export-${new Date().toISOString().slice(0, 10)}.json`)),
        filters: { JSON: ['json'] }
    });
    if (!uri) {
        return;
    }
    const data = await portableCurrentData();
    await fs.writeFile(uri.fsPath, JSON.stringify(buildExport(data), null, 2), 'utf-8');
    const choice = await showInfo(`Exported ${data.projects.length} project(s) to ${uri.fsPath}.`, 'Reveal');
    if (choice === 'Reveal') {
        await vscode.commands.executeCommand('revealFileInOS', uri);
    }
}

async function importData(deps: CommandDeps): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
        title: 'Import Odoo DevTools data',
        openLabel: 'Import',
        canSelectMany: false,
        filters: { JSON: ['json'] }
    });
    const file = picked?.[0]?.fsPath;
    if (!file) {
        return;
    }

    const parsed = readImportFile(parse(await fs.readFile(file, 'utf-8')));
    if (!parsed) {
        void showError(`${path.basename(file)} is not an Odoo DevTools export or data file.`);
        return;
    }
    // Exports are already absolute; a raw data file is relative to its workspace.
    const incoming = absolutizePaths(stripSelection(parsed), dataRootFor(file));
    delete incoming.activeVersion;

    const current = await SettingsStore.get();
    const { data, summary } = mergeData(current, incoming);
    const lines = describeMerge(summary);
    const choice = await showModalInfo(
        `Import ${path.basename(file)} into ${describeLocation(currentDataLocation())}?\n\n`
        + (lines.length > 0 ? `Merging adds:\n${lines.map(line => `  ${line}`).join('\n')}\n\n` : 'Merging adds nothing: it is all here already.\n\n')
        + 'Merge never overwrites what is here. Replace discards it.',
        'Merge',
        'Replace…'
    );
    if (!choice) {
        return;
    }

    let result: DebuggerData = data;
    if (choice === 'Replace…') {
        const confirmed = await showModalWarning(
            `Replace everything in ${describeLocation(currentDataLocation())} with ${path.basename(file)}? `
            + 'Every project, version and database record there now is discarded. Export first if you might want it back.',
            'Replace Everything'
        );
        if (confirmed !== 'Replace Everything') {
            return;
        }
        result = incoming;
    }

    await SettingsStore.saveWithoutComments(result);
    await deps.versionsService.refresh();
    await deps.refreshAll({ reason: 'all' });
    void showInfo(choice === 'Merge'
        ? `Imported ${path.basename(file)}${lines.length > 0 ? `: ${lines.join(', ')}` : ' (nothing was missing)'}.`
        : `Replaced the data with ${path.basename(file)}.`);
}

export function registerDataStoreCommands(deps: CommandDeps): void {
    const guarded = (name: string, run: () => Promise<void>) => async () => {
        try {
            await run();
        } catch (error) {
            logger.error(`${name} failed:`, error);
            void showError(`${name} failed: ${errorMessage(error)}`);
        }
    };
    deps.context.subscriptions.push(
        vscode.commands.registerCommand('odoo.chooseDataStore', guarded('Choose Data Store', chooseDataStore)),
        vscode.commands.registerCommand('odoo.exportData', guarded('Export Data', exportData)),
        vscode.commands.registerCommand('odoo.importData', guarded('Import Data', () => importData(deps)))
    );
}
