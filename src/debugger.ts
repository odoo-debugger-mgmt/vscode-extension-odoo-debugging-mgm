import * as vscode from "vscode";
import { ProjectModel } from "./models/project";
import { SettingsModel } from "./models/settings";
import { saveToFileWithComments, , getWorkspacePath, normalizePath} from './utils';
import { SettingsStore } from './settingsStore';


export async function setupDebugger(): Promise<void> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
        return;
    }
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    const settings = data.settings;
    // Normalize paths to handle absolute vs relative
    const normalizedOdooPath = normalizePath(settings.odooPath);
    const normalizedPythonPath = normalizePath(settings.pythonPath);
    let launchJsonFile: any = SettingsStore.get('launch.json');
    if (!launchJsonFile) {
        vscode.window.showErrorMessage('Error reading launch.json');
        return;
    }
    let configurations: Object[] = launchJsonFile?.configurations;
    let odooConfig = configurations.find((config: any) => config.name === settings.debuggerName);

    let newOdooConfig: {};
    if (!odooConfig) {
        newOdooConfig = {
            "name": settings.debuggerName,
            "type": "debugpy",
            "request": "launch",
            "cwd": workspacePath,
            "program": `${normalizedOdooPath}/odoo-bin`,
            "python": normalizedPythonPath,
            "console": "integratedTerminal",
            "args": [
                ...prepareArgs(project, settings),
            ]
        };
        await SettingsStore.save(
            newOdooConfig, ["configurations", 0], "launch.json", { isArrayInsertion: true, formattingOptions: { insertSpaces: true, tabSize: 2 } }
        );
    } else {
        newOdooConfig = {
            ...odooConfig,
            "cwd": workspacePath,
            "program": `${normalizedOdooPath}/odoo-bin`,
            "python": normalizedPythonPath,
            "args": [
                ...prepareArgs(project, settings),
            ]
        };
        await SettingsStore.save(
            newOdooConfig, ["configurations", configurations.indexOf(odooConfig)], "launch.json", {formattingOptions: { insertSpaces: true, tabSize: 2 } }
        );
    }
}

function prepareArgs(project: ProjectModel, settings: SettingsModel, isShell=false ): any{
    // Normalize the paths for addons
    const normalizedRepoPaths = project.repos.map(repo => normalizePath(repo.path));
    let addonsPath = `--addons-path=` + [
        './enterprise',
        './odoo/odoo/addons',
        './odoo/addons',
        ...normalizedRepoPaths
    ].join(',');
    if (settings.subModulesPaths !== '') {
        const normalizedSubModulePaths = settings.subModulesPaths
            .split(',')
            .map(p => normalizePath(p.trim()))
            .join(',');
        addonsPath += `,${normalizedSubModulePaths}`;
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
    if (installs.length > 0 || settings.installApps !== "") {
        args.push("-i", `${installs.join(',')}${settings.installApps ? "," : ""}${settings.installApps ? settings.installApps : ""}`);
    }
    if (upgrades.length > 0) {
        args.push("-u", `${upgrades.join(',')}${settings.upgradeApps ? "," : ""}${settings.upgradeApps ? settings.upgradeApps : ""}`);
    }
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
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
        return;
    }
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    const workspaceSettings = data.settings;
    // Normalize paths for terminal commands
    const normalizedOdooPath = normalizePath(workspaceSettings.odooPath);
    const normalizedPythonPath = normalizePath(workspaceSettings.pythonPath);

    const args = prepareArgs(project, workspaceSettings, true);
    const odooBinPath = `${normalizedOdooPath}/odoo-bin`;

    const fullCommand = `${normalizedPythonPath} ${odooBinPath} ${args.join(' ')}`;
    const terminal = vscode.window.createTerminal({
        name: 'Odoo Shell',
        cwd: workspacePath,
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
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data } = result;
    const workspaceSettings = data.settings;
    const existingSession = vscode.debug.activeDebugSession;
    if (existingSession) {
        await vscode.debug.stopDebugging(existingSession);
    }
    vscode.debug.startDebugging(
        workspaceFolders[0],
        workspaceSettings.debuggerName
    );
}
