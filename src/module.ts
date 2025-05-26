import { ModuleModel } from "./models/module";
import { ProjectModel } from "./models/project";
import { DatabaseModel } from "./models/db";
import * as vscode from "vscode";
import { saveToFile, readFromFile, getFolderPathsAndNames } from './common';

export class ModuleTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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
        let db: DatabaseModel | undefined;
        db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
        if (!db) {
            vscode.window.showErrorMessage('No database selected');
            return [];
        }
        let modules: ModuleModel[] = db.modules;
        if (!modules) {
            vscode.window.showErrorMessage('No modules found');
            return [];
        }
        let allModules: {"path": string, "name": string}[] = [];
        for (const repo of project.repos) {
            allModules = allModules.concat(getFolderPathsAndNames(repo.path));
        }
        let treeItems: vscode.TreeItem[] = [];
        for (const module of allModules) {
            const existingModule = modules.find(mod => mod.name === module.name);
            if (existingModule) {
                let moduleIcon: string;
                switch (existingModule.state) {
                    case 'install':
                        moduleIcon = '🟢';
                        break;
                    case 'upgrade':
                        moduleIcon = '🟡';
                        break;
                    default:
                        moduleIcon = '⚪';
                        break;
                }
                treeItems.push({
                    label: `${moduleIcon} ${existingModule.name}`,
                    tooltip: `Module: ${existingModule.name}\nState: ${existingModule.state}`,
                    command: {
                        command: 'moduleSelector.select',
                        title: 'Select Module',
                        arguments: [existingModule]
                    }
                });
            } else {
                // If the module does not exist, treat it as a new module
                treeItems.push({
                    label: `⚪ ${module.name}`,
                    tooltip: `Module: ${module.name}\nState: none`,
                    command: {
                        command: 'moduleSelector.select',
                        title: 'Select Module',
                        arguments: [{ name: module.name, path: module.path, state: 'none' }]
                    }
                });
            }
        }
        return treeItems;
    }
}

export async function selectModule(event: any) {
    const module = event;
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
    let db: DatabaseModel | undefined;
    db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        vscode.window.showErrorMessage('No database selected');
        return;
    }
    const moduleExistsInDb = db.modules.find(mod => mod.name === module.name);
    if (!moduleExistsInDb) {
        db.modules.push(new ModuleModel(module.name, 'install'));
    }else{
        if (moduleExistsInDb.state === 'install') {
            moduleExistsInDb.state = 'upgrade';
        }else{
            db.modules = db.modules.filter(mod => mod.name !== module.name);
        }
    }
    settings['projects'] = projects;
    await saveToFile(settings, 'odoo-debugger-data.json');
}
