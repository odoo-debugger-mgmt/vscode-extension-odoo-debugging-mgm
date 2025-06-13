import { ProjectModel } from "./models/project";
import { RepoModel } from "./models/repo";
import * as vscode from "vscode";
import { saveToFile, readFromFile, getFolderPathsAndNames } from './common';
import * as path from 'path';
import { getRepo } from './project';


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
        let settings = await readFromFile('odoo-debugger-data.json');
        if (!settings) {
            vscode.window.showErrorMessage('Error reading settings');
            return;
        }
        let projects: ProjectModel[] = settings['projects'];
        if (!projects) {
            vscode.window.showErrorMessage('Error reading projects, please create a project first');
            return [];
        }
        if (typeof projects !== 'object') {
            vscode.window.showErrorMessage('Error reading projects');
            return [];
        }
        let project: ProjectModel | undefined;
        project = projects.find((project: ProjectModel) => project.isSelected === true);
        if (!project) {
            vscode.window.showErrorMessage('No project selected');
            return [];
        }
        let repos: RepoModel[] = project.repos;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage("No workspace open.");
            return;
        }
        // const allRepos
        const devsRepos = getFolderPathsAndNames(path.join(workspaceFolder.uri.fsPath, settings.settings.customAddonsPath) );
        if (devsRepos.length === 0) {
            vscode.window.showInformationMessage('No folders found in custom-addons.');
            throw new Error('No folders found in custom-addons.');
        }
        if (!repos) {
            vscode.window.showErrorMessage('No modules found');
            return [];
        }
        let treeItems: vscode.TreeItem[] = [];
        for (const repo of devsRepos) {
            const existingRepo = repos.find(r => r.name === repo.name);
            let repoIcon: string = existingRepo ? "☑️" : "⬜️";
            const treeItem = new vscode.TreeItem(`${repoIcon} ${repo.name}`);
            treeItem.tooltip = `Repo: ${repo.name}\nPath: ${repo.path}`;
            treeItem.description = `${repo.branch}`;
            treeItem.id = repo.path;
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
    let settings = await readFromFile('odoo-debugger-data.json');
    if (!settings) {
        vscode.window.showErrorMessage('Error reading settings');
        return;
    }
    let projects: ProjectModel[] = settings['projects'];
    if (!projects) {
        vscode.window.showErrorMessage('Error reading projects, please create a project first');
        return;
    }
    if (typeof projects !== 'object') {
        vscode.window.showErrorMessage('Error reading projects');
        return;
    }
    let project: ProjectModel | undefined;
    project = projects.find((project: ProjectModel) => project.isSelected === true);
    if (!project) {
        vscode.window.showErrorMessage('No project selected');
        return;
    }
    const repoInProject = project.repos.find((repo: RepoModel) => repo.name === selectedRepo.name);
    if (!repoInProject) {
        project.repos.push(new RepoModel(selectedRepo.name, selectedRepo.path, selectedRepo.isSelected));
    } else {
        project.repos = project.repos.filter((repo: RepoModel) => repo.name !== selectedRepo.name);
    }
    settings['projects'] = projects;
    await saveToFile(settings, 'odoo-debugger-data.json');
}
