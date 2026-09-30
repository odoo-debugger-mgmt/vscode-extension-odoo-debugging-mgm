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
import {
    launchTarget,
    readManagedLaunchConfig,
    removeManagedLaunchConfigIn,
    removeManagedLaunchConfigs,
    updateManagedLaunchConfigIn,
    type LaunchTarget
} from './services/launchConfig';
import { currentDataLocation } from './services/dataLocation';
import { getSessionByName, runningDebuggerNames, resolveStopTarget } from './services/debugSessions';
import { dbForVersion } from './services/dbResolution';
import { resolveReposForDatabase } from './services/versionRepos';
import { isVersionProvisioned } from './services/provisioning';
import { ensureCustomWorktrees } from './services/customWorktree';
import { readSetupState } from './services/setupState';
import { provisionExistingVersion } from './odooInstaller';
import { buildServerUrl, isPortOpen } from './services/server';
import { excludeLaunchFromGit } from './services/gitExclude';

/** Why prepareArgs refuses: no database of that version is selected. */
const NO_DATABASE = 'Select a database before running this action.';

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

/** Where this window's launch configurations live (see launchTarget). */
export function currentLaunchTarget(): LaunchTarget | undefined {
    return launchTarget(
        vscode.workspace.workspaceFile,
        (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)
    );
}

/**
 * The directory Odoo runs in: the workspace the data belongs to. In a folder
 * window that is the folder; in a generated project workspace, whose first
 * folder is a repository, it is the workspace the data came from.
 */
function runDirectory(workspacePath: string): string {
    return currentDataLocation()?.root ?? workspacePath;
}

/** Workspace files whose first folder has already been cleaned this session. */
const cleanedFirstFolders = new Set<string>();

/**
 * Takes our entries back out of a multi-root workspace's first folder, where
 * earlier builds wrote them - usually the user's own repository.
 */
async function cleanUpFirstFolderLaunch(target: LaunchTarget, names: string[]): Promise<void> {
    if (target.kind !== 'workspaceFile' || !target.firstFolderPath || cleanedFirstFolders.has(target.filePath)) {
        return;
    }
    cleanedFirstFolders.add(target.filePath);
    try {
        const removed = await removeManagedLaunchConfigs(target.firstFolderPath, new Set(names));
        if (removed > 0) {
            logger.info(`[debugger] moved ${removed} launch entr${removed === 1 ? 'y' : 'ies'} out of ${target.firstFolderPath} into ${target.filePath}`);
        }
    } catch (error) {
        logger.warn(`[debugger] could not clean up ${target.firstFolderPath}/.vscode/launch.json:`, error);
    }
}

export async function setupDebugger(): Promise<any> {
    const workspacePath = getWorkspacePath();
    const target = currentLaunchTarget();
    if (!workspacePath || !target) {
        return undefined;
    }
    const cwd = runDirectory(workspacePath);
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
    /** Versions whose entry is removed: no database of theirs is selected. */
    const withoutDatabase = new Set<string>();

    let activeConfig: unknown;

    for (const version of targets) {
        const settings = version.settings;
        const normalizedOdooPath = normalizePath(settings.odooPath);
        const normalizedPythonPath = normalizePath(settings.pythonPath);

        const versionDb = dbForVersion(project, version.id);
        if (versionDb) {
            // Non-interactive on purpose: this sync runs on a debounce after
            // almost every command, so it creates the worktrees that need no
            // arbitration and reports the rest instead of raising a modal.
            const { problems, needsResolution } = await ensureCustomWorktrees(
                await resolveReposForDatabase(project, versionDb, { version, root: setupRoot }),
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
            // No database of this version: the entry an earlier sync wrote
            // still names the old one, so F5 would still launch it there.
            if (error instanceof Error && error.message === NO_DATABASE) {
                withoutDatabase.add(settings.debuggerName);
            }
            // A version with no resolvable database is skipped rather than
            // failing the sync for every other version. Only the active one is
            // worth telling the user about.
            if (version.id === activeVersion?.id) {
                logger.warn('Could not prepare debugger launch arguments:', error);
                if (error instanceof Error && error.message === NO_DATABASE) {
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
            const config = await updateManagedLaunchConfigIn(target, {
                name: settings.debuggerName,
                type: 'debugpy',
                request: 'launch',
                cwd,
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

    if (withoutDatabase.size > 0) {
        const removed = await removeManagedLaunchConfigIn(target, withoutDatabase).catch(error => {
            logger.warn('[debugger] could not remove launch entries of versions without a database:', error);
            return 0;
        });
        if (removed > 0) {
            logger.info(`[debugger] removed the launch entries of ${Array.from(withoutDatabase).join(', ')}: no database of that version is selected`);
        }
    }

    // A folder window that is itself a clone: keep launch.json out of git status.
    if (target.kind === 'folder') {
        await excludeLaunchFromGit(target.folderPath);
    }
    // Every version's name, not only the provisioned ones written above.
    await cleanUpFirstFolderLaunch(target, versionsService.getVersions()
        .map(version => version.settings.debuggerName)
        .filter(name => !!name));
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

    const db = dbForVersion(project, options.versionId);
    if (!db) {
        throw new Error(NO_DATABASE);
    }
    const projectModules = db.modules ?? [];

    // psae-internal directories: resolved through the shared service so the
    // Modules tree and the launch args always agree on what is included.
    // Resolve every project repo to the directory this version runs from, so
    // two versions on different branches never share one copy of the code.
    const resolvedRepos = await resolveReposForDatabase(project, db, {
        version: options.versionId ? VersionsService.getInstance().getVersion(options.versionId) : undefined
    });
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
            if (error.message === NO_DATABASE) {
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
        cwd: runDirectory(workspacePath),
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

/**
 * Starts one named version's server.
 *
 * Separate from `startDebugServer` because "the active version" is the wrong
 * answer whenever two servers run side by side: an upgrade starts both, and
 * only one of them can be active. launch.json already carries an entry per
 * provisioned version, so any of them can be started by name.
 *
 * `quiet` suppresses the prompts that only make sense for a command the user
 * invoked directly; a batch reports its own failures.
 */
export async function startServerForVersion(
    versionId: string | undefined,
    options: { noDebug?: boolean; quiet?: boolean; afterPick?: boolean } = {}
): Promise<{ ok: boolean; message?: string }> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        if (!options.quiet) {
            void showError('Open a workspace to use this command.');
        }
        return { ok: false, message: 'No workspace is open.' };
    }
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return { ok: false, message: 'No project is selected.' };
    }

    const versionsService = VersionsService.getInstance();
    await versionsService.initialize();
    const version = versionId ? versionsService.getVersion(versionId) : versionsService.getActiveVersion();
    if (!version) {
        if (!options.quiet) {
            void showError('No version to run. Create or select one first.');
        }
        return { ok: false, message: 'No version to run.' };
    }
    const settings = new SettingsModel(version.settings);

    // Handing an unprovisioned version to vscode.debug produces its generic
    // "configuration not found" error, which says nothing about the cause.
    if (!isVersionProvisioned(resolveOptionalPath(settings.pythonPath))) {
        const message = `"${version.name}" has no environment to run.`;
        if (options.quiet) {
            return { ok: false, message };
        }
        const choice = await showError(message, 'Provision');
        if (choice === 'Provision') {
            await provisionExistingVersion(version.id);
        }
        return { ok: false, message };
    }

    const db = dbForVersion(result.project, version.id);
    if (!db) {
        const message = `No database is selected for "${version.name}".`;
        if (options.quiet) {
            return { ok: false, message };
        }
        const choice = await showError(message, 'Select Database');
        if (choice === 'Select Database') {
            await vscode.commands.executeCommand('dbSelector.quickSearch', { versionId: version.id });
            // Picked one: carry on with the start that asked for it, once,
            // after writing its launch entry.
            const picked = dbForVersion((await SettingsStore.peekSelectedProject())?.project, version.id);
            if (picked && !options.afterPick) {
                await setupDebugger();
                return startServerForVersion(version.id, { ...options, afterPick: true });
            }
        }
        return { ok: false, message };
    }

    const notWritten = () => {
        const message = `Could not start "${settings.debuggerName}". Its launch entry may not be written yet.`;
        if (!options.quiet) {
            void showError(message);
        }
        return { ok: false, message };
    };

    // Found before anything is stopped: a start that cannot happen must not
    // take the running server of this version down with it.
    const target = currentLaunchTarget();
    const entry = target ? await readManagedLaunchConfig(target, settings.debuggerName) : undefined;
    if (!target || !entry) {
        return notWritten();
    }

    // Restarting this version stops only this version's session; other
    // versions running side by side must survive.
    const existingSession = getSessionByName(settings.debuggerName);

    // Something already on the port that is not this window's session is
    // usually the same version started from another window. Odoo would only
    // fail to bind; say what is going on instead.
    const port = Number(settings.portNumber) || 0;
    if (!existingSession && port && await isPortOpen(port)) {
        const message = `"${version.name}" is already running on port ${port}, probably in another window.`;
        if (!options.quiet) {
            void showWarning(message, 'Open in Browser').then(choice => {
                if (choice === 'Open in Browser') {
                    void vscode.env.openExternal(buildServerUrl(port, db.id));
                }
            });
        }
        return { ok: false, message };
    }
    if (existingSession) {
        await vscode.debug.stopDebugging(existingSession);
    }
    // VS Code looks a configuration up by name only in a folder's
    // launch.json, so an entry in a workspace file is passed as itself. Its
    // name is the session's name either way, which Stop and Restart rely on.
    const started = await vscode.debug.startDebugging(
        workspaceFolders[0],
        target.kind === 'workspaceFile' ? entry as vscode.DebugConfiguration : settings.debuggerName,
        { noDebug: options.noDebug === true }
    );
    if (!started) {
        return notWritten();
    }
    return { ok: true };
}

export async function startDebugServer(options: { noDebug?: boolean } = {}): Promise<void> {
    await startServerForVersion(undefined, options);
}
