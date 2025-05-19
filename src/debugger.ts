import * as vscode from "vscode";
import { ProjectModel } from "./models/project";
import { SettingsModel } from "./models/settings";
import { ModuleState } from "./models/module";
import { saveToFile, readFromFile} from './common';

export async function setupDebugger(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    let workspacePath: string;
    if (workspaceFolders && workspaceFolders.length > 0) {
        workspacePath = workspaceFolders[0].uri.fsPath;
    } else {
        vscode.window.showErrorMessage("No workspace open.");
        return;
    }
    let settings = await readFromFile();
    if (!settings) {
        vscode.window.showErrorMessage('Error reading settings');
        return;
    }
    let projects = settings['projects'];
    let workspaceSettings = settings['settings'];

    let project = projects.find((project: ProjectModel) => project.isSelected === true);
    if (!project) {
        vscode.window.showErrorMessage('No project selected');
        return;
    }
    let args = prepareAddonsInstallsUpgrades(project, workspacePath, settings);

}

function prepareAddonsInstallsUpgrades(project: ProjectModel, workspacePath: string, settings: SettingsModel ): any{
    let addonsPath = `--addons-path=../enterprise,../odoo/odoo/addons,../odoo/addons,${project.repoPath}\n`;
    let db = project.dbs.find((db: any) => {db.isSelected === true;});
    if (!db) {
        vscode.window.showErrorMessage('No database selected');
        return;
    }
    let installs = db?.modules.filter((module: any) => {
        return module.state === "install";
    }
    ).map((module: any) => {
        return module.name;
    }) || [];
    let to_install = `-i ${installs.join(',')}`;
    let upgrades = db?.modules.filter((module: any) => {
        return module.state === "upgrade";
    }
    ).map((module: any) => {
        return module.name;
    }
    ) || [];
    let to_upgrade = `-u ${upgrades.join(',')}`;
    let dbName = `-d ${db.name}-${db.createdAt.toISOString().split('T')[0]}`;
    let portNumber = `-p=${settings.portNumber}`;
    Object.entries(settings).forEach(([key, value]) => {
    return [
        dbName,
        to_install,
        to_upgrade,
        // `--limit-time-real ${settings.limitTimeReal}`,
        // settings.limitTimeCpu,
        // settings.devMode,
        // settings.maxCronThreads,
        // settings.isTestingEnabled ? `--test-enable` : ``,
        // settings.isTestingEnabled && settings.testFile ? `--test-file ${settings.testFile}` : ``,
        // settings.isTestingEnabled && settings.testModule ? `--test-module ${settings.testModule}` : ``,

    ]

})}
