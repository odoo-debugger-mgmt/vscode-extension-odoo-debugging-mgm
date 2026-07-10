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
import { showAutoInfo } from '../services/notifications';
import { SettingsStore } from '../settingsStore';
import { stripSettings } from '../utils';
import { invalidateModuleDiscoveryCache, invalidateRepositoryDiscoveryCache, invalidateGitBranchCache } from '../services/runtimeCache';
import {
    createNewFile as explorerCreateNewFile,
    createNewFolder as explorerCreateNewFolder,
    renameEntry as explorerRenameEntry,
    deleteEntry as explorerDeleteEntry,
    openTerminalHere as explorerOpenTerminalHere,
    selectProjectForExplorer,
    copyEntries as explorerCopyEntries,
    pasteEntries as explorerPasteEntries
} from '../projectReposExplorer';

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
    const { context, providers } = deps;

    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.newFile', async (uri?: vscode.Uri) => {
        await explorerCreateNewFile(uri);
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.newFolder', async (uri?: vscode.Uri) => {
        await explorerCreateNewFolder(uri);
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.rename', async (uri?: vscode.Uri) => {
        await explorerRenameEntry(uri);
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.delete', async (uri?: vscode.Uri) => {
        await explorerDeleteEntry(uri);
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.openTerminalHere', async (uri?: vscode.Uri) => {
        await explorerOpenTerminalHere(uri);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.selectProject', async () => {
        await selectProjectForExplorer();
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.copy', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const list = uris && uris.length ? uris : uri ? [uri] : [];
        if (!list.length) {
            return;
        }
        explorerCopyEntries(list, false);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.cut', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const list = uris && uris.length ? uris : uri ? [uri] : [];
        if (!list.length) {
            return;
        }
        explorerCopyEntries(list, true);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.paste', async (uri?: vscode.Uri) => {
        await explorerPasteEntries(uri);
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
