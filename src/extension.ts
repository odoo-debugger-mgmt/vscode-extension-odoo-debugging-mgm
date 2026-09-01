import * as vscode from 'vscode';
import * as fs from 'node:fs';

import { DbsTreeProvider } from './views/dbsView';
import { migrateLegacySwitchBehaviorSetting } from './services/environment';
import { migrateDebuggerData } from './services/dataMigration';
import { ProjectTreeProvider } from './project';
import { RepoTreeProvider } from './repos';
import { ModuleTreeProvider } from './module';
import { TestingTreeProvider } from './testing';
import { setupDebugger } from './debugger';
import { SettingsStore } from './settingsStore';
import { VersionsTreeProvider } from './versionsTreeProvider';
import { VersionsService } from './versionsService';
import { updateTestingContext, updateActiveContext, updateServerRunningContext, updateConfiguredContext } from './context';
import { registerServerLifecycle } from './services/server';
import type { DatabaseModel } from './models/db';
import { SortPreferences } from './sortPreferences';
import { ProjectReposExplorerProvider } from './projectReposExplorer';
import { logger, registerLogger } from './services/logger';
import { logStaleReferences } from './services/reconcile';
import { invalidateRunningState } from './services/runningState';
import { registerWrongCopyGuard } from './services/wrongCopyGuard';
import { readSetupState, shouldAdoptLegacySourceRepo, readRawSetupSettings, writeSetupSettings } from './services/setupState';
import { showInfo } from './services/notifications';
import { getDefaultVersionSettings, normalizePath } from './utils';
import { StatusBarIndicators } from './views/statusBar';
import { registerAllCommands, RefreshReason } from './commands';

/** Syncs the testing context key with the selected project's testing state. */
async function initializeTestingContext(): Promise<void> {
    try {
        const result = await SettingsStore.getSelectedProject();
        updateTestingContext(!!result?.project?.testingConfig?.isEnabled);
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

    // Setup state gates the welcome buttons and the first-run prompt. Adopting
    // a pre-existing defaultVersion.odooPath first means nobody already working
    // is asked to set up something they have effectively already set up.
    await adoptLegacySourceRepo();
    updateConfiguredContext(readSetupState().isConfigured);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('odooDebugger.sourceRepo') || event.affectsConfiguration('odooDebugger.provisioning.root')) {
            updateConfiguredContext(readSetupState().isConfigured);
        }
    }));

    await initializeTestingContext();

    const providers = {
        project: new ProjectTreeProvider(context, sortPreferences),
        repo: new RepoTreeProvider(context, sortPreferences),
        db: new DbsTreeProvider(sortPreferences),
        module: new ModuleTreeProvider(context, sortPreferences),
        testing: new TestingTreeProvider(context),
        versions: new VersionsTreeProvider(sortPreferences),
        projectReposExplorer: new ProjectReposExplorerProvider(sortPreferences)
    };

    // React to version changes fired by VersionsService.refresh(). Must be
    // registered before the migrations below, which may fire it, and outside
    // the provider so re-activation cannot double-register the command.
    context.subscriptions.push(vscode.commands.registerCommand('odoo.versionsChanged', () => {
        providers.versions.refresh();
    }));
    // Providers own event emitters (and the explorer owns file watchers)
    // that need disposal with the extension.
    context.subscriptions.push(...Object.values(providers));

    const statusBar = new StatusBarIndicators();
    context.subscriptions.push(statusBar);

    // Track the extension's own debug sessions for when-clauses and the
    // optional open-browser-on-start automation. Registered further down,
    // once refreshViews exists for it to call.
    updateServerRunningContext(false);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('odooDebugger.statusBar.enabled')) {
            void statusBar.update();
        }
    }));

    // One-time v1.2 migrations: fold legacy per-DB odooVersion into versions,
    // and map old databaseSwitchBehavior values onto the new auto/ask/never
    // enum. Runs after provider construction so the versions-changed refresh
    // command used when new profiles are created is already registered.
    await migrateDebuggerData();
    void migrateLegacySwitchBehaviorSetting();
    // Passive check only: stale references are logged, never prompted about.
    void logStaleReferences();

    context.subscriptions.push(vscode.window.registerTreeDataProvider('projectSelector', providers.project));
    context.subscriptions.push(vscode.window.registerTreeDataProvider('repoSelector', providers.repo));
    context.subscriptions.push(vscode.window.registerTreeDataProvider('dbSelector', providers.db));
    // The Modules view needs a TreeView handle: reveal() for the editor
    // "Reveal Module" command and canSelectMany for bulk state changes.
    const moduleTreeView = vscode.window.createTreeView('moduleSelector', {
        treeDataProvider: providers.module,
        canSelectMany: true,
        showCollapseAll: true
    });
    context.subscriptions.push(moduleTreeView);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('testingSelector', providers.testing));
    context.subscriptions.push(vscode.window.registerTreeDataProvider('versionsManager', providers.versions));
    context.subscriptions.push(vscode.window.registerTreeDataProvider('odt.projectReposExplorer', providers.projectReposExplorer));

    // ------------------------------------------------------------------
    // Refresh machinery: UI refreshes update every provider; debugger
    // refreshes rewrite launch.json (debounced, single-flight).
    // ------------------------------------------------------------------

    const refreshViews = async () => {
        await initializeTestingContext();
        Object.values(providers).forEach(provider => provider.refresh());
        await statusBar.update();
    };

    registerServerLifecycle(context, {
        onRunningChanged: running => {
            updateServerRunningContext(running);
            // A session just started or stopped: the cached probe is stale and
            // the Databases view is showing the previous state.
            invalidateRunningState();
            // Fire-and-forget from an event handler: an unhandled rejection
            // here would surface as a bare error in the Debug Console.
            refreshViews().catch(error => logger.warn('Refresh after a debug session change failed:', error));
        },
        getSelectedDbName: async () => {
            const result = await SettingsStore.getSelectedProject();
            const db = (result?.project.dbs as DatabaseModel[] | undefined)?.find(entry => entry.isSelected);
            return db?.id;
        }
    });

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
            void runDebuggerSync()
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

    registerAllCommands({ context, providers, versionsService, sortPreferences, moduleTreeView, refreshAll });
    registerWrongCopyGuard(context);

    void statusBar.update();
    promptFirstRunSetup(context).catch(error => logger.warn('First-run setup prompt failed:', error));
}

/**
 * Before this design, `defaultVersion.odooPath` doubled as the repository
 * worktrees were cut from, so an existing user already has it pointed at a
 * real checkout. Adopting it silently keeps the upgrade invisible to them.
 */
async function adoptLegacySourceRepo(): Promise<void> {
    try {
        const legacy = getDefaultVersionSettings().odooPath;
        const adopted = shouldAdoptLegacySourceRepo(
            readRawSetupSettings(),
            legacy ? normalizePath(legacy) : undefined,
            candidate => fs.existsSync(candidate)
        );
        if (adopted) {
            await writeSetupSettings({ sourceRepo: adopted });
            logger.info(`[setup] adopted the existing odooPath as the source repository: ${adopted}`);
        }
    } catch (error) {
        logger.debug('Could not adopt a legacy source repository:', error);
    }
}

/** One dismissible nudge; "Later" is remembered so it never nags. */
const FIRST_RUN_DISMISSED_KEY = 'odooDevtools.setupPromptDismissed';

async function promptFirstRunSetup(context: vscode.ExtensionContext): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
        return;
    }
    if (readSetupState().isConfigured || context.globalState.get<boolean>(FIRST_RUN_DISMISSED_KEY)) {
        return;
    }

    const choice = await showInfo("Odoo DevTools isn't set up yet.", 'Set Up', 'Later');
    if (choice === 'Set Up') {
        await vscode.commands.executeCommand('odoo.setup');
    } else if (choice === 'Later') {
        // Remembered globally: a per-window nag is worse than no nag at all.
        await context.globalState.update(FIRST_RUN_DISMISSED_KEY, true);
    }
}

export function deactivate() {
    // All cleanup runs through context.subscriptions.
}
