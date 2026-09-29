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
import { MergeSummary, absolutizePaths, buildExport, describeMerge, mergeData, readImportFile } from '../services/dataImport';

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

/** The preview text for a merge: what it adds, or that it adds nothing, and what it found. */
function describeMergePreview(summary: MergeSummary, heading: string): string {
    const { adds, notes } = describeMerge(summary);
    const body = adds.length > 0
        ? `${heading}\n${adds.map(line => `  ${line}`).join('\n')}`
        : 'Nothing is missing: it is all here already.';
    return notes.length > 0 ? `${body}\n\n(${notes.join('; ')}.)` : body;
}

/** "3 projects, 2 versions and 5 databases": what a store holds, for Replace's warning. */
function describeContents(data: DebuggerData): string {
    const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;
    const databases = (data.projects ?? []).reduce((total, project) => total + (project.dbs?.length ?? 0), 0);
    return `${count(data.projects?.length ?? 0, 'project', 'projects')}, `
        + `${count(Object.keys(data.versions ?? {}).length, 'version', 'versions')} and `
        + `${count(databases, 'database', 'databases')}`;
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
    const { adds } = describeMerge(summary);

    if (adds.length === 0) {
        // Joining a store that already holds all of this: nothing to ask.
        return true;
    }
    const choice = await showModalInfo(
        `Bring this workspace's data into ${file}?\n\n`
        + describeMergePreview(summary, 'It adds:')
        + '\n\nNothing already in that store is overwritten. This workspace\'s own file is left as it is.',
        'Bring It Along',
        'Use What Is There'
    );
    if (!choice) {
        return false;
    }
    if (choice === 'Bring It Along') {
        await target.commit(targetRead, data);
        logger.info(`[store] merged this workspace's data into ${file}: ${adds.join('; ')}`);
    }
    return true;
}

/** Asks for an existing store, or where to create one. */
async function pickStoreFile(mode: 'open' | 'create', near: string): Promise<string | undefined> {
    if (mode === 'open') {
        // An open dialog, not a save dialog: joining an existing store must
        // not ask whether to "overwrite" it.
        const picked = await vscode.window.showOpenDialog({
            title: 'Open an existing data store',
            openLabel: 'Use This Store',
            canSelectMany: false,
            defaultUri: vscode.Uri.file(path.dirname(near)),
            filters: { 'Odoo DevTools data store': ['db'] }
        });
        return picked?.[0]?.fsPath;
    }
    const uri = await vscode.window.showSaveDialog({
        title: 'Create a data store',
        saveLabel: 'Create Store',
        defaultUri: vscode.Uri.file(near),
        filters: { 'Odoo DevTools data store': ['db'] }
    });
    if (!uri) {
        return undefined;
    }
    return uri.fsPath.toLowerCase().endsWith('.db') ? uri.fsPath : `${uri.fsPath}.db`;
}

async function chooseDataStore(): Promise<void> {
    const current = currentDataLocation();
    const sharedDefault = path.join(readSetupState().provisioningRoot, SHARED_STORE_FILE);
    const inUse = (file: string) => current?.kind === 'sqlite' && path.resolve(current.file) === path.resolve(file);
    const customInUse = current?.kind === 'sqlite' && !inUse(sharedDefault) ? current.file : undefined;

    type Row = vscode.QuickPickItem & { action: 'store' | 'open' | 'create' | 'workspace'; file?: string; current?: boolean };
    const rows: Row[] = [];
    if (customInUse) {
        rows.push({
            label: `$(check) ${path.basename(customInUse)}`,
            description: `${customInUse} — in use`,
            detail: 'The shared store this window uses now.',
            action: 'store', file: customInUse, current: true
        });
    }
    rows.push(
        {
            label: `${inUse(sharedDefault) ? '$(check)' : '$(database)'} Shared store`,
            description: inUse(sharedDefault) ? `${sharedDefault} — in use` : sharedDefault,
            detail: 'One store several workspaces use at once - one per Odoo version, say. What is selected stays per window.',
            action: 'store', file: sharedDefault, current: inUse(sharedDefault)
        },
        {
            label: '$(folder-opened) Open an existing store…',
            detail: 'A .db file another workspace already uses.',
            action: 'open'
        },
        {
            label: '$(new-file) Create a new store…',
            detail: 'A separate store: for one client, for instance.',
            action: 'create'
        },
        {
            label: `${current?.kind === 'json' ? '$(check)' : '$(file)'} This workspace only`,
            description: current?.kind === 'json' ? `.vscode/${DATA_FILE_NAME} — in use` : `.vscode/${DATA_FILE_NAME}`,
            detail: 'The data lives with this workspace, as it always did.',
            action: 'workspace', current: current?.kind === 'json'
        }
    );

    const quickPick = vscode.window.createQuickPick<Row>();
    quickPick.title = 'Choose Data Store';
    quickPick.placeholder = `Now using ${describeLocation(current)}`;
    quickPick.items = rows;
    // Enter on its own keeps what is in use, rather than switching.
    quickPick.activeItems = rows.filter(row => row.current);
    const picked = await new Promise<Row | undefined>(resolve => {
        quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
        quickPick.onDidHide(() => resolve(undefined));
        quickPick.show();
    });
    quickPick.dispose();
    if (!picked) {
        return;
    }
    if (picked.current) {
        void showInfo(`Already using ${describeLocation(current)}.`);
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

    const file = picked.action === 'store'
        ? picked.file
        : await pickStoreFile(picked.action, sharedDefault);
    if (!file) {
        return;
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
    const { adds } = describeMerge(summary);
    const where = describeLocation(currentDataLocation());
    const choice = await showModalInfo(
        `Import ${path.basename(file)} into ${where}?\n\n`
        + describeMergePreview(summary, 'Merging adds:')
        + `\n\nMerge never overwrites what is here. Replace would discard the ${describeContents(current)} here now.`,
        'Merge',
        'Replace…'
    );
    if (!choice) {
        return;
    }

    if (choice === 'Merge') {
        if (adds.length > 0) {
            await SettingsStore.saveWithoutComments(data);
        }
    } else {
        // The safe answer comes first, so Enter keeps the data.
        const confirmed = await showModalWarning(
            `Replace everything in ${where} with ${path.basename(file)}?\n\n`
            + `The ${describeContents(current)} there now are discarded, and replaced by the `
            + `${describeContents(incoming)} in the file. Export first if you might want them back.`,
            'Keep Current Data',
            'Replace Everything'
        );
        if (confirmed !== 'Replace Everything') {
            return;
        }
        await SettingsStore.saveWithoutComments(incoming);
    }

    await deps.versionsService.refresh();
    await deps.refreshAll({ reason: 'all' });
    void showInfo(choice === 'Merge'
        ? (adds.length > 0
            ? `Imported ${path.basename(file)}: ${adds.join(', ')}.`
            : `Nothing to import: everything in ${path.basename(file)} is already here.`)
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
