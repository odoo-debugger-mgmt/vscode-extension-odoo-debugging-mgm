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
        // Dismissed without a choice: asked again next time.
    } catch (error) {
        logger.warn('Offering to bind the workspace to a version failed:', error);
    }
}

export function registerBindingCommand(deps: CommandDeps): void {
    deps.context.subscriptions.push(registerCommand('odoo.bindWorkspaceVersion', async () => {
        await VersionsService.getInstance().initialize();
        await chooseAndBind(await propose());
        await deps.refreshAll();
    }));
}
