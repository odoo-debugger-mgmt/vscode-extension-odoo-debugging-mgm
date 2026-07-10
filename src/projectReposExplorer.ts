import * as vscode from 'vscode';
import * as path from 'node:path';
import { SettingsStore } from './settingsStore';
import { ProjectModel } from './models/project';
import { RepoModel } from './models/repo';
import { showError, showInfo, normalizePath } from './utils';
import { invalidateModuleDiscoveryCache, invalidateRepositoryDiscoveryCache } from './services/runtimeCache';
import { createFilesExcludeMatcher } from './services/filesExclude';
import { showModalWarning } from './services/notifications';
import { BaseTreeProvider } from './views/baseTreeProvider';
import { SortPreferences } from './sortPreferences';
import { getDefaultSortOption } from './sortOptions';
import { getRepoBranch } from './services/branches';
import { pathExists as fsPathExists } from './services/dumpImport';

type NodeKind = 'placeholder' | 'repo' | 'folder' | 'file';

interface BaseNode {
    kind: NodeKind;
    label: string;
}

interface RepoNode extends BaseNode {
    kind: 'repo';
    repo: RepoModel;
    uri: vscode.Uri;
    branch: string | null;
    missing: boolean;
}

interface FolderNode extends BaseNode {
    kind: 'folder';
    uri: vscode.Uri;
}

interface FileNode extends BaseNode {
    kind: 'file';
    uri: vscode.Uri;
}

interface PlaceholderNode extends BaseNode {
    kind: 'placeholder';
    command?: vscode.Command;
}

type ExplorerNode = RepoNode | FolderNode | FileNode | PlaceholderNode;

export class ProjectReposExplorerProvider extends BaseTreeProvider<ExplorerNode> {
    private watchers: vscode.FileSystemWatcher[] = [];
    private watcherKey = '';
    private refreshDebounceTimer: NodeJS.Timeout | undefined;

    constructor(private readonly sortPreferences: SortPreferences) {
        super();
    }

    private scheduleRefresh(): void {
        if (this.refreshDebounceTimer) {
            clearTimeout(this.refreshDebounceTimer);
        }
        this.refreshDebounceTimer = setTimeout(() => {
            this.refreshDebounceTimer = undefined;
            this.refresh();
        }, 200);
    }

    private shouldIgnoreWatcherPath(fsPath: string): boolean {
        const normalized = fsPath.replace(/\\/g, '/');
        const ignoredFragments = ['/.git/', '/node_modules/', '/.venv/', '/__pycache__/'];
        if (ignoredFragments.some(fragment => normalized.includes(fragment))) {
            return true;
        }
        return normalized.endsWith('/.git') || normalized.endsWith('/node_modules') || normalized.endsWith('/.venv') || normalized.endsWith('/__pycache__');
    }

    private onWatcherEvent(uri: vscode.Uri): void {
        if (this.shouldIgnoreWatcherPath(uri.fsPath)) {
            return;
        }
        invalidateModuleDiscoveryCache();
        invalidateRepositoryDiscoveryCache();
        this.scheduleRefresh();
    }

    private disposeWatchers() {
        this.watchers.forEach(w => w.dispose());
        this.watchers = [];
        this.watcherKey = '';
        if (this.refreshDebounceTimer) {
            clearTimeout(this.refreshDebounceTimer);
            this.refreshDebounceTimer = undefined;
        }
    }

    override dispose(): void {
        this.disposeWatchers();
        super.dispose();
    }

    getTreeItem(element: ExplorerNode): vscode.TreeItem {
        switch (element.kind) {
            case 'placeholder': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
                item.contextValue = 'projectReposExplorerInfo';
                item.command = (element as PlaceholderNode).command;
                return item;
            }
            case 'repo': {
                if (element.missing) {
                    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
                    item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
                    item.description = 'path missing';
                    item.tooltip = `${element.repo.path} does not exist.\nThe folder may have been moved or deleted - use "Relocate Repository" to fix the path.`;
                    item.contextValue = 'projectRepoRootMissing';
                    return item;
                }
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
                item.resourceUri = element.uri;
                item.description = element.branch ?? undefined;
                item.tooltip = element.branch ? `${element.repo.path}\nBranch: ${element.branch}` : element.repo.path;
                item.contextValue = 'projectRepoRoot';
                return item;
            }
            case 'folder': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
                item.resourceUri = element.uri;
                item.contextValue = 'projectRepoFolder';
                return item;
            }
            case 'file': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
                item.resourceUri = element.uri;
                item.contextValue = 'projectRepoFile';
                item.command = {
                    command: 'vscode.open',
                    title: 'Open File',
                    arguments: [element.uri]
                };
                return item;
            }
        }
    }

    async getChildren(element?: ExplorerNode): Promise<ExplorerNode[]> {
        if (!element) {
            const selection = await SettingsStore.getSelectedProject();
            if (!selection) {
                return [
                    {
                        kind: 'placeholder',
                        label: 'No active project. Select a project to view its repos.',
                        command: { command: 'odt.projectReposExplorer.selectProject', title: 'Select Project' }
                    }
                ];
            }

            const { project } = selection;
            const repos = (project.repos ?? []) as RepoModel[];
            if (!repos.length) {
                return [
                    {
                        kind: 'placeholder',
                        label: 'No repositories selected for this project.',
                        command: { command: 'repoSelector.selectRepo', title: 'Select Repo' }
                    }
                ];
            }

            this.resetWatchers(repos);

            const sortId = this.sortPreferences.get('projectRepos', getDefaultSortOption('projectRepos'));
            const sortedRepos = [...repos].sort((a, b) => this.compareRepos(a, b, sortId));
            return Promise.all(sortedRepos.map(async repo => {
                const repoPath = normalizePath(repo.path);
                const missing = !(await fsPathExists(repoPath));
                return {
                    kind: 'repo' as const,
                    label: repo.name,
                    repo,
                    uri: vscode.Uri.file(repoPath),
                    branch: missing ? null : await getRepoBranch(repoPath),
                    missing
                };
            }));
        }

        if (element.kind === 'repo' || element.kind === 'folder') {
            return this.readDirectory(element.uri);
        }

        return [];
    }

    private compareRepos(a: RepoModel, b: RepoModel, sortId: string): number {
        switch (sortId) {
            case 'projectRepos:name:asc':
                return a.name.localeCompare(b.name);
            case 'projectRepos:name:desc':
                return b.name.localeCompare(a.name);
            case 'projectRepos:added:newest':
                return this.getAddedTimestamp(b) - this.getAddedTimestamp(a);
            case 'projectRepos:added:oldest':
                return this.getAddedTimestamp(a) - this.getAddedTimestamp(b);
            default:
                return a.name.localeCompare(b.name);
        }
    }

    private getAddedTimestamp(repo: RepoModel): number {
        if (repo.addedAt) {
            const value = new Date(repo.addedAt).getTime();
            if (!isNaN(value)) {
                return value;
            }
        }
        return 0;
    }

    private resetWatchers(repos: RepoModel[]) {
        const nextKey = repos
            .map(repo => repo.path)
            .sort((a, b) => a.localeCompare(b))
            .join('|');

        if (nextKey === this.watcherKey) {
            return;
        }

        this.disposeWatchers();
        this.watcherKey = nextKey;
        for (const repo of repos) {
            const pattern = new vscode.RelativePattern(repo.path, '**/*');
            const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
            watcher.onDidCreate(uri => this.onWatcherEvent(uri));
            watcher.onDidChange(uri => this.onWatcherEvent(uri));
            watcher.onDidDelete(uri => this.onWatcherEvent(uri));
            this.watchers.push(watcher);
        }
    }

    private async readDirectory(dir: vscode.Uri): Promise<ExplorerNode[]> {
        try {
            const filesExcludeMatcher = createFilesExcludeMatcher(dir);
            const entries = await vscode.workspace.fs.readDirectory(dir);
            const nodes: ExplorerNode[] = [];
            for (const [name, type] of entries) {
                const childUri = vscode.Uri.file(path.join(dir.fsPath, name));
                if (filesExcludeMatcher.isExcluded(childUri.fsPath, name)) {
                    continue;
                }
                if (type === vscode.FileType.Directory) {
                    nodes.push({ kind: 'folder', label: name, uri: childUri } as FolderNode);
                    continue;
                }
                nodes.push({ kind: 'file', label: name, uri: childUri } as FileNode);
            }
            nodes.sort((a, b) => {
                if (a.kind === b.kind) {
                    return a.label.localeCompare(b.label);
                }
                if (a.kind === 'folder' && b.kind === 'file') {
                    return -1;
                }
                if (a.kind === 'file' && b.kind === 'folder') {
                    return 1;
                }
                return 0;
            });
            return nodes;
        } catch (error: any) {
            void showError(`Unable to read ${dir.fsPath}: ${error?.message ?? error}`);
            return [];
        }
    }
}

async function promptName(placeHolder: string, value?: string): Promise<string | undefined> {
    return vscode.window.showInputBox({
        prompt: placeHolder,
        value,
        ignoreFocusOut: true
    });
}

export async function createNewFile(folderUri?: vscode.Uri): Promise<void> {
    const baseUri = folderUri ?? (vscode.window.activeTextEditor?.document.uri);
    if (!baseUri) {
        void showInfo('Select a folder to create a file.');
        return;
    }
    const folderPath = baseUri.fsPath;
    const name = await promptName('New file name', 'untitled.txt');
    if (!name) {
        return;
    }
    const target = vscode.Uri.file(path.join(folderPath, name));
    await vscode.workspace.fs.writeFile(target, new Uint8Array());
}

export async function createNewFolder(folderUri?: vscode.Uri): Promise<void> {
    if (!folderUri) {
        void showInfo('Select a folder to create a new folder.');
        return;
    }
    const name = await promptName('New folder name', 'new-folder');
    if (!name) {
        return;
    }
    const target = vscode.Uri.file(path.join(folderUri.fsPath, name));
    await vscode.workspace.fs.createDirectory(target);
}

export async function renameEntry(uri?: vscode.Uri): Promise<void> {
    if (!uri) {
        void showInfo('Select a file or folder to rename.');
        return;
    }
    const currentName = path.basename(uri.fsPath);
    const newName = await promptName('Rename to', currentName);
    if (!newName || newName === currentName) {
        return;
    }
    const target = vscode.Uri.file(path.join(path.dirname(uri.fsPath), newName));
    await vscode.workspace.fs.rename(uri, target, { overwrite: false });
}

export async function deleteEntry(uri?: vscode.Uri): Promise<void> {
    if (!uri) {
        void showInfo('Select a file or folder to delete.');
        return;
    }
    const choice = await showModalWarning(
        `Delete "${path.basename(uri.fsPath)}"?`,
        'Delete'
    );
    if (choice !== 'Delete') {
        return;
    }
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
}

export async function openTerminalHere(uri?: vscode.Uri): Promise<void> {
    if (!uri) {
        void showInfo('Select a folder to open in terminal.');
        return;
    }
    const terminal = vscode.window.createTerminal({ cwd: uri.fsPath });
    terminal.show();
}

export async function selectProjectForExplorer(): Promise<void> {
    const data = await SettingsStore.get('odoo-debugger-data.json');
    if (!data?.projects || data.projects.length === 0) {
        void showInfo('No projects found. Create a project first.');
        return;
    }

    const pick = await vscode.window.showQuickPick(
        data.projects.map((p: ProjectModel, idx: number) => ({
            label: p.name,
            description: `${p.repos?.length ?? 0} repos`,
            index: idx
        })),
        { placeHolder: 'Select a project' }
    );
    if (!pick) {
        return;
    }

    data.projects.forEach((p: ProjectModel, idx: number) => (p.isSelected = idx === pick.index));
    await SettingsStore.saveWithoutComments(data);
}

// Clipboard for copy/cut
let clipboard: { uris: vscode.Uri[]; cut: boolean } | null = null;

export function copyEntries(uris: vscode.Uri[], cut = false): void {
    clipboard = { uris, cut };
    const action = cut ? 'Cut' : 'Copied';
    vscode.window.setStatusBarMessage(`${action} ${uris.length} item(s)`, 2000);
}

function getTargetFolderUri(uri?: vscode.Uri): vscode.Uri | undefined {
    if (!uri) {
        return undefined;
    }
    return uri;
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

export async function pasteEntries(targetUri?: vscode.Uri): Promise<void> {
    if (!clipboard || clipboard.uris.length === 0) {
        void showInfo('Nothing to paste.');
        return;
    }

    const folderUri = getTargetFolderUri(targetUri);
    if (!folderUri) {
        void showInfo('Select a destination folder.');
        return;
    }

    for (const source of clipboard.uris) {
        const base = path.basename(source.fsPath);
        const destination = vscode.Uri.file(path.join(folderUri.fsPath, base));

        const exists = await pathExists(destination);
        if (exists) {
            const choice = await showModalWarning(
                `"${base}" already exists. Overwrite?`,
                'Overwrite',
                'Skip'
            );
            if (choice !== 'Overwrite') {
                continue;
            }
        }

        try {
            if (clipboard.cut) {
                await vscode.workspace.fs.rename(source, destination, { overwrite: true });
            } else {
                await vscode.workspace.fs.copy(source, destination, { overwrite: true });
            }
        } catch (error: any) {
            void showError(`Failed to paste "${base}": ${error?.message ?? error}`);
        }
    }

    if (clipboard.cut) {
        clipboard = null;
    }
}
