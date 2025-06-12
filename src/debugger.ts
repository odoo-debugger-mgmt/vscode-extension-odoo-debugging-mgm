import * as vscode from "vscode";
import { ProjectModel } from "./models/project";
import { SettingsModel } from "./models/settings";
import { saveToFile, readFromFile} from './common';
import * as path from 'path';


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
            "python": `${workspaceSettings.pythonPath}`,
            "console": "integratedTerminal",
            "args": [
                ...prepareArgs(project, workspaceSettings),
            ]
        };
        configurations.unshift(newOdooConfig);
    }else {
        newOdooConfig = {
            ...odooConfig,
            "cwd": workspacePath,
            "program": `${workspaceSettings.odooPath}/odoo-bin`,
            "python": `${workspaceSettings.pythonPath}`,
            "args": [
                ...prepareArgs(project, workspaceSettings),
            ]
        };
        configurations[configurations.indexOf(odooConfig)] = newOdooConfig;
    }
    saveToFile(launchJsonFile, "launch.json");
}

function prepareArgs(project: ProjectModel, settings: SettingsModel, isShell=false ): any{
    let addonsPath = `--addons-path=` + [
        './enterprise',
        './odoo/odoo/addons',
        './odoo/addons',
        ...project.repos.map(repo => repo.path)
    ].join(',');
    if (settings.subModulesPaths !== '') {
        addonsPath += `,${settings.subModulesPaths}`;
    }
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
    let upgrades: any[] = db?.modules.filter((module: any) => {
        return module.state === "upgrade";
    }
    ).map((module: any) => {
        return module.name;
    }
    ) || [];
    let args: any[] = [];
    if (isShell) { args.push(`shell`); args.push('-p', settings.shellPortNumber.toString());}
    else{args.push('-p', settings.portNumber.toString());}
    args.push(addonsPath);
    args.push("-d", db.id);
    if (installs.length > 0) { args.push("-i", `${installs.join(',')}`); }
    if (upgrades.length > 0) { args.push("-u", `${upgrades.join(',')}`); }
    args.push('--limit-time-real', settings.limitTimeReal.toString());
    args.push('--limit-time-cpu', settings.limitTimeCpu.toString());
    args.push('--max-cron-threads', settings.maxCronThreads.toString());

    if (settings.isTestingEnabled) {
        args.push(`--test-enable`);
        if (settings.testFile) {args.push(`--test-file=${settings.testFile}`);}
        if (settings.testTags) {args.push(`--test-tags=${settings.testTags}`);}
    }
    if(settings.extraParams){args.push(...settings.extraParams.split(","));};
    if(settings.devMode){args.push(settings.devMode);};
    return args;

}

export async function startDebugShell(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage("No workspace open.");
        return;
    }
    let settings = await readFromFile('odoo-debugger-data.json');
    if (!settings) {
        vscode.window.showErrorMessage('Error reading settings');
        return;
    }
    let workspaceSettings = settings['settings'];

    let projects = settings['projects'];

    let project = projects.find((project: ProjectModel) => project.isSelected === true);
    if (!project) {
        vscode.window.showErrorMessage('No project selected');
        return;
    }
    const args = prepareArgs(project, workspaceSettings, true);
    const odooBinPath = `${workspaceSettings.odooPath}/odoo-bin`;
    const pythonPath = workspaceSettings.pythonPath;
    const cwd = workspaceFolders[0].uri.fsPath;

    const fullCommand = `${pythonPath} ${odooBinPath} ${args.join(' ')}`;
    const terminal = vscode.window.createTerminal({
        name: 'Odoo Shell',
        cwd: cwd,
        isTransient: true
    });
    terminal.show();
    terminal.sendText(fullCommand);
}

export async function startDebugServer(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage("No workspace open.");
        return;
    }
    let settings = await readFromFile('odoo-debugger-data.json');
    if (!settings) {
        vscode.window.showErrorMessage('Error reading settings');
        return;
    }
    let workspaceSettings = settings['settings'];
    const existingSession = vscode.debug.activeDebugSession;
    if (existingSession) {
        await vscode.debug.stopDebugging(existingSession);
    }
    vscode.debug.startDebugging(
        workspaceFolders[0],
        workspaceSettings.debuggerName
    );
}
