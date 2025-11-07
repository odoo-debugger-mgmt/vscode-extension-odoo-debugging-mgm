import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { SettingsStore } from './settingsStore';
import { RepoModel } from './models/repo';
import { showError, showInfo } from './utils';
import { SortPreferences } from './sortPreferences';
import { getDefaultSortOption } from './sortOptions';
import * as os from 'node:os';

type ProjectRepoItemMetadata =
    | { kind: 'info'; message: string }
    | { kind: 'repo'; repo: RepoModel }
    | { kind: 'folder'; repo: RepoModel; fsPath: string }
    | { kind: 'file'; repo: RepoModel; fsPath: string };

class ProjectRepoItem extends vscode.TreeItem {
    constructor(public readonly metadata: ProjectRepoItemMetadata) {
        super(ProjectRepoItem.getLabel(metadata), ProjectRepoItem.getCollapsibleState(metadata));
        this.contextValue = ProjectRepoItem.getContext(metadata);
        this.tooltip = ProjectRepoItem.getTooltip(metadata);
        this.resourceUri = ProjectRepoItem.getResource(metadata);
        this.command = ProjectRepoItem.getCommand(metadata);
        this.description = ProjectRepoItem.getDescription(metadata);
    }

    private static getLabel(metadata: ProjectRepoItemMetadata): string {
        switch (metadata.kind) {
            case 'info':
                return metadata.message;
            case 'repo':
                return metadata.repo.name;
            case 'folder':
            case 'file':
                return path.basename(metadata.fsPath);
            default:
                return '';
        }
    }

    private static getDescription(metadata: ProjectRepoItemMetadata): string | undefined {
        if (metadata.kind === 'repo') {
            return metadata.repo.path;
        }
        return undefined;
    }

    private static getCollapsibleState(metadata: ProjectRepoItemMetadata): vscode.TreeItemCollapsibleState {
        if (metadata.kind === 'info' || metadata.kind === 'file') {
            return vscode.TreeItemCollapsibleState.None;
        }
        return vscode.TreeItemCollapsibleState.Collapsed;
    }

    private static getTooltip(metadata: ProjectRepoItemMetadata): string | undefined {
        if (metadata.kind === 'repo') {
            return metadata.repo.path;
        }
        if (metadata.kind === 'folder' || metadata.kind === 'file') {
            return metadata.fsPath;
        }
        return undefined;
    }

    private static getResource(metadata: ProjectRepoItemMetadata): vscode.Uri | undefined {
        if (metadata.kind === 'repo') {
            return vscode.Uri.file(metadata.repo.path);
        }
        if (metadata.kind === 'folder' || metadata.kind === 'file') {
            return vscode.Uri.file(metadata.fsPath);
        }
        return undefined;
    }

    private static getCommand(metadata: ProjectRepoItemMetadata): vscode.Command | undefined {
        if (metadata.kind === 'file') {
            return {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [vscode.Uri.file(metadata.fsPath)]
            };
        }

        return undefined;
    }

    private static getContext(metadata: ProjectRepoItemMetadata): string | undefined {
        switch (metadata.kind) {
            case 'info':
                return 'projectReposInfo';
            case 'repo':
                return 'projectRepoRoot';
            case 'folder':
                return 'projectRepoFolder';
            case 'file':
                return 'projectRepoFile';
            default:
                return undefined;
        }
    }
}

export class ProjectReposProvider implements vscode.TreeDataProvider<ProjectRepoItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ProjectRepoItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ProjectRepoItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private readonly sortPreferences: SortPreferences) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ProjectRepoItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ProjectRepoItem): Promise<ProjectRepoItem[]> {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            return [new ProjectRepoItem({ kind: 'info', message: 'Select a project to see its repositories.' })];
        }

        const repos = result.project.repos ?? [];
        if (!repos.length) {
            return [new ProjectRepoItem({ kind: 'info', message: 'No repositories selected for this project.' })];
        }

        if (!element) {
            const sortId = this.sortPreferences.get('projectRepos', getDefaultSortOption('projectRepos'));
            const sortedRepos = [...repos].sort((a, b) => this.compareRepos(a, b, sortId));
            return sortedRepos.map(repo => new ProjectRepoItem({ kind: 'repo', repo }));
        }

        if (element.metadata.kind === 'repo') {
            return this.getDirectoryEntries(element.metadata.repo.path, element.metadata.repo);
        }

        if (element.metadata.kind === 'folder') {
            return this.getDirectoryEntries(element.metadata.fsPath, element.metadata.repo);
        }

        return [];
    }

    private async getDirectoryEntries(dirPath: string, repo: RepoModel): Promise<ProjectRepoItem[]> {
        try {
            const dirents = await fs.readdir(dirPath, { withFileTypes: true });
            const sorted = dirents.sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory()) {
                    return -1;
                }
                if (!a.isDirectory() && b.isDirectory()) {
                    return 1;
                }
                return a.name.localeCompare(b.name);
            });

            return sorted.map(dirent => {
                const childPath = path.join(dirPath, dirent.name);
                if (dirent.isDirectory()) {
                    return new ProjectRepoItem({ kind: 'folder', repo, fsPath: childPath });
                }
                return new ProjectRepoItem({ kind: 'file', repo, fsPath: childPath });
            });
        } catch (error: any) {
            return [
                new ProjectRepoItem({
                    kind: 'info',
                    message: `Unable to read folder: ${error?.message ?? error}`
                })
            ];
        }
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
}

export async function revealProjectRepo(repo: RepoModel): Promise<void> {
    try {
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(repo.path));
    } catch (error: any) {
        showError(`Unable to reveal repository: ${error?.message ?? error}`);
    }
}
