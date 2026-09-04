/**
 * Debugger integration: keeps the managed launch.json entry in sync with the
 * active version/database/module selections, builds odoo-bin arguments
 * (addons path, -i/-u, testing flags), and starts/stops the server and shell.
 */
import * as vscode from "vscode";
import * as path from 'node:path';
import { ProjectModel } from "./models/project";
import { SettingsModel } from "./models/settings";
import { getWorkspacePath, normalizePath, resolveOptionalPath, showError, showInfo, showWarning, showAutoInfo } from './utils';
import { collectModuleDiscovery, resolvePsaeDirectories } from './services/psaeInternal';
import { SettingsStore } from './settingsStore';
import { VersionsService } from './versionsService';
import { ensureTestingConfigModel } from './models/testing';
import { getInstalledModuleNames, databaseHasModuleTable } from './services/database';
import { logger, errorMessage } from './services/logger';
import { updateManagedLaunchConfig } from './services/launchConfig';
import { getSessionByName, runningDebuggerNames, resolveStopTarget } from './services/debugSessions';
import { resolveDbForVersion } from './services/dbResolution';
import { isVersionProvisioned } from './services/provisioning';
import { resolveProjectRepos } from './services/repoPaths';
import { ensureCustomWorktrees } from './services/customWorktree';
import { readSetupState } from './services/setupState';
import { resolveProjectRepoBranchAssignments } from './services/environment';
import { provisionExistingVersion } from './odooInstaller';

// Databases we already told the user about; prepareArgs re-runs on every
// debounced sync, so without this the toast repeats until the DB is initialized.
const baseInstallNotifiedDbs = new Set<string>();

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
        logger.warn(`Failed to set Python interpreter to "${pythonPath}":`, error);
    }
}

export async function setupDebugger(): Promise<any> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
        return undefined;
    }
    // Silent: this runs from every refresh, and an install with no projects
    // yet must not be told to create one by a sync it did not request.
    const result = await SettingsStore.peekSelectedProject();
    if (!result) {
        return undefined;
    }
    const { project } = result;

    const versionsService = VersionsService.getInstance();
    await versionsService.initialize();
    const activeVersion = versionsService.getActiveVersion();
    const activeSettings = await versionsService.getActiveVersionSettings();

    // One entry per provisioned version, each with its own name, ports and
    // database: launch.json accumulates durable entries instead of one being
    // renamed out from under the Run and Debug dropdown, and two versions can
    // run at once. Unprovisioned versions have no interpreter to launch.
    const targets = versionsService.getVersions()
        .filter(version => isVersionProvisioned(resolveOptionalPath(version.settings.pythonPath)));
    if (activeVersion && !targets.some(version => version.id === activeVersion.id)) {
        targets.push(activeVersion);
    }

    // Worktrees are created once per sync rather than per launch entry: the
    // same branch is often shared by several versions.
    const setupRoot = readSetupState().provisioningRoot;
    const worktreeProblems = new Set<string>();
    const worktreesNeedingResolution = new Set<string>();

    let activeConfig: unknown;

    for (const version of targets) {
        const settings = version.settings;
        const normalizedOdooPath = normalizePath(settings.odooPath);
        const normalizedPythonPath = normalizePath(settings.pythonPath);

        const versionDb = resolveDbForVersion(project.dbs, project.selectedDbByVersion, version.id);
        if (versionDb) {
            // Non-interactive on purpose: this sync runs on a debounce after
            // almost every command, so it creates the worktrees that need no
            // arbitration and reports the rest instead of raising a modal.
            const { problems, needsResolution } = await ensureCustomWorktrees(
                resolveProjectRepos(
                    project.repos ?? [],
                    resolveProjectRepoBranchAssignments(versionDb, project.repos ?? []),
                    setupRoot
                ),
                undefined,
                { interactive: false }
            );
            problems.forEach(problem => worktreeProblems.add(problem));
            needsResolution.forEach(name => worktreesNeedingResolution.add(name));
        }

        let args: string[];
        try {
            args = await prepareArgs(project, settings as SettingsModel, { versionId: version.id });
        } catch (error) {
            // A version with no resolvable database is skipped rather than
            // failing the sync for every other version. Only the active one is
            // worth telling the user about.
            if (version.id === activeVersion?.id) {
                logger.warn('Could not prepare debugger launch arguments:', error);
                if (error instanceof Error && error.message === 'Select a database before running this action.') {
                    void showInfo('Select a database before configuring the debugger.');
                } else {
                    void showError(error instanceof Error ? error.message : 'Could not prepare debugger launch arguments.');
                }
            } else {
                logger.debug(`Skipping launch entry for "${version.name}": ${errorMessage(error)}`);
            }
            continue;
        }

        try {
            // Only the extension's own entries in launch.json are rewritten;
            // user comments and other configurations are preserved.
            const config = await updateManagedLaunchConfig(workspacePath, {
                name: settings.debuggerName,
                type: 'debugpy',
                request: 'launch',
                cwd: workspacePath,
                program: `${normalizedOdooPath}/odoo-bin`,
                python: normalizedPythonPath,
                console: 'integratedTerminal',
                args
            });
            if (version.id === activeVersion?.id) {
                activeConfig = config;
            }
        } catch (error) {
            void showError(`Unable to update launch.json: ${errorMessage(error)}`);
            return undefined;
        }
    }

    if (worktreeProblems.size > 0) {
        const names = Array.from(worktreesNeedingResolution);
        if (names.length > 0) {
            // Offered, not forced: freeing the branch edits a checkout the
            // user owns, so it happens inside a command they started.
            void showWarning(
                `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} using the source checkout: `
                + 'the branch each needs is checked out there.',
                'Resolve'
            ).then(choice => {
                if (choice === 'Resolve') {
                    void vscode.commands.executeCommand('odt.repo.resolveWorktrees');
                }
            });
        } else {
            void showWarning(`Some repositories fell back to their source checkout — ${Array.from(worktreeProblems).join('; ')}`);
        }
    }

    await selectPythonInterpreter(activeSettings.pythonPath);

    return activeConfig;
}

async function prepareArgs(
    project: ProjectModel,
    settings: SettingsModel,
    options: { isShell?: boolean; versionId?: string } = {}
): Promise<string[]> {
    const isShell = options.isShell === true;

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

    const db = resolveDbForVersion(project.dbs, project.selectedDbByVersion, options.versionId);
    if (!db) {
        throw new Error('Select a database before running this action.');
    }
    const projectModules = db.modules ?? [];

    // psae-internal directories: resolved through the shared service so the
    // Modules tree and the launch args always agree on what is included.
    // Resolve every project repo to the directory this version runs from, so
    // two versions on different branches never share one copy of the code.
    const resolvedRepos = resolveProjectRepos(
        project.repos ?? [],
        resolveProjectRepoBranchAssignments(db, project.repos ?? []),
        readSetupState().provisioningRoot
    );
    const discovery = collectModuleDiscovery(project, resolvedRepos);

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

    const selectedModuleNames = new Set(
        projectModules
            .filter(module => module.state === 'install' || module.state === 'upgrade')
            .map(module => module.name)
    );

    let installedModuleNames: Set<string> = new Set();
    try {
        installedModuleNames = await getInstalledModuleNames(db.id);
    } catch (error) {
        logger.warn('Failed to get installed modules from database:', error);
    }

    const psaeStates = resolvePsaeDirectories({
        psaeDirectories: discovery.psaeDirectories,
        includedPsaeInternalPaths: project.includedPsaeInternalPaths,
        selectedModuleNames,
        installedModuleNames
    });
    for (const psaeState of psaeStates) {
        if (psaeState.isIncluded) {
            addAddonPath(psaeState.path);
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
                if (!baseInstallNotifiedDbs.has(db.id)) {
                    baseInstallNotifiedDbs.add(db.id);
                    showAutoInfo('Added "base" during initialization so the new database can install core tables.', 3000);
                }
            }
        } catch (error) {
            logger.warn('Failed to verify module table state:', error);
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

/**
 * Assembles the full `python odoo-bin …` command line for the selected
 * project's active version, quoted for a POSIX shell — the same command
 * the debugger runs (server) or the shell terminal sends (`isShell`).
 * Returns undefined after surfacing the reason when prerequisites are
 * missing.
 */
export async function buildOdooCommandLine(isShell = false): Promise<string | undefined> {
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return undefined;
    }
    const { project } = result;
    const versionsService = VersionsService.getInstance();
    const workspaceSettings = await versionsService.getActiveVersionSettings();
    const normalizedOdooPath = normalizePath(workspaceSettings.odooPath);
    const normalizedPythonPath = normalizePath(workspaceSettings.pythonPath);

    let args: string[];
    try {
        args = await prepareArgs(project, workspaceSettings, {
            isShell,
            versionId: versionsService.getActiveVersion()?.id
        });
    } catch (error) {
        if (error instanceof Error) {
            if (error.message === 'Select a database before running this action.') {
                void showInfo('Select a database first.');
            } else {
                void showError(error.message);
            }
        } else {
            void showError('Could not prepare the Odoo command.');
        }
        return undefined;
    }
    const odooBinPath = `${normalizedOdooPath}/odoo-bin`;

    return [
        quoteShellArg(normalizedPythonPath),
        quoteShellArg(odooBinPath),
        ...args.map(quoteShellArg)
    ].join(' ');
}

export async function startDebugShell(): Promise<void> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
        return undefined;
    }
    const fullCommand = await buildOdooCommandLine(true);
    if (!fullCommand) {
        return undefined;
    }
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

/** Stops one of the extension's running sessions, asking only when ambiguous. */
export async function stopDebugServer(): Promise<void> {
    const settings = await VersionsService.getInstance().getActiveVersionSettings();
    const target = resolveStopTarget(runningDebuggerNames(), settings.debuggerName);

    if (target.kind === 'none') {
        void showInfo('No Odoo debug session is currently running.');
        return;
    }

    let name: string;
    if (target.kind === 'single') {
        name = target.name;
    } else {
        const picked = await vscode.window.showQuickPick(target.names, {
            title: 'Stop which Odoo server?',
            placeHolder: 'Several versions are running'
        });
        if (!picked) {
            return;
        }
        name = picked;
    }

    const session = getSessionByName(name);
    if (!session) {
        void showInfo('No Odoo debug session is currently running.');
        return;
    }
    await vscode.debug.stopDebugging(session);
}

export async function startDebugServer(options: { noDebug?: boolean } = {}): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        void showError("Open a workspace to use this command.");
        return undefined;
    }
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    // Get settings from active version instead of legacy settings
    const versionsService = VersionsService.getInstance();
    const workspaceSettings = await versionsService.getActiveVersionSettings();
    const activeVersion = versionsService.getActiveVersion();

    // Handing an unprovisioned version to vscode.debug produces its generic
    // "configuration not found" error, which says nothing about the cause.
    if (!isVersionProvisioned(resolveOptionalPath(workspaceSettings.pythonPath))) {
        const choice = await showError(
            `"${activeVersion?.name ?? 'This version'}" has no environment to run.`,
            'Provision'
        );
        if (choice === 'Provision' && activeVersion) {
            await provisionExistingVersion(activeVersion.id);
        }
        return;
    }

    const db = activeVersion
        ? resolveDbForVersion(result.project.dbs, result.project.selectedDbByVersion, activeVersion.id)
        : undefined;
    if (!db) {
        const choice = await showError('No database is selected for this version.', 'Select Database');
        if (choice === 'Select Database') {
            await vscode.commands.executeCommand('dbSelector.quickSearch');
        }
        return;
    }

    // Restarting this version stops only this version's session; other
    // versions running side by side must survive.
    const existingSession = getSessionByName(workspaceSettings.debuggerName);
    if (existingSession) {
        await vscode.debug.stopDebugging(existingSession);
    }
    const started = await vscode.debug.startDebugging(
        workspaceFolders[0],
        workspaceSettings.debuggerName,
        { noDebug: options.noDebug === true }
    );
    if (!started) {
        void showError(`Could not start "${workspaceSettings.debuggerName}". Its launch entry may not be written yet.`);
    }
}
