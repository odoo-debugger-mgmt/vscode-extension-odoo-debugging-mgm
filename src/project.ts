import * as vscode from 'vscode';
import { ProjectModel } from './models/project';
import { DatabaseModel } from './models/db';
import { RepoModel } from './models/repo';
import { listSubdirectories } from './utils';
import { SettingsStore } from './settingsStore';

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
        const data = await SettingsStore.get('odoo-debugger-data.json');
        if (!data) {
            return [];
        }

        const projects: ProjectModel[] = data.projects;
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

export async function createProject(name: string, repos: RepoModel[], db?: DatabaseModel) {
    let project: ProjectModel;
    if (!db) {
        project = new ProjectModel(name, new Date(), [], repos, true);
    } else {
        project = new ProjectModel(name, new Date(), [db], repos, true);
    }
    await SettingsStore.save(project, ["projects", project.uid], 'odoo-debugger-data.json');
    selectProject(project);
}

export async function selectProject(event: any) {
    const project = event;
    const DebuggerData = await SettingsStore.get( 'odoo-debugger-data.json');
    const projects: ProjectModel[] = DebuggerData.projects;
    if (!projects) {
        vscode.window.showErrorMessage('Error reading projects');
        return;
    }
    let oldSelectedProject = projects.find((p: ProjectModel) => p.isSelected);
    if (oldSelectedProject) {
        oldSelectedProject.isSelected = false;
        await SettingsStore.save(false, ["projects", oldSelectedProject.uid, "isSelected"], 'odoo-debugger-data.json');
    }
    await SettingsStore.save(true, ["projects", project.uid, "isSelected"], 'odoo-debugger-data.json');
}

export async function getRepo(targetPath:string): Promise<RepoModel[] > {
    const devsRepos = listSubdirectories(targetPath);
        if (devsRepos.length === 0) {
        vscode.window.showInformationMessage('No folders found in custom-addons.');
        throw new Error('No folders found in custom-addons.');
    }
    // Show QuickPick with both name and path as label and description
    const quickPickItems = devsRepos.map(entry => ({
        label: entry.name,
        description: entry.path
    }));
    const selectedItems = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: 'Select a folder from custom-addons',
        canPickMany: true
    });
    if (selectedItems) {
        return selectedItems.map(item => {
            return new RepoModel(item.label, item.description, true);
        });
    }else{
        vscode.window.showErrorMessage("No Folder selected");
        throw new Error("No Folder selected");
    }
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
    const debuggerData = await SettingsStore.get('odoo-debugger-data.json');
    const projects: ProjectModel[] = debuggerData.projects;
    if (!projects) {
        vscode.window.showErrorMessage('Error reading projects');
        return;
    }
    if (project.uid in projects) {
        SettingsStore.save(undefined, ["projects", project.uid], 'odoo-debugger-data.json');
    } else {
        vscode.window.showErrorMessage('Project not found.');
    }
}
