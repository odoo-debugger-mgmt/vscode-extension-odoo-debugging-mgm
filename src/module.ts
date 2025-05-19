import { ModuleModel, ModuleState } from "./models/module";
import { ProjectModel } from "./models/project";
import { DatabaseModel } from "./models/db";
import * as vscode from "vscode";
import { saveToFile, readFromFile } from './common';

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
        let settings = await readFromFile();
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
        return modules.map((module: ModuleModel) => {
            let moduleIcon: string;
            switch (module.state) {
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
            const treeItem = new vscode.TreeItem(`${moduleIcon} ${module.name}`);
            treeItem.tooltip = `Module: ${module.name}\nState: ${module.state}`;
            treeItem.command = {
                command: 'moduleSelector.select',
                title: 'Select Module',
                arguments: [module]
            };
            return treeItem;
        });
    }
}

export async function selectModule(event: any) {
    const module = event;
    let settings = await readFromFile();
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
    db.modules.forEach((mod: ModuleModel) => {
        if (mod.name === module.name) {
            switch (mod.state) {
                case 'upgrade':
                    mod.state = 'none';
                    break;
                case 'install':
                    mod.state = 'upgrade';
                    break;
                default:
                    mod.state = 'install';
                    break;
            }
        }
    });
    settings['projects'] = projects;
    await saveToFile(settings);
}
