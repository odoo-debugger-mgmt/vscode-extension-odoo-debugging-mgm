import { RepoModel } from "./models/repo";
import * as vscode from "vscode";
import { listSubdirectories, getWorkspacePath, normalizePath, showError, showInfo } from './utils';
import { SettingsStore } from './settingsStore';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';



export class RepoTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    constructor(private context: vscode.ExtensionContext) {
        this.context = context;
    }
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }
    async getChildren(element?: any): Promise<vscode.TreeItem[] | undefined> {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            return [];
        }

        const { data, project } = result;
        const workspacePath = getWorkspacePath();
        if (!workspacePath) {
            return [];
        }

        const repos: RepoModel[] = project.repos;
        const customAddonsPath = normalizePath(data.settings.customAddonsPath);
        const devsRepos = listSubdirectories(customAddonsPath);
        if (devsRepos.length === 0) {
            showInfo('No folders found in custom-addons.');
            throw new Error('No folders found in custom-addons.');
        }

        if (!repos) {
            showError('No modules found');
            return [];
        }

        let treeItems: vscode.TreeItem[] = [];
        for (const repo of devsRepos) {
            const existingRepo = repos.find(r => r.name === repo.name);
            let repoIcon: string = existingRepo ? "☑️" : "⬜️";
            const treeItem = new vscode.TreeItem(`${repoIcon} ${repo.name}`);
            treeItem.tooltip = `Repo: ${repo.name}\nPath: ${repo.path}`;
            treeItem.id = repo.path;
            if (existingRepo) {
                let branch: string | null = null;
                const gitPath = path.join(repo.path, '.git');
                if (fs.existsSync(gitPath)) {
                    try {
                        branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repo.path })
                            .toString()
                            .trim();
                    } catch (err) {
                        branch = null;
                    }
                }
                treeItem.description = `${branch}`;
            } else {
                treeItem.description = ``;
            }
            treeItem.command = {
                command: 'repoSelector.selectRepo',
                title: 'Select Module',
                arguments: [{isSelected: existingRepo ? true : false, path: repo.path, name: repo.name}]
            };
            treeItems.push(treeItem);
        }
        // Sort so that selected repos show up first
        treeItems.sort((a, b) => {
            const aSelected = a.label?.toString().startsWith("☑️") ? 1 : 0;
            const bSelected = b.label?.toString().startsWith("☑️") ? 1 : 0;
            return bSelected - aSelected;
        });
        return treeItems;
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

    await SettingsStore.saveAll(data);
}
