import * as vscode from "vscode";
import * as fs from 'fs';
import * as path from 'node:path';
import { ProjectModel } from "./models/project";
import { SettingsModel } from "./models/settings";
import { InstalledModuleInfo } from "./models/module";
import { getWorkspacePath, normalizePath, showError, showInfo, showAutoInfo, discoverModulesInRepos } from './utils';
import { SettingsStore } from './settingsStore';
import { VersionsService } from './versionsService';
import { ensureTestingConfigModel } from './models/testing';
import { getInstalledModules, databaseHasModuleTable } from './services/database';
import { parse } from 'jsonc-parser';

async function selectPythonInterpreter(pythonPath: string): Promise<void> {
    if (!pythonPath || pythonPath.trim().length === 0) {
        return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return;
    }

    try {
        const pythonExtension = vscode.extensions.getExtension('ms-python.python');
        if (pythonExtension) {
            const pythonApi = pythonExtension.isActive ? pythonExtension.exports : await pythonExtension.activate();
            const updateActive = pythonApi?.environments?.updateActiveEnvironmentPath;
            if (typeof updateActive === 'function') {
                await updateActive(pythonPath);
                return;
            }
        }

        const config = vscode.workspace.getConfiguration('python', workspaceFolder.uri);
        await Promise.all([
            config.update('defaultInterpreterPath', pythonPath, vscode.ConfigurationTarget.Workspace),
            config.update('pythonPath', pythonPath, vscode.ConfigurationTarget.Workspace)
        ]);
    } catch (error) {
        console.warn(`Failed to set Python interpreter to "${pythonPath}":`, error);
    }
}

function readLaunchData(workspacePath: string, debuggerName: string): { launchPath: string; launchData: any; configurations: any[]; existingIndex: number } {
    const vscodeDir = path.join(workspacePath, '.vscode');
    const launchPath = path.join(vscodeDir, 'launch.json');

    fs.mkdirSync(vscodeDir, { recursive: true });

    let content: string;
    if (fs.existsSync(launchPath)) {
        content = fs.readFileSync(launchPath, 'utf8');
    } else {
        content = JSON.stringify({ version: '0.2.0', configurations: [] }, null, 2) + '\n';
        fs.writeFileSync(launchPath, content, 'utf8');
    }

    let launchData = parse(content);
    if (!launchData || typeof launchData !== 'object') {
        launchData = { version: '0.2.0', configurations: [] };
    }

    const configurations = Array.isArray(launchData.configurations) ? [...launchData.configurations] : [];
    const existingIndex = configurations.findIndex(conf => conf?.name === debuggerName);
    return { launchPath, launchData, configurations, existingIndex };
}


export async function setupDebugger(): Promise<any> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
        return undefined;
    }
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return undefined;
    }
    const { project } = result;
    // Get settings from active version instead of legacy settings
    const versionsService = VersionsService.getInstance();
    const settings = await versionsService.getActiveVersionSettings();
    // Normalize paths to handle absolute vs relative
    const normalizedOdooPath = normalizePath(settings.odooPath);
    const normalizedPythonPath = normalizePath(settings.pythonPath);
    let args: string[];
    try {
        args = await prepareArgs(project, settings);
    } catch (error) {
        console.warn('Could not prepare debugger launch arguments:', error);
        if (error instanceof Error) {
            if (error.message === 'Select a database before running this action.') {
                showInfo('Select a database before configuring the debugger.');
            } else {
                showError(error.message);
            }
        } else {
            showError('Could not prepare debugger launch arguments.');
        }
        return undefined;
    }

    const { launchPath, launchData, configurations, existingIndex } = readLaunchData(workspacePath, settings.debuggerName);
    const existingConfig = existingIndex >= 0 ? configurations[existingIndex] : undefined;

    const newOdooConfig = {
        ...existingConfig,
        name: settings.debuggerName,
        type: "debugpy",
        request: "launch",
        cwd: workspacePath,
        program: `${normalizedOdooPath}/odoo-bin`,
        python: normalizedPythonPath,
        console: "integratedTerminal",
        args
    };

    if (existingIndex >= 0) {
        configurations.splice(existingIndex, 1);
    }
    configurations.unshift(newOdooConfig);
    launchData.version = launchData.version ?? '0.2.0';
    launchData.configurations = configurations;

    try {
        fs.writeFileSync(launchPath, JSON.stringify(launchData, null, 2) + '\n', 'utf8');
    } catch (error) {
        showError(`Unable to update launch.json: ${error}`);
    }

    await selectPythonInterpreter(settings.pythonPath);

    return newOdooConfig;
}

async function prepareArgs(project: ProjectModel, settings: SettingsModel, isShell = false): Promise<string[]> {
    // Build addons path using settings paths
    const addonsPaths: string[] = [];
    const addonPathSet = new Set<string>();

    const addAddonPath = (rawPath: string | undefined) => {
        if (!rawPath) {
            return;
        }
        const normalized = normalizePath(rawPath);
        const resolved = path.resolve(normalized);
        if (addonPathSet.has(resolved)) {
            return;
        }
        addonPathSet.add(resolved);
        addonsPaths.push(normalized);
    };

    // Add enterprise path if it exists
    if (settings.enterprisePath) {
        addAddonPath(settings.enterprisePath);
    }

    // Add design-themes path if it exists
    if (settings.designThemesPath) {
        addAddonPath(settings.designThemesPath);
    }

    // Add Odoo core addons paths
    if (settings.odooPath) {
        addAddonPath(`${settings.odooPath}/odoo/addons`);
        addAddonPath(`${settings.odooPath}/addons`);
    }

    const db = project.dbs.find(database => database.isSelected);
    if (!db) {
        throw new Error('Select a database before running this action.');
    }
    const projectModules = db.modules ?? [];

    // Auto-detect ps*-internal paths needed based on selected modules
    const psInternalPaths = new Set<string>();
    const manualIncludes = new Set<string>();
    const manualExcludes = new Set<string>();

    for (const entry of project.includedPsaeInternalPaths ?? []) {
        if (entry.startsWith('!')) {
            manualExcludes.add(normalizePath(entry.substring(1)));
        } else {
            const normalized = normalizePath(entry);
            manualIncludes.add(normalized);
            psInternalPaths.add(normalized);
        }
    }

    const manualPsaeIncludes = (project.includedPsaeInternalPaths ?? []).filter(entry => !entry.startsWith('!'));
    const discovery = discoverModulesInRepos(project.repos, { manualIncludePaths: manualPsaeIncludes });

    const containerPathMap = new Map<string, string>();

    const recordContainerPath = (rawContainerPath: string) => {
        const normalized = normalizePath(rawContainerPath);
        const resolved = path.resolve(normalized);
        if (!containerPathMap.has(resolved)) {
            containerPathMap.set(resolved, normalized);
        }
    };

    for (const moduleInfo of discovery.modules) {
        const resolvedModulePath = path.resolve(moduleInfo.path);
        const resolvedRepoPath = path.resolve(moduleInfo.repoPath);
        if (resolvedModulePath === resolvedRepoPath) {
            recordContainerPath(moduleInfo.path);
        } else {
            recordContainerPath(path.dirname(moduleInfo.path));
        }
    }

    for (const containerPath of containerPathMap.values()) {
        addAddonPath(containerPath);
    }

    const foundPsInternalDirs = new Map<string, string[]>(); // path -> modules

    for (const dir of discovery.psaeDirectories) {
        foundPsInternalDirs.set(normalizePath(dir.path), dir.moduleNames);
    }

    const selectedModuleNames = new Set(
        projectModules
            .filter(module => module.state === 'install' || module.state === 'upgrade')
            .map(module => module.name)
    );

    let installedModuleNames: Set<string> = new Set();
    try {
        const installedModules = await getInstalledModules(db.id);
        installedModuleNames = new Set(installedModules.map((m: InstalledModuleInfo) => m.name));
    } catch (error) {
        console.warn('Failed to get installed modules from database:', error);
    }

    for (const [psPath, psModules] of foundPsInternalDirs.entries()) {
        if (manualExcludes.has(psPath)) {
            continue;
        }

        const isManuallyIncluded = manualIncludes.has(psPath);
        const hasSelectedModules = psModules.some(psModule => selectedModuleNames.has(psModule));
        const hasDbModules = psModules.some(psModule => installedModuleNames.has(psModule));

        if (isManuallyIncluded || hasSelectedModules || hasDbModules) {
            psInternalPaths.add(psPath);
        }
    }

    // Add auto-detected ps*-internal paths to addons paths
    if (psInternalPaths.size > 0) {
        for (const psPath of psInternalPaths) {
            addAddonPath(psPath);
        }
    }

    // Add global submodules paths from settings (for backward compatibility)
    if (settings.subModulesPaths) {
        const normalizedSubModulePaths = settings.subModulesPaths
            .split(',')
            .map(p => p.trim())
            .filter(Boolean)
            .map(p => normalizePath(p));
        for (const subModulePath of normalizedSubModulePaths) {
            addAddonPath(subModulePath);
        }
    }

    let installs = projectModules
        .filter(module => module.state === 'install')
        .map(module => module.name);
    const upgrades = projectModules
        .filter(module => module.state === 'upgrade')
        .map(module => module.name);

    if (installs.length === 0) {
        try {
            const hasModuleTable = await databaseHasModuleTable(db.id);
            if (!hasModuleTable) {
                installs = ['base'];
                showAutoInfo('Added "base" during initialization so the new database can install core tables.', 3000);
            }
        } catch (error) {
            console.warn('Failed to verify module table state:', error);
        }
    }
    const args: string[] = [];
    if (isShell) {
        args.push('shell', '-p', settings.shellPortNumber.toString());
    } else {
        args.push('-p', settings.portNumber.toString());
    }

    args.push(
        '--addons-path', addonsPaths.join(','),
        '-d', db.id
    );

    if (installs.length > 0 || settings.installApps) {
        const installParts = [installs.join(','), settings.installApps]
            .map(part => part?.trim())
            .filter(part => part && part.length > 0);
        if (installParts.length > 0) {
            args.push('-i', installParts.join(','));
        }
    }

    if (upgrades.length > 0 || settings.upgradeApps) {
        const upgradeParts = [upgrades.join(','), settings.upgradeApps]
            .map(part => part?.trim())
            .filter(part => part && part.length > 0);
        if (upgradeParts.length > 0) {
            args.push('-u', upgradeParts.join(','));
        }
    }
    args.push(
        '--limit-time-real', settings.limitTimeReal.toString(),
        '--limit-time-cpu', settings.limitTimeCpu.toString(),
        '--max-cron-threads', settings.maxCronThreads.toString()
    );

    // Use new testing system from project configuration
    if (project.testingConfig?.isEnabled) {
        args.push('--test-enable');

        // Ensure testingConfig is a proper TestingConfigModel instance
        const testingConfig = ensureTestingConfigModel(project.testingConfig);

        if (testingConfig.testFile) {
            args.push('--test-file', testingConfig.testFile);
        }

        const tagsString = testingConfig.getTestTagsString();
        if (tagsString) {
            args.push('--test-tags', tagsString);
        }

        if (testingConfig.stopAfterInit) {
            args.push('--stop-after-init');
        }

        if (testingConfig.logLevel && testingConfig.logLevel !== 'disabled') {
            args.push('--log-level', testingConfig.logLevel);
        }
    }

    if (settings.extraParams) {
        const extraArgs = settings.extraParams
            .split(',')
            .map(param => param.trim())
            .filter(Boolean);
        args.push(...extraArgs);
    }
    if (settings.devMode) {
        args.push(settings.devMode);
    }
    return args;

}

export async function startDebugShell(): Promise<void> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
        return undefined;
    }
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return undefined;
    }
    const { project } = result;
    // Get settings from active version instead of legacy settings
    const versionsService = VersionsService.getInstance();
    const workspaceSettings = await versionsService.getActiveVersionSettings();
    // Normalize paths for terminal commands
    const normalizedOdooPath = normalizePath(workspaceSettings.odooPath);
    const normalizedPythonPath = normalizePath(workspaceSettings.pythonPath);

    let args: string[];
    try {
        args = await prepareArgs(project, workspaceSettings, true);
    } catch (error) {
        if (error instanceof Error) {
            if (error.message === 'Select a database before running this action.') {
                showInfo('Select a database before opening the Odoo shell.');
            } else {
                showError(error.message);
            }
        } else {
            showError('Could not prepare shell arguments.');
        }
        return undefined;
    }
    const odooBinPath = `${normalizedOdooPath}/odoo-bin`;

    const fullCommand = [
        quoteShellArg(normalizedPythonPath),
        quoteShellArg(odooBinPath),
        ...args.map(quoteShellArg)
    ].join(' ');
    const terminal = vscode.window.createTerminal({
        name: 'Odoo Shell',
        cwd: workspacePath,
        isTransient: true
    });
    terminal.show();
    terminal.sendText(fullCommand);
}

function quoteShellArg(value: string): string {
    if (/^[\w@%+=:,./-]+$/.test(value)) {
        return value;
    }
    const escapedValue = value.replaceAll("'", String.raw`'\''`);
    return `'${escapedValue}'`;
}

export async function startDebugServer(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        showError("Open a workspace to use this command.");
        return undefined;
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
