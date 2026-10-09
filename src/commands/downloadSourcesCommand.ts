/**
 * `odoo.downloadSources`: a shallow copy of one Odoo branch in a folder of the
 * user's choice, to read the code. It creates no version and changes no
 * setting; Create Version keeps building its own worktrees.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { showError, showInfo, showWarning } from '../services/notifications';
import { readSetupState } from '../services/setupState';
import { logger, errorMessage } from '../services/logger';
import {
    SOURCE_REPOS,
    cloneShallow,
    isInside,
    isValidBranchName,
    listRemoteSeries,
    planDownload,
    type SourceRepo
} from '../services/sourceDownload';
import type { CommandDeps } from './index';
import { registerCommand } from './registerCommand';

const LAST_FOLDER_KEY = 'odoo.downloadSources.lastFolder';
const OTHER = 'Other branch…';

async function pickBranch(): Promise<string | undefined> {
    const quickPick = vscode.window.createQuickPick();
    quickPick.title = 'Download Odoo Sources: branch';
    quickPick.placeholder = 'Listing the branches on github.com/odoo/odoo…';
    quickPick.busy = true;
    quickPick.ignoreFocusOut = true;
    quickPick.items = [{ label: OTHER }];
    const listing = new vscode.CancellationTokenSource();

    listRemoteSeries(undefined, listing.token).then(branches => {
        quickPick.items = [...branches.map(label => ({ label })), { label: OTHER }];
        quickPick.placeholder = 'The branch to download';
    }, error => {
        logger.warn('[download] could not list the remote branches:', error);
        quickPick.placeholder = 'Could not list the branches: pick "Other branch…" and type one';
    }).finally(() => { quickPick.busy = false; });

    const picked = await new Promise<string | undefined>(resolve => {
        quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]?.label));
        quickPick.onDidHide(() => resolve(undefined));
        quickPick.show();
    });
    listing.cancel();
    quickPick.dispose();

    if (picked !== OTHER) {
        return picked;
    }
    const typed = await vscode.window.showInputBox({
        title: 'Download Odoo Sources: branch',
        prompt: 'A branch of odoo/odoo, e.g. 17.0, saas-17.4 or master',
        ignoreFocusOut: true,
        validateInput: value => isValidBranchName(value.trim()) ? undefined : 'A branch name, e.g. 17.0'
    });
    return typed?.trim() || undefined;
}

async function pickRepos(): Promise<SourceRepo[] | undefined> {
    const picks = await vscode.window.showQuickPick(
        [
            { label: SOURCE_REPOS.odoo.label, repo: SOURCE_REPOS.odoo, picked: true },
            { label: SOURCE_REPOS.enterprise.label, repo: SOURCE_REPOS.enterprise, picked: false },
            { label: SOURCE_REPOS.designThemes.label, repo: SOURCE_REPOS.designThemes, picked: false }
        ],
        { title: 'Download Odoo Sources: repositories', canPickMany: true, ignoreFocusOut: true }
    );
    if (!picks || picks.length === 0) {
        return undefined;
    }
    return picks.map(pick => pick.repo);
}

function defaultFolder(context: vscode.ExtensionContext): string {
    const remembered = context.globalState.get<string>(LAST_FOLDER_KEY);
    if (remembered) {
        return remembered;
    }
    const sourceRepo = readSetupState().sourceRepo;
    return sourceRepo ? path.dirname(sourceRepo) : os.homedir();
}

async function pickFolder(context: vscode.ExtensionContext): Promise<string | undefined> {
    const provisioningRoot = readSetupState().provisioningRoot;
    for (;;) {
        const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            defaultUri: vscode.Uri.file(defaultFolder(context)),
            openLabel: 'Download Here',
            title: 'Download Odoo Sources: the folder to put them in'
        });
        const folder = picked?.[0]?.fsPath;
        if (!folder) {
            return undefined;
        }
        // Versions are built there as odoo-<branch> worktrees; a copy of the same name would be taken for one.
        if (provisioningRoot && isInside(folder, provisioningRoot)) {
            const again = await showWarning(`${provisioningRoot} is where versions are built. Pick another folder.`, 'Pick Another');
            if (again !== 'Pick Another') {
                return undefined;
            }
            continue;
        }
        return folder;
    }
}

async function offerToOpen(folders: string[]): Promise<void> {
    const list = folders.map(folder => path.basename(folder)).join(', ');
    const choice = await showInfo(`Downloaded ${list} to ${path.dirname(folders[0])}.`, 'Open in New Window', 'Add to Workspace', 'Reveal');
    if (choice === 'Open in New Window') {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folders[0]), { forceNewWindow: true });
    } else if (choice === 'Add to Workspace') {
        const start = vscode.workspace.workspaceFolders?.length ?? 0;
        vscode.workspace.updateWorkspaceFolders(start, 0, ...folders.map(folder => ({ uri: vscode.Uri.file(folder) })));
    } else if (choice === 'Reveal') {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(folders[0]));
    }
}

export async function downloadOdooSources(context: vscode.ExtensionContext): Promise<void> {
    const branch = await pickBranch();
    if (!branch) {
        return;
    }
    const repos = await pickRepos();
    if (!repos) {
        return;
    }
    const folder = await pickFolder(context);
    if (!folder) {
        return;
    }
    await context.globalState.update(LAST_FOLDER_KEY, folder);

    const plan = await planDownload(folder, repos, branch);
    if (plan.skip.length > 0) {
        void showInfo(`Skipped, already there: ${plan.skip.map(item => item.folder).join(', ')}.`);
    }
    if (plan.clone.length === 0) {
        return;
    }

    const done: string[] = [];
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Downloading Odoo ${branch} (shallow)`,
        cancellable: true
    }, async (progress, token) => {
        for (const item of plan.clone) {
            const name = path.basename(item.folder);
            progress.report({ message: `${name}…` });
            try {
                await cloneShallow(item.repo.urls, branch, item.folder, {
                    token,
                    onLine: line => progress.report({ message: `${name}: ${line}` })
                });
                done.push(item.folder);
            } catch (error) {
                if (token.isCancellationRequested) {
                    void showInfo(`Download cancelled.${done.length ? ` Kept: ${done.map(f => path.basename(f)).join(', ')}.` : ''}`);
                    return;
                }
                logger.error(`[download] ${name} failed:`, error);
                const hint = item.repo === SOURCE_REPOS.enterprise
                    ? ' Enterprise is private: it needs an SSH key or a GitHub login with access to odoo/enterprise.'
                    : '';
                void showError(`Could not download ${name}: ${errorMessage(error)}.${hint}`);
            }
        }
    });

    if (done.length > 0) {
        await offerToOpen(done);
    }
}

export function registerDownloadSourcesCommand(deps: CommandDeps): void {
    deps.context.subscriptions.push(registerCommand('odoo.downloadSources', () => downloadOdooSources(deps.context)));
}
