import { RepoModel } from "./models/repo";
import * as vscode from "vscode";
import { findRepositories, getWorkspacePath, normalizePath, showError, showInfo, stripSettings, getGitBranch } from './utils';
import { SettingsStore } from './settingsStore';
import { VersionsService } from './versionsService';
import * as path from 'path';
import * as fs from 'fs';
import { SortPreferences } from './sortPreferences';
import { getDefaultSortOption } from './sortOptions';
import { getCurrentBranchViaSourceControl } from './services/gitService';
import { invalidateModuleDiscoveryCache, invalidateRepositoryDiscoveryCache, runtimeCache } from './services/runtimeCache';

interface RepoEntry {
    name: string;
    path: string;
    isSelected: boolean;
    branch: string | null;
    repoModel?: RepoModel;
    fsCreatedAt: number;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    if (items.length === 0) {
        return [];
    }

    const normalizedLimit = Math.max(1, limit);
    const results: R[] = new Array(items.length);
    let cursor = 0;

    const runNext = async (): Promise<void> => {
        const index = cursor++;
        if (index >= items.length) {
            return;
        }
        results[index] = await worker(items[index]);
        await runNext();
    };

    const workers = Array.from({ length: Math.min(normalizedLimit, items.length) }, () => runNext());
    await Promise.all(workers);
    return results;
}

async function resolveRepoBranch(repoPath: string): Promise<string | null> {
    return runtimeCache.getGitBranch(repoPath, async () => {
        const sourceControlBranch = await getCurrentBranchViaSourceControl(repoPath);
        if (sourceControlBranch) {
            return sourceControlBranch;
        }
        return getGitBranch(repoPath);
    });
}

export class RepoTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    constructor(private context: vscode.ExtensionContext, private sortPreferences: SortPreferences) {
        this.context = context;
    }
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }
    async getChildren(_element?: any): Promise<vscode.TreeItem[] | undefined> {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            return [];
        }

        const { project } = result;
        const workspacePath = getWorkspacePath();
        if (!workspacePath) {
            return [];
        }

        const repos: RepoModel[] = project.repos;
        
        // Get settings from active version
        const versionsService = VersionsService.getInstance();
        const settings = await versionsService.getActiveVersionSettings();
        const customAddonsPath = normalizePath(settings.customAddonsPath);

        // Check if path exists first
        if (!fs.existsSync(customAddonsPath)) {
            showError(`Path does not exist: ${customAddonsPath}`);
            return [];
        }

        const devsRepos = findRepositories(customAddonsPath);
        if (devsRepos.length === 0) {
            showInfo('No repositories found in the custom addons directory.');
            return [];
        }

        if (!repos) {
            showError('No modules are configured for this database.');
            return [];
        }

        const repoEntries = await mapWithConcurrency(devsRepos, 6, async repo => {
            const existingRepo = repos.find(r => r.name === repo.name);
            let branch: string | null = null;
            const gitPath = path.join(repo.path, '.git');
            if (fs.existsSync(gitPath)) {
                try {
                    branch = await resolveRepoBranch(repo.path);
                } catch {
                    branch = null;
                }
            }
            let fsCreatedAt = 0;
            try {
                const stats = fs.statSync(repo.path);
                fsCreatedAt = stats.birthtimeMs || stats.ctimeMs || 0;
            } catch {
                fsCreatedAt = 0;
            }
            return {
                name: repo.name,
                path: repo.path,
                isSelected: !!existingRepo,
                branch,
                repoModel: existingRepo,
                fsCreatedAt
            };
        });

        const sortId = this.sortPreferences.get('repoSelector', getDefaultSortOption('repoSelector'));
        repoEntries.sort((a, b) => this.compareRepos(a, b, sortId));

        return repoEntries.map(entry => {
            const repoIcon = entry.isSelected ? "☑️" : "⬜️";
            const treeItem = new vscode.TreeItem(`${repoIcon} ${entry.name}`);
            treeItem.tooltip = `Repo: ${entry.name}\nPath: ${entry.path}`;
            treeItem.id = entry.path;
            treeItem.description = entry.branch ?? '';
            treeItem.command = {
                command: 'repoSelector.selectRepo',
                title: 'Select Module',
                arguments: [{ isSelected: entry.isSelected, path: entry.path, name: entry.name }]
            };
            return treeItem;
        });
    }

    private compareRepos(a: RepoEntry, b: RepoEntry, sortId: string): number {
        const selectedDelta = Number(b.isSelected) - Number(a.isSelected);
        if (selectedDelta !== 0) {
            return selectedDelta;
        }

        switch (sortId) {
            case 'repo:name:asc':
                return a.name.localeCompare(b.name);
            case 'repo:name:desc':
                return b.name.localeCompare(a.name);
            case 'repo:created:newest':
                return this.getRepoTimestamp(b) - this.getRepoTimestamp(a);
            case 'repo:created:oldest':
                return this.getRepoTimestamp(a) - this.getRepoTimestamp(b);
            default:
                return a.name.localeCompare(b.name);
        }
    }

    private getRepoTimestamp(entry: RepoEntry): number {
        if (entry.repoModel?.addedAt) {
            const added = new Date(entry.repoModel.addedAt).getTime();
            if (!isNaN(added)) {
                return added;
            }
        }
        return entry.fsCreatedAt ?? 0;
    }
}

export async function selectRepo(event: any) {
    const selectedRepo = event;
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }

    const { data, project } = result;
    const repoInProject = project.repos.find((repo: RepoModel) => repo.name === selectedRepo.name);

    if (!repoInProject) {
        project.repos.push(new RepoModel(selectedRepo.name, selectedRepo.path, selectedRepo.isSelected));
    } else {
        project.repos = project.repos.filter((repo: RepoModel) => repo.name !== selectedRepo.name);
    }

    invalidateModuleDiscoveryCache();
    invalidateRepositoryDiscoveryCache();
    await SettingsStore.saveWithoutComments(stripSettings(data));
}
