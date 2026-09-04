/**
 * Command handlers for the Project Repos (Explorer) view: file operations,
 * path utilities and repository relocation.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandDeps } from './index';
import { extractUri } from './args';
import { showInfo, showError } from '../services/notifications';
import { ensureCustomWorktrees } from '../services/customWorktree';
import { showAutoInfo } from '../services/notifications';
import { SettingsStore } from '../settingsStore';
import { stripSettings } from '../utils';
import { invalidateModuleDiscoveryCache, invalidateRepositoryDiscoveryCache, invalidateGitBranchCache } from '../services/runtimeCache';
import {
    createNewFile as explorerCreateNewFile,
    createNewFolder as explorerCreateNewFolder,
    renameEntry as explorerRenameEntry,
    selectProjectForExplorer
} from '../projectReposExplorer';
import { normalizePath } from '../utils';
import { showWarning, showModalWarning } from '../services/notifications';
import { errorMessage, logger } from '../services/logger';
import { tryRunCommand } from '../services/process';
import { removeWorktree } from '../services/worktree';
import { readSetupState } from '../services/setupState';
import { describeModeChange, resolveRepoPath, resolveProjectRepos } from '../services/repoPaths';
import { parsePorcelainStatus } from '../services/sourceConflict';
import { normalizeBranchMode, RepoBranchMode, RepoModel } from '../models/repo';
import { sanitizeProjectRepoBranchAssignments } from '../services/environment';

/** Registers the checkout/worktree mode toggle for a project repository. */
export function registerRepoBranchModeCommand(deps: CommandDeps): void {
    const { context, refreshAll } = deps;

    // Two command ids, one handler. The menu shows whichever names the
    // direction the click will take: a single entry meant the action that
    // removes the copies still read "Use One Copy Per Branch".
    const toggle = async (event?: unknown) => {
        try {
            const result = await SettingsStore.getSelectedProject();
            if (!result) {
                return;
            }
            const { data, project } = result;
            const repoPath = extractUri(event)?.fsPath;
            const repo = (project.repos ?? []).find(entry => normalizePath(entry.path) === normalizePath(repoPath ?? ''));
            if (!repo) {
                // Reachable from the Repos view, which lists every repository
                // discovered in the addons folder, not only the project's.
                const choice = await showError(
                    `"${path.basename(repoPath ?? '')}" is not part of "${project.name}" yet.`,
                    'Select Repositories'
                );
                if (choice === 'Select Repositories') {
                    await vscode.commands.executeCommand('repoSelector.selectRepo');
                }
                return;
            }

            const root = readSetupState().provisioningRoot;
            const nextMode: RepoBranchMode = normalizeBranchMode(repo.branchMode) === 'worktree' ? 'checkout' : 'worktree';
            const branches = Array.from(new Set(
                (project.dbs ?? []).flatMap(db =>
                    sanitizeProjectRepoBranchAssignments(db.projectRepoBranches)
                        .filter(entry => entry.repoName === repo.name || normalizePath(entry.repoPath) === normalizePath(repo.path))
                        .map(entry => entry.branch))
            ));

            const confirm = await showModalWarning(
                describeModeChange(repo.name, nextMode, root, branches, normalizePath(repo.path)),
                nextMode === 'worktree' ? 'Create Copies' : 'Remove Copies'
            );
            if (!confirm) {
                return;
            }

            if (nextMode === 'checkout') {
                for (const branch of branches) {
                    const dest = resolveRepoPath({ ...repo, branchMode: 'worktree' } as RepoModel, branch, root).path;
                    if (!fs.existsSync(dest)) {
                        continue;
                    }
                    const status = await tryRunCommand('git', ['status', '--porcelain'], { cwd: dest });
                    if (status !== undefined && parsePorcelainStatus(status).length > 0) {
                        void showWarning(`Kept ${dest}: it has uncommitted changes.`);
                        continue;
                    }
                    await removeWorktree(repo.path, dest).catch(error =>
                        logger.warn(`[worktree] could not remove ${dest}:`, error));
                }
            }

            repo.branchMode = nextMode;
            await SettingsStore.saveWithoutComments(stripSettings(data));
            void showInfo(`"${repo.name}" now uses ${nextMode === 'worktree' ? 'one copy per branch' : 'a single checkout'}.`);
            await refreshAll();
        } catch (error) {
            void showError(`Could not change the repository mode: ${errorMessage(error)}`);
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('odt.repo.toggleBranchMode', toggle),
        vscode.commands.registerCommand('odt.repo.useSingleCheckout', toggle)
    );
}

/**
 * `odt.repo.resolveWorktrees`: creates the per-branch copies the debugger sync
 * could not, asking about any branch the source checkout is holding.
 *
 * This is the interactive half of the split: the sync creates what needs no
 * arbitration and reports the rest, and this command is where the questions
 * are allowed to happen, because the user started it.
 */
export function registerResolveWorktreesCommand(deps: CommandDeps): void {
    const { context, refreshAll } = deps;

    context.subscriptions.push(
        vscode.commands.registerCommand('odt.repo.resolveWorktrees', async () => {
            try {
                const result = await SettingsStore.getSelectedProject();
                if (!result) {
                    return;
                }
                const { project } = result;
                const root = readSetupState().provisioningRoot;

                // Every branch any of this project's databases maps, so one
                // pass fixes the whole project rather than one version of it.
                const assignments = (project.dbs ?? []).flatMap(db =>
                    sanitizeProjectRepoBranchAssignments(db.projectRepoBranches));
                const resolved = resolveProjectRepos(project.repos ?? [], assignments, root);
                const pending = resolved.filter(entry => entry.isWorktree);

                if (pending.length === 0) {
                    void showInfo('No repositories are set to one copy per branch.');
                    return;
                }

                const { problems } = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Creating per-branch copies', cancellable: true },
                    (_progress, token) => ensureCustomWorktrees(pending, token, { interactive: true })
                );

                await refreshAll();
                if (problems.length > 0) {
                    void showWarning(`Still using the source checkout — ${problems.join('; ')}`);
                } else {
                    void showInfo('Every repository now has its own copy per branch.');
                }
            } catch (error) {
                void showError(`Could not create the per-branch copies: ${errorMessage(error)}`);
            }
        })
    );
}

async function copyPathToClipboard(uri: vscode.Uri | undefined, relative: boolean): Promise<void> {
    if (!uri) {
        void showInfo('Select a file or folder first.');
        return;
    }

    const absolutePath = uri.fsPath;
    if (!relative) {
        await vscode.env.clipboard.writeText(absolutePath);
        vscode.window.setStatusBarMessage('Copied path', 2000);
        return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        await vscode.env.clipboard.writeText(absolutePath);
        vscode.window.setStatusBarMessage('Copied path (no workspace for relative path)', 2500);
        return;
    }

    const relativePath = path.relative(workspaceRoot, absolutePath);
    const valueToCopy = relativePath.startsWith('..') ? absolutePath : relativePath;
    await vscode.env.clipboard.writeText(valueToCopy);
    vscode.window.setStatusBarMessage('Copied relative path', 2000);
}

async function openUriInIntegratedTerminal(uri: vscode.Uri | undefined): Promise<void> {
    if (!uri) {
        void showInfo('Select a folder to open in terminal.');
        return;
    }

    const cwd = fs.existsSync(uri.fsPath) && fs.lstatSync(uri.fsPath).isDirectory()
        ? uri.fsPath
        : path.dirname(uri.fsPath);

    const terminal = vscode.window.createTerminal({ cwd });
    terminal.show();
}

export function registerReposExplorerCommands(deps: CommandDeps): void {
    registerRepoBranchModeCommand(deps);
    registerResolveWorktreesCommand(deps);
    const { context, providers } = deps;

    // Tree context menus pass the tree node (which carries `.uri`), while
    // programmatic calls may pass a Uri directly — extractUri handles both.
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.newFile', async (arg?: unknown) => {
        await explorerCreateNewFile(extractUri(arg));
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.newFolder', async (arg?: unknown) => {
        await explorerCreateNewFolder(extractUri(arg));
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.rename', async (arg?: unknown) => {
        await explorerRenameEntry(extractUri(arg));
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.selectProject', async () => {
        await selectProjectForExplorer();
        providers.projectReposExplorer.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.copyFilePath', async (arg?: unknown) => {
        await copyPathToClipboard(extractUri(arg), false);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.copyRelativePath', async (arg?: unknown) => {
        await copyPathToClipboard(extractUri(arg), true);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.openInIntegratedTerminal', async (arg?: unknown) => {
        await openUriInIntegratedTerminal(extractUri(arg));
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.revealInExplorer', async (arg?: unknown) => {
        const uri = extractUri(arg);
        if (!uri) {
            void showInfo('Select a file or folder first.');
            return;
        }
        await vscode.commands.executeCommand('revealInExplorer', uri);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.revealFileInOS', async (arg?: unknown) => {
        const uri = extractUri(arg);
        if (!uri) {
            void showInfo('Select a file or folder first.');
            return;
        }
        await vscode.commands.executeCommand('revealFileInOS', uri);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.relocateRepo', async (arg?: unknown) => {
        const repo = (arg as { repo?: { name?: string; path?: string } } | undefined)?.repo;
        if (!repo?.path) {
            void showInfo('Select a repository to relocate.');
            return;
        }

        const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            title: `Select the new location of "${repo.name ?? repo.path}"`,
            openLabel: 'Use This Folder'
        });
        if (!picked || picked.length === 0) {
            return;
        }
        const newPath = picked[0].fsPath;

        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            return;
        }
        const { data, project } = result;
        const target = (project.repos ?? []).find(r => r.path === repo.path || r.name === repo.name);
        if (!target) {
            void showError('The repository could not be found in the current project.');
            return;
        }

        target.path = newPath;
        await SettingsStore.saveWithoutComments(stripSettings(data));
        invalidateModuleDiscoveryCache();
        invalidateRepositoryDiscoveryCache();
        invalidateGitBranchCache();
        showAutoInfo(`Repository "${target.name}" now points to ${newPath}`, 3000);
        await deps.refreshAll();
    }));
}
