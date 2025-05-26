import * as vscode from "vscode";
import { ProjectModel } from "./models/project";
import { SettingsModel } from "./models/settings";
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
    let settings = await readFromFile('odoo-debugger-data.json');
    let launchJsonFile = await readFromFile('launch.json');
    if (!settings) {
        vscode.window.showErrorMessage('Error reading settings');
        return;
    }
    if (!launchJsonFile) {
        vscode.window.showErrorMessage('Error reading launch.json');
        return;
    }
    let projects = settings['projects'];
    let workspaceSettings = settings['settings'];

    let project = projects.find((project: ProjectModel) => project.isSelected === true);
    if (!project) {
        vscode.window.showErrorMessage('No project selected');
        return;
    }
    let configurations: Object[] = launchJsonFile?.configurations;
    let odooConfig = configurations.find((config: any) => config.name === workspaceSettings.debuggerName);
    let newOdooConfig: {};
    if (!odooConfig) {
        newOdooConfig = {
            "name": workspaceSettings.debuggerName,
            "type": "debugpy",
            "request": "launch",
            "cwd": workspacePath,
            "program": `${workspaceSettings.odooPath}/odoo-bin`,
            "python": `${workspaceSettings.python}`,
            "console": "integratedTerminal",
            "args": [
                ...prepareArgs(project, workspacePath, settings),
            ]
        };
        configurations.unshift(newOdooConfig);
    }else {
        newOdooConfig = {
            ...odooConfig,
            "cwd": workspacePath,
            "program": `${workspaceSettings.odooPath}/odoo-bin`,
            "python": `${workspaceSettings.python}`,
            "args": [
                ...prepareArgs(project, workspacePath, settings),
            ]
        };
        configurations[configurations.indexOf(odooConfig)] = newOdooConfig;
    }
    saveToFile(launchJsonFile, "launch.json");

}

function prepareArgs(project: ProjectModel, workspacePath: string, settings: SettingsModel, isShell=false ): any{
    let addonsPath = `--addons-path=` + [
        '../enterprise',
        '../odoo/odoo/addons',
        '../odoo/addons',
        ...project.repos.map(repo => repo.path)
    ].join(',');
    let db = project.dbs.find((db) => db.isSelected);
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
    let to_install = installs? `-i ${installs.join(',')}` : '';
    let upgrades: any[] = db?.modules.filter((module: any) => {
        return module.state === "upgrade";
    }
    ).map((module: any) => {
        return module.name;
    }
    ) || [];
    let to_upgrade = upgrades.length > 0 ?`-u ${upgrades.join(',')}` : '';
    let args: any[] = [
        addonsPath,
        `-d ${db.id}`,
        to_install,
        to_upgrade,
        `--limit-time-real ${settings.limitTimeReal}`,
        `--limit-time-cpu ${settings.limitTimeCpu}`,
        `--max-cron-threads ${settings.maxCronThreads}`
    ];
    if (isShell) { args.push(`shell`); args.push(`-p ${settings.shellPortNumber}`);}
    else{args.push(`-p ${settings.portNumber}`);}
    if (settings.isTestingEnabled) {
        args.push(`--test-enable`);
        if (settings.testFile) {args.push(`--test-file=${settings.testFile}`);}
        if (settings.testTags) {args.push(`--test-tags=${settings.testTags}`);}
    }
    if(settings.extraParams){args.push(settings.extraParams)}
    if(settings.devMode){args.push(settings.devMode)}
    return args;

}
