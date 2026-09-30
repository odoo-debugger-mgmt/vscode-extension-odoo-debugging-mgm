import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { registerCommand } from './registerCommand';
import { SettingsStore } from '../settingsStore';
import { VersionsService } from '../versionsService';
import { currentMainStore } from '../services/mainStore';
import { getRepoBranch } from '../services/branches';
import { remoteOf } from '../services/repoLocations';
import { logger } from '../services/logger';
import { showInfo } from '../services/notifications';
import { normalizePath } from '../utils';
import { refreshRegistry, registerThisWorkspace, thisWorkspaceId } from '../services/workspaceRegistry';
import { extractVersionId } from './args';
import {
    BindingProposal,
    WorkspaceFolderFacts,
    proposeWorkspaceVersion,
    readBinding,
    shouldOfferBinding,
    writeBinding
} from '../services/workspaceBinding';

/** This window's folders, with the branch and remote of those that are git checkouts. */
async function folderFacts(): Promise<WorkspaceFolderFacts[]> {
    return Promise.all((vscode.workspace.workspaceFolders ?? []).map(async folder => {
        const folderPath = folder.uri.fsPath;
        const isCheckout = fs.existsSync(path.join(folderPath, '.git'));
        return {
            path: folderPath,
            name: path.basename(folderPath),
            branch: isCheckout ? (await getRepoBranch(folderPath)) ?? undefined : undefined,
            remote: isCheckout ? await remoteOf(folderPath) : undefined
        };
    }));
}

async function propose(): Promise<BindingProposal | undefined> {
    const data = await SettingsStore.get().catch(() => undefined);
    const projects = data?.projects ?? [];
    const repoRemotes = new Map<string, string | undefined>();
    for (const project of projects) {
        for (const repo of project.repos ?? []) {
            const key = normalizePath(repo.path);
            if (!repoRemotes.has(key)) {
                repoRemotes.set(key, await remoteOf(key));
            }
        }
    }
    return proposeWorkspaceVersion(
        await folderFacts(),
        projects,
        VersionsService.getInstance().getVersions(),
        repo => repoRemotes.get(normalizePath(repo.path))
    );
}

/** Binds this window to `versionId` and makes it the active version. */
async function bindTo(versionId: string): Promise<void> {
    await writeBinding({ versionId, asked: true });
    answered();
    void registerThisWorkspace();
    const versions = VersionsService.getInstance();
    if (versions.getActiveVersion()?.id !== versionId) {
        // The command, not the service: it carries the upgrade guard and the
        // environment alignment a version switch needs.
        await vscode.commands.executeCommand('odoo.setActiveVersion', versionId);
    }
    void showInfo(`This workspace runs ${versions.getVersion(versionId)?.name ?? 'that version'}.`);
}

/** The version pick, with the proposal first; undefined when dismissed. */
async function pickVersion(proposal: BindingProposal | undefined): Promise<string | 'create' | undefined> {
    const versions = VersionsService.getInstance().getVersions();
    const bound = readBinding().versionId;
    const items: Array<vscode.QuickPickItem & { versionId: string | 'create' }> = versions
        .map(version => ({
            label: version.name,
            description: version.odooVersion,
            detail: [
                version.id === bound ? '$(pin) Bound to this workspace' : undefined,
                version.id === proposal?.versionId ? `$(lightbulb) ${proposal.because}` : undefined
            ].filter(Boolean).join('  ') || undefined,
            versionId: version.id
        }))
        .sort((a, b) => Number(b.versionId === proposal?.versionId) - Number(a.versionId === proposal?.versionId));
    items.push({ label: '$(add) Create Version…', versionId: 'create' });
    const picked = await vscode.window.showQuickPick(items, {
        title: 'Bind This Workspace to a Version',
        placeHolder: 'Which version does this workspace run?'
    });
    return picked?.versionId;
}

async function chooseAndBind(proposal: BindingProposal | undefined): Promise<void> {
    const choice = await pickVersion(proposal);
    if (choice === 'create') {
        await vscode.commands.executeCommand('odoo.createVersion');
        return;
    }
    if (choice) {
        await bindTo(choice);
    }
}

/**
 * The question as a status bar item, until it is answered: the message hides
 * itself after a few seconds, and was usually gone before it was read.
 */
let pendingItem: vscode.StatusBarItem | undefined;

function showPendingItem(): void {
    if (pendingItem) {
        return;
    }
    pendingItem = vscode.window.createStatusBarItem('odooDevtools.bindWorkspace', vscode.StatusBarAlignment.Left, 97);
    pendingItem.name = 'Odoo DevTools: Workspace Version';
    pendingItem.text = '$(question) Which version here?';
    pendingItem.tooltip = 'Which Odoo version does this workspace run? Click to choose; it is asked once.';
    pendingItem.command = 'odoo.bindWorkspaceVersion';
    pendingItem.show();
}

function answered(): void {
    pendingItem?.dispose();
    pendingItem = undefined;
}

/**
 * Asks a new window on a shared store which version it runs, once. With a
 * proposal from what the workspace holds, one click accepts it.
 */
export async function offerWorkspaceBinding(): Promise<void> {
    try {
        const versions = VersionsService.getInstance();
        await versions.initialize();
        if (!shouldOfferBinding(currentMainStore()?.kind, versions.getVersions().length, readBinding())) {
            return;
        }
        showPendingItem();
        const proposal = await propose();
        const name = proposal ? versions.getVersion(proposal.versionId)?.name : undefined;
        const choice = proposal && name
            ? await showInfo(`Use ${name} in this workspace? (${proposal.because}.)`, 'Use It', 'Choose Another…', 'Not Now')
            : await showInfo('Which version does this workspace run? It is asked once; the store has several.', 'Choose a Version…', 'Not Now');

        if (choice === 'Use It' && proposal) {
            await bindTo(proposal.versionId);
        } else if (choice === 'Choose Another…' || choice === 'Choose a Version…') {
            await writeBinding({ ...readBinding(), asked: true });
            await chooseAndBind(proposal);
        } else if (choice === 'Not Now') {
            await writeBinding({ ...readBinding(), asked: true });
        }
        if (readBinding().asked) {
            answered();
        }
        // Dismissed without a choice: asked again next time.
    } catch (error) {
        logger.warn('Offering to bind the workspace to a version failed:', error);
    }
}

/**
 * Opens another workspace on this shared store, from the registry: the one
 * that runs a version (from a version's context menu), or any of them.
 */
async function openVersionWorkspace(versionIdOrTreeItem?: unknown): Promise<void> {
    if (!currentMainStore()?.listWorkspaces) {
        void showInfo('Only a shared data store keeps a list of the workspaces that use it. Choose one with Choose Data Store….');
        return;
    }
    const versions = VersionsService.getInstance();
    await versions.initialize();
    const versionId = extractVersionId(versionIdOrTreeItem);
    const own = thisWorkspaceId();
    const rows = (await refreshRegistry())
        .filter(row => row.id !== own && (!versionId || row.versionId === versionId));
    if (rows.length === 0) {
        const name = versionId ? versions.getVersion(versionId)?.name : undefined;
        void showInfo(name
            ? `No other workspace on this store runs ${name} yet. Open one, and bind it with Bind This Workspace to a Version….`
            : 'No other workspace has opened this store yet.');
        return;
    }
    const picked = rows.length === 1 && versionId
        ? rows[0]
        : (await vscode.window.showQuickPick(rows.map(row => ({
            label: row.name,
            description: row.versionId ? versions.getVersion(row.versionId)?.name ?? 'a removed version' : 'no version chosen',
            detail: vscode.Uri.parse(row.uri).fsPath,
            row
        })), { title: 'Open the Workspace for a Version', placeHolder: 'Which workspace?' }))?.row;
    if (picked) {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(picked.uri), { forceNewWindow: true });
    }
}

export function registerBindingCommand(deps: CommandDeps): void {
    deps.context.subscriptions.push(registerCommand('odoo.openVersionWorkspace', openVersionWorkspace));
    deps.context.subscriptions.push(registerCommand('odoo.bindWorkspaceVersion', async () => {
        await VersionsService.getInstance().initialize();
        await chooseAndBind(await propose());
        await deps.refreshAll();
    }));
}
