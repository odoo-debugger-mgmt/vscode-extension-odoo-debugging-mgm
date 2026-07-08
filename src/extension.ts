import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { normalizePath, showError, showInfo, showWarning, getGitBranches } from './utils';
import { ProjectModel } from './models/project';
import { DatabaseModel } from './models/db';
import { DbsTreeProvider, createDb, selectDatabase, deleteDb, restoreDb, changeDatabaseVersion, changeDatabaseProjectRepoBranches, manageDatabaseTemplates } from './dbs';
import { alignEnvironment, migrateLegacySwitchBehaviorSetting } from './services/environment';
import { migrateDebuggerData } from './services/dataMigration';
import { ProjectTreeProvider, createProject, selectProject, getRepo, getProjectName, deleteProject, editProjectSettings, duplicateProject, exportProject, importProject, quickProjectSearch, manageProjectTickets, openProjectTicket} from './project';
import { RepoTreeProvider, selectRepo } from './repos';
import { ProjectReposProvider, revealProjectRepo } from './projectRepos';
import { ModuleTreeProvider, selectModule, setModuleToInstall, setModuleToUpgrade, clearModuleState, togglePsaeInternalModule, updateAllModules, installAllModules, clearAllModuleSelections, updateInstalledModules, viewInstalledModules, createModuleFromScaffold } from './module';
import { TestingTreeProvider, toggleTesting, toggleStopAfterInit, setTestFile, addTestTag, removeTestTag, cycleTestTagState, toggleLogLevel, setSpecificLogLevel } from './testing';
import { setupDebugger, startDebugShell, startDebugServer } from './debugger';
import { setupOdooBranch } from './odooInstaller';
import { SettingsStore } from './settingsStore';
import { VersionsTreeProvider } from './versionsTreeProvider';
import { VersionsService } from './versionsService';
import { updateTestingContext, updateActiveContext } from './context';
import type { RepoModel } from './models/repo';
import { getBranchesWithMetadata } from './services/gitService';
import { SortPreferences } from './sortPreferences';
import { getSortOptions, getDefaultSortOption, SortableViewId } from './sortOptions';
import { openProjectWorkspace, rebuildProjectWorkspace, quickSwitchProjectWorkspace } from './projectWorkspace';
import { ProjectReposExplorerProvider, createNewFile as explorerCreateNewFile, createNewFolder as explorerCreateNewFolder, renameEntry as explorerRenameEntry, deleteEntry as explorerDeleteEntry, openTerminalHere as explorerOpenTerminalHere, selectProjectForExplorer, copyEntries as explorerCopyEntries, pasteEntries as explorerPasteEntries } from './projectReposExplorer';
import { invalidateModuleDiscoveryCache, invalidateRepositoryDiscoveryCache } from './services/runtimeCache';
import { logger, registerLogger } from './services/logger';
import { showModalWarning } from './services/notifications';

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

function getTreeItemLabel(item: vscode.TreeItem): string {
    if (typeof item.label === 'string') {
        return item.label;
    }
    if (item.label && typeof item.label === 'object' && 'label' in item.label) {
        return item.label.label;
    }
    return '';
}

function getTreeItemDescription(item: vscode.TreeItem): string | undefined {
    return typeof item.description === 'string' ? item.description : undefined;
}

function stripMarkdownForQuickPick(value: string): string {
    return value
        // Convert markdown links to visible text only.
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        // Remove common markdown tokens.
        .replace(/[*_`>#~]/g, '')
        // Normalize line breaks for quick-pick rows.
        .replace(/\r?\n+/g, ' • ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function getTreeItemDetail(item: vscode.TreeItem): string | undefined {
    if (typeof item.tooltip === 'string') {
        return stripMarkdownForQuickPick(item.tooltip);
    }
    if (item.tooltip instanceof vscode.MarkdownString) {
        return stripMarkdownForQuickPick(item.tooltip.value);
    }
    return undefined;
}

async function quickSearchTreeItems(
    items: vscode.TreeItem[],
    options: {
        placeHolder: string;
        title: string;
        emptyMessage: string;
        onPick?: (item: vscode.TreeItem) => Promise<void>;
    }
): Promise<void> {
    if (!items.length) {
        showInfo(options.emptyMessage);
        return;
    }

    const picks = items.map(item => ({
        label: getTreeItemLabel(item),
        description: getTreeItemDescription(item),
        detail: getTreeItemDetail(item),
        item
    }));

    const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: options.placeHolder,
        title: options.title,
        ignoreFocusOut: true,
        matchOnDescription: true,
        matchOnDetail: true
    });

    if (!selected) {
        return;
    }

    if (options.onPick) {
        await options.onPick(selected.item);
        return;
    }

    if (!selected.item.command) {
        showInfo('No action is available for the selected item.');
        return;
    }

    await vscode.commands.executeCommand(
        selected.item.command.command,
        ...(selected.item.command.arguments ?? [])
    );
}

function extractVersionIdFromArg(arg: any): string | undefined {
    // Commands receive either a version id (direct call) or a tree item (context menu).
    if (typeof arg === 'string') {
        return arg;
    }
    return arg?.version?.id;
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
        logger.warn('Error initializing testing context:', error);
        updateTestingContext(false);
    }
}

export async function activate(context: vscode.ExtensionContext) {
    registerLogger(context);

    const sortPreferences = new SortPreferences(context.workspaceState);

    // Initialize version management service
    const versionsService = VersionsService.getInstance();
    await versionsService.initialize();

    // Migrate existing settings to version management for backwards compatibility
    // Wait for migration to complete to ensure proper initialization order
    await versionsService.migrateFromLegacySettings().catch(error => {
        logger.warn('Settings migration failed (this is non-critical):', error);
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

    // React to version changes fired by VersionsService.refresh(). Must be
    // registered before the migrations below, which may fire it, and outside
    // the provider so re-activation cannot double-register the command.
    context.subscriptions.push(vscode.commands.registerCommand('odoo.versionsChanged', () => {
        providers.versions.refresh();
    }));
    // The explorer provider owns file-system watchers that need disposal.
    context.subscriptions.push(providers.projectReposExplorer);

    // One-time v1.2 migrations: fold legacy per-DB odooVersion into versions,
    // and map old databaseSwitchBehavior values onto the new auto/ask/never
    // enum. Runs after provider construction so the versions-changed refresh
    // command used when new profiles are created is already registered.
    await migrateDebuggerData();
    void migrateLegacySwitchBehaviorSetting();

    const registerViewSortCommand = (viewId: SortableViewId, provider: { refresh(): void }) => {
        const options = getSortOptions(viewId);
        type SortPickItem = vscode.QuickPickItem & { optionId: string };
        context.subscriptions.push(vscode.commands.registerCommand(`${viewId}.sort`, async () => {
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
    context.subscriptions.push(vscode.window.registerTreeDataProvider('projectSelector', providers.project));
    context.subscriptions.push(vscode.window.registerTreeDataProvider('repoSelector', providers.repo));
    context.subscriptions.push(vscode.window.registerTreeDataProvider('dbSelector', providers.db));
    context.subscriptions.push(vscode.window.registerTreeDataProvider('moduleSelector', providers.module));
    context.subscriptions.push(vscode.window.registerTreeDataProvider('testingSelector', providers.testing));
    context.subscriptions.push(vscode.window.registerTreeDataProvider('versionsManager', providers.versions));
    context.subscriptions.push(vscode.window.registerTreeDataProvider('projectRepos', providers.projectRepos));
    context.subscriptions.push(vscode.window.registerTreeDataProvider('odt.projectReposExplorer', providers.projectReposExplorer));

    type RefreshReason = 'ui' | 'debugger' | 'all';

    const refreshViews = async () => {
        await initializeTestingContext();
        Object.values(providers).forEach(provider => provider.refresh());
    };

    let debuggerSyncTimer: NodeJS.Timeout | undefined;
    let debuggerSyncInFlight: Promise<void> | null = null;
    let debuggerSyncWaiters: Array<() => void> = [];

    const runDebuggerSync = async (): Promise<void> => {
        if (debuggerSyncInFlight) {
            await debuggerSyncInFlight;
            return;
        }

        debuggerSyncInFlight = (async () => {
            try {
                await setupDebugger();
            } catch (error) {
                // Keeping this non-blocking so refresh still occurs when launch sync fails
                logger.warn('Failed to synchronize debugger configuration:', error);
            }
        })();

        try {
            await debuggerSyncInFlight;
        } finally {
            debuggerSyncInFlight = null;
        }
    };

    const syncDebuggerDebounced = (delayMs = 200): Promise<void> => new Promise(resolve => {
        debuggerSyncWaiters.push(resolve);
        if (debuggerSyncTimer) {
            clearTimeout(debuggerSyncTimer);
        }
        debuggerSyncTimer = setTimeout(() => {
            debuggerSyncTimer = undefined;
            runDebuggerSync()
                .finally(() => {
                    const waiters = debuggerSyncWaiters;
                    debuggerSyncWaiters = [];
                    waiters.forEach(waiter => waiter());
                });
        }, delayMs);
    });

    const refreshAll = async (options: { reason?: RefreshReason; debounceMs?: number } = {}) => {
        const { reason = 'all', debounceMs = 200 } = options;

        if (reason === 'all' || reason === 'debugger') {
            await syncDebuggerDebounced(debounceMs);
        }

        if (reason === 'all' || reason === 'ui') {
            await refreshViews();
        }
    };

    registerViewSortCommand('projectSelector', providers.project);
    registerViewSortCommand('repoSelector', providers.repo);
    registerViewSortCommand('dbSelector', providers.db);
    registerViewSortCommand('moduleSelector', providers.module);
    registerViewSortCommand('versionsManager', providers.versions);
    registerViewSortCommand('projectRepos', providers.projectRepos);

    // Register all commands and store disposables
    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.refresh', async () => refreshAll({ reason: 'ui' })));
    context.subscriptions.push(vscode.commands.registerCommand('repoSelector.refresh', async () => refreshAll({ reason: 'ui' })));
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.refresh', async () => refreshAll({ reason: 'ui' })));
    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.refresh', async () => refreshAll({ reason: 'ui' })));
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.refresh', async () => refreshAll({ reason: 'ui' })));
    context.subscriptions.push(vscode.commands.registerCommand('projectRepos.reveal', async (arg?: any) => {
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
    context.subscriptions.push(vscode.commands.registerCommand('proj.openProjectWorkspace', async () => {
        await openProjectWorkspace(context);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('proj.rebuildProjectWorkspace', async () => {
        await rebuildProjectWorkspace(context);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('proj.quickSwitchProject', async () => {
        await quickSwitchProjectWorkspace(context);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.newFile', async (uri?: vscode.Uri) => {
        await explorerCreateNewFile(uri);
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.newFolder', async (uri?: vscode.Uri) => {
        await explorerCreateNewFolder(uri);
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.rename', async (uri?: vscode.Uri) => {
        await explorerRenameEntry(uri);
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.delete', async (uri?: vscode.Uri) => {
        await explorerDeleteEntry(uri);
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.openTerminalHere', async (uri?: vscode.Uri) => {
        await explorerOpenTerminalHere(uri);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.selectProject', async () => {
        await selectProjectForExplorer();
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.copy', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const list = uris && uris.length ? uris : uri ? [uri] : [];
        if (!list.length) {
            return;
        }
        explorerCopyEntries(list, false);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.cut', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const list = uris && uris.length ? uris : uri ? [uri] : [];
        if (!list.length) {
            return;
        }
        explorerCopyEntries(list, true);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.paste', async (uri?: vscode.Uri) => {
        await explorerPasteEntries(uri);
        providers.projectReposExplorer.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.copyFilePath', async (arg?: any) => {
        await copyPathToClipboard(extractUriFromContext(arg), false);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.copyRelativePath', async (arg?: any) => {
        await copyPathToClipboard(extractUriFromContext(arg), true);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.openInIntegratedTerminal', async (arg?: any) => {
        await openUriInIntegratedTerminal(extractUriFromContext(arg));
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.revealInExplorer', async (arg?: any) => {
        const uri = extractUriFromContext(arg);
        if (!uri) {
            showInfo('Select a file or folder first.');
            return;
        }
        await vscode.commands.executeCommand('revealInExplorer', uri);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.revealFileInOS', async (arg?: any) => {
        const uri = extractUriFromContext(arg);
        if (!uri) {
            showInfo('Select a file or folder first.');
            return;
        }
        await vscode.commands.executeCommand('revealFileInOS', uri);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.renameEntry', async (arg?: any) => {
        await explorerRenameEntry(extractUriFromContext(arg));
        providers.projectRepos.refresh();
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.deleteEntry', async (arg?: any) => {
        await explorerDeleteEntry(extractUriFromContext(arg));
        providers.projectRepos.refresh();
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.copyEntry', async (arg?: any) => {
        const uri = extractUriFromContext(arg);
        if (!uri) {
            showInfo('Select a file or folder first.');
            return;
        }
        explorerCopyEntries([uri], false);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.cutEntry', async (arg?: any) => {
        const uri = extractUriFromContext(arg);
        if (!uri) {
            showInfo('Select a file or folder first.');
            return;
        }
        explorerCopyEntries([uri], true);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.pasteEntry', async (arg?: any) => {
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
    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.create', async () => {
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
            if (!databaseChoice) {
                return;
            }

            let db: DatabaseModel | undefined;
            if (databaseChoice?.value === 'create') {
                db = await createDb(name, repos, settings.dumpsFolder, settings, { allowExistingOption: false });
            } else if (databaseChoice?.value === 'connect') {
                db = await createDb(name, repos, settings.dumpsFolder, settings, { initialMethod: 'existing' });
            }

            if (databaseChoice.value !== 'skip' && !db) {
                // User cancelled within DB creation flow.
                return;
            }

            await createProject(name, repos, db);
            if (db) {
                // Ensure project creation follows the same version/branch switch path as manual DB selection.
                await selectDatabase(db);
            }
            await refreshAll();
        } catch (err: any) {
            showError(err.message);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.selectProject', async (event) => {
        await selectProject(event);
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.delete', async (event) => {
        await deleteProject(event);
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.editSettings', async (event) => {
        await editProjectSettings(event);
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.manageTickets', async (event) => {
        await manageProjectTickets(event);
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.openTicket', async (event) => {
        await openProjectTicket(event);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.duplicateProject', async (event) => {
        await duplicateProject(event);
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.exportProject', async (event) => {
        await exportProject(event);
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.importProject', async () => {
        await importProject();
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.setup', async () => {
        await setupOdooBranch();
        await refreshAll({ reason: 'ui' });
    }));

    // Quick Project Search
    context.subscriptions.push(vscode.commands.registerCommand('odoo-debugger.quickProjectSearch', async () => {
        await quickProjectSearch();
        await refreshAll({ reason: 'ui' });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('repoSelector.quickSearch', async () => {
        const items = ((await providers.repo.getChildren()) ?? [])
            .filter(item => !!item.command && getTreeItemLabel(item).trim().length > 0);

        await quickSearchTreeItems(items, {
            placeHolder: 'Search repositories...',
            title: 'Repository Search',
            emptyMessage: 'No repositories available to search.'
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.quickSearch', async () => {
        const items = ((await providers.db.getChildren()) ?? [])
            .filter(item => (item as any).contextValue === 'database' && !!item.command);

        await quickSearchTreeItems(items, {
            placeHolder: 'Search databases...',
            title: 'Database Search',
            emptyMessage: 'No databases available to search.'
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.quickSearch', async () => {
        const items = ((await providers.module.getChildren()) ?? [])
            .filter(item => (item as any).contextValue === 'module' && !!item.command);

        await quickSearchTreeItems(items, {
            placeHolder: 'Search modules...',
            title: 'Module Search',
            emptyMessage: 'No searchable modules found for the selected database.',
            onPick: async (item) => {
                const moduleData = (item as any).moduleData ?? item.command?.arguments?.[0];
                if (!moduleData?.name) {
                    showInfo('Unable to read module details for this selection.');
                    return;
                }

                const stateSelection = await vscode.window.showQuickPick([
                    {
                        label: 'Set to Install',
                        description: moduleData.name,
                        action: 'install' as const
                    },
                    {
                        label: 'Set to Upgrade',
                        description: moduleData.name,
                        action: 'upgrade' as const
                    },
                    {
                        label: 'Clear State',
                        description: moduleData.name,
                        action: 'none' as const
                    }
                ], {
                    placeHolder: `Set state for module "${moduleData.name}"`,
                    ignoreFocusOut: true
                });

                if (!stateSelection) {
                    return;
                }

                if (stateSelection.action === 'install') {
                    await setModuleToInstall(moduleData);
                } else if (stateSelection.action === 'upgrade') {
                    await setModuleToUpgrade(moduleData);
                } else {
                    await clearModuleState(moduleData);
                }

                await refreshAll({ reason: 'ui' });
            }
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('versionsManager.quickSearch', async () => {
        const items = ((await providers.versions.getChildren()) ?? [])
            .filter(item => {
                const contextValue = (item as any).contextValue;
                return (contextValue === 'version' || contextValue === 'activeVersion') && !!item.command;
            })
            .map(item => providers.versions.getTreeItem(item));

        await quickSearchTreeItems(items, {
            placeHolder: 'Search versions...',
            title: 'Version Search',
            emptyMessage: 'No versions available to search.'
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('projectRepos.quickSearch', async () => {
        const rootItems = ((await providers.projectRepos.getChildren()) ?? [])
            .filter(item => (item as any)?.metadata?.kind === 'repo');

        await quickSearchTreeItems(rootItems, {
            placeHolder: 'Search project repositories...',
            title: 'Project Repo Search',
            emptyMessage: 'No project repositories available to search.',
            onPick: async (item) => {
                const repo = (item as any)?.metadata?.repo;
                if (!repo?.path) {
                    showInfo('Select a repository to reveal.');
                    return;
                }
                await revealProjectRepo(repo);
            }
        });
    }));

    // DBS
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.create', async () => {
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
                    activeVersion: data.activeVersion,
                    dbTemplates: data.dbTemplates
                });
                await selectDatabase(db);
            }
            await refreshAll();
        } catch (err: any) {
            showError(err.message);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.selectDb', async (event) => {
        try {
            await selectDatabase(event);
            await refreshAll();
        } catch (err: any) {
            showError(`Failed to select database: ${err.message}`);
            logger.error('Error in database selection:', err);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.delete', async (event) => {
        try {
            await deleteDb(event);
            await refreshAll();
        } catch (err: any) {
            showError(`Failed to delete database: ${err.message}`);
            logger.error('Error in database deletion:', err);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.restore', async (event) => {
        try {
            // restoreDb shows its own success notification.
            await restoreDb(event);
            await refreshAll();
        } catch (err: any) {
            showError(`Failed to restore database: ${err.message}`);
            logger.error('Error in database restoration:', err);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.changeVersion', async (event) => {
        try {
            await changeDatabaseVersion(event);
            await refreshAll();
        } catch (err: any) {
            showError(`Failed to change database version: ${err.message}`);
            logger.error('Error in database version change:', err);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.configureRepoBranches', async (event) => {
        try {
            await changeDatabaseProjectRepoBranches(event);
            await refreshAll({ reason: 'ui' });
        } catch (err: any) {
            showError(`Failed to update project repo branch mapping: ${err.message}`);
            logger.error('Error in database project repo branch mapping update:', err);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.manageTemplates', async () => {
        try {
            await manageDatabaseTemplates();
            await refreshAll({ reason: 'ui' });
        } catch (err: any) {
            showError(`Failed to manage database templates: ${err.message}`);
            logger.error('Error in database template management:', err);
        }
    }));

    // Repos
    context.subscriptions.push(vscode.commands.registerCommand('repoSelector.selectRepo', async (event) => {
        await selectRepo(event);
        await rebuildProjectWorkspace(context);
        await refreshAll();
    }));

    // Modules
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.select', async (event) => {
        await selectModule(event);
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.togglePsaeInternalModule', async (event) => {
        await togglePsaeInternalModule(event);
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.create', async () => {
        await createModuleFromScaffold();
        await refreshAll({ reason: 'ui' });
    }));

    // Context menu commands for individual modules
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.setToInstall', async (event) => {
        await setModuleToInstall(event);
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.setToUpgrade', async (event) => {
        await setModuleToUpgrade(event);
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.clearState', async (event) => {
        await clearModuleState(event);
        await refreshAll();
    }));

    // Module Quick Actions
context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.updateAll', async () => {
    await updateAllModules();
    await refreshAll();
}));

context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.updateInstalled', async () => {
    await updateInstalledModules();
    await refreshAll();
}));

context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.installAll', async () => {
    await installAllModules();
    await refreshAll();
}));

context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.clearAll', async () => {
    await clearAllModuleSelections();
    await refreshAll();
}));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.viewInstalled', async () => {
        await viewInstalledModules();
    }));

    // Testing
context.subscriptions.push(vscode.commands.registerCommand('testingSelector.toggleTesting', async (event) => {
    await toggleTesting(event);
    await refreshAll({ reason: 'ui' });
}));

context.subscriptions.push(vscode.commands.registerCommand('testingSelector.toggleStopAfterInit', async () => {
    await toggleStopAfterInit();
    await refreshAll({ reason: 'ui' });
}));

context.subscriptions.push(vscode.commands.registerCommand('testingSelector.setTestFile', async () => {
    await setTestFile();
    await refreshAll({ reason: 'ui' });
}));

    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.addTestTag', async () => {
        await addTestTag();
        providers.testing.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.removeTestTag', async (event) => {
        await removeTestTag(event);
        providers.testing.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.cycleTestTagState', async (event) => {
        await cycleTestTagState(event);
        providers.testing.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.toggleLogLevel', async () => {
        await toggleLogLevel();
        providers.testing.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.setSpecificLogLevel', async () => {
        await setSpecificLogLevel();
        providers.testing.refresh();
    }));

    // Version management commands

    context.subscriptions.push(vscode.commands.registerCommand('odoo.createVersion', async () => {
        try {
            // Two prompts: branch, then name. Paths and ports come from the
            // odooDebugger.defaultVersion.* settings and stay editable in the
            // Versions tree after creation.
            const activeSettings = await versionsService.getActiveVersionSettings();
            const odooPath = activeSettings?.odooPath ? normalizePath(activeSettings.odooPath) : undefined;

            type BranchPickItem = vscode.QuickPickItem & { action: 'branch' | 'manual'; branch?: string };
            const branchItems: BranchPickItem[] = [];
            if (odooPath && fs.existsSync(odooPath)) {
                const metadata = await getBranchesWithMetadata(odooPath);
                if (metadata.length > 0) {
                    branchItems.push(...metadata.map(branch => ({
                        label: branch.name,
                        description: branch.type === 'remote' ? 'Remote branch' : 'Local branch',
                        action: 'branch' as const,
                        branch: branch.name
                    })));
                } else {
                    const branches = await getGitBranches(odooPath);
                    branchItems.push(...branches.map(branch => ({
                        label: branch,
                        action: 'branch' as const,
                        branch
                    })));
                }
            }
            branchItems.push({
                label: '$(pencil) Enter branch manually…',
                description: 'e.g. "19.0", "saas-18.4", "master"',
                action: 'manual'
            });

            const branchPick = await vscode.window.showQuickPick(branchItems, {
                title: 'Create Version',
                placeHolder: 'Select the Odoo branch for this version',
                ignoreFocusOut: true
            });
            if (!branchPick) { return; }

            let odooVersion = branchPick.branch;
            if (branchPick.action === 'manual') {
                odooVersion = (await vscode.window.showInputBox({
                    title: 'Create Version',
                    placeHolder: 'Enter Odoo version/branch (e.g. "19.0", "saas-18.4", "master")',
                    ignoreFocusOut: true,
                    validateInput: value => value.trim() ? undefined : 'Branch is required.'
                }))?.trim();
            }
            if (!odooVersion) { return; }

            const name = (await vscode.window.showInputBox({
                title: 'Create Version',
                prompt: 'Version name',
                value: `Odoo ${odooVersion}`,
                ignoreFocusOut: true,
                validateInput: value => value.trim() ? undefined : 'Name is required.'
            }))?.trim();
            if (!name) { return; }

            const version = await versionsService.createVersion(name, odooVersion);
            await refreshAll({ reason: 'ui' });

            const action = await showInfo(
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

    context.subscriptions.push(vscode.commands.registerCommand('odoo.openVersionDefaults', async () => {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:AhmadMansour.odoo-devtools-vscode odooDebugger.defaultVersion');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.changeBranch', async (versionIdOrTreeItem?: any) => {
        try {
            const versionId = extractVersionIdFromArg(versionIdOrTreeItem);
            if (!versionId) {
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

    context.subscriptions.push(vscode.commands.registerCommand('odoo.setActiveVersion', async (versionIdOrTreeItem?: any) => {
        try {
            let versionId = extractVersionIdFromArg(versionIdOrTreeItem);
            if (!versionId) {
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
                if (version) {
                    // Align the core repos to the version's branch through the
                    // shared switch pipeline (honors databaseSwitchBehavior).
                    await alignEnvironment({ versionId: version.id }, { label: `Version "${version.name}"` });
                }
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

    context.subscriptions.push(vscode.commands.registerCommand('odoo.editVersionSetting', async (versionIdOrTreeItem?: any, settingKey?: string, currentValue?: any) => {
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

            if (['customAddonsPath'].includes(key)) {
                invalidateRepositoryDiscoveryCache();
                invalidateModuleDiscoveryCache();
            } else if (['odooPath', 'enterprisePath', 'designThemesPath', 'subModulesPaths'].includes(key)) {
                invalidateModuleDiscoveryCache();
            }

            showInfo(`Updated ${key} successfully`);
            await refreshAll();
        } catch (error: any) {
            showError(`Failed to edit setting: ${error.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.cloneVersion', async (versionIdOrTreeItem?: any) => {
        try {
            let versionId = extractVersionIdFromArg(versionIdOrTreeItem);
            if (!versionId) {
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

    context.subscriptions.push(vscode.commands.registerCommand('odoo.deleteVersion', async (versionIdOrTreeItem?: any) => {
        try {
            let versionId = extractVersionIdFromArg(versionIdOrTreeItem);
            if (!versionId) {
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

            const confirm = await showModalWarning(
                `Are you sure you want to delete version "${version.name}"?`,
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
    context.subscriptions.push(vscode.commands.registerCommand('odoo.setSettingToDefault', async (settingTreeItem?: any) => {
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

    context.subscriptions.push(vscode.commands.registerCommand('odoo.setSettingAsDefault', async (settingTreeItem?: any) => {
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

    context.subscriptions.push(vscode.commands.registerCommand('odoo.setAllSettingsToDefault', async (versionTreeItem?: any) => {
        try {
            const versionId = extractVersionIdFromArg(versionTreeItem);
            if (!versionId) {
                showError('Select a version before continuing.');
                return;
            }

            const version = versionsService.getVersion(versionId);
            if (!version) {
                showError('The selected version could not be found.');
                return;
            }

            const confirm = await showWarning(
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

    context.subscriptions.push(vscode.commands.registerCommand('odoo.setAllSettingsAsDefault', async (versionTreeItem?: any) => {
        try {
            const versionId = extractVersionIdFromArg(versionTreeItem);
            if (!versionId) {
                showError('Select a version before continuing.');
                return;
            }

            const version = versionsService.getVersion(versionId);
            if (!version) {
                showError('The selected version could not be found.');
                return;
            }

            const confirm = await showWarning(
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

    context.subscriptions.push(vscode.commands.registerCommand('odoo.refreshVersions', async () => {
        await versionsService.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.manageVersions', async () => {
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
    context.subscriptions.push(vscode.commands.registerCommand('odoo.startServer', async () => {
        await startDebugServer();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.startShell', async () => {
        await startDebugShell();
    }));

}

export function deactivate() {
    // All cleanup runs through context.subscriptions.
}
