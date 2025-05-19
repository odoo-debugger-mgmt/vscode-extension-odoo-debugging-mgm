import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectModel } from './models/project';
import { DatabaseModel } from './models/db';
import { ModuleModel, ModuleState } from './models/module';
import { saveToFile } from './common';
import { readFromFile } from './common';

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
            const treeItem = new vscode.TreeItem(`${project.name} ${project.isSelected ? '✅' : ''}`);
            treeItem.command = {
                command: 'projects.selectProject',
                title: 'Select Project',
                arguments: [project]
            };
            return treeItem;
        });
    }
}


export async function createProject(context: vscode.ExtensionContext) {
    const name = await vscode.window.showInputBox({ prompt: "Please make sure you have a folder called custom-addons in the current directory", title: "Project Name" });
    if (!name) {
        vscode.window.showErrorMessage('Project name is required.');
        return;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
    }
    const targetPath = path.join(workspaceFolder.uri.fsPath, 'custom-addons');
    const devsRepos = getFolderPathsAndNames(targetPath);
        if (devsRepos.length === 0) {
        vscode.window.showInformationMessage('No folders found in custom-addons.');
        return;
    }

    const selected = await vscode.window.showQuickPick(devsRepos.map(entry => entry[1]), {
        placeHolder: 'Select a folder from custom-addons',
    });
    let repo: [string, string] | undefined;
    if (selected) {
        repo = devsRepos.find(entry => entry[1] === selected);
    }else{
        vscode.window.showErrorMessage("No Folder selected");
        return;
    }
    if (!repo) {
        vscode.window.showErrorMessage('No folder selected.');
        return;
    }
    const allModules = getFolderPathsAndNames(repo[0]);
    const createADb = await vscode.window.showQuickPick(["Yes", "No"], {
        placeHolder: 'Do you want to create a database?',
    });
    let selectedModules: string[] | undefined;
    let db: DatabaseModel | undefined;
    let modules: ModuleModel[] = [];

    if (createADb === "Yes") {
        selectedModules = await vscode.window.showQuickPick(allModules.map(entry => entry[1]), {
            placeHolder: 'Select modules',
            canPickMany: true,
        });
        for (const module of allModules) {
            let isSelected: ModuleState = 'none';
            if (module[1] in selectedModules){
                isSelected = 'install';
            }
            modules.push(new ModuleModel(module[1], isSelected));
        }
        db = new DatabaseModel(new Date(), modules, false, true); // to be updated
    }else{
        selectedModules = [];
    }
    let project: ProjectModel;
    if (!db) {
        project = new ProjectModel(name, repo[0], new Date());
    }else{
        project = new ProjectModel(name, repo[0], new Date(), [db], true);
    }
    // const projects = await getProjects(context);
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

function getFolderPathsAndNames(targetPath: string): [string, string][] {
    if (!fs.existsSync(targetPath)) {
        vscode.window.showErrorMessage(`Path does not exist: ${targetPath}`);
        return [];
    }

    return fs.readdirSync(targetPath)
        .map(file => {
            const fullPath = path.join(targetPath, file);
            return { fullPath, file };
        })
        .filter(entry => {
            try {
                return (fs.statSync(entry.fullPath).isDirectory() && !entry.file.startsWith('.'));
            } catch {
                return false;
            }
        })
        .map(entry => [entry.fullPath, entry.file] as [string, string]);
}

