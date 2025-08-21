import * as vscode from "vscode";
import * as fs from 'fs';
import { execSync } from 'child_process';
import { ProjectModel } from "./models/project";
import { SettingsModel } from "./models/settings";
import { InstalledModuleInfo } from "./models/module";
import { getWorkspacePath, normalizePath, showError, showInfo, listSubdirectories } from './utils';
import { SettingsStore } from './settingsStore';
import { VersionsService } from './versionsService';


export async function setupDebugger(): Promise<void> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
        return;
    }
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { project } = result;
    // Get settings from active version instead of legacy settings
    const versionsService = VersionsService.getInstance();
    const settings = await versionsService.getActiveVersionSettings();
    // Normalize paths to handle absolute vs relative
    const normalizedOdooPath = normalizePath(settings.odooPath);
    const normalizedPythonPath = normalizePath(settings.pythonPath);
    const launchData: any = await SettingsStore.get('launch.json');
    if (!launchData) {
        showError('Error reading launch.json');
        return;
    }
    let configurations: Object[] = launchData.configurations;
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
                ...(await prepareArgs(project, settings)),
            ]
        };
        await SettingsStore.saveWithComments(
            newOdooConfig, ["configurations", 0], "launch.json", { isArrayInsertion: true, formattingOptions: { insertSpaces: true, tabSize: 2 } }
        );
    } else {
        newOdooConfig = {
            ...odooConfig,
            "cwd": workspacePath,
            "program": `${normalizedOdooPath}/odoo-bin`,
            "python": normalizedPythonPath,
            "args": [
                ...(await prepareArgs(project, settings)),
            ]
        };
        await SettingsStore.saveWithComments(
            newOdooConfig, ["configurations", configurations.indexOf(odooConfig)], "launch.json", {formattingOptions: { insertSpaces: true, tabSize: 2 } }
        );
    }
}

async function getInstalledModules(dbName: string): Promise<InstalledModuleInfo[]> {
    try {
        const query = `SELECT id, name, shortdesc, latest_version, state, application FROM ir_module_module WHERE state IN ('installed','to upgrade') ORDER BY name;`;
        const command = `psql ${dbName} -t -A -F'|' -c "${query}"`;

        const output = execSync(command, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const lines = output.trim().split('\n').filter(line => line.trim());
        const installedModules: InstalledModuleInfo[] = [];

        for (const line of lines) {
            const [id, name, shortdesc, latest_version, state, application] = line.split('|');
            installedModules.push({
                id: parseInt(id),
                name,
                shortdesc: shortdesc || '',
                installed_version: latest_version || null,
                latest_version: latest_version || null,
                state,
                application: application === 't'
            });
        }

        return installedModules;
    } catch (error) {
        console.error(`Error getting installed modules for database ${dbName}:`, error);
        return [];
    }
}

async function prepareArgs(project: ProjectModel, settings: SettingsModel, isShell=false ): Promise<any>{
    // Normalize the paths for addons
    const normalizedRepoPaths = project.repos.map(repo => normalizePath(repo.path));

    // Build addons path using settings paths
    const addonsPaths = [];

    // Add enterprise path if it exists
    if (settings.enterprisePath) {
        addonsPaths.push(normalizePath(settings.enterprisePath));
    }

    // Add design-themes path if it exists
    if (settings.designThemesPath) {
        addonsPaths.push(normalizePath(settings.designThemesPath));
    }

    // Add Odoo core addons paths
    if (settings.odooPath) {
        addonsPaths.push(normalizePath(`${settings.odooPath}/odoo/addons`));
        addonsPaths.push(normalizePath(`${settings.odooPath}/addons`));
    }

    // Add repository paths
    addonsPaths.push(...normalizedRepoPaths);

    let db = project.dbs.find((db) => db.isSelected);
    if (!db) {
        showError('No database selected');
        return;
    }

    // Auto-detect ps*-internal paths needed based on selected modules
    const psInternalPaths = new Set<string>();
    const excludedPsInternalPaths = new Set<string>();

    // Process manually included/excluded ps*-internal paths
    for (const path of project.includedPsaeInternalPaths) {
        if (path.startsWith('!')) {
            // This is an excluded path
            const excludedPath = normalizePath(path.substring(1));
            excludedPsInternalPaths.add(excludedPath);
        } else {
            // This is an included path
            const includedPath = normalizePath(path);
            psInternalPaths.add(includedPath);
        }
    }

    // Scan all repos for ps*-internal directories
    const foundPsInternalDirs = new Map<string, string[]>(); // path -> modules

    for (const repo of project.repos) {
        try {
            const repoItems = fs.readdirSync(repo.path);
            for (const item of repoItems) {
                if (/^ps[a-z]*-internal$/i.test(item)) {
                    const psInternalPath = `${repo.path}/${item}`;

                    if (fs.existsSync(psInternalPath) && fs.statSync(psInternalPath).isDirectory()) {
                        try {
                            const psModules = listSubdirectories(psInternalPath);
                            const moduleNames = psModules.map(m => m.name);
                            foundPsInternalDirs.set(normalizePath(psInternalPath), moduleNames);
                        } catch (error) {
                            console.warn(`Failed to read modules from ${psInternalPath}:`, error);
                        }
                    }
                }
            }
        } catch (error) {
            console.warn(`Failed to scan repo ${repo.path}:`, error);
        }
    }

    // Determine which modules to use for ps*-internal detection
    if (!db || !db.modules || db.modules.length === 0) {
        // If no modules in project data, query database directly for installed modules
        try {
            const installedModules = await getInstalledModules(db.id);

            if (installedModules.length > 0) {
                const installedModuleNames = installedModules.map((m: InstalledModuleInfo) => m.name);

                // Check which ps*-internal directories contain installed modules
                for (const [psPath, psModules] of foundPsInternalDirs.entries()) {
                    if (excludedPsInternalPaths.has(psPath)) {
                        continue;
                    }

                    const matchingModules = psModules.filter((psModule: string) => installedModuleNames.includes(psModule));
                    if (matchingModules.length > 0) {
                        psInternalPaths.add(psPath);
                    }
                }
            }

        } catch (error) {
            console.warn('Failed to get installed modules from database:', error);
        }
    } else {
        // Use modules from project data
        const dbModuleNames = db.modules.map(m => m.name);

        for (const [psPath, psModules] of foundPsInternalDirs.entries()) {
            if (excludedPsInternalPaths.has(psPath)) {
                continue;
            }

            const matchingModules = psModules.filter((psModule: string) => dbModuleNames.includes(psModule));
            if (matchingModules.length > 0) {
                psInternalPaths.add(psPath);
            }
        }
    }

    // Add auto-detected ps*-internal paths to addons paths
    if (psInternalPaths.size > 0) {
        addonsPaths.push(...Array.from(psInternalPaths));
    }

    // Add global submodules paths from settings (for backward compatibility)
    if (settings.subModulesPaths !== '') {
        const normalizedSubModulePaths = settings.subModulesPaths
            .split(',')
            .map(p => normalizePath(p.trim()));
        addonsPaths.push(...normalizedSubModulePaths);
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
    if (isShell) { args.push('shell'); args.push('-p', settings.shellPortNumber.toString());}
    else{args.push('-p', settings.portNumber.toString());}
    args.push('--addons-path', addonsPaths.join(','));
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

    // Use new testing system from project configuration
    if (project.testingConfig?.isEnabled) {
        args.push('--test-enable');

        if (project.testingConfig.testFile) {
            args.push('--test-file', project.testingConfig.testFile);
        }

        const activeTags = project.testingConfig.testTags.filter(tag => tag.state !== 'disabled');
        if (activeTags.length > 0) {
            const tagsString = activeTags
                .map(tag => (tag.state === 'exclude' ? '-' : '') + tag.value)
                .join(',');
            args.push('--test-tags', tagsString);
        }

        if (project.testingConfig.stopAfterInit) {
            args.push('--stop-after-init');
        }
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
    const { project } = result;
    // Get settings from active version instead of legacy settings
    const versionsService = VersionsService.getInstance();
    const workspaceSettings = await versionsService.getActiveVersionSettings();
    // Normalize paths for terminal commands
    const normalizedOdooPath = normalizePath(workspaceSettings.odooPath);
    const normalizedPythonPath = normalizePath(workspaceSettings.pythonPath);

    const args = await prepareArgs(project, workspaceSettings, true);
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
        showError("No workspace open.");
        return;
    }
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    // Get settings from active version instead of legacy settings
    const versionsService = VersionsService.getInstance();
    const workspaceSettings = await versionsService.getActiveVersionSettings();
    const existingSession = vscode.debug.activeDebugSession;
    if (existingSession) {
        await vscode.debug.stopDebugging(existingSession);
    }
    vscode.debug.startDebugging(
        workspaceFolders[0],
        workspaceSettings.debuggerName
    );
}
