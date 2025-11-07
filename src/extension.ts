import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { normalizePath, showError, showInfo, showWarning, showAutoInfo, getGitBranches, getGitBranch } from './utils';
import { ProjectModel } from './models/project';
import { DatabaseModel } from './models/db';
import { DbsTreeProvider, createDb, selectDatabase, deleteDb, restoreDb, changeDatabaseVersion, checkoutBranch } from './dbs';
import { ProjectTreeProvider, createProject, selectProject, getRepo, getProjectName, deleteProject, editProjectSettings, duplicateProject, exportProject, importProject, quickProjectSearch} from './project';
import { RepoTreeProvider, selectRepo } from './repos';
import { ProjectReposProvider, revealProjectRepo } from './projectRepos';
import { ModuleTreeProvider, selectModule, setModuleToInstall, setModuleToUpgrade, clearModuleState, togglePsaeInternalModule, updateAllModules, installAllModules, clearAllModuleSelections, updateInstalledModules, viewInstalledModules } from './module';
import { TestingTreeProvider, toggleTesting, toggleStopAfterInit, setTestFile, addTestTag, removeTestTag, cycleTestTagState, toggleLogLevel, setSpecificLogLevel } from './testing';
import { setupDebugger, startDebugShell, startDebugServer } from './debugger';
import { setupOdooBranch } from './odooInstaller';
import { SettingsStore } from './settingsStore';
import { VersionsTreeProvider } from './versionsTreeProvider';
import { VersionsService } from './versionsService';
import { updateTestingContext, updateActiveContext } from './context';
import type { VersionSettings } from './models/version';
import { VersionModel } from './models/version';
import { SettingsModel } from './models/settings';
import type { RepoModel } from './models/repo';
import { getBranchesWithMetadata } from './services/gitService';
import { SortPreferences } from './sortPreferences';
import { getSortOptions, getDefaultSortOption, SortableViewId } from './sortOptions';
import { openProjectWorkspace, rebuildProjectWorkspace, quickSwitchProjectWorkspace } from './projectWorkspace';
import { ProjectReposExplorerProvider, createNewFile as explorerCreateNewFile, createNewFolder as explorerCreateNewFolder, renameEntry as explorerRenameEntry, deleteEntry as explorerDeleteEntry, openTerminalHere as explorerOpenTerminalHere, selectProjectForExplorer, copyEntries as explorerCopyEntries, pasteEntries as explorerPasteEntries } from './projectReposExplorer';

// Store disposables for proper cleanup
let extensionDisposables: vscode.Disposable[] = [];

function extractUriFromContext(arg: any): vscode.Uri | undefined {
    if (!arg) {
        return undefined;
    }
    if (arg instanceof vscode.Uri) {
        return arg;
    }
    if (typeof arg === 'object') {
        const maybeResourceUri = (arg as any).resourceUri;
        if (maybeResourceUri instanceof vscode.Uri) {
            return maybeResourceUri;
        }
        const maybeUri = (arg as any).uri;
        if (maybeUri instanceof vscode.Uri) {
            return maybeUri;
        }
    }
    return undefined;
}

async function copyPathToClipboard(uri: vscode.Uri | undefined, relative: boolean): Promise<void> {
    if (!uri) {
        showInfo('Select a file or folder first.');
        return;
    }

    const absolutePath = uri.fsPath;
    if (!relative) {
        await vscode.env.clipboard.writeText(absolutePath);
        vscode.window.setStatusBarMessage('Copied path', 2000);
        return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        await vscode.env.clipboard.writeText(absolutePath);
        vscode.window.setStatusBarMessage('Copied path (no workspace for relative path)', 2500);
        return;
    }

    const relativePath = path.relative(workspaceRoot, absolutePath);
    const valueToCopy = relativePath.startsWith('..') ? absolutePath : relativePath;
    await vscode.env.clipboard.writeText(valueToCopy);
    vscode.window.setStatusBarMessage('Copied relative path', 2000);
}

async function openUriInIntegratedTerminal(uri: vscode.Uri | undefined): Promise<void> {
    if (!uri) {
        showInfo('Select a folder to open in terminal.');
        return;
    }

    const cwd = fs.existsSync(uri.fsPath) && fs.lstatSync(uri.fsPath).isDirectory()
        ? uri.fsPath
        : path.dirname(uri.fsPath);

    const terminal = vscode.window.createTerminal({ cwd });
    terminal.show();
}

// Initialize testing context based on current project state
async function initializeTestingContext(): Promise<void> {
    try {
        const result = await SettingsStore.getSelectedProject();
        if (result?.project?.testingConfig?.isEnabled) {
            updateTestingContext(true);
        } else {
            updateTestingContext(false);
        }
    } catch (error) {
        // If there's an error, default to testing disabled
        console.warn('Error initializing testing context:', error);
        updateTestingContext(false);
    }
}

async function maybeSwitchBranchForActivatedVersion(version: VersionModel | undefined): Promise<void> {
    if (!version) {
        return;
    }

    const targetBranch = version.odooVersion;
    if (!targetBranch) {
        return;
    }

    const switchBehavior = vscode.workspace.getConfiguration('odooDebugger').get('databaseSwitchBehavior', 'ask') as string;
    if (switchBehavior === 'auto-version-only') {
        return;
    }

    const checkoutSettings = new SettingsModel(version.settings);
    if (!checkoutSettings.odooPath || checkoutSettings.odooPath.trim() === '') {
        return;
    }

    let currentBranch = await getGitBranch(checkoutSettings.odooPath);

    const performCheckout = async (branch: string, context: 'auto' | 'manual') => {
        if (!branch || !branch.trim()) {
            return;
        }

        if (currentBranch === branch) {
            const message = context === 'auto'
                ? `Branch "${branch}" already active`
                : `Branch "${branch}" already active`;
            showAutoInfo(message, 2000);
            return;
        }

        await checkoutBranch(checkoutSettings, branch);
        currentBranch = branch;
        const message = context === 'auto'
            ? `Auto-switched to branch "${branch}" for version "${version.name}".`
            : `Switched to branch "${branch}" for version "${version.name}".`;
        showAutoInfo(message, 3000);
    };

    if (switchBehavior === 'auto-both' || switchBehavior === 'auto-branch-only') {
        await performCheckout(targetBranch, 'auto');
        return;
    }

    const metadata = await getBranchesWithMetadata(checkoutSettings.odooPath);
    const branchRecord = metadata.find(entry => entry.name === targetBranch);
    const branchTypeDescription = branchRecord
        ? (branchRecord.type === 'remote' ? 'Remote branch' : 'Local branch')
        : undefined;

    const options: Array<{ label: string; description?: string; detail?: string; action: 'switch' | 'keep'; }> = [
        {
            label: `$(git-branch) Switch to ${targetBranch}`,
            description: branchTypeDescription ?? 'Checkout the version branch for all repositories',
            detail: currentBranch ? `Current branch: ${currentBranch}` : undefined,
            action: 'switch'
        },
        {
            label: '$(circle-slash) Keep current branch',
            description: currentBranch ? `Stay on ${currentBranch}` : 'Do not change the working branch',
            action: 'keep'
        }
    ];

    const selection = await vscode.window.showQuickPick(options, {
        placeHolder: `Version "${version.name}" specifies branch "${targetBranch}".`,
        ignoreFocusOut: true
    });

    if (selection?.action === 'switch') {
        await performCheckout(targetBranch, 'manual');
    }
}

export async function activate(context: vscode.ExtensionContext) {
    // Clear any existing disposables
    extensionDisposables.forEach(d => d.dispose());
    extensionDisposables = [];

    const sortPreferences = new SortPreferences(context.workspaceState);

    // Initialize version management service
    const versionsService = VersionsService.getInstance();
    await versionsService.initialize();

    // Migrate existing settings to version management for backwards compatibility
    // Wait for migration to complete to ensure proper initialization order
    await versionsService.migrateFromLegacySettings().catch(error => {
        console.warn('Settings migration failed (this is non-critical):', error);
    });

    const isWorkspaceOpen = !!vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
    updateActiveContext(isWorkspaceOpen);

    // Initialize testing context
    await initializeTestingContext();

    const providers = {
        project: new ProjectTreeProvider(context, sortPreferences),
        repo: new RepoTreeProvider(context, sortPreferences),
        db: new DbsTreeProvider(sortPreferences),
        module: new ModuleTreeProvider(context, sortPreferences),
        testing: new TestingTreeProvider(context),
        versions: new VersionsTreeProvider(sortPreferences),
        projectRepos: new ProjectReposProvider(sortPreferences),
        projectReposExplorer: new ProjectReposExplorerProvider()
    };

    const registerViewSortCommand = (viewId: SortableViewId, provider: { refresh(): void }) => {
        const options = getSortOptions(viewId);
        type SortPickItem = vscode.QuickPickItem & { optionId: string };
        extensionDisposables.push(vscode.commands.registerCommand(`${viewId}.sort`, async () => {
            const current = sortPreferences.get(viewId, getDefaultSortOption(viewId));
            const picks: SortPickItem[] = options.map(option => ({
                label: `${option.id === current ? '$(check) ' : ''}${option.label}`,
                description: option.description,
                optionId: option.id
            }));
            const selection = await vscode.window.showQuickPick(picks, {
                placeHolder: 'Select sort order',
                ignoreFocusOut: true
            });
            if (!selection || selection.optionId === current) {
                return;
            }
            await sortPreferences.set(viewId, selection.optionId);
            provider.refresh();
        }));
    };

    // Register tree data providers and store disposables
    extensionDisposables.push(vscode.window.registerTreeDataProvider('projectSelector', providers.project));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('repoSelector', providers.repo));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('dbSelector', providers.db));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('moduleSelector', providers.module));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('testingSelector', providers.testing));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('versionsManager', providers.versions));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('projectRepos', providers.projectRepos));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('odt.projectReposExplorer', providers.projectReposExplorer));

const refreshAll = async (options: { syncDebugger?: boolean } = {}) => {
    const { syncDebugger = true } = options;

    if (syncDebugger) {
        try {
            await setupDebugger();
        } catch (error) {
            // Keeping this non-blocking so refresh still occurs when launch sync fails
            console.warn('Failed to synchronize debugger configuration:', error);
        }
    }

    await initializeTestingContext();
    Object.values(providers).forEach(provider => provider.refresh());
};

    registerViewSortCommand('projectSelector', providers.project);
    registerViewSortCommand('repoSelector', providers.repo);
    registerViewSortCommand('dbSelector', providers.db);
    registerViewSortCommand('moduleSelector', providers.module);
    registerViewSortCommand('versionsManager', providers.versions);
    registerViewSortCommand('projectRepos', providers.projectRepos);

    // Register all commands and store disposables
    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.refresh', refreshAll));
    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.refresh', refreshAll));
    extensionDisposables.push(vscode.commands.registerCommand('testingSelector.refresh', refreshAll));
    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.refresh', refreshAll));
    extensionDisposables.push(vscode.commands.registerCommand('projectRepos.reveal', async (arg?: any) => {
        const repo = arg?.metadata?.kind === 'repo' ? arg?.metadata?.repo : undefined;
        if (repo?.path) {
            await revealProjectRepo(repo);
            return;
        }

        const uri = extractUriFromContext(arg);
        if (!uri) {
            showInfo('Select a repository to reveal.');
            return;
        }
        await vscode.commands.executeCommand('revealInExplorer', uri);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('proj.openProjectWorkspace', async () => {
        await openProjectWorkspace(context);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('proj.rebuildProjectWorkspace', async () => {
        await rebuildProjectWorkspace(context);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('proj.quickSwitchProject', async () => {
        await quickSwitchProjectWorkspace(context);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odt.projectReposExplorer.newFile', async (uri?: vscode.Uri) => {
        await explorerCreateNewFile(uri);
        providers.projectReposExplorer.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odt.projectReposExplorer.newFolder', async (uri?: vscode.Uri) => {
        await explorerCreateNewFolder(uri);
        providers.projectReposExplorer.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odt.projectReposExplorer.rename', async (uri?: vscode.Uri) => {
        await explorerRenameEntry(uri);
        providers.projectReposExplorer.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odt.projectReposExplorer.delete', async (uri?: vscode.Uri) => {
        await explorerDeleteEntry(uri);
        providers.projectReposExplorer.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odt.projectReposExplorer.openTerminalHere', async (uri?: vscode.Uri) => {
        await explorerOpenTerminalHere(uri);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odt.projectReposExplorer.selectProject', async () => {
        await selectProjectForExplorer();
        providers.projectReposExplorer.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odt.projectReposExplorer.copy', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const list = uris && uris.length ? uris : uri ? [uri] : [];
        if (!list.length) {
            return;
        }
        explorerCopyEntries(list, false);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odt.projectReposExplorer.cut', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const list = uris && uris.length ? uris : uri ? [uri] : [];
        if (!list.length) {
            return;
        }
        explorerCopyEntries(list, true);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odt.projectReposExplorer.paste', async (uri?: vscode.Uri) => {
        await explorerPasteEntries(uri);
        providers.projectReposExplorer.refresh();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.copyFilePath', async (arg?: any) => {
        await copyPathToClipboard(extractUriFromContext(arg), false);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.copyRelativePath', async (arg?: any) => {
        await copyPathToClipboard(extractUriFromContext(arg), true);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.openInIntegratedTerminal', async (arg?: any) => {
        await openUriInIntegratedTerminal(extractUriFromContext(arg));
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.revealInExplorer', async (arg?: any) => {
        const uri = extractUriFromContext(arg);
        if (!uri) {
            showInfo('Select a file or folder first.');
            return;
        }
        await vscode.commands.executeCommand('revealInExplorer', uri);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.revealFileInOS', async (arg?: any) => {
        const uri = extractUriFromContext(arg);
        if (!uri) {
            showInfo('Select a file or folder first.');
            return;
        }
        await vscode.commands.executeCommand('revealFileInOS', uri);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.renameEntry', async (arg?: any) => {
        await explorerRenameEntry(extractUriFromContext(arg));
        providers.projectRepos.refresh();
        providers.projectReposExplorer.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.deleteEntry', async (arg?: any) => {
        await explorerDeleteEntry(extractUriFromContext(arg));
        providers.projectRepos.refresh();
        providers.projectReposExplorer.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.copyEntry', async (arg?: any) => {
        const uri = extractUriFromContext(arg);
        if (!uri) {
            showInfo('Select a file or folder first.');
            return;
        }
        explorerCopyEntries([uri], false);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.cutEntry', async (arg?: any) => {
        const uri = extractUriFromContext(arg);
        if (!uri) {
            showInfo('Select a file or folder first.');
            return;
        }
        explorerCopyEntries([uri], true);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.pasteEntry', async (arg?: any) => {
        const uri = extractUriFromContext(arg);
        if (!uri) {
            showInfo('Select a folder to paste into.');
            return;
        }

        let target = uri;
        try {
            if (fs.existsSync(uri.fsPath) && fs.lstatSync(uri.fsPath).isFile()) {
                target = vscode.Uri.file(path.dirname(uri.fsPath));
            }
        } catch {
            // Best effort: fall back to the provided uri
        }

        await explorerPasteEntries(target);
        providers.projectRepos.refresh();
        providers.projectReposExplorer.refresh();
    }));

    // Projects
    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.create', async () => {
        try {
            // Get settings from active version
            const settings = await versionsService.getActiveVersionSettings();

            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {throw new Error("Open a workspace to use this command.");}
            const name = await getProjectName(workspaceFolder);
            const customAddonsPath = normalizePath(settings.customAddonsPath);
            const repos = await getRepo(customAddonsPath, name); // Pass project name as search filter
            const databaseChoice = await vscode.window.showQuickPick([
                {
                    label: 'Create a new database',
                    description: 'Set up a fresh database or restore from a dump',
                    detail: 'You can add more databases later from the Databases view.',
                    value: 'create'
                },
                {
                    label: 'Connect to an existing database',
                    description: 'Link this project to a database that already exists in PostgreSQL',
                    value: 'connect'
                },
                {
                    label: 'Skip for now',
                    description: 'You can configure databases later from the Databases view.',
                    value: 'skip'
                }
            ], {
                placeHolder: 'Set up a database for this project?',
                ignoreFocusOut: true
            });

            let db: DatabaseModel | undefined;
            if (databaseChoice?.value === 'create') {
                db = await createDb(name, repos, settings.dumpsFolder, settings, { allowExistingOption: false });
            } else if (databaseChoice?.value === 'connect') {
                db = await createDb(name, repos, settings.dumpsFolder, settings, { initialMethod: 'existing' });
            }

            await createProject(name, repos, db);
            await refreshAll();
        } catch (err: any) {
            showError(err.message);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.selectProject', async (event) => {
        await selectProject(event);
        await refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.delete', async (event) => {
        await deleteProject(event);
        await refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.editSettings', async (event) => {
        await editProjectSettings(event);
        await refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.duplicateProject', async (event) => {
        await duplicateProject(event);
        await refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.exportProject', async (event) => {
        await exportProject(event);
        await refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.importProject', async () => {
        await importProject();
        await refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.setup', async () => {
        await setupOdooBranch();
        await refreshAll();
    }));

    // Quick Project Search
    extensionDisposables.push(vscode.commands.registerCommand('odoo-debugger.quickProjectSearch', async () => {
        await quickProjectSearch();
        await refreshAll();
    }));

    // DBS
    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.create', async () => {
        try {
            // Get settings from active version
            const settings = await versionsService.getActiveVersionSettings();

            const projects = await SettingsStore.getProjects();
            const project = projects?.find((p: ProjectModel) => p.isSelected);
            if (!project) {
                throw new Error('Select a project before running this action.');
            }
            const db = await createDb(project.name, project.repos, settings.dumpsFolder, settings);
            if (db) {
                project.dbs.push(db);
                // Only save projects, not settings - settings are managed via versions
                const data = await SettingsStore.load();
                await SettingsStore.saveWithoutComments({
                    projects,
                    versions: data.versions,
                    activeVersion: data.activeVersion
                });
                await selectDatabase(db);
            }
            await refreshAll();
        } catch (err: any) {
            showError(err.message);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.selectDb', async (event) => {
        try {
            await selectDatabase(event);
            await refreshAll();
        } catch (err: any) {
            showError(`Failed to select database: ${err.message}`);
            console.error('Error in database selection:', err);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.delete', async (event) => {
        try {
            await deleteDb(event);
            await refreshAll();
        } catch (err: any) {
            showError(`Failed to delete database: ${err.message}`);
            console.error('Error in database deletion:', err);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.restore', async (event) => {
        try {
            await restoreDb(event);
            await refreshAll();
            showInfo(`Database ${event.name || event.id} restored successfully!`);
        } catch (err: any) {
            showError(`Failed to restore database: ${err.message}`);
            console.error('Error in database restoration:', err);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.changeVersion', async (event) => {
        try {
            await changeDatabaseVersion(event);
            await refreshAll();
        } catch (err: any) {
            showError(`Failed to change database version: ${err.message}`);
            console.error('Error in database version change:', err);
        }
    }));

    // Repos
    extensionDisposables.push(vscode.commands.registerCommand('repoSelector.selectRepo', async (event) => {
        await selectRepo(event);
        await rebuildProjectWorkspace(context);
        await refreshAll();
    }));

    // Modules
    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.select', async (event) => {
        await selectModule(event);
        await refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.togglePsaeInternalModule', async (event) => {
        await togglePsaeInternalModule(event);
        await refreshAll();
    }));

    // Context menu commands for individual modules
    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.setToInstall', async (event) => {
        await setModuleToInstall(event);
        await refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.setToUpgrade', async (event) => {
        await setModuleToUpgrade(event);
        await refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.clearState', async (event) => {
        await clearModuleState(event);
        await refreshAll();
    }));

    // Module Quick Actions
extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.updateAll', async () => {
    await updateAllModules();
    await refreshAll();
}));

extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.updateInstalled', async () => {
    await updateInstalledModules();
    await refreshAll();
}));

extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.installAll', async () => {
    await installAllModules();
    await refreshAll();
}));

extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.clearAll', async () => {
    await clearAllModuleSelections();
    await refreshAll();
}));

    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.viewInstalled', async () => {
        await viewInstalledModules();
    }));

    // Testing
extensionDisposables.push(vscode.commands.registerCommand('testingSelector.toggleTesting', async (event) => {
    await toggleTesting(event);
    await refreshAll({ syncDebugger: false });
}));

extensionDisposables.push(vscode.commands.registerCommand('testingSelector.toggleStopAfterInit', async () => {
    await toggleStopAfterInit();
    await refreshAll({ syncDebugger: false });
}));

extensionDisposables.push(vscode.commands.registerCommand('testingSelector.setTestFile', async () => {
    await setTestFile();
    await refreshAll({ syncDebugger: false });
}));

    extensionDisposables.push(vscode.commands.registerCommand('testingSelector.addTestTag', async () => {
        await addTestTag();
        providers.testing.refresh();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('testingSelector.removeTestTag', async (event) => {
        await removeTestTag(event);
        providers.testing.refresh();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('testingSelector.cycleTestTagState', async (event) => {
        await cycleTestTagState(event);
        providers.testing.refresh();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('testingSelector.toggleLogLevel', async () => {
        await toggleLogLevel();
        providers.testing.refresh();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('testingSelector.setSpecificLogLevel', async () => {
        await setSpecificLogLevel();
        providers.testing.refresh();
    }));

    // Version management commands

    extensionDisposables.push(vscode.commands.registerCommand('odoo.createVersion', async () => {
        try {
            const name = await vscode.window.showInputBox({
                placeHolder: 'Enter version name (e.g., "Odoo 19.0")',
                prompt: 'Version name'
            });
            if (!name) { return; }

            const activeSettings = await versionsService.getActiveVersionSettings();

            const promptRepoPath = async (label: string, currentValue: string | undefined, required: boolean): Promise<string | undefined> => {
                type RepoPathAction = 'current' | 'browse' | 'manual' | 'empty';
                interface RepoPathQuickPickItem extends vscode.QuickPickItem {
                    action: RepoPathAction;
                    path?: string;
                }

                let current = currentValue?.trim();

                while (true) {
                    const items: RepoPathQuickPickItem[] = [];

                    if (current && current.length > 0) {
                        items.push({
                            label: current,
                            description: 'Use the current path',
                            action: 'current',
                            path: current
                        });
                    }

                    items.push({
                        label: 'Browse for folder…',
                        description: `Select the ${label}`,
                        action: 'browse'
                    });

                    items.push({
                        label: 'Enter path manually…',
                        description: 'Type the repository path',
                        action: 'manual'
                    });

                    if (!required) {
                        items.push({
                            label: 'Leave empty',
                            description: 'Skip this repository',
                            action: 'empty'
                        });
                    }

                    const selection = await vscode.window.showQuickPick(items, {
                        title: 'Create Version',
                        placeHolder: `How would you like to set the ${label.toLowerCase()}?`,
                        ignoreFocusOut: true
                    });

                    if (!selection) {
                        return undefined;
                    }

                    switch (selection.action) {
                        case 'current':
                            return selection.path;
                        case 'empty':
                            return '';
                        case 'browse': {
                            const defaultUriCandidates: vscode.Uri[] = [];
                            if (current) {
                                try {
                                    const normalized = normalizePath(current);
                                    if (fs.existsSync(normalized)) {
                                        defaultUriCandidates.push(vscode.Uri.file(normalized));
                                    }
                                } catch { /* ignore */ }
                            }
                            const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
                            if (workspaceUri) {
                                defaultUriCandidates.push(workspaceUri);
                            }

                            const dialogResult = await vscode.window.showOpenDialog({
                                title: `Select ${label}`,
                                canSelectMany: false,
                                canSelectFiles: false,
                                canSelectFolders: true,
                                defaultUri: defaultUriCandidates[0],
                                openLabel: 'Select'
                            });

                            if (!dialogResult || dialogResult.length === 0) {
                                continue;
                            }

                            const selectedPath = dialogResult[0].fsPath;
                            current = selectedPath;
                            return selectedPath;
                        }
                        case 'manual': {
                            const manualValue = await vscode.window.showInputBox({
                                title: 'Create Version',
                                prompt: `Enter the path to the ${label}.`,
                                value: current ?? '',
                                ignoreFocusOut: true,
                                validateInput: value => {
                                    if (!required) {
                                        return undefined;
                                    }
                                    return value && value.trim().length > 0 ? undefined : `${label} is required.`;
                                }
                            });

                            if (manualValue === undefined) {
                                continue;
                            }

                            const trimmed = manualValue.trim();
                            if (!required && trimmed.length === 0) {
                                return '';
                            }

                            if (trimmed.length === 0) {
                                continue;
                            }

                            current = trimmed;
                            return trimmed;
                        }
                    }
                }
            };

            const odooPathInput = await promptRepoPath('Odoo repository', activeSettings?.odooPath, true);
            if (odooPathInput === undefined) { return; }
            const odooPath = odooPathInput.trim();
            const normalizedOdooPath = normalizePath(odooPath);

            const enterprisePathInput = await promptRepoPath('Enterprise repository (optional)', activeSettings?.enterprisePath, false);
            if (enterprisePathInput === undefined) { return; }
            const enterprisePath = enterprisePathInput.trim();

            const designThemesPathInput = await promptRepoPath('Design Themes repository (optional)', activeSettings?.designThemesPath, false);
            if (designThemesPathInput === undefined) { return; }
            const designThemesPath = designThemesPathInput.trim();

            let odooVersion: string | undefined;
            let branches: string[] = [];

            const branchMetadata = await getBranchesWithMetadata(normalizedOdooPath);
            if (branchMetadata.length > 0) {
                branches = branchMetadata.map(branch => branch.name);
                const branchQuickPickItems = branchMetadata.map(branch => ({
                    label: branch.name,
                    description: branch.type === 'remote' ? 'Remote branch' : 'Local branch'
                }));

                const selectedBranch = await vscode.window.showQuickPick(branchQuickPickItems, {
                    placeHolder: 'Select Odoo version/branch',
                    title: 'Choose from available Git branches'
                });
                odooVersion = selectedBranch?.label;
            } else {
                branches = await getGitBranches(odooPath);
                if (branches.length > 0) {
                    const selectedBranch = await vscode.window.showQuickPick(branches, {
                        placeHolder: 'Select Odoo version/branch',
                        title: 'Choose from available Git branches'
                    });
                    odooVersion = selectedBranch ?? undefined;
                }
            }

            if (!odooVersion) {
                const noBranchMessage = fs.existsSync(normalizedOdooPath)
                    ? `No Git branches found in Odoo path: ${odooPath}. Enter the branch manually?`
                    : `The path "${odooPath}" does not exist. Enter the branch manually?`;

                const fallbackAction = await showWarning(
                    noBranchMessage,
                    'Enter Manually',
                    'Cancel'
                );

                if (fallbackAction !== 'Enter Manually') {
                    return;
                }

                odooVersion = await vscode.window.showInputBox({
                    placeHolder: 'Enter Odoo version/branch (e.g., "19.0", "saas-18.4", "master")',
                    prompt: 'Odoo version/branch',
                    value: branches[0] ?? ''
                }) ?? undefined;

                if (!odooVersion) { return; }
            }

            const settingsOverrides: Partial<VersionSettings> = { odooPath };
            if (enterprisePath) {
                settingsOverrides.enterprisePath = enterprisePath;
            }
            if (designThemesPath) {
                settingsOverrides.designThemesPath = designThemesPath;
            }

            const version = await versionsService.createVersion(name, odooVersion, settingsOverrides);
            await refreshAll({ syncDebugger: false });

            const action = await vscode.window.showInformationMessage(
                `Version "${name}" created on branch "${odooVersion}".`,
                'Activate Now'
            );

            if (action === 'Activate Now') {
                await vscode.commands.executeCommand('odoo.setActiveVersion', version.id);
            }
        } catch (error: any) {
            showError(`Failed to create version: ${error.message}`);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('odoo.openVersionDefaults', async () => {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:odoo-ps.odoo-debugging-mgm-tool odooDebugger.defaultVersion');
    }));

    extensionDisposables.push(vscode.commands.registerCommand('odoo.changeBranch', async (versionIdOrTreeItem?: any) => {
        try {
            let versionId: string;

            // Handle both direct calls and context menu calls
            if (typeof versionIdOrTreeItem === 'string') {
                // Direct command call with version ID
                versionId = versionIdOrTreeItem;
            } else if (versionIdOrTreeItem?.version?.id) {
                // Context menu call - extract ID from tree item
                versionId = versionIdOrTreeItem.version.id;
            } else {
                showError('Select a version before continuing.');
                return;
            }

            const version = versionsService.getVersion(versionId);
            if (!version) {
                showError('The selected version could not be found.');
                return;
            }

            // Get Odoo path from the specific version being edited
            const odooPath = version.settings.odooPath;

            let newBranch: string | undefined;

            if (odooPath) {
                // Try to get Git branches from the Odoo path
                const branches = await getGitBranches(odooPath);

                if (branches.length > 0) {
                    // Show branch selection with current branch highlighted
                    const items = branches.map(branch => ({
                        label: branch,
                        description: branch === version.odooVersion ? '(current)' : ''
                    }));

                    const selected = await vscode.window.showQuickPick(items, {
                        placeHolder: `Current branch: ${version.odooVersion}. Select new branch:`,
                        title: `Change branch for "${version.name}"`
                    });

                    newBranch = selected?.label;
                } else {
                    // Fallback to manual input if no branches found
                    const result = await showWarning(
                        `No Git branches found in Odoo path: ${odooPath}. Would you like to enter the branch manually?`,
                        'Enter Manually', 'Cancel'
                    );

                    if (result === 'Enter Manually') {
                        newBranch = await vscode.window.showInputBox({
                            placeHolder: version.odooVersion,
                            prompt: 'Enter new Odoo version/branch',
                            value: version.odooVersion
                        });
                    }
                }
            } else {
                // No Odoo path configured, show warning and fallback to manual input
                const result = await showWarning(
                    'Odoo path is not configured. Please set the Odoo path in settings first, or enter the branch manually.',
                    'Enter Manually', 'Cancel'
                );

                if (result === 'Enter Manually') {
                    newBranch = await vscode.window.showInputBox({
                        placeHolder: version.odooVersion,
                        prompt: 'Enter new Odoo version/branch',
                        value: version.odooVersion
                    });
                }
            }

            if (!newBranch || newBranch === version.odooVersion) {
                return; // No change or cancelled
            }

            await versionsService.updateVersion(versionId, { odooVersion: newBranch });
            showInfo(`Branch changed from "${version.odooVersion}" to "${newBranch}" for version "${version.name}"`);
        } catch (error: any) {
            showError(`Failed to change branch: ${error.message}`);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('odoo.setActiveVersion', async (versionIdOrTreeItem?: any) => {
        try {
            let versionId: string;

            // Handle both direct calls and context menu calls
            if (typeof versionIdOrTreeItem === 'string') {
                // Direct command call with version ID
                versionId = versionIdOrTreeItem;
            } else if (versionIdOrTreeItem?.version?.id) {
                // Context menu call - extract ID from tree item
                versionId = versionIdOrTreeItem.version.id;
            } else {
                // No version provided - show version picker
                const versions = versionsService.getVersions();
                const items = versions.map(v => ({
                    label: v.name,
                    description: v.odooVersion,
                    detail: v.isActive ? '⭐ Currently active' : '',
                    versionId: v.id
                }));

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select version to activate'
                });
                if (!selected) {
                    return;
                }

                versionId = selected.versionId;
            }

            const success = await versionsService.setActiveVersion(versionId);
            if (success) {
                const version = versionsService.getVersion(versionId);
                showInfo(`Activated version: ${version?.name}`);
                await maybeSwitchBranchForActivatedVersion(version);
                await refreshAll(); // Refresh all views to reflect new active version
            } else {
                showError('Unable to activate the selected version.');
            }
        } catch (error: any) {
            showError(`Unable to activate the selected version: ${error.message}`);
        }
    }));

    // Helper functions for setting editing
    const editNumberSetting = async (settingKey: string, currentValue: any) => {
        const displayValue = currentValue?.toString() || '';
        const newValue = await vscode.window.showInputBox({
            placeHolder: `Enter ${settingKey} (number)`,
            value: displayValue,
            prompt: `Edit ${settingKey}`,
            validateInput: (input) => {
                const num = parseFloat(input);
                if (isNaN(num) || num < 0) {
                    return 'Please enter a valid non-negative number';
                }
                if ((settingKey === 'portNumber' || settingKey === 'shellPortNumber') && (num < 1024 || num > 65535)) {
                    return 'Port number must be between 1024 and 65535';
                }
                return undefined;
            }
        });
        return newValue !== undefined ? parseFloat(newValue) : undefined;
    };

    const editPathSetting = async (settingKey: string, currentValue: any) => {
        const pathAction = await vscode.window.showQuickPick([
            { label: 'Enter Path Manually', value: 'manual' },
            { label: 'Browse for Folder', value: 'browse' }
        ], { placeHolder: `How would you like to set ${settingKey}?` });

        if (pathAction?.value === 'manual') {
            return await vscode.window.showInputBox({
                placeHolder: `Enter ${settingKey}`,
                value: currentValue?.toString() || '',
                prompt: `Edit ${settingKey}`
            });
        } else if (pathAction?.value === 'browse') {
            const result = await vscode.window.showOpenDialog({
                canSelectFolders: settingKey !== 'pythonPath',
                canSelectFiles: settingKey === 'pythonPath',
                canSelectMany: false,
                title: `Select ${settingKey}`
            });
            return result?.[0]?.fsPath;
        }
        return undefined;
    };

    const editDevModeSetting = async (currentValue: any) => {
        const devModeOption = await vscode.window.showQuickPick([
            { label: 'all', description: 'Enable all development features' },
            { label: 'xml', description: 'Enable XML development features' },
            { label: 'reload', description: 'Enable auto-reload' },
            { label: 'qweb', description: 'Enable QWeb development' },
            { label: 'Custom', description: 'Enter custom development parameters' },
            { label: 'None', description: 'Disable development mode' }
        ], {
            placeHolder: 'Select development mode',
            title: 'Development Mode Settings'
        });

        if (!devModeOption) {
            return undefined;
        }

        if (devModeOption.label === 'Custom') {
            const userInput = await vscode.window.showInputBox({
                placeHolder: 'Enter development mode value (e.g., xml, reload, qweb)',
                value: currentValue?.toString().replace('--dev=', '') || '',
                prompt: 'Development mode value (--dev= will be added automatically)'
            });
            return userInput ? `--dev=${userInput}` : '';
        } else if (devModeOption.label === 'None') {
            return '';
        } else {
            return `--dev=${devModeOption.label}`;
        }
    };

    extensionDisposables.push(vscode.commands.registerCommand('odoo.editVersionSetting', async (versionIdOrTreeItem?: any, settingKey?: string, currentValue?: any) => {
        try {
            let versionId: string;
            let key: string;
            let value: any;

            // Handle both direct command calls and context menu calls
            if (typeof versionIdOrTreeItem === 'string') {
                // Direct command call with parameters
                versionId = versionIdOrTreeItem;
                key = settingKey!;
                value = currentValue;
            } else if (versionIdOrTreeItem?.versionId) {
                // Context menu call - extract from tree item
                versionId = versionIdOrTreeItem.versionId;
                key = versionIdOrTreeItem.key;
                value = versionIdOrTreeItem.value;
            } else {
                showError('This command was invoked with invalid parameters.');
                return;
            }

            let newValue: any = undefined;

            // Handle different types of settings
            if (['portNumber', 'shellPortNumber', 'limitTimeReal', 'limitTimeCpu', 'maxCronThreads'].includes(key)) {
                newValue = await editNumberSetting(key, value);
            } else if (['odooPath', 'enterprisePath', 'designThemesPath', 'customAddonsPath', 'pythonPath', 'dumpsFolder'].includes(key)) {
                newValue = await editPathSetting(key, value);
            } else if (key === 'devMode') {
                newValue = await editDevModeSetting(value);
            } else {
                // Default string input for other settings
                newValue = await vscode.window.showInputBox({
                    placeHolder: `Enter ${key}`,
                    value: value?.toString() || '',
                    prompt: `Edit ${key}`
                });
            }

            if (newValue === undefined) {
                return; // User cancelled
            }

            await versionsService.updateVersion(versionId, {
                settings: { [key]: newValue }
            } as any);

            showInfo(`Updated ${key} successfully`);
        } catch (error: any) {
            showError(`Failed to edit setting: ${error.message}`);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('odoo.cloneVersion', async (versionIdOrTreeItem?: any) => {
        try {
            let versionId: string;

            // Handle both direct calls and context menu calls
            if (typeof versionIdOrTreeItem === 'string') {
                // Direct command call with version ID
                versionId = versionIdOrTreeItem;
            } else if (versionIdOrTreeItem?.version?.id) {
                // Context menu call - extract ID from tree item
                versionId = versionIdOrTreeItem.version.id;
            } else {
                // No version provided - show version picker
                const versions = versionsService.getVersions();
                const items = versions.map(v => ({
                    label: v.name,
                    description: v.odooVersion,
                    versionId: v.id
                }));

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select version to clone'
                });
                if (!selected) {
                    return;
                }

                versionId = selected.versionId;
            }

            const name = await vscode.window.showInputBox({
                placeHolder: 'Enter name for the cloned version',
                prompt: 'Version name'
            });
            if (!name) {
                return;
            }

            const clonedVersion = await versionsService.cloneVersion(versionId, name);
            if (clonedVersion) {
                showInfo(`Version "${name}" cloned successfully`);
            } else {
                showError('Failed to clone the selected version.');
            }
        } catch (error: any) {
            showError(`Failed to clone the selected version: ${error.message}`);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('odoo.deleteVersion', async (versionIdOrTreeItem?: any) => {
        try {
            let versionId: string;

            // Handle both direct calls and context menu calls
            if (typeof versionIdOrTreeItem === 'string') {
                // Direct command call with version ID
                versionId = versionIdOrTreeItem;
            } else if (versionIdOrTreeItem?.version?.id) {
                // Context menu call - extract ID from tree item
                versionId = versionIdOrTreeItem.version.id;
            } else {
                // No version provided - show version picker
                const versions = versionsService.getVersions();
                const items = versions.filter(v => !v.isActive).map(v => ({
                    label: v.name,
                    description: v.odooVersion,
                    versionId: v.id
                }));

                if (items.length === 0) {
                    showInfo('There are no versions available to delete (the active version cannot be removed).');
                    return;
                }

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select version to delete'
                });
                if (!selected) {
                    return;
                }

                versionId = selected.versionId;
            }

            const version = versionsService.getVersion(versionId);
            if (!version) {
                showError('The selected version could not be found.');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to delete version "${version.name}"?`,
                { modal: true },
                'Delete'
            );
            if (confirm !== 'Delete') {
                return;
            }

            const success = await versionsService.deleteVersion(versionId);
            if (success) {
                showInfo(`Version "${version.name}" deleted successfully`);
            } else {
                showError('Failed to delete the selected version.');
            }
        } catch (error: any) {
            showError(`Failed to delete the selected version.: ${error.message}`);
        }
    }));

    // Version settings context menu commands
    extensionDisposables.push(vscode.commands.registerCommand('odoo.setSettingToDefault', async (settingTreeItem?: any) => {
        try {
            if (!settingTreeItem) {
                showError('Select a setting before continuing.');
                return;
            }

            // Extract version ID and setting key from the tree item
            const versionId = settingTreeItem.versionId;
            const settingKey = settingTreeItem.key;

            if (!versionId || !settingKey) {
                showError('Could not identify the selected setting.');
                return;
            }

            const success = await versionsService.setSettingToDefault(versionId, settingKey);
            if (!success) {
                showError('Unable to reset this setting to its default value.');
            }
        } catch (error: any) {
            showError(`Failed to reset setting to default: ${error.message}`);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('odoo.setSettingAsDefault', async (settingTreeItem?: any) => {
        try {
            if (!settingTreeItem) {
                showError('Select a setting before continuing.');
                return;
            }

            // Extract version ID and setting key from the tree item
            const versionId = settingTreeItem.versionId;
            const settingKey = settingTreeItem.key;

            if (!versionId || !settingKey) {
                showError('Could not identify the selected setting.');
                return;
            }

            const success = await versionsService.setSettingAsDefault(versionId, settingKey);
            if (!success) {
                showError('Unable to save this setting as the default.');
            }
        } catch (error: any) {
            showError(`Unable to save this setting as the default: ${error.message}`);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('odoo.setAllSettingsToDefault', async (versionTreeItem?: any) => {
        try {
            let versionId: string;

            // Handle both direct calls and context menu calls
            if (typeof versionTreeItem === 'string') {
                // Direct command call with version ID
                versionId = versionTreeItem;
            } else if (versionTreeItem?.version?.id) {
                // Context menu call - extract ID from tree item
                versionId = versionTreeItem.version.id;
            } else {
                showError('Select a version before continuing.');
                return;
            }

            const version = versionsService.getVersion(versionId);
            if (!version) {
                showError('The selected version could not be found.');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to reset ALL settings for version "${version.name}" to their default values?`,
                'Reset All',
                'Cancel'
            );
            if (confirm !== 'Reset All') {
                return;
            }

            const success = await versionsService.setAllSettingsToDefault(versionId);
            if (!success) {
                showError('Unable to reset all settings to their default values.');
            }
        } catch (error: any) {
            showError(`Failed to reset all settings to default: ${error.message}`);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('odoo.setAllSettingsAsDefault', async (versionTreeItem?: any) => {
        try {
            let versionId: string;

            // Handle both direct calls and context menu calls
            if (typeof versionTreeItem === 'string') {
                // Direct command call with version ID
                versionId = versionTreeItem;
            } else if (versionTreeItem?.version?.id) {
                // Context menu call - extract ID from tree item
                versionId = versionTreeItem.version.id;
            } else {
                showError('Select a version before continuing.');
                return;
            }

            const version = versionsService.getVersion(versionId);
            if (!version) {
                showError('The selected version could not be found.');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to save ALL settings from version "${version.name}" as new default values?`,
                'Save All as Default',
                'Cancel'
            );
            if (confirm !== 'Save All as Default') {
                return;
            }

            const success = await versionsService.setAllSettingsAsDefault(versionId);
            if (!success) {
                showError('Unable to save these settings as the new defaults.');
            }
        } catch (error: any) {
            showError(`Unable to save these settings as the new defaults.: ${error.message}`);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('odoo.refreshVersions', async () => {
        await versionsService.refresh();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('odoo.manageVersions', async () => {
        const actions = [
            'Create New Version',
            'Switch Active Version',
            'Clone Version',
            'Delete Version'
        ];

        const action = await vscode.window.showQuickPick(actions, {
            placeHolder: 'Choose version management action'
        });

        switch (action) {
            case 'Create New Version':
                vscode.commands.executeCommand('odoo.createVersion');
                break;
            case 'Switch Active Version':
                vscode.commands.executeCommand('odoo.setActiveVersion');
                break;
            case 'Clone Version':
                vscode.commands.executeCommand('odoo.cloneVersion');
                break;
            case 'Delete Version':
                vscode.commands.executeCommand('odoo.deleteVersion');
                break;
        }
    }));

    // Start Server and Start Shell commands for versions panel
    extensionDisposables.push(vscode.commands.registerCommand('odoo.startServer', async () => {
        await startDebugServer();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('odoo.startShell', async () => {
        await startDebugShell();
    }));

    // Add all disposables to the context for automatic cleanup
    extensionDisposables.forEach(disposable => context.subscriptions.push(disposable));

    return {
        dispose() {
            // Clean up all disposables
            extensionDisposables.forEach(d => d.dispose());
            extensionDisposables = [];

            // Reset the context
            updateActiveContext(false);
        }
    };
}

// Proper deactivate function
export function deactivate() {
    // Clean up all disposables
    extensionDisposables.forEach(d => d.dispose());
    extensionDisposables = [];

    // Reset the context
    updateActiveContext(false);

    console.log('Odoo Debugger extension deactivated');
}
