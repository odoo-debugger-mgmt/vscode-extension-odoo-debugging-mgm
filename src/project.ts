import * as vscode from 'vscode';
import { ProjectModel } from './models/project';
import { DatabaseModel } from './models/db';
import { RepoModel } from './models/repo';
import { listSubdirectories, showError, showInfo } from './utils';
import { SettingsStore } from './settingsStore';
import { randomUUID } from 'crypto';

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
            showError('Error reading projects, please create a project first');
            return [];
        }

        // Ensure all projects have UIDs (migration for existing data)
        const needsSave = await ensureProjectUIDs(data);
        if (needsSave) {
            await SettingsStore.saveAll(data);
        }

        return projects.map(project => {
            const treeItem = new vscode.TreeItem(`${project.isSelected ? '👉' : ''} ${project.name}`);
            treeItem.id = project.name;
            treeItem.command = {
                command: 'projectSelector.selectProject',
                title: 'Select Project',
                arguments: [project.uid] // Pass just the UID instead of the whole object
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
    
    // Get current data and add the new project to the array
    const data = await SettingsStore.get('odoo-debugger-data.json');
    if (!data.projects) {
        data.projects = [];
    }
    data.projects.push(project);
    
    // Save the entire updated data
    await SettingsStore.saveAll(data);
    selectProject(project.uid);
}

async function ensureProjectUIDs(data: any): Promise<boolean> {
    let needsSave = false;
    if (data.projects && Array.isArray(data.projects)) {
        for (const project of data.projects) {
            if (!project.uid) {
                project.uid = randomUUID();
                needsSave = true;
            }
        }
    }
    return needsSave;
}

export async function selectProject(projectUid: string) {
    const data = await SettingsStore.get('odoo-debugger-data.json');
    const projects: ProjectModel[] = data.projects;
    if (!projects) {
        showError('Error reading projects');
        return;
    }
    
    // Ensure all projects have UIDs (migration for existing data)
    const needsSave = await ensureProjectUIDs(data);
    if (needsSave) {
        await SettingsStore.saveAll(data);
    }
    
    // Find and deselect the currently selected project
    const oldSelectedIndex = projects.findIndex((p: ProjectModel) => p.isSelected);
    if (oldSelectedIndex !== -1) {
        await SettingsStore.save(false, ["projects", oldSelectedIndex, "isSelected"], 'odoo-debugger-data.json');
    }
    
    // Find and select the new project by UID
    const newSelectedIndex = projects.findIndex((p: ProjectModel) => p.uid === projectUid);
    
    if (newSelectedIndex !== -1) {
        await SettingsStore.save(true, ["projects", newSelectedIndex, "isSelected"], 'odoo-debugger-data.json');
    } else {
        showError('Project not found');
    }
}

export async function getRepo(targetPath:string): Promise<RepoModel[] > {
    const devsRepos = listSubdirectories(targetPath);
        if (devsRepos.length === 0) {
        showInfo('No folders found in custom-addons.');
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
        showError("No Folder selected");
        throw new Error("No Folder selected");
    }
}

export async function getProjectName(workspaceFolder: vscode.WorkspaceFolder): Promise<string> {
    const name = await vscode.window.showInputBox({ prompt: "Please make sure you have a folder called custom-addons in the current directory", title: "Project Name" });
    if (!name) {
        showError('Project name is required.');
        throw new Error('Project name is required.');
    }
    return name;
}

export async function deleteProject(event: any) {
    const project = event;
    const data = await SettingsStore.get('odoo-debugger-data.json');
    const projects: ProjectModel[] = data.projects;
    if (!projects) {
        showError('Error reading projects');
        return;
    }
    
    // Find the project index in the array
    const projectIndex = projects.findIndex((p: ProjectModel) => p.uid === project.uid);
    if (projectIndex !== -1) {
        // Remove the project from the array and save the updated data
        data.projects.splice(projectIndex, 1);
        await SettingsStore.saveAll(data);
    } else {
        showError('Project not found.');
    }
}
