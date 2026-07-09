import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandDeps } from './index';
import { extractUri, extractRepoFromMetadata } from './args';
import { showInfo } from '../services/notifications';
import { revealProjectRepo } from '../projectRepos';
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
        showInfo('Select a file or folder first.');
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
        showInfo('Select a folder to open in terminal.');
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

    context.subscriptions.push(vscode.commands.registerCommand('projectRepos.reveal', async (arg?: unknown) => {
        const repo = extractRepoFromMetadata(arg);
        if (repo?.path) {
            await revealProjectRepo(repo);
            return;
        }

        const uri = extractUri(arg);
        if (!uri) {
            showInfo('Select a repository to reveal.');
            return;
        }
        await vscode.commands.executeCommand('revealInExplorer', uri);
    }));

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
            showInfo('Select a file or folder first.');
            return;
        }
        await vscode.commands.executeCommand('revealInExplorer', uri);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.revealFileInOS', async (arg?: unknown) => {
        const uri = extractUri(arg);
        if (!uri) {
            showInfo('Select a file or folder first.');
            return;
        }
        await vscode.commands.executeCommand('revealFileInOS', uri);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.renameEntry', async (arg?: unknown) => {
        await explorerRenameEntry(extractUri(arg));
        providers.projectRepos.refresh();
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.deleteEntry', async (arg?: unknown) => {
        await explorerDeleteEntry(extractUri(arg));
        providers.projectRepos.refresh();
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.copyEntry', async (arg?: unknown) => {
        const uri = extractUri(arg);
        if (!uri) {
            showInfo('Select a file or folder first.');
            return;
        }
        explorerCopyEntries([uri], false);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.cutEntry', async (arg?: unknown) => {
        const uri = extractUri(arg);
        if (!uri) {
            showInfo('Select a file or folder first.');
            return;
        }
        explorerCopyEntries([uri], true);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.pasteEntry', async (arg?: unknown) => {
        const uri = extractUri(arg);
        if (!uri) {
            showInfo('Select a folder to paste into.');
            return;
        }

        let target = uri;
        try {
            if (fs.existsSync(uri.fsPath) && fs.lstatSync(uri.fsPath).isFile()) {
                target = vscode.Uri.file(path.dirname(uri.fsPath));
            }
        } catch {
            // Best effort: fall back to the provided uri
        }

        await explorerPasteEntries(target);
        providers.projectRepos.refresh();
        providers.projectReposExplorer.refresh();
    }));
}
