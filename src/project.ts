import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectModel } from './models/project';
import { DatabaseModel } from './models/db';
import { ModuleModel, ModuleState } from './models/module';
import { saveToFile } from './common';
import { readFromFile, getFolderPathsAndNames} from './common';

export class ProjectTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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
    async getChildren(element?: any): Promise<vscode.TreeItem[]> {
        let settings = await readFromFile();
        if (!settings) {
            vscode.window.showErrorMessage('Error reading settings');
            return [];
        }
        let projects: ProjectModel[] = settings['projects'];
        if (!projects) {
            vscode.window.showErrorMessage('Error reading projects, please create a project first');
            return [];
        }
        return projects.map(project => {
            const treeItem = new vscode.TreeItem(`${project.isSelected ? '👉' : ''} ${project.name}`);
            treeItem.id = project.name;
            treeItem.command = {
                command: 'projectSelector.selectProject',
                title: 'Select Project',
                arguments: [project]
            };
            return treeItem;
        });
    }
}

export async function createProject(name: string, repo: string, db?: DatabaseModel) {
    let project: ProjectModel;
    if (!db) {
        project = new ProjectModel(name, repo, new Date());
    }else{
        project = new ProjectModel(name, repo, new Date(), [db], true);
    }
    let settings = await readFromFile();
    if (!settings) {
        vscode.window.showErrorMessage('Error reading settings');
        return;
    }
    const projects = settings['projects'];
    if (projects === undefined) {
        settings['projects'] = [project];
        saveToFile(settings);
    }
    else {
        projects.push(project);
        settings['projects'] = projects;
        saveToFile(settings);
    }
    vscode.window.showInformationMessage(`Project ${name} created successfully!`);
}

export async function selectProject(event: any) {
    const project = event;
    let settings = await readFromFile();
    if (!settings) {
        vscode.window.showErrorMessage('Error reading settings');
        return;
    }
    let projects: ProjectModel[] = settings['projects'];
    if (!projects) {
        vscode.window.showErrorMessage('Error reading projects');
        return;
    }
    projects.forEach((settingProject: ProjectModel) => {
        if (settingProject.name === project.name) {
            settingProject.isSelected = true;
        } else {
            settingProject.isSelected = false;
        }
    });
    project.isSelected = true;
    settings['projects'] = projects;
    await saveToFile(settings);
    vscode.window.showInformationMessage(`Project ${project.name} selected successfully!`);
}

export async function getRepo(targetPath:string): Promise<string > {
    const devsRepos = getFolderPathsAndNames(targetPath);
        if (devsRepos.length === 0) {
        vscode.window.showInformationMessage('No folders found in custom-addons.');
        throw new Error('No folders found in custom-addons.');
    }
    const selected = await vscode.window.showQuickPick(devsRepos.map(entry => entry[1]), {
        placeHolder: 'Select a folder from custom-addons',
    });
    let repo: [string, string] | undefined;
    if (selected) {
        repo = devsRepos.find(entry => entry[1] === selected);
    }else{
        vscode.window.showErrorMessage("No Folder selected");
        throw new Error("No Folder selected");
    }
    if (!repo) {
        vscode.window.showErrorMessage('No folder selected.');
        throw new Error('No folder selected.');
    }
    return repo[0];
}

export async function getProjectName(workspaceFolder: vscode.WorkspaceFolder): Promise<string> {
    const name = await vscode.window.showInputBox({ prompt: "Please make sure you have a folder called custom-addons in the current directory", title: "Project Name" });
    if (!name) {
        vscode.window.showErrorMessage('Project name is required.');
        throw new Error('Project name is required.');
    }
    return name;
}

export async function deleteProject(event: any) {
    const project = event;
    let settings = await readFromFile();
    if (!settings) {
        vscode.window.showErrorMessage('Error reading settings');
        return;
    }
    let projects: ProjectModel[] = settings['projects'];
    if (!projects) {
        vscode.window.showErrorMessage('Error reading projects');
        return;
    }
    const index = projects.findIndex((settingProject: ProjectModel) => settingProject.name === project.id);
    if (index !== -1) {
        projects.splice(index, 1);
        await saveToFile(settings);
        vscode.window.showInformationMessage(`Project ${project.name} deleted successfully!`);
    } else {
        vscode.window.showErrorMessage('Project not found.');
    }
}
