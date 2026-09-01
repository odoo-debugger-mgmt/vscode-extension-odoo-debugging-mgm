/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ([
/* 0 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(__webpack_require__(1));
const fs = __importStar(__webpack_require__(2));
const dbsView_1 = __webpack_require__(3);
const environment_1 = __webpack_require__(31);
const dataMigration_1 = __webpack_require__(52);
const project_1 = __webpack_require__(53);
const repos_1 = __webpack_require__(61);
const module_1 = __webpack_require__(62);
const testing_1 = __webpack_require__(65);
const debugger_1 = __webpack_require__(67);
const settingsStore_1 = __webpack_require__(6);
const versionsTreeProvider_1 = __webpack_require__(75);
const versionsService_1 = __webpack_require__(24);
const context_1 = __webpack_require__(66);
const server_1 = __webpack_require__(76);
const sortPreferences_1 = __webpack_require__(77);
const projectReposExplorer_1 = __webpack_require__(78);
const logger_1 = __webpack_require__(12);
const reconcile_1 = __webpack_require__(49);
const runningState_1 = __webpack_require__(50);
const wrongCopyGuard_1 = __webpack_require__(80);
const setupState_1 = __webpack_require__(64);
const notifications_1 = __webpack_require__(16);
const utils_1 = __webpack_require__(8);
const statusBar_1 = __webpack_require__(81);
const commands_1 = __webpack_require__(82);
/** Syncs the testing context key with the selected project's testing state. */
async function initializeTestingContext() {
    try {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        (0, context_1.updateTestingContext)(!!result?.project?.testingConfig?.isEnabled);
    }
    catch (error) {
        // If there's an error, default to testing disabled
        logger_1.logger.warn('Error initializing testing context:', error);
        (0, context_1.updateTestingContext)(false);
    }
}
async function activate(context) {
    (0, logger_1.registerLogger)(context);
    const sortPreferences = new sortPreferences_1.SortPreferences(context.workspaceState);
    // Initialize version management service
    const versionsService = versionsService_1.VersionsService.getInstance();
    await versionsService.initialize();
    // Migrate existing settings to version management for backwards compatibility
    // Wait for migration to complete to ensure proper initialization order
    await versionsService.migrateFromLegacySettings().catch(error => {
        logger_1.logger.warn('Settings migration failed (this is non-critical):', error);
    });
    const isWorkspaceOpen = !!vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
    (0, context_1.updateActiveContext)(isWorkspaceOpen);
    // Setup state gates the welcome buttons and the first-run prompt. Adopting
    // a pre-existing defaultVersion.odooPath first means nobody already working
    // is asked to set up something they have effectively already set up.
    await adoptLegacySourceRepo();
    (0, context_1.updateConfiguredContext)((0, setupState_1.readSetupState)().isConfigured);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('odooDebugger.sourceRepo') || event.affectsConfiguration('odooDebugger.provisioning.root')) {
            (0, context_1.updateConfiguredContext)((0, setupState_1.readSetupState)().isConfigured);
        }
    }));
    await initializeTestingContext();
    const providers = {
        project: new project_1.ProjectTreeProvider(context, sortPreferences),
        repo: new repos_1.RepoTreeProvider(context, sortPreferences),
        db: new dbsView_1.DbsTreeProvider(sortPreferences),
        module: new module_1.ModuleTreeProvider(context, sortPreferences),
        testing: new testing_1.TestingTreeProvider(context),
        versions: new versionsTreeProvider_1.VersionsTreeProvider(sortPreferences),
        projectReposExplorer: new projectReposExplorer_1.ProjectReposExplorerProvider(sortPreferences)
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
    const statusBar = new statusBar_1.StatusBarIndicators();
    context.subscriptions.push(statusBar);
    // Track the extension's own debug sessions for when-clauses and the
    // optional open-browser-on-start automation. Registered further down,
    // once refreshViews exists for it to call.
    (0, context_1.updateServerRunningContext)(false);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('odooDebugger.statusBar.enabled')) {
            void statusBar.update();
        }
    }));
    // One-time v1.2 migrations: fold legacy per-DB odooVersion into versions,
    // and map old databaseSwitchBehavior values onto the new auto/ask/never
    // enum. Runs after provider construction so the versions-changed refresh
    // command used when new profiles are created is already registered.
    await (0, dataMigration_1.migrateDebuggerData)();
    void (0, environment_1.migrateLegacySwitchBehaviorSetting)();
    // Passive check only: stale references are logged, never prompted about.
    void (0, reconcile_1.logStaleReferences)();
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
    (0, server_1.registerServerLifecycle)(context, {
        onRunningChanged: running => {
            (0, context_1.updateServerRunningContext)(running);
            // A session just started or stopped: the cached probe is stale and
            // the Databases view is showing the previous state.
            (0, runningState_1.invalidateRunningState)();
            // Fire-and-forget from an event handler: an unhandled rejection
            // here would surface as a bare error in the Debug Console.
            refreshViews().catch(error => logger_1.logger.warn('Refresh after a debug session change failed:', error));
        },
        getSelectedDbName: async () => {
            const result = await settingsStore_1.SettingsStore.getSelectedProject();
            const db = result?.project.dbs?.find(entry => entry.isSelected);
            return db?.id;
        }
    });
    let debuggerSyncTimer;
    let debuggerSyncInFlight = null;
    let debuggerSyncWaiters = [];
    const runDebuggerSync = async () => {
        if (debuggerSyncInFlight) {
            await debuggerSyncInFlight;
            return;
        }
        debuggerSyncInFlight = (async () => {
            try {
                await (0, debugger_1.setupDebugger)();
            }
            catch (error) {
                // Keeping this non-blocking so refresh still occurs when launch sync fails
                logger_1.logger.warn('Failed to synchronize debugger configuration:', error);
            }
        })();
        try {
            await debuggerSyncInFlight;
        }
        finally {
            debuggerSyncInFlight = null;
        }
    };
    const syncDebuggerDebounced = (delayMs = 200) => new Promise(resolve => {
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
    const refreshAll = async (options = {}) => {
        const { reason = 'all', debounceMs = 200 } = options;
        if (reason === 'all' || reason === 'debugger') {
            await syncDebuggerDebounced(debounceMs);
        }
        if (reason === 'all' || reason === 'ui') {
            await refreshViews();
        }
    };
    (0, commands_1.registerAllCommands)({ context, providers, versionsService, sortPreferences, moduleTreeView, refreshAll });
    (0, wrongCopyGuard_1.registerWrongCopyGuard)(context);
    void statusBar.update();
    promptFirstRunSetup(context).catch(error => logger_1.logger.warn('First-run setup prompt failed:', error));
}
/**
 * Before this design, `defaultVersion.odooPath` doubled as the repository
 * worktrees were cut from, so an existing user already has it pointed at a
 * real checkout. Adopting it silently keeps the upgrade invisible to them.
 */
async function adoptLegacySourceRepo() {
    try {
        const legacy = (0, utils_1.getDefaultVersionSettings)().odooPath;
        const adopted = (0, setupState_1.shouldAdoptLegacySourceRepo)((0, setupState_1.readRawSetupSettings)(), legacy ? (0, utils_1.normalizePath)(legacy) : undefined, candidate => fs.existsSync(candidate));
        if (adopted) {
            await (0, setupState_1.writeSetupSettings)({ sourceRepo: adopted });
            logger_1.logger.info(`[setup] adopted the existing odooPath as the source repository: ${adopted}`);
        }
    }
    catch (error) {
        logger_1.logger.debug('Could not adopt a legacy source repository:', error);
    }
}
/** One dismissible nudge; "Later" is remembered so it never nags. */
const FIRST_RUN_DISMISSED_KEY = 'odooDevtools.setupPromptDismissed';
async function promptFirstRunSetup(context) {
    if (!vscode.workspace.workspaceFolders?.length) {
        return;
    }
    if ((0, setupState_1.readSetupState)().isConfigured || context.globalState.get(FIRST_RUN_DISMISSED_KEY)) {
        return;
    }
    const choice = await (0, notifications_1.showInfo)("Odoo DevTools isn't set up yet.", 'Set Up', 'Later');
    if (choice === 'Set Up') {
        await vscode.commands.executeCommand('odoo.setup');
    }
    else if (choice === 'Later') {
        // Remembered globally: a per-window nag is worse than no nag at all.
        await context.globalState.update(FIRST_RUN_DISMISSED_KEY, true);
    }
}
function deactivate() {
    // All cleanup runs through context.subscriptions.
}


/***/ }),
/* 1 */
/***/ ((module) => {

module.exports = require("vscode");

/***/ }),
/* 2 */
/***/ ((module) => {

module.exports = require("node:fs");

/***/ }),
/* 3 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.DbsTreeProvider = void 0;
const vscode = __importStar(__webpack_require__(1));
const path = __importStar(__webpack_require__(4));
const baseTreeProvider_1 = __webpack_require__(5);
const settingsStore_1 = __webpack_require__(6);
const versionsService_1 = __webpack_require__(24);
const sortOptions_1 = __webpack_require__(29);
const utils_1 = __webpack_require__(8);
const icons_1 = __webpack_require__(30);
const environment_1 = __webpack_require__(31);
const dbs_1 = __webpack_require__(36);
const runningState_1 = __webpack_require__(50);
/** Tree provider for the Databases view of the selected project. */
class DbsTreeProvider extends baseTreeProvider_1.BaseTreeProvider {
    sortPreferences;
    constructor(sortPreferences) {
        super();
        this.sortPreferences = sortPreferences;
    }
    getTreeItem(item) {
        return item;
    }
    async getChildren(_element) {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            return [];
        }
        // Empty list: the view's welcome content offers "Create Database".
        const { project } = result;
        const dbs = project.dbs;
        if (!dbs) {
            return [];
        }
        const sortId = this.sortPreferences.get('dbSelector', (0, sortOptions_1.getDefaultSortOption)('dbSelector'));
        const sortedDbs = [...dbs].sort((a, b) => this.compareDatabases(a, b, sortId));
        // Probed once per refresh, not once per row.
        const running = new Map((await (0, runningState_1.getRunningInstances)()).map(instance => [instance.dbName, instance]));
        return sortedDbs.map(db => this.buildDatabaseItem(db, running.get(db.id)));
    }
    buildDatabaseItem(db, running) {
        // Handle date parsing defensively
        let editedDate = new Date(db.createdAt);
        if (isNaN(editedDate.getTime())) {
            editedDate = new Date();
        }
        const formattedDate = `${editedDate.toISOString().split('T')[0]} ${editedDate.toTimeString().split(' ')[0]}`;
        const dbLabel = (0, utils_1.getDatabaseLabel)(db);
        const treeItem = new vscode.TreeItem(dbLabel, vscode.TreeItemCollapsibleState.None);
        treeItem.id = db.id;
        treeItem.iconPath = db.isSelected ? icons_1.activeIcon : new vscode.ThemeIcon('database');
        treeItem.description = this.buildDescription(db, running);
        treeItem.tooltip = new vscode.MarkdownString(this.buildTooltip(db, dbLabel, formattedDate, running));
        treeItem.contextValue = 'database';
        // Store the database object for commands that need it
        treeItem.database = db;
        treeItem.command = {
            command: 'dbSelector.selectDb',
            title: 'Select DB',
            arguments: [db]
        };
        return treeItem;
    }
    /** Description shows running state, branch, version and origin as subtext. */
    buildDescription(db, running) {
        const parts = [];
        // Running state leads: when switching databases, what is already up is
        // the thing worth seeing first.
        const runningPart = (0, runningState_1.runningDescriptionPart)(running);
        if (runningPart) {
            parts.push(runningPart);
        }
        if (db.versionId) {
            const version = this.lookupVersion(db.versionId);
            const versionLabel = version ? version.name : `${db.versionId.substring(0, 8)}...`;
            if (db.branchName && db.branchName !== version?.odooVersion) {
                parts.push(db.branchName);
            }
            parts.push(versionLabel);
        }
        else if (db.branchName && db.branchName.trim() !== '') {
            parts.push(db.branchName);
            const effectiveOdooVersion = (0, dbs_1.getEffectiveOdooVersion)(db);
            if (effectiveOdooVersion && effectiveOdooVersion !== db.branchName) {
                parts.push(effectiveOdooVersion);
            }
        }
        else {
            const effectiveOdooVersion = (0, dbs_1.getEffectiveOdooVersion)(db);
            if (effectiveOdooVersion && effectiveOdooVersion.trim() !== '') {
                parts.push(effectiveOdooVersion);
            }
        }
        if (db.isItABackup) {
            parts.push('backup');
        }
        if (db.isExisting) {
            parts.push('existing');
        }
        return parts.join(' • ');
    }
    buildTooltip(db, dbLabel, formattedDate, running) {
        const tooltipDetails = [];
        tooltipDetails.push(`**${dbLabel}**`);
        tooltipDetails.push(`**Internal name:** ${db.id}`);
        if (running) {
            tooltipDetails.push(running.origin === 'managed'
                ? `**Status:** running${running.port ? ` on port ${running.port}` : ''}`
                : `**Status:** running outside this window`);
        }
        if (db.versionId) {
            const version = this.lookupVersion(db.versionId);
            if (version) {
                tooltipDetails.push(`**Version:** ${version.name}`);
                tooltipDetails.push(`**Odoo Version:** ${version.odooVersion}`);
            }
            else {
                tooltipDetails.push(`**Version ID:** ${db.versionId}`);
            }
        }
        else {
            tooltipDetails.push(`**Version:** None`);
            const effectiveOdooVersion = (0, dbs_1.getEffectiveOdooVersion)(db);
            if (effectiveOdooVersion) {
                tooltipDetails.push(`**Odoo Version:** ${effectiveOdooVersion}`);
            }
        }
        if (db.branchName) {
            tooltipDetails.push(`**Branch:** ${db.branchName}`);
        }
        const projectRepoBranches = (0, environment_1.sanitizeProjectRepoBranchAssignments)(db.projectRepoBranches);
        if (projectRepoBranches.length > 0) {
            const formattedRepoBranches = projectRepoBranches
                .map(entry => `- ${entry.repoName || path.basename(entry.repoPath)}: \`${entry.branch}\``)
                .join('\n');
            tooltipDetails.push(`**Project Repo Branches:**\n${formattedRepoBranches}`);
        }
        tooltipDetails.push(`**Created:** ${formattedDate}`);
        if (db.kind === 'template') {
            tooltipDetails.push(`**Type:** Created from template`);
        }
        else if (db.isItABackup) {
            tooltipDetails.push(`**Type:** Restored from backup`);
            if (db.sqlFilePath) {
                tooltipDetails.push(`**Backup Path:** ${db.sqlFilePath}`);
            }
        }
        else if (db.isExisting) {
            tooltipDetails.push(`**Type:** Connected to existing database`);
        }
        else {
            tooltipDetails.push(`**Type:** Fresh database`);
        }
        if (db.isSelected) {
            tooltipDetails.push(`**Status:** Currently selected`);
        }
        if (db.modules && db.modules.length > 0) {
            tooltipDetails.push(`**Modules:** ${db.modules.length} installed`);
        }
        return tooltipDetails.join('\n\n');
    }
    lookupVersion(versionId) {
        try {
            return versionsService_1.VersionsService.getInstance().getVersion(versionId);
        }
        catch {
            return undefined;
        }
    }
    compareDatabases(a, b, sortId) {
        const activeDelta = Number(b.isSelected) - Number(a.isSelected);
        if (activeDelta !== 0) {
            return activeDelta;
        }
        switch (sortId) {
            case 'db:name:asc':
                return this.getNameValue(a).localeCompare(this.getNameValue(b));
            case 'db:name:desc':
                return this.getNameValue(b).localeCompare(this.getNameValue(a));
            case 'db:created:newest':
                return this.getCreatedTimestamp(b) - this.getCreatedTimestamp(a);
            case 'db:created:oldest':
                return this.getCreatedTimestamp(a) - this.getCreatedTimestamp(b);
            case 'db:branch:asc':
                return this.compareBranch(a, b, false);
            case 'db:branch:desc':
                return this.compareBranch(a, b, true);
            default:
                return this.getNameValue(a).localeCompare(this.getNameValue(b));
        }
    }
    getCreatedTimestamp(db) {
        if (db.createdAt instanceof Date) {
            return db.createdAt.getTime();
        }
        const date = new Date(db.createdAt);
        return isNaN(date.getTime()) ? 0 : date.getTime();
    }
    getBranchValue(db) {
        if (db.branchName && db.branchName.trim() !== '') {
            return db.branchName.toLowerCase();
        }
        const effective = (0, dbs_1.getEffectiveOdooVersion)(db);
        return effective ? effective.toLowerCase() : '';
    }
    getNameValue(db) {
        return (0, utils_1.getDatabaseLabel)(db).toLowerCase();
    }
    compareBranch(a, b, descending) {
        const aBranch = this.getBranchValue(a);
        const bBranch = this.getBranchValue(b);
        const aHas = aBranch.trim().length > 0;
        const bHas = bBranch.trim().length > 0;
        const missingDelta = Number(bHas) - Number(aHas);
        if (missingDelta !== 0) {
            return descending ? -missingDelta : missingDelta;
        }
        if (descending) {
            return bBranch.localeCompare(aBranch);
        }
        return aBranch.localeCompare(bBranch);
    }
}
exports.DbsTreeProvider = DbsTreeProvider;


/***/ }),
/* 4 */
/***/ ((module) => {

module.exports = require("node:path");

/***/ }),
/* 5 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.BaseTreeProvider = void 0;
const vscode = __importStar(__webpack_require__(1));
/**
 * Shared base for the extension's tree data providers: owns the change
 * emitter (and disposes it), and exposes refresh() supporting both full and
 * element-scoped updates. Register instances in context.subscriptions so the
 * emitter is cleaned up on deactivation.
 */
class BaseTreeProvider {
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    /** Refreshes the whole tree, or only `element` when provided. */
    refresh(element) {
        this._onDidChangeTreeData.fire(element);
    }
    dispose() {
        this._onDidChangeTreeData.dispose();
    }
}
exports.BaseTreeProvider = BaseTreeProvider;


/***/ }),
/* 6 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.SettingsStore = void 0;
/**
 * Workspace data store for .vscode/odoo-debugger-data.json: mtime-based
 * read cache and debounced, single-flight writes.
 */
const settings_1 = __webpack_require__(7);
const utils_1 = __webpack_require__(8);
const jsonc_parser_1 = __webpack_require__(17);
const fs = __importStar(__webpack_require__(23));
const path_1 = __importDefault(__webpack_require__(10));
const logger_1 = __webpack_require__(12);
const WRITE_DEBOUNCE_MS = 25;
class SettingsStore {
    static cache = new Map();
    static pendingWrites = new Map();
    static cloneData(value) {
        if (typeof structuredClone === 'function') {
            return structuredClone(value);
        }
        return JSON.parse(JSON.stringify(value));
    }
    static resolveFilePath(fileName) {
        const workspacePath = (0, utils_1.getWorkspacePath)();
        if (!workspacePath) {
            return undefined;
        }
        return path_1.default.join(workspacePath, '.vscode', fileName);
    }
    static async updateCache(fileName, filePath, raw, data) {
        // Fall back to "now" when stat fails (e.g. file not written yet).
        const stats = await fs.stat(filePath).catch(() => undefined);
        const mtimeMs = stats?.mtimeMs ?? Date.now();
        this.cache.set(fileName, {
            mtimeMs,
            raw,
            data: this.cloneData(data)
        });
    }
    static async ensureDataLoaded(fileName, filePath) {
        const loaded = await (0, utils_1.readFromFile)(fileName);
        if (!loaded) {
            throw new Error(`Error reading file: ${fileName}`);
        }
        const raw = await fs.readFile(filePath, 'utf-8').catch(() => JSON.stringify(loaded, null, 4));
        await this.updateCache(fileName, filePath, raw, loaded);
        return this.cloneData(loaded);
    }
    static async flushPendingWrite(fileName) {
        const pending = this.pendingWrites.get(fileName);
        if (!pending) {
            return;
        }
        this.pendingWrites.delete(fileName);
        if (pending.timer) {
            clearTimeout(pending.timer);
            pending.timer = undefined;
        }
        try {
            const jsonString = JSON.stringify(pending.data, null, 4);
            await fs.writeFile(pending.filePath, jsonString, 'utf8');
            await this.updateCache(fileName, pending.filePath, jsonString, pending.data);
            pending.waiters.forEach(waiter => waiter.resolve());
        }
        catch (error) {
            pending.waiters.forEach(waiter => waiter.reject(error));
            throw error;
        }
    }
    /**
     * Helper function to read raw file content for JSON modification
     */
    static async readRawFileContent(fileName) {
        const filePath = this.resolveFilePath(fileName);
        if (!filePath) {
            return null;
        }
        try {
            const stats = await fs.stat(filePath).catch(() => undefined);
            if (!stats) {
                return null;
            }
            const cached = this.cache.get(fileName);
            if (cached && cached.mtimeMs === stats.mtimeMs) {
                return cached.raw;
            }
            const raw = await fs.readFile(filePath, 'utf-8');
            const parsed = (0, jsonc_parser_1.parse)(raw);
            await this.updateCache(fileName, filePath, raw, parsed ?? {});
            return raw;
        }
        catch (error) {
            void (0, utils_1.showError)(`Failed to read raw content from ${fileName}: ${error}`);
            return null;
        }
    }
    static async get(fileName) {
        const filePath = this.resolveFilePath(fileName);
        if (!filePath) {
            throw new Error(`Open a workspace before reading ${fileName}.`);
        }
        await this.flushPendingWrite(fileName);
        const stats = await fs.stat(filePath).catch(() => undefined);
        if (stats) {
            const cached = this.cache.get(fileName);
            if (cached && cached.mtimeMs === stats.mtimeMs) {
                return this.cloneData(cached.data);
            }
        }
        return this.ensureDataLoaded(fileName, filePath);
    }
    static async saveWithComments(value, jsonPath, fileName, options = {}) {
        const filePath = this.resolveFilePath(fileName);
        if (!filePath) {
            return;
        }
        await this.flushPendingWrite(fileName);
        const rawData = await this.readRawFileContent(fileName);
        if (!rawData) {
            return;
        }
        const edits = (0, jsonc_parser_1.modify)(rawData, jsonPath, value, options);
        const updatedJson = (0, jsonc_parser_1.applyEdits)(rawData, edits);
        await fs.writeFile(filePath, updatedJson, 'utf8');
        const parsed = (0, jsonc_parser_1.parse)(updatedJson);
        await this.updateCache(fileName, filePath, updatedJson, parsed ?? {});
    }
    /**
     * Saves the entire data object to file
     */
    static async saveWithoutComments(data, fileName = 'odoo-debugger-data.json') {
        const filePath = this.resolveFilePath(fileName);
        if (!filePath) {
            return;
        }
        const payload = this.cloneData(data);
        await new Promise((resolve, reject) => {
            const existing = this.pendingWrites.get(fileName);
            if (existing) {
                existing.data = payload;
                existing.waiters.push({ resolve, reject });
                if (existing.timer) {
                    clearTimeout(existing.timer);
                }
                existing.timer = setTimeout(() => {
                    this.flushPendingWrite(fileName).catch(error => {
                        logger_1.logger.warn(`Failed to flush pending write for ${fileName}:`, error);
                    });
                }, WRITE_DEBOUNCE_MS);
                return;
            }
            const pending = {
                fileName,
                filePath,
                data: payload,
                waiters: [{ resolve, reject }]
            };
            pending.timer = setTimeout(() => {
                this.flushPendingWrite(fileName).catch(error => {
                    logger_1.logger.warn(`Failed to flush pending write for ${fileName}:`, error);
                });
            }, WRITE_DEBOUNCE_MS);
            this.pendingWrites.set(fileName, pending);
        });
    }
    static async load() {
        const data = await this.get('odoo-debugger-data.json').catch(async () => {
            const fallback = await (0, utils_1.readFromFile)('odoo-debugger-data.json') || {};
            return fallback;
        });
        return {
            settings: data.settings ? Object.assign(new settings_1.SettingsModel((0, utils_1.getDefaultVersionSettings)()), data.settings) : undefined,
            projects: data.projects || [],
            versions: data.versions || {},
            activeVersion: data.activeVersion || '',
            dbTemplates: Array.isArray(data.dbTemplates) ? data.dbTemplates : []
        };
    }
    static async getProjects() {
        const data = await this.load();
        return data.projects || [];
    }
    static async updateProjects(projects) {
        const data = await this.load();
        data.projects = projects;
        await this.saveWithoutComments((0, utils_1.stripSettings)(data));
    }
    /**
     * Gets the currently selected project with validation
     */
    static async getSelectedProject() {
        const data = await this.get('odoo-debugger-data.json');
        const projects = data.projects;
        if (!projects || projects.length === 0) {
            void (0, utils_1.showError)('Unable to load projects, please create a project first');
            return null;
        }
        if (typeof projects !== 'object') {
            void (0, utils_1.showError)('Unable to load projects.');
            return null;
        }
        const project = projects.find((p) => p.isSelected === true);
        if (!project) {
            void (0, utils_1.showError)('Select a project before running this action.');
            return null;
        }
        return { data, project };
    }
}
exports.SettingsStore = SettingsStore;


/***/ }),
/* 7 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.SettingsModel = void 0;
/**
 * Runtime settings shape shared by versions (paths, ports, params).
 */
class SettingsModel {
    // Identity is derived from the version's branch (see versionIdentity.ts);
    // these blanks mark "not derived yet".
    debuggerName = "";
    debuggerVersion = "1.0.0";
    portNumber = 0;
    shellPortNumber = 0;
    limitTimeReal = 0;
    limitTimeCpu = 0;
    maxCronThreads = 0;
    extraParams = "--log-handler,odoo.addons.base.models.ir_attachment:WARNING";
    devMode = "--dev=all";
    dumpsFolder = "/dumps";
    odooPath = "./odoo";
    enterprisePath = "./enterprise";
    designThemesPath = "./design-themes";
    customAddonsPath = "./custom-addons";
    pythonPath = "./venv/bin/python";
    subModulesPaths = "";
    installApps = "";
    upgradeApps = "";
    postSwitchCommands = [];
    managedPaths = [];
    constructor(data) {
        if (data) {
            Object.assign(this, data);
        }
        this.postSwitchCommands = Array.isArray(this.postSwitchCommands) ? this.postSwitchCommands : [];
        this.managedPaths = Array.isArray(this.managedPaths) ? this.managedPaths : [];
    }
}
exports.SettingsModel = SettingsModel;


/***/ }),
/* 8 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.CONFIG = exports.showBriefStatus = exports.showAutoInfo = exports.showModalWarning = exports.showWarning = exports.showInfo = exports.showError = exports.showMessage = exports.MessageType = void 0;
exports.stripSettings = stripSettings;
exports.getDatabaseLabel = getDatabaseLabel;
exports.getWorkspacePath = getWorkspacePath;
exports.resolveOptionalPath = resolveOptionalPath;
exports.normalizePath = normalizePath;
exports.findModules = findModules;
exports.findRepositories = findRepositories;
exports.discoverModulesInRepos = discoverModulesInRepos;
exports.createInfoTreeItem = createInfoTreeItem;
exports.readFromFile = readFromFile;
exports.camelCaseToTitleCase = camelCaseToTitleCase;
exports.getSettingDisplayName = getSettingDisplayName;
exports.getSettingDisplayValue = getSettingDisplayValue;
exports.getGitBranches = getGitBranches;
exports.getDefaultVersionSettings = getDefaultVersionSettings;
/**
 * Shared utilities: workspace paths, module/repository discovery walkers,
 * data-file access helpers and setting display formatting. Messaging
 * helpers are re-exported from services/notifications.
 */
const vscode = __importStar(__webpack_require__(1));
const fs = __importStar(__webpack_require__(9));
const path = __importStar(__webpack_require__(10));
const settings_1 = __webpack_require__(7);
const gitService_1 = __webpack_require__(11);
const runtimeCache_1 = __webpack_require__(15);
const notifications_1 = __webpack_require__(16);
const process_1 = __webpack_require__(13);
const jsonc_parser_1 = __webpack_require__(17);
const logger_1 = __webpack_require__(12);
// Re-exported so existing `from './utils'` imports keep working; new code
// should import these from './services/notifications' directly.
var notifications_2 = __webpack_require__(16);
Object.defineProperty(exports, "MessageType", ({ enumerable: true, get: function () { return notifications_2.MessageType; } }));
Object.defineProperty(exports, "showMessage", ({ enumerable: true, get: function () { return notifications_2.showMessage; } }));
Object.defineProperty(exports, "showError", ({ enumerable: true, get: function () { return notifications_2.showError; } }));
Object.defineProperty(exports, "showInfo", ({ enumerable: true, get: function () { return notifications_2.showInfo; } }));
Object.defineProperty(exports, "showWarning", ({ enumerable: true, get: function () { return notifications_2.showWarning; } }));
Object.defineProperty(exports, "showModalWarning", ({ enumerable: true, get: function () { return notifications_2.showModalWarning; } }));
Object.defineProperty(exports, "showAutoInfo", ({ enumerable: true, get: function () { return notifications_2.showAutoInfo; } }));
Object.defineProperty(exports, "showBriefStatus", ({ enumerable: true, get: function () { return notifications_2.showBriefStatus; } }));
const launchJsonFileContent = `{
    // For more information, visit: https://go.microsoft.com/fwlink/?linkid=830387
    "version": "0.2.0",

    // Debug configurations for VS Code
    // Odoo configurations will be automatically added here by the Odoo Debugger extension
    "configurations": []
}`;
const debuggerDataFileContent = `{
    // Odoo Debugger Extension Configuration
    // This file stores your project settings and configurations
    "settings": {
        // Add your Odoo settings here
    },
    "projects": [],
    "dbTemplates": []
}`;
/**
 * Strip settings from DebuggerData to ensure settings are managed exclusively by versions
 */
function stripSettings(data) {
    return {
        projects: data.projects,
        versions: data.versions,
        activeVersion: data.activeVersion,
        dbTemplates: data.dbTemplates
    };
}
// ============================================================================
// CONFIGURATION
// ============================================================================
/**
 * Configuration options for file operations
 */
exports.CONFIG = {
    tabSize: 4,
    insertSpaces: true
};
// ============================================================================
// UI UTILITIES
// ============================================================================
/**
 * Returns a user-friendly database label prioritizing displayName, then name, then id.
 */
function getDatabaseLabel(db) {
    if (!db) {
        return 'Unknown Database';
    }
    const candidates = [
        typeof db.displayName === 'string' ? db.displayName.trim() : '',
        typeof db.name === 'string' ? db.name.trim() : '',
        typeof db.id === 'string' ? db.id.trim() : ''
    ].filter(Boolean);
    return candidates[0] || 'Unknown Database';
}
// ============================================================================
// WORKSPACE & PATH UTILITIES
// ============================================================================
/**
 * Gets the workspace folder path with validation
 * @returns workspace path or null if no workspace is open
 */
function getWorkspacePath() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        void (0, notifications_1.showError)("Open a workspace to use this command.");
        return null;
    }
    return workspaceFolders[0].uri.fsPath;
}
/**
 * Normalizes a path to be absolute, relative to workspace if needed
 */
/**
 * Absolute form of an optional stored path, or undefined when it is unset.
 * `normalizePath('')` yields the workspace root - which exists - so anything
 * testing a configured path for existence must go through this first.
 */
function resolveOptionalPath(stored) {
    const trimmed = stored?.trim();
    return trimmed ? normalizePath(trimmed) : undefined;
}
function normalizePath(inputPath) {
    if (path.isAbsolute(inputPath)) {
        return inputPath;
    }
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
        return inputPath; // Return as-is if no workspace
    }
    return path.join(workspacePath, inputPath);
}
// ============================================================================
// FILE SYSTEM UTILITIES
// ============================================================================
/**
 * Ensures the .vscode directory exists in the workspace
 * @param workspacePath - the workspace root path
 * @returns the .vscode directory path
 */
function ensureVSCodeDirectory(workspacePath) {
    const vscodeDir = path.join(workspacePath, '.vscode');
    try {
        if (!fs.existsSync(vscodeDir)) {
            fs.mkdirSync(vscodeDir, { recursive: true });
        }
    }
    catch (error) {
        throw new Error(`Failed to create .vscode directory: ${error}`);
    }
    return vscodeDir;
}
const DEFAULT_MODULE_EXCLUDES = [
    '**/node_modules/**',
    '**/.venv/**',
    '**/__pycache__/**',
    '**/.git/**'
];
const DEFAULT_REPOSITORY_EXCLUDES = [
    '**/node_modules/**',
    '**/.venv/**',
    '**/__pycache__/**'
];
function globToRegExp(pattern) {
    const normalizedPattern = pattern.split(path.sep).join('/');
    const placeholders = {
        doubleStar: '__GLOB_DOUBLE_STAR__',
        singleStar: '__GLOB_SINGLE_STAR__',
        question: '__GLOB_QUESTION__'
    };
    let working = normalizedPattern
        .replaceAll('**', placeholders.doubleStar)
        .replaceAll('*', placeholders.singleStar)
        .replaceAll('?', placeholders.question);
    working = working.replaceAll(/[.+^${}()|[\]\\]/g, String.raw `\$&`);
    working = working
        .replaceAll(new RegExp(placeholders.doubleStar, 'g'), '.*')
        .replaceAll(new RegExp(placeholders.singleStar, 'g'), '[^/]*')
        .replaceAll(new RegExp(placeholders.question, 'g'), '[^/]');
    return new RegExp(`^${working}$`, 'i');
}
function compilePatterns(patterns) {
    return patterns.map(globToRegExp);
}
function shouldExcludePath(fullPath, root, regexes) {
    if (regexes.length === 0) {
        return false;
    }
    const normalized = fullPath.split(path.sep).join('/');
    const relative = normalized.startsWith(root) ? normalized.slice(root.length) : normalized;
    const candidates = new Set();
    candidates.add(normalized);
    candidates.add(`${normalized}/`);
    if (relative) {
        const trimmed = relative.replace(/^\//, '');
        candidates.add(trimmed);
        candidates.add(`${trimmed}/`);
    }
    for (const candidate of candidates) {
        for (const regex of regexes) {
            if (regex.test(candidate)) {
                return true;
            }
        }
    }
    return false;
}
function getSearchOptions(kind, overrides = {}) {
    const { maxDepth, maxEntries, patterns } = resolveSearchConfig(kind, overrides);
    return {
        maxDepth,
        maxEntries,
        excludeRegexes: compilePatterns(patterns),
        token: overrides.token
    };
}
function resolveSearchConfig(kind, overrides = {}) {
    const config = vscode.workspace.getConfiguration('odooDebugger.search');
    const maxDepth = Math.max(0, overrides.maxDepth ?? config.get('maxDepth', 4));
    const maxEntries = Math.max(1, overrides.maxEntries ?? config.get('maxEntries', 100000));
    const patternKey = kind === 'modules' ? 'excludePatterns.modules' : 'excludePatterns.repositories';
    const defaults = kind === 'modules' ? DEFAULT_MODULE_EXCLUDES : DEFAULT_REPOSITORY_EXCLUDES;
    const patterns = overrides.excludePatterns ?? config.get(patternKey, defaults);
    return { maxDepth, maxEntries, patterns };
}
function buildDiscoveryCacheKey(kind, targetPath, overrides = {}) {
    const normalizedRoot = path.resolve(normalizePath(targetPath));
    const { maxDepth, maxEntries, patterns } = resolveSearchConfig(kind, overrides);
    return JSON.stringify({
        kind,
        normalizedRoot,
        maxDepth,
        maxEntries,
        patterns
    });
}
function discoverDirectories(targetPath, kind, options) {
    if (!targetPath) {
        void (0, notifications_1.showError)('Enter a target path to continue.');
        return [];
    }
    const normalizedRoot = normalizePath(targetPath);
    if (!fs.existsSync(normalizedRoot)) {
        void (0, notifications_1.showError)(`Path does not exist: ${normalizedRoot}`);
        return [];
    }
    const stack = [{ dir: normalizedRoot, depth: 0 }];
    const visited = new Set();
    const results = [];
    const resultPaths = new Set();
    let processed = 0;
    let limitWarningShown = false;
    const rootNormalized = normalizedRoot.split(path.sep).join('/');
    const addResult = (dirPath) => {
        if (!resultPaths.has(dirPath)) {
            resultPaths.add(dirPath);
            results.push({ path: dirPath, name: path.basename(dirPath) });
        }
    };
    while (stack.length > 0) {
        if (options.token?.isCancellationRequested) {
            break;
        }
        const current = stack.pop();
        const resolved = path.resolve(current.dir);
        if (visited.has(resolved)) {
            continue;
        }
        visited.add(resolved);
        if (current.depth > 0 && shouldExcludePath(resolved, rootNormalized, options.excludeRegexes)) {
            continue;
        }
        let entries;
        try {
            entries = fs.readdirSync(resolved, { withFileTypes: true });
        }
        catch (error) {
            logger_1.logger.warn(`Failed to read directory ${resolved}:`, error);
            continue;
        }
        processed++;
        if (processed > options.maxEntries) {
            if (!limitWarningShown) {
                void (0, notifications_1.showWarning)(`Search limit reached while scanning ${targetPath}. Some folders may be skipped. Adjust "odooDebugger.search.maxEntries" to increase the limit.`);
                limitWarningShown = true;
            }
            break;
        }
        const hasManifest = entries.some(entry => entry.isFile() && entry.name === '__manifest__.py');
        const hasGitDir = entries.some(entry => entry.isDirectory() && entry.name === '.git');
        if (kind === 'modules' && hasManifest) {
            addResult(resolved);
            continue;
        }
        if (kind === 'repositories' && hasGitDir) {
            addResult(resolved);
            // Do not recurse into repository contents.
            continue;
        }
        if (kind === 'repositories' && hasManifest) {
            // An Odoo module without a surrounding git repo: its parent folder
            // is an addons directory Odoo can load, even before `git init`
            // (folders are often filled with modules before the repo exists).
            const parent = path.dirname(resolved);
            if (!path.relative(normalizedRoot, parent).startsWith('..')) {
                addResult(parent);
            }
            // Do not recurse into the module itself.
            continue;
        }
        if (current.depth >= options.maxDepth) {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            if (entry.name === '.' || entry.name === '..') {
                continue;
            }
            const childPath = path.join(resolved, entry.name);
            stack.push({ dir: childPath, depth: current.depth + 1 });
        }
    }
    return results.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
function findModules(targetPath, overrides = {}) {
    const options = getSearchOptions('modules', overrides);
    return discoverDirectories(targetPath, 'modules', options);
}
function findRepositories(targetPath, overrides = {}) {
    if (overrides.token) {
        const options = getSearchOptions('repositories', overrides);
        return discoverDirectories(targetPath, 'repositories', options);
    }
    const cacheKey = buildDiscoveryCacheKey('repositories', targetPath, overrides);
    return runtimeCache_1.runtimeCache.getRepositoryDiscovery(cacheKey, () => {
        const options = getSearchOptions('repositories', overrides);
        return discoverDirectories(targetPath, 'repositories', options);
    });
}
const PSAE_INTERNAL_REGEX = /^ps[a-z]*-internal$/i;
function buildModuleDiscoveryCacheKey(repos, options) {
    const searchOverrides = options.search ?? {};
    const searchConfig = resolveSearchConfig('modules', searchOverrides);
    const repoPaths = repos
        .map(repo => `${repo.name}:${path.resolve(normalizePath(repo.path))}`)
        .sort((a, b) => a.localeCompare(b));
    const manualIncludes = (options.manualIncludePaths ?? [])
        .map(entry => path.resolve(normalizePath(entry)))
        .sort((a, b) => a.localeCompare(b));
    return JSON.stringify({
        repoPaths,
        manualIncludes,
        search: searchConfig
    });
}
function findRepoContext(repos, targetPath) {
    for (const repo of repos) {
        const repoPath = normalizePath(repo.path);
        const relative = path.relative(repoPath, targetPath);
        if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
            return { repoName: repo.name, repoPath };
        }
        if (!relative.startsWith('..')) {
            // When target is exactly the repo root, relative can be ''
            return { repoName: repo.name, repoPath };
        }
    }
    return undefined;
}
function addPsaeDirectory(psaeMap, pathKey, repoName, dirName) {
    if (!psaeMap.has(pathKey)) {
        psaeMap.set(pathKey, { repoName, dirName, moduleNames: new Set() });
    }
}
function toPosixRelative(relativePath) {
    return relativePath.split(path.sep).join('/');
}
function discoverModulesInRepos(repos, options = {}) {
    const searchOverrides = options.search ?? {};
    if (searchOverrides.token) {
        return computeModuleDiscovery(repos, options, searchOverrides);
    }
    const cacheKey = buildModuleDiscoveryCacheKey(repos, options);
    return runtimeCache_1.runtimeCache.getModuleDiscovery(cacheKey, () => computeModuleDiscovery(repos, options, searchOverrides));
}
function computeModuleDiscovery(repos, options, searchOverrides) {
    const modulesByPath = new Map();
    const psaeDirectories = new Map();
    const accumulateModule = (entry, repoName, repoRoot) => {
        const resolvedRepoRoot = path.resolve(repoRoot);
        const resolvedModulePath = path.resolve(entry.path);
        const relative = path.relative(resolvedRepoRoot, resolvedModulePath);
        const normalizedRelative = relative ? toPosixRelative(relative) : entry.name;
        const segments = normalizedRelative.split('/').filter(Boolean);
        const psaeIndex = segments.findIndex(segment => PSAE_INTERNAL_REGEX.test(segment));
        let isPsaeInternal = false;
        let psInternalDirName;
        let psInternalDirPath;
        if (psaeIndex >= 0) {
            isPsaeInternal = true;
            psInternalDirName = segments[psaeIndex];
            const dirSegments = segments.slice(0, psaeIndex + 1);
            psInternalDirPath = path.join(resolvedRepoRoot, ...dirSegments);
            addPsaeDirectory(psaeDirectories, psInternalDirPath, repoName, psInternalDirName);
            psaeDirectories.get(psInternalDirPath)?.moduleNames.add(entry.name);
        }
        modulesByPath.set(resolvedModulePath, {
            path: resolvedModulePath,
            name: entry.name,
            repoName,
            repoPath: resolvedRepoRoot,
            relativePath: normalizedRelative,
            isPsaeInternal,
            psInternalDirName,
            psInternalDirPath
        });
    };
    for (const repo of repos) {
        const repoPath = normalizePath(repo.path);
        if (!fs.existsSync(repoPath)) {
            continue;
        }
        const repoModules = findModules(repoPath, searchOverrides);
        for (const module of repoModules) {
            accumulateModule(module, repo.name, repoPath);
        }
    }
    for (const manualRaw of options.manualIncludePaths ?? []) {
        const manualPath = normalizePath(manualRaw);
        if (!fs.existsSync(manualPath)) {
            continue;
        }
        const repoContext = findRepoContext(repos, manualPath);
        const repoName = repoContext?.repoName ?? 'unknown';
        const repoRoot = repoContext?.repoPath ?? path.dirname(manualPath);
        const resolvedRepoRoot = path.resolve(repoRoot);
        const dirName = path.basename(manualPath);
        addPsaeDirectory(psaeDirectories, manualPath, repoName, dirName);
        const manualModules = findModules(manualPath, searchOverrides);
        for (const module of manualModules) {
            if (modulesByPath.has(path.resolve(module.path))) {
                psaeDirectories.get(manualPath)?.moduleNames.add(module.name);
                continue;
            }
            const relative = repoContext
                ? toPosixRelative(path.relative(resolvedRepoRoot, module.path))
                : toPosixRelative(path.join(dirName, module.name));
            modulesByPath.set(path.resolve(module.path), {
                path: path.resolve(module.path),
                name: module.name,
                repoName,
                repoPath: resolvedRepoRoot,
                relativePath: relative || module.name,
                isPsaeInternal: true,
                psInternalDirName: dirName,
                psInternalDirPath: manualPath
            });
            psaeDirectories.get(manualPath)?.moduleNames.add(module.name);
        }
    }
    const modules = Array.from(modulesByPath.values()).sort((a, b) => {
        const repoCompare = a.repoName.localeCompare(b.repoName, undefined, { sensitivity: 'base' });
        if (repoCompare !== 0) {
            return repoCompare;
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    const psaeDirs = Array.from(psaeDirectories.entries())
        .map(([dirPath, info]) => ({
        path: dirPath,
        repoName: info.repoName,
        dirName: info.dirName,
        moduleNames: Array.from(info.moduleNames).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    }))
        .sort((a, b) => {
        const repoCompare = a.repoName.localeCompare(b.repoName, undefined, { sensitivity: 'base' });
        if (repoCompare !== 0) {
            return repoCompare;
        }
        return a.dirName.localeCompare(b.dirName, undefined, { sensitivity: 'base' });
    });
    return { modules, psaeDirectories: psaeDirs };
}
/**
 * Creates a read-only tree item used for informational placeholders.
 */
function createInfoTreeItem(message) {
    const item = new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'info';
    return item;
}
// ============================================================================
// FILE I/O UTILITIES
// ============================================================================
/**
 * Creates initial data files for the Odoo debugger
 * @param filePath - full path to the file to create
 * @param workspacePath - workspace root path
 * @param fileName - name of the file to create
 * @returns the initial data object
 */
async function createOdooDebuggerFile(filePath, workspacePath, fileName) {
    try {
        ensureVSCodeDirectory(workspacePath);
        let data;
        let content;
        if (fileName === "launch.json") {
            data = {
                version: "0.2.0",
                configurations: []
            };
            content = launchJsonFileContent;
        }
        else {
            data = {
                settings: new settings_1.SettingsModel(getDefaultVersionSettings()),
                projects: [],
                dbTemplates: []
            };
            content = debuggerDataFileContent;
        }
        fs.writeFileSync(filePath, content, 'utf-8');
        return data;
    }
    catch (error) {
        void (0, notifications_1.showError)(`Failed to create ${fileName}: ${error}`);
        throw error;
    }
}
/**
 * Reads and parses a JSON file from the .vscode directory
 * @param fileName - the name of the file to read
 * @returns the parsed data or null if reading fails
 */
async function readFromFile(fileName) {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
        return null;
    }
    try {
        const filePath = path.join(workspacePath, '.vscode', fileName);
        if (!fs.existsSync(filePath)) {
            void (0, notifications_1.showInfo)(`Creating ${fileName} file...`);
            return await createOdooDebuggerFile(filePath, workspacePath, fileName);
        }
        const data = fs.readFileSync(filePath, 'utf-8');
        return (0, jsonc_parser_1.parse)(data);
    }
    catch (error) {
        void (0, notifications_1.showError)(`Failed to read ${fileName}: ${error}`);
        return null;
    }
}
/**
 * Converts a camelCase string to a human-readable title case
 * @param str - the camelCase string to convert
 * @returns the converted title case string
 */
function camelCaseToTitleCase(str) {
    if (!str) {
        return '';
    }
    return str.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase());
}
/**
 * Gets the display name for a settings key
 * @param key - The settings key in camelCase
 * @returns The human-readable display name
 */
function getSettingDisplayName(key) {
    const displayNames = {
        debuggerName: 'Debugger',
        debuggerVersion: 'Version',
        portNumber: 'Port',
        shellPortNumber: 'Shell Port',
        limitTimeReal: 'Time Limit (Real)',
        limitTimeCpu: 'Time Limit (CPU)',
        maxCronThreads: 'Max Cron Threads',
        extraParams: 'Extra Params',
        devMode: 'Dev Mode',
        installApps: 'Install Apps',
        upgradeApps: 'Upgrade Apps',
        dumpsFolder: 'Dumps Dir',
        odooPath: 'Odoo Dir',
        enterprisePath: 'Enterprise Dir',
        designThemesPath: 'Themes Dir',
        customAddonsPath: 'Custom Addons',
        pythonPath: 'Python Exec',
        subModulesPaths: 'Sub-modules'
    };
    return displayNames[key] || camelCaseToTitleCase(key);
}
/**
 * Gets the display value for a setting, cleaning up internal prefixes for UI display
 * @param key - The settings key
 * @param value - The internal setting value
 * @returns The cleaned value for UI display
 */
function getSettingDisplayValue(key, value) {
    if (key === 'devMode' && typeof value === 'string' && value.startsWith('--dev=')) {
        // Remove --dev= prefix for display, show clean value
        return value.substring(6) || 'none';
    }
    return value?.toString() || '';
}
/**
 * Gets all available Git branches from a repository path.
 * @param repoPath - The path to the git repository.
 * @returns Array of branch names, or empty array if not found or error occurs.
 */
async function getGitBranches(repoPath) {
    if (!repoPath) {
        return [];
    }
    const normalizedPath = normalizePath(repoPath);
    const apiBranches = await (0, gitService_1.getBranchesViaSourceControl)(normalizedPath);
    if (apiBranches && apiBranches.length > 0) {
        return apiBranches;
    }
    try {
        // Check if it's a git repository
        const gitDir = path.join(normalizedPath, '.git');
        if (!fs.existsSync(gitDir)) {
            logger_1.logger.warn(`Not a git repository: ${normalizedPath}`);
            return [];
        }
        const { stdout } = await (0, process_1.runCommand)('git', ['branch', '-a', '--format=%(refname:short)'], { cwd: normalizedPath });
        return stdout
            .split('\n')
            .map(branch => branch.trim())
            // Filter out empty lines and HEAD reference
            .filter(branch => !!branch && branch !== 'HEAD')
            // Strip remote prefixes
            .map(branch => branch.replace(/^remotes\/origin\//, '').replace(/^origin\//, ''))
            // Remove duplicates (local and remote of same branch)
            .filter((branch, index, array) => array.indexOf(branch) === index)
            .sort((a, b) => a.localeCompare(b));
    }
    catch (err) {
        logger_1.logger.warn(`Failed to get branches for ${normalizedPath}: ${err}`);
        return [];
    }
}
/**
 * Get default settings for new versions from VS Code configuration
 * These settings can be configured via VS Code Settings UI or by searching for "odooDebugger.defaultVersion"
 * @returns SettingsModel with default values from configuration
 */
function getDefaultVersionSettings() {
    const config = vscode.workspace.getConfiguration('odooDebugger.defaultVersion');
    return {
        debuggerVersion: config.get('debuggerVersion', '1.0.0'),
        limitTimeReal: config.get('limitTimeReal', 0),
        limitTimeCpu: config.get('limitTimeCpu', 0),
        maxCronThreads: config.get('maxCronThreads', 0),
        extraParams: config.get('extraParams', '--log-handler,odoo.addons.base.models.ir_attachment:WARNING'),
        devMode: config.get('devMode', '--dev=all'),
        dumpsFolder: config.get('dumpsFolder', '/dumps'),
        odooPath: config.get('odooPath', './odoo'),
        enterprisePath: config.get('enterprisePath', './enterprise'),
        designThemesPath: config.get('designThemesPath', './design-themes'),
        customAddonsPath: config.get('customAddonsPath', './custom-addons'),
        pythonPath: config.get('pythonPath', './venv/bin/python'),
        subModulesPaths: config.get('subModulesPaths', ''),
        installApps: config.get('installApps', ''),
        upgradeApps: config.get('upgradeApps', ''),
        postSwitchCommands: config.get('postSwitchCommands', [])
    };
}


/***/ }),
/* 9 */
/***/ ((module) => {

module.exports = require("fs");

/***/ }),
/* 10 */
/***/ ((module) => {

module.exports = require("path");

/***/ }),
/* 11 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.checkoutBranchViaSourceControl = checkoutBranchViaSourceControl;
exports.getCurrentBranchViaSourceControl = getCurrentBranchViaSourceControl;
exports.getBranchesWithMetadata = getBranchesWithMetadata;
exports.getBranchesViaSourceControl = getBranchesViaSourceControl;
exports.isOdooSeriesBranch = isOdooSeriesBranch;
exports.parseRefList = parseRefList;
exports.rankBranches = rankBranches;
exports.listSeriesBranches = listSeriesBranches;
exports.listAllBranches = listAllBranches;
/**
 * Bridge to the built-in git extension's API: current branch, branch
 * listings and checkouts via source control (with type-safe fallbacks).
 */
const vscode = __importStar(__webpack_require__(1));
const path = __importStar(__webpack_require__(4));
const logger_1 = __webpack_require__(12);
const process_1 = __webpack_require__(13);
function resolveRepoPath(repoPath) {
    if (path.isAbsolute(repoPath)) {
        return path.normalize(repoPath);
    }
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        return path.normalize(path.join(workspaceFolders[0].uri.fsPath, repoPath));
    }
    return path.normalize(path.resolve(repoPath));
}
async function getRepository(repoPath) {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension) {
        return undefined;
    }
    const extension = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    const api = extension.getAPI(1);
    const targetPath = path.resolve(resolveRepoPath(repoPath));
    const repositories = api.repositories;
    return repositories.find(repo => {
        const repoPathResolved = path.resolve(repo.rootUri.fsPath);
        return repoPathResolved === targetPath || repoPathResolved.toLowerCase() === targetPath.toLowerCase();
    });
}
async function checkoutBranchViaSourceControl(repoPath, branch) {
    try {
        const repo = await getRepository(repoPath);
        if (!repo) {
            return false;
        }
        await repo.checkout(branch, false);
        return true;
    }
    catch (error) {
        logger_1.logger.warn(`Git API checkout failed for ${repoPath}:`, error);
        return false;
    }
}
async function getCurrentBranchViaSourceControl(repoPath) {
    try {
        const repo = await getRepository(repoPath);
        const headName = repo?.state?.HEAD?.name;
        return headName && headName.trim().length > 0 ? headName : null;
    }
    catch (error) {
        logger_1.logger.warn(`Git API branch lookup failed for ${repoPath}:`, error);
        return null;
    }
}
function normalizeBranchName(value) {
    if (value.startsWith('remotes/origin/')) {
        return value.replace('remotes/origin/', '');
    }
    if (value.startsWith('origin/')) {
        return value.replace('origin/', '');
    }
    return value;
}
async function getBranchesWithMetadata(repoPath) {
    try {
        const repo = await getRepository(repoPath);
        if (!repo || !repo.getBranches) {
            return [];
        }
        const [localBranches, remoteBranches] = await Promise.all([
            repo.getBranches({ remote: false }),
            repo.getBranches({ remote: true })
        ]);
        const branchMap = new Map();
        const addBranches = (branches, type) => {
            for (const branch of branches) {
                const name = branch.name;
                if (!name || !name.trim()) {
                    continue;
                }
                const normalized = normalizeBranchName(name.trim());
                if (type === 'local' || !branchMap.has(normalized)) {
                    branchMap.set(normalized, type);
                }
            }
        };
        addBranches(localBranches, 'local');
        addBranches(remoteBranches, 'remote');
        return Array.from(branchMap.entries())
            .map(([name, type]) => ({ name, type }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }
    catch (error) {
        logger_1.logger.warn(`Git API branch listing failed for ${repoPath}:`, error);
        return [];
    }
}
async function getBranchesViaSourceControl(repoPath) {
    const metadata = await getBranchesWithMetadata(repoPath);
    if (!metadata || metadata.length === 0) {
        return undefined;
    }
    return metadata.map(branch => branch.name);
}
// ---------------------------------------------------------------------------
// Fast branch listing
//
// The git extension's getBranches() returns every ref. On the odoo repository
// that is ~68,700 remote refs (measured: 1.6s of git time, 7.6 MB of output),
// almost all of them PR branches on the `dev` remote, and every one of them
// gets marshalled across the extension-host boundary and turned into a quick
// pick item before the user sees anything. These helpers read only the refs a
// version could plausibly be built from, via `git for-each-ref`.
// ---------------------------------------------------------------------------
/** Odoo release branches: `17.0`, `saas-17.4`, `master`. */
const ODOO_SERIES_PATTERN = /^((saas-)?\d+(\.\d+)?|master)$/i;
function isOdooSeriesBranch(name) {
    return ODOO_SERIES_PATTERN.test(name.trim());
}
/** Parses `for-each-ref`/`branch` output into unique short branch names. */
function parseRefList(stdout) {
    const seen = new Set();
    const names = [];
    for (const rawLine of stdout.split('\n')) {
        const name = normalizeBranchName(rawLine.trim());
        if (!name || name === 'HEAD' || name.endsWith('/HEAD')) {
            continue;
        }
        if (seen.has(name)) {
            continue;
        }
        seen.add(name);
        names.push(name);
    }
    return names;
}
function seriesSortKey(name) {
    if (/^master$/i.test(name)) {
        return [Number.MAX_SAFE_INTEGER, 0];
    }
    const match = /^(?:saas-)?(\d+)(?:\.(\d+))?$/i.exec(name);
    if (!match) {
        return [-1, 0];
    }
    return [Number(match[1]), Number(match[2] ?? 0)];
}
/** Series branches first (newest first), then everything else alphabetically. */
function rankBranches(names) {
    const series = names.filter(isOdooSeriesBranch);
    const rest = names.filter(name => !isOdooSeriesBranch(name));
    series.sort((a, b) => {
        const [aMajor, aMinor] = seriesSortKey(a);
        const [bMajor, bMinor] = seriesSortKey(b);
        return bMajor - aMajor || bMinor - aMinor || a.localeCompare(b);
    });
    rest.sort((a, b) => a.localeCompare(b));
    return [...series, ...rest];
}
async function forEachRef(repoPath, patterns) {
    try {
        const { stdout } = await (0, process_1.runCommand)('git', ['for-each-ref', '--format=%(refname:short)', ...patterns], { cwd: resolveRepoPath(repoPath) });
        return parseRefList(stdout);
    }
    catch (error) {
        logger_1.logger.warn(`Failed to list refs in ${repoPath}:`, error);
        return [];
    }
}
/**
 * Local branches plus the release branches on `origin` - the ones a version is
 * actually built from. Cheap enough to run before showing UI.
 */
async function listSeriesBranches(repoPath) {
    const names = await forEachRef(repoPath, ['refs/heads', 'refs/remotes/origin']);
    return rankBranches(names.filter(isOdooSeriesBranch));
}
/** Every branch, including PR branches on every remote. Can be very slow. */
async function listAllBranches(repoPath) {
    return rankBranches(await forEachRef(repoPath, ['refs/heads', 'refs/remotes']));
}


/***/ }),
/* 12 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.logger = void 0;
exports.registerLogger = registerLogger;
exports.showLogOutput = showLogOutput;
exports.errorMessage = errorMessage;
const vscode = __importStar(__webpack_require__(1));
/**
 * Central logging for the extension. Everything user-relevant that used to go
 * to the developer console is appended to a single "Odoo DevTools" output
 * channel so users can actually see it (View -> Output -> Odoo DevTools).
 */
let channel;
function getChannel() {
    channel ??= vscode.window.createOutputChannel('Odoo DevTools');
    return channel;
}
/**
 * Registers the output channel for disposal with the extension context.
 * Safe to call before the channel exists; disposal is lazy.
 */
function registerLogger(context) {
    context.subscriptions.push({
        dispose: () => {
            channel?.dispose();
            channel = undefined;
        }
    });
}
/** Reveals the output channel in the panel. */
function showLogOutput() {
    getChannel().show(true);
}
/**
 * Normalizes an unknown thrown value into a human-readable message,
 * so raw `${error}` interpolation (which prints stacks/objects) is avoided.
 */
function errorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
function formatDetail(detail) {
    if (detail instanceof Error) {
        return detail.stack ?? detail.message;
    }
    if (typeof detail === 'string') {
        return detail;
    }
    try {
        return JSON.stringify(detail);
    }
    catch {
        return String(detail);
    }
}
function append(level, message, details) {
    const timestamp = new Date().toISOString();
    const suffix = details.length > 0 ? ` ${details.map(formatDetail).join(' ')}` : '';
    getChannel().appendLine(`[${timestamp}] ${level}: ${message}${suffix}`);
}
exports.logger = {
    debug(message, ...details) {
        append('DEBUG', message, details);
    },
    info(message, ...details) {
        append('INFO', message, details);
    },
    warn(message, ...details) {
        append('WARN', message, details);
    },
    error(message, ...details) {
        append('ERROR', message, details);
    }
};


/***/ }),
/* 13 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.CommandError = void 0;
exports.runCommand = runCommand;
exports.tryRunCommand = tryRunCommand;
const node_child_process_1 = __webpack_require__(14);
/** Error thrown when a command exits non-zero, fails to spawn, or is killed. */
class CommandError extends Error {
    command;
    args;
    exitCode;
    stderr;
    stdout;
    constructor(command, args, exitCode, stderr, stdout, cause) {
        const detail = stderr.trim() || stdout.trim() || (cause instanceof Error ? cause.message : '');
        super(`${command} ${args.join(' ')} failed${exitCode === null ? '' : ` (exit code ${exitCode})`}${detail ? `: ${detail}` : ''}`);
        this.command = command;
        this.args = args;
        this.exitCode = exitCode;
        this.stderr = stderr;
        this.stdout = stdout;
        this.name = 'CommandError';
    }
}
exports.CommandError = CommandError;
function makeLineForwarder(forward) {
    let buffer = '';
    return (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
            forward(line);
        }
    };
}
/**
 * Runs a command (no shell) and resolves with its collected output.
 * Rejects with {@link CommandError} on spawn failure, non-zero exit,
 * timeout, or cancellation.
 */
function runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.spawn)(command, args, {
            cwd: options.cwd,
            env: options.env,
            shell: false
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer;
        let cancellation;
        const finish = (fn) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timer) {
                clearTimeout(timer);
            }
            cancellation?.dispose();
            fn();
        };
        const forwardStdout = options.onStdoutLine ? makeLineForwarder(options.onStdoutLine) : undefined;
        const forwardStderr = options.onStderrLine ? makeLineForwarder(options.onStderrLine) : undefined;
        child.stdout.setEncoding('utf-8');
        child.stderr.setEncoding('utf-8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            forwardStdout?.(chunk);
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
            forwardStderr?.(chunk);
        });
        child.on('error', error => {
            finish(() => reject(new CommandError(command, args, null, stderr, stdout, error)));
        });
        child.on('close', code => {
            finish(() => {
                if (code === 0) {
                    resolve({ stdout, stderr });
                }
                else {
                    reject(new CommandError(command, args, code, stderr, stdout));
                }
            });
        });
        if (options.timeoutMs && options.timeoutMs > 0) {
            timer = setTimeout(() => {
                child.kill();
                finish(() => reject(new CommandError(command, args, null, stderr || 'Command timed out', stdout)));
            }, options.timeoutMs);
        }
        if (options.token) {
            cancellation = options.token.onCancellationRequested(() => {
                child.kill();
                finish(() => reject(new CommandError(command, args, null, stderr || 'Command was cancelled', stdout)));
            });
        }
        if (options.input !== undefined) {
            child.stdin.write(options.input);
        }
        child.stdin.end();
    });
}
/**
 * Runs a command and returns its trimmed stdout, or undefined on any failure.
 * For best-effort probes where the caller has a fallback.
 */
async function tryRunCommand(command, args, options = {}) {
    try {
        const { stdout } = await runCommand(command, args, options);
        return stdout.trim();
    }
    catch {
        return undefined;
    }
}


/***/ }),
/* 14 */
/***/ ((module) => {

module.exports = require("node:child_process");

/***/ }),
/* 15 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.runtimeCache = void 0;
exports.invalidateModuleDiscoveryCache = invalidateModuleDiscoveryCache;
exports.invalidateRepositoryDiscoveryCache = invalidateRepositoryDiscoveryCache;
exports.invalidateInstalledModulesCache = invalidateInstalledModulesCache;
exports.invalidateGitBranchCache = invalidateGitBranchCache;
exports.invalidateActiveDatabasesCache = invalidateActiveDatabasesCache;
exports.invalidateAllRuntimeCaches = invalidateAllRuntimeCaches;
const DEFAULT_TTLS = {
    moduleDiscoveryMs: 5000,
    repositoryDiscoveryMs: 5000,
    installedModulesMs: 5000,
    installedModuleNamesMs: 5000,
    gitBranchMs: 3000,
    activeDatabasesMs: 3000
};
class RuntimeCacheService {
    moduleDiscovery = new Map();
    repositoryDiscovery = new Map();
    installedModules = new Map();
    installedModuleNames = new Map();
    gitBranches = new Map();
    activeDatabases = new Map();
    getOrCompute(store, key, ttlMs, loader) {
        const now = Date.now();
        const cached = store.get(key);
        if (cached && cached.expiresAt > now) {
            return cached.value;
        }
        const value = loader();
        store.set(key, { value, expiresAt: now + ttlMs });
        return value;
    }
    async getOrComputeAsync(store, key, ttlMs, loader) {
        const now = Date.now();
        const cached = store.get(key);
        if (cached && cached.expiresAt > now) {
            return cached.value;
        }
        const value = await loader();
        store.set(key, { value, expiresAt: now + ttlMs });
        return value;
    }
    getModuleDiscovery(key, loader, ttlMs = DEFAULT_TTLS.moduleDiscoveryMs) {
        return this.getOrCompute(this.moduleDiscovery, key, ttlMs, loader);
    }
    getRepositoryDiscovery(key, loader, ttlMs = DEFAULT_TTLS.repositoryDiscoveryMs) {
        return this.getOrCompute(this.repositoryDiscovery, key, ttlMs, loader);
    }
    async getInstalledModules(dbName, loader, ttlMs = DEFAULT_TTLS.installedModulesMs) {
        return this.getOrComputeAsync(this.installedModules, dbName, ttlMs, loader);
    }
    async getInstalledModuleNames(dbName, loader, ttlMs = DEFAULT_TTLS.installedModuleNamesMs) {
        return this.getOrComputeAsync(this.installedModuleNames, dbName, ttlMs, loader);
    }
    async getGitBranch(repoPath, loader, ttlMs = DEFAULT_TTLS.gitBranchMs) {
        return this.getOrComputeAsync(this.gitBranches, repoPath, ttlMs, loader);
    }
    async getActiveDatabases(loader, ttlMs = DEFAULT_TTLS.activeDatabasesMs) {
        // Cluster-wide, so a single key.
        return this.getOrComputeAsync(this.activeDatabases, 'cluster', ttlMs, loader);
    }
    invalidateActiveDatabasesCache() {
        this.activeDatabases.clear();
    }
    invalidateModuleDiscoveryCache(key) {
        if (key) {
            this.moduleDiscovery.delete(key);
            return;
        }
        this.moduleDiscovery.clear();
    }
    invalidateRepositoryDiscoveryCache(key) {
        if (key) {
            this.repositoryDiscovery.delete(key);
            return;
        }
        this.repositoryDiscovery.clear();
    }
    invalidateInstalledModulesCache(dbName) {
        if (dbName) {
            this.installedModules.delete(dbName);
            this.installedModuleNames.delete(dbName);
            return;
        }
        this.installedModules.clear();
        this.installedModuleNames.clear();
    }
    invalidateGitBranchCache(repoPath) {
        if (repoPath) {
            this.gitBranches.delete(repoPath);
            return;
        }
        this.gitBranches.clear();
    }
    invalidateAll() {
        this.invalidateModuleDiscoveryCache();
        this.invalidateRepositoryDiscoveryCache();
        this.invalidateInstalledModulesCache();
        this.invalidateGitBranchCache();
        this.invalidateActiveDatabasesCache();
    }
}
exports.runtimeCache = new RuntimeCacheService();
function invalidateModuleDiscoveryCache(key) {
    exports.runtimeCache.invalidateModuleDiscoveryCache(key);
}
function invalidateRepositoryDiscoveryCache(key) {
    exports.runtimeCache.invalidateRepositoryDiscoveryCache(key);
}
function invalidateInstalledModulesCache(dbName) {
    exports.runtimeCache.invalidateInstalledModulesCache(dbName);
}
function invalidateGitBranchCache(repoPath) {
    exports.runtimeCache.invalidateGitBranchCache(repoPath);
}
function invalidateActiveDatabasesCache() {
    exports.runtimeCache.invalidateActiveDatabasesCache();
}
function invalidateAllRuntimeCaches() {
    exports.runtimeCache.invalidateAll();
}


/***/ }),
/* 16 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.MessageType = void 0;
exports.showMessage = showMessage;
exports.showError = showError;
exports.showInfo = showInfo;
exports.showWarning = showWarning;
exports.showModalWarning = showModalWarning;
exports.showModalInfo = showModalInfo;
exports.showAutoInfo = showAutoInfo;
exports.showBriefStatus = showBriefStatus;
const vscode = __importStar(__webpack_require__(1));
const logger_1 = __webpack_require__(12);
/**
 * User-facing messaging helpers. Every notification shown through these is
 * also logged to the "Odoo DevTools" output channel, which is why direct
 * vscode.window.show*Message calls should be avoided elsewhere.
 */
var MessageType;
(function (MessageType) {
    MessageType["Error"] = "error";
    MessageType["Warning"] = "warning";
    MessageType["Info"] = "info";
})(MessageType || (exports.MessageType = MessageType = {}));
/**
 * Shows a message with logging to the output channel.
 * @param message - the message to display
 * @param type - the type of message (error, warning, info)
 * @param actions - optional action buttons
 * @returns the selected action or undefined
 */
async function showMessage(message, type = MessageType.Error, ...actions) {
    switch (type) {
        case MessageType.Error:
            logger_1.logger.error(message);
            return vscode.window.showErrorMessage(message, ...actions);
        case MessageType.Warning:
            logger_1.logger.warn(message);
            return vscode.window.showWarningMessage(message, ...actions);
        case MessageType.Info:
            logger_1.logger.info(message);
            return vscode.window.showInformationMessage(message, ...actions);
    }
}
/** Shows an error notification with optional action buttons. */
async function showError(message, ...actions) {
    return showMessage(message, MessageType.Error, ...actions);
}
/** Shows an info notification with optional action buttons. */
async function showInfo(message, ...actions) {
    return showMessage(message, MessageType.Info, ...actions);
}
/** Shows a warning notification with optional action buttons. */
async function showWarning(message, ...actions) {
    return showMessage(message, MessageType.Warning, ...actions);
}
/**
 * Shows a modal warning dialog. Use for destructive confirmations where the
 * user must answer before anything proceeds.
 */
async function showModalWarning(message, ...actions) {
    logger_1.logger.warn(message);
    return vscode.window.showWarningMessage(message, { modal: true }, ...actions);
}
/** Shows a modal information dialog (blocks until dismissed). */
async function showModalInfo(message, ...actions) {
    logger_1.logger.info(message);
    return vscode.window.showInformationMessage(message, { modal: true }, ...actions);
}
/**
 * Shows an auto-dismissing information message that disappears after a specified time.
 * @param message - the info message to display
 * @param timeoutMs - time in milliseconds before auto-dismiss (default: 3000ms)
 */
function showAutoInfo(message, timeoutMs = 3000) {
    logger_1.logger.info(message);
    void vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: message,
        cancellable: false
    }, () => new Promise(resolve => setTimeout(resolve, timeoutMs)));
}
/**
 * Shows a brief status bar message that disappears automatically.
 * @param message - the message to display in the status bar
 * @param timeoutMs - time in milliseconds before auto-dismiss (default: 2000ms)
 */
function showBriefStatus(message, timeoutMs = 2000) {
    logger_1.logger.info(message);
    // setStatusBarMessage owns the disposal; no leaked status bar items.
    vscode.window.setStatusBarMessage(`$(info) ${message}`, timeoutMs);
}


/***/ }),
/* 17 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ParseErrorCode: () => (/* binding */ ParseErrorCode),
/* harmony export */   ScanError: () => (/* binding */ ScanError),
/* harmony export */   SyntaxKind: () => (/* binding */ SyntaxKind),
/* harmony export */   applyEdits: () => (/* binding */ applyEdits),
/* harmony export */   createScanner: () => (/* binding */ createScanner),
/* harmony export */   findNodeAtLocation: () => (/* binding */ findNodeAtLocation),
/* harmony export */   findNodeAtOffset: () => (/* binding */ findNodeAtOffset),
/* harmony export */   format: () => (/* binding */ format),
/* harmony export */   getLocation: () => (/* binding */ getLocation),
/* harmony export */   getNodePath: () => (/* binding */ getNodePath),
/* harmony export */   getNodeValue: () => (/* binding */ getNodeValue),
/* harmony export */   modify: () => (/* binding */ modify),
/* harmony export */   parse: () => (/* binding */ parse),
/* harmony export */   parseTree: () => (/* binding */ parseTree),
/* harmony export */   printParseErrorCode: () => (/* binding */ printParseErrorCode),
/* harmony export */   stripComments: () => (/* binding */ stripComments),
/* harmony export */   visit: () => (/* binding */ visit)
/* harmony export */ });
/* harmony import */ var _impl_format__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(18);
/* harmony import */ var _impl_edit__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(21);
/* harmony import */ var _impl_scanner__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(19);
/* harmony import */ var _impl_parser__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(22);
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/





/**
 * Creates a JSON scanner on the given text.
 * If ignoreTrivia is set, whitespaces or comments are ignored.
 */
const createScanner = _impl_scanner__WEBPACK_IMPORTED_MODULE_2__.createScanner;
var ScanError;
(function (ScanError) {
    ScanError[ScanError["None"] = 0] = "None";
    ScanError[ScanError["UnexpectedEndOfComment"] = 1] = "UnexpectedEndOfComment";
    ScanError[ScanError["UnexpectedEndOfString"] = 2] = "UnexpectedEndOfString";
    ScanError[ScanError["UnexpectedEndOfNumber"] = 3] = "UnexpectedEndOfNumber";
    ScanError[ScanError["InvalidUnicode"] = 4] = "InvalidUnicode";
    ScanError[ScanError["InvalidEscapeCharacter"] = 5] = "InvalidEscapeCharacter";
    ScanError[ScanError["InvalidCharacter"] = 6] = "InvalidCharacter";
})(ScanError || (ScanError = {}));
var SyntaxKind;
(function (SyntaxKind) {
    SyntaxKind[SyntaxKind["OpenBraceToken"] = 1] = "OpenBraceToken";
    SyntaxKind[SyntaxKind["CloseBraceToken"] = 2] = "CloseBraceToken";
    SyntaxKind[SyntaxKind["OpenBracketToken"] = 3] = "OpenBracketToken";
    SyntaxKind[SyntaxKind["CloseBracketToken"] = 4] = "CloseBracketToken";
    SyntaxKind[SyntaxKind["CommaToken"] = 5] = "CommaToken";
    SyntaxKind[SyntaxKind["ColonToken"] = 6] = "ColonToken";
    SyntaxKind[SyntaxKind["NullKeyword"] = 7] = "NullKeyword";
    SyntaxKind[SyntaxKind["TrueKeyword"] = 8] = "TrueKeyword";
    SyntaxKind[SyntaxKind["FalseKeyword"] = 9] = "FalseKeyword";
    SyntaxKind[SyntaxKind["StringLiteral"] = 10] = "StringLiteral";
    SyntaxKind[SyntaxKind["NumericLiteral"] = 11] = "NumericLiteral";
    SyntaxKind[SyntaxKind["LineCommentTrivia"] = 12] = "LineCommentTrivia";
    SyntaxKind[SyntaxKind["BlockCommentTrivia"] = 13] = "BlockCommentTrivia";
    SyntaxKind[SyntaxKind["LineBreakTrivia"] = 14] = "LineBreakTrivia";
    SyntaxKind[SyntaxKind["Trivia"] = 15] = "Trivia";
    SyntaxKind[SyntaxKind["Unknown"] = 16] = "Unknown";
    SyntaxKind[SyntaxKind["EOF"] = 17] = "EOF";
})(SyntaxKind || (SyntaxKind = {}));
/**
 * For a given offset, evaluate the location in the JSON document. Each segment in the location path is either a property name or an array index.
 */
const getLocation = _impl_parser__WEBPACK_IMPORTED_MODULE_3__.getLocation;
/**
 * Parses the given text and returns the object the JSON content represents. On invalid input, the parser tries to be as fault tolerant as possible, but still return a result.
 * Therefore, always check the errors list to find out if the input was valid.
 */
const parse = _impl_parser__WEBPACK_IMPORTED_MODULE_3__.parse;
/**
 * Parses the given text and returns a tree representation the JSON content. On invalid input, the parser tries to be as fault tolerant as possible, but still return a result.
 */
const parseTree = _impl_parser__WEBPACK_IMPORTED_MODULE_3__.parseTree;
/**
 * Finds the node at the given path in a JSON DOM.
 */
const findNodeAtLocation = _impl_parser__WEBPACK_IMPORTED_MODULE_3__.findNodeAtLocation;
/**
 * Finds the innermost node at the given offset. If includeRightBound is set, also finds nodes that end at the given offset.
 */
const findNodeAtOffset = _impl_parser__WEBPACK_IMPORTED_MODULE_3__.findNodeAtOffset;
/**
 * Gets the JSON path of the given JSON DOM node
 */
const getNodePath = _impl_parser__WEBPACK_IMPORTED_MODULE_3__.getNodePath;
/**
 * Evaluates the JavaScript object of the given JSON DOM node
 */
const getNodeValue = _impl_parser__WEBPACK_IMPORTED_MODULE_3__.getNodeValue;
/**
 * Parses the given text and invokes the visitor functions for each object, array and literal reached.
 */
const visit = _impl_parser__WEBPACK_IMPORTED_MODULE_3__.visit;
/**
 * Takes JSON with JavaScript-style comments and remove
 * them. Optionally replaces every none-newline character
 * of comments with a replaceCharacter
 */
const stripComments = _impl_parser__WEBPACK_IMPORTED_MODULE_3__.stripComments;
var ParseErrorCode;
(function (ParseErrorCode) {
    ParseErrorCode[ParseErrorCode["InvalidSymbol"] = 1] = "InvalidSymbol";
    ParseErrorCode[ParseErrorCode["InvalidNumberFormat"] = 2] = "InvalidNumberFormat";
    ParseErrorCode[ParseErrorCode["PropertyNameExpected"] = 3] = "PropertyNameExpected";
    ParseErrorCode[ParseErrorCode["ValueExpected"] = 4] = "ValueExpected";
    ParseErrorCode[ParseErrorCode["ColonExpected"] = 5] = "ColonExpected";
    ParseErrorCode[ParseErrorCode["CommaExpected"] = 6] = "CommaExpected";
    ParseErrorCode[ParseErrorCode["CloseBraceExpected"] = 7] = "CloseBraceExpected";
    ParseErrorCode[ParseErrorCode["CloseBracketExpected"] = 8] = "CloseBracketExpected";
    ParseErrorCode[ParseErrorCode["EndOfFileExpected"] = 9] = "EndOfFileExpected";
    ParseErrorCode[ParseErrorCode["InvalidCommentToken"] = 10] = "InvalidCommentToken";
    ParseErrorCode[ParseErrorCode["UnexpectedEndOfComment"] = 11] = "UnexpectedEndOfComment";
    ParseErrorCode[ParseErrorCode["UnexpectedEndOfString"] = 12] = "UnexpectedEndOfString";
    ParseErrorCode[ParseErrorCode["UnexpectedEndOfNumber"] = 13] = "UnexpectedEndOfNumber";
    ParseErrorCode[ParseErrorCode["InvalidUnicode"] = 14] = "InvalidUnicode";
    ParseErrorCode[ParseErrorCode["InvalidEscapeCharacter"] = 15] = "InvalidEscapeCharacter";
    ParseErrorCode[ParseErrorCode["InvalidCharacter"] = 16] = "InvalidCharacter";
})(ParseErrorCode || (ParseErrorCode = {}));
function printParseErrorCode(code) {
    switch (code) {
        case 1 /* ParseErrorCode.InvalidSymbol */: return 'InvalidSymbol';
        case 2 /* ParseErrorCode.InvalidNumberFormat */: return 'InvalidNumberFormat';
        case 3 /* ParseErrorCode.PropertyNameExpected */: return 'PropertyNameExpected';
        case 4 /* ParseErrorCode.ValueExpected */: return 'ValueExpected';
        case 5 /* ParseErrorCode.ColonExpected */: return 'ColonExpected';
        case 6 /* ParseErrorCode.CommaExpected */: return 'CommaExpected';
        case 7 /* ParseErrorCode.CloseBraceExpected */: return 'CloseBraceExpected';
        case 8 /* ParseErrorCode.CloseBracketExpected */: return 'CloseBracketExpected';
        case 9 /* ParseErrorCode.EndOfFileExpected */: return 'EndOfFileExpected';
        case 10 /* ParseErrorCode.InvalidCommentToken */: return 'InvalidCommentToken';
        case 11 /* ParseErrorCode.UnexpectedEndOfComment */: return 'UnexpectedEndOfComment';
        case 12 /* ParseErrorCode.UnexpectedEndOfString */: return 'UnexpectedEndOfString';
        case 13 /* ParseErrorCode.UnexpectedEndOfNumber */: return 'UnexpectedEndOfNumber';
        case 14 /* ParseErrorCode.InvalidUnicode */: return 'InvalidUnicode';
        case 15 /* ParseErrorCode.InvalidEscapeCharacter */: return 'InvalidEscapeCharacter';
        case 16 /* ParseErrorCode.InvalidCharacter */: return 'InvalidCharacter';
    }
    return '<unknown ParseErrorCode>';
}
/**
 * Computes the edit operations needed to format a JSON document.
 *
 * @param documentText The input text
 * @param range The range to format or `undefined` to format the full content
 * @param options The formatting options
 * @returns The edit operations describing the formatting changes to the original document following the format described in {@linkcode EditResult}.
 * To apply the edit operations to the input, use {@linkcode applyEdits}.
 */
function format(documentText, range, options) {
    return _impl_format__WEBPACK_IMPORTED_MODULE_0__.format(documentText, range, options);
}
/**
 * Computes the edit operations needed to modify a value in the JSON document.
 *
 * @param documentText The input text
 * @param path The path of the value to change. The path represents either to the document root, a property or an array item.
 * If the path points to an non-existing property or item, it will be created.
 * @param value The new value for the specified property or item. If the value is undefined,
 * the property or item will be removed.
 * @param options Options
 * @returns The edit operations describing the changes to the original document, following the format described in {@linkcode EditResult}.
 * To apply the edit operations to the input, use {@linkcode applyEdits}.
 */
function modify(text, path, value, options) {
    return _impl_edit__WEBPACK_IMPORTED_MODULE_1__.setProperty(text, path, value, options);
}
/**
 * Applies edits to an input string.
 * @param text The input text
 * @param edits Edit operations following the format described in {@linkcode EditResult}.
 * @returns The text with the applied edits.
 * @throws An error if the edit operations are not well-formed as described in {@linkcode EditResult}.
 */
function applyEdits(text, edits) {
    let sortedEdits = edits.slice(0).sort((a, b) => {
        const diff = a.offset - b.offset;
        if (diff === 0) {
            return a.length - b.length;
        }
        return diff;
    });
    let lastModifiedOffset = text.length;
    for (let i = sortedEdits.length - 1; i >= 0; i--) {
        let e = sortedEdits[i];
        if (e.offset + e.length <= lastModifiedOffset) {
            text = _impl_edit__WEBPACK_IMPORTED_MODULE_1__.applyEdit(text, e);
        }
        else {
            throw new Error('Overlapping edit');
        }
        lastModifiedOffset = e.offset;
    }
    return text;
}


/***/ }),
/* 18 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   format: () => (/* binding */ format),
/* harmony export */   isEOL: () => (/* binding */ isEOL)
/* harmony export */ });
/* harmony import */ var _scanner__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(19);
/* harmony import */ var _string_intern__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(20);
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/



function format(documentText, range, options) {
    let initialIndentLevel;
    let formatText;
    let formatTextStart;
    let rangeStart;
    let rangeEnd;
    if (range) {
        rangeStart = range.offset;
        rangeEnd = rangeStart + range.length;
        formatTextStart = rangeStart;
        while (formatTextStart > 0 && !isEOL(documentText, formatTextStart - 1)) {
            formatTextStart--;
        }
        let endOffset = rangeEnd;
        while (endOffset < documentText.length && !isEOL(documentText, endOffset)) {
            endOffset++;
        }
        formatText = documentText.substring(formatTextStart, endOffset);
        initialIndentLevel = computeIndentLevel(formatText, options);
    }
    else {
        formatText = documentText;
        initialIndentLevel = 0;
        formatTextStart = 0;
        rangeStart = 0;
        rangeEnd = documentText.length;
    }
    const eol = getEOL(options, documentText);
    const eolFastPathSupported = _string_intern__WEBPACK_IMPORTED_MODULE_1__.supportedEols.includes(eol);
    let numberLineBreaks = 0;
    let indentLevel = 0;
    let indentValue;
    if (options.insertSpaces) {
        indentValue = _string_intern__WEBPACK_IMPORTED_MODULE_1__.cachedSpaces[options.tabSize || 4] ?? repeat(_string_intern__WEBPACK_IMPORTED_MODULE_1__.cachedSpaces[1], options.tabSize || 4);
    }
    else {
        indentValue = '\t';
    }
    const indentType = indentValue === '\t' ? '\t' : ' ';
    let scanner = (0,_scanner__WEBPACK_IMPORTED_MODULE_0__.createScanner)(formatText, false);
    let hasError = false;
    function newLinesAndIndent() {
        if (numberLineBreaks > 1) {
            return repeat(eol, numberLineBreaks) + repeat(indentValue, initialIndentLevel + indentLevel);
        }
        const amountOfSpaces = indentValue.length * (initialIndentLevel + indentLevel);
        if (!eolFastPathSupported || amountOfSpaces > _string_intern__WEBPACK_IMPORTED_MODULE_1__.cachedBreakLinesWithSpaces[indentType][eol].length) {
            return eol + repeat(indentValue, initialIndentLevel + indentLevel);
        }
        if (amountOfSpaces <= 0) {
            return eol;
        }
        return _string_intern__WEBPACK_IMPORTED_MODULE_1__.cachedBreakLinesWithSpaces[indentType][eol][amountOfSpaces];
    }
    function scanNext() {
        let token = scanner.scan();
        numberLineBreaks = 0;
        while (token === 15 /* SyntaxKind.Trivia */ || token === 14 /* SyntaxKind.LineBreakTrivia */) {
            if (token === 14 /* SyntaxKind.LineBreakTrivia */ && options.keepLines) {
                numberLineBreaks += 1;
            }
            else if (token === 14 /* SyntaxKind.LineBreakTrivia */) {
                numberLineBreaks = 1;
            }
            token = scanner.scan();
        }
        hasError = token === 16 /* SyntaxKind.Unknown */ || scanner.getTokenError() !== 0 /* ScanError.None */;
        return token;
    }
    const editOperations = [];
    function addEdit(text, startOffset, endOffset) {
        if (!hasError && (!range || (startOffset < rangeEnd && endOffset > rangeStart)) && documentText.substring(startOffset, endOffset) !== text) {
            editOperations.push({ offset: startOffset, length: endOffset - startOffset, content: text });
        }
    }
    let firstToken = scanNext();
    if (options.keepLines && numberLineBreaks > 0) {
        addEdit(repeat(eol, numberLineBreaks), 0, 0);
    }
    if (firstToken !== 17 /* SyntaxKind.EOF */) {
        let firstTokenStart = scanner.getTokenOffset() + formatTextStart;
        let initialIndent = (indentValue.length * initialIndentLevel < 20) && options.insertSpaces
            ? _string_intern__WEBPACK_IMPORTED_MODULE_1__.cachedSpaces[indentValue.length * initialIndentLevel]
            : repeat(indentValue, initialIndentLevel);
        addEdit(initialIndent, formatTextStart, firstTokenStart);
    }
    while (firstToken !== 17 /* SyntaxKind.EOF */) {
        let firstTokenEnd = scanner.getTokenOffset() + scanner.getTokenLength() + formatTextStart;
        let secondToken = scanNext();
        let replaceContent = '';
        let needsLineBreak = false;
        while (numberLineBreaks === 0 && (secondToken === 12 /* SyntaxKind.LineCommentTrivia */ || secondToken === 13 /* SyntaxKind.BlockCommentTrivia */)) {
            let commentTokenStart = scanner.getTokenOffset() + formatTextStart;
            addEdit(_string_intern__WEBPACK_IMPORTED_MODULE_1__.cachedSpaces[1], firstTokenEnd, commentTokenStart);
            firstTokenEnd = scanner.getTokenOffset() + scanner.getTokenLength() + formatTextStart;
            needsLineBreak = secondToken === 12 /* SyntaxKind.LineCommentTrivia */;
            replaceContent = needsLineBreak ? newLinesAndIndent() : '';
            secondToken = scanNext();
        }
        if (secondToken === 2 /* SyntaxKind.CloseBraceToken */) {
            if (firstToken !== 1 /* SyntaxKind.OpenBraceToken */) {
                indentLevel--;
            }
            ;
            if (options.keepLines && numberLineBreaks > 0 || !options.keepLines && firstToken !== 1 /* SyntaxKind.OpenBraceToken */) {
                replaceContent = newLinesAndIndent();
            }
            else if (options.keepLines) {
                replaceContent = _string_intern__WEBPACK_IMPORTED_MODULE_1__.cachedSpaces[1];
            }
        }
        else if (secondToken === 4 /* SyntaxKind.CloseBracketToken */) {
            if (firstToken !== 3 /* SyntaxKind.OpenBracketToken */) {
                indentLevel--;
            }
            ;
            if (options.keepLines && numberLineBreaks > 0 || !options.keepLines && firstToken !== 3 /* SyntaxKind.OpenBracketToken */) {
                replaceContent = newLinesAndIndent();
            }
            else if (options.keepLines) {
                replaceContent = _string_intern__WEBPACK_IMPORTED_MODULE_1__.cachedSpaces[1];
            }
        }
        else {
            switch (firstToken) {
                case 3 /* SyntaxKind.OpenBracketToken */:
                case 1 /* SyntaxKind.OpenBraceToken */:
                    indentLevel++;
                    if (options.keepLines && numberLineBreaks > 0 || !options.keepLines) {
                        replaceContent = newLinesAndIndent();
                    }
                    else {
                        replaceContent = _string_intern__WEBPACK_IMPORTED_MODULE_1__.cachedSpaces[1];
                    }
                    break;
                case 5 /* SyntaxKind.CommaToken */:
                    if (options.keepLines && numberLineBreaks > 0 || !options.keepLines) {
                        replaceContent = newLinesAndIndent();
                    }
                    else {
                        replaceContent = _string_intern__WEBPACK_IMPORTED_MODULE_1__.cachedSpaces[1];
                    }
                    break;
                case 12 /* SyntaxKind.LineCommentTrivia */:
                    replaceContent = newLinesAndIndent();
                    break;
                case 13 /* SyntaxKind.BlockCommentTrivia */:
                    if (numberLineBreaks > 0) {
                        replaceContent = newLinesAndIndent();
                    }
                    else if (!needsLineBreak) {
                        replaceContent = _string_intern__WEBPACK_IMPORTED_MODULE_1__.cachedSpaces[1];
                    }
                    break;
                case 6 /* SyntaxKind.ColonToken */:
                    if (options.keepLines && numberLineBreaks > 0) {
                        replaceContent = newLinesAndIndent();
                    }
                    else if (!needsLineBreak) {
                        replaceContent = _string_intern__WEBPACK_IMPORTED_MODULE_1__.cachedSpaces[1];
                    }
                    break;
                case 10 /* SyntaxKind.StringLiteral */:
                    if (options.keepLines && numberLineBreaks > 0) {
                        replaceContent = newLinesAndIndent();
                    }
                    else if (secondToken === 6 /* SyntaxKind.ColonToken */ && !needsLineBreak) {
                        replaceContent = '';
                    }
                    break;
                case 7 /* SyntaxKind.NullKeyword */:
                case 8 /* SyntaxKind.TrueKeyword */:
                case 9 /* SyntaxKind.FalseKeyword */:
                case 11 /* SyntaxKind.NumericLiteral */:
                case 2 /* SyntaxKind.CloseBraceToken */:
                case 4 /* SyntaxKind.CloseBracketToken */:
                    if (options.keepLines && numberLineBreaks > 0) {
                        replaceContent = newLinesAndIndent();
                    }
                    else {
                        if ((secondToken === 12 /* SyntaxKind.LineCommentTrivia */ || secondToken === 13 /* SyntaxKind.BlockCommentTrivia */) && !needsLineBreak) {
                            replaceContent = _string_intern__WEBPACK_IMPORTED_MODULE_1__.cachedSpaces[1];
                        }
                        else if (secondToken !== 5 /* SyntaxKind.CommaToken */ && secondToken !== 17 /* SyntaxKind.EOF */) {
                            hasError = true;
                        }
                    }
                    break;
                case 16 /* SyntaxKind.Unknown */:
                    hasError = true;
                    break;
            }
            if (numberLineBreaks > 0 && (secondToken === 12 /* SyntaxKind.LineCommentTrivia */ || secondToken === 13 /* SyntaxKind.BlockCommentTrivia */)) {
                replaceContent = newLinesAndIndent();
            }
        }
        if (secondToken === 17 /* SyntaxKind.EOF */) {
            if (options.keepLines && numberLineBreaks > 0) {
                replaceContent = newLinesAndIndent();
            }
            else {
                replaceContent = options.insertFinalNewline ? eol : '';
            }
        }
        const secondTokenStart = scanner.getTokenOffset() + formatTextStart;
        addEdit(replaceContent, firstTokenEnd, secondTokenStart);
        firstToken = secondToken;
    }
    return editOperations;
}
function repeat(s, count) {
    let result = '';
    for (let i = 0; i < count; i++) {
        result += s;
    }
    return result;
}
function computeIndentLevel(content, options) {
    let i = 0;
    let nChars = 0;
    const tabSize = options.tabSize || 4;
    while (i < content.length) {
        let ch = content.charAt(i);
        if (ch === _string_intern__WEBPACK_IMPORTED_MODULE_1__.cachedSpaces[1]) {
            nChars++;
        }
        else if (ch === '\t') {
            nChars += tabSize;
        }
        else {
            break;
        }
        i++;
    }
    return Math.floor(nChars / tabSize);
}
function getEOL(options, text) {
    for (let i = 0; i < text.length; i++) {
        const ch = text.charAt(i);
        if (ch === '\r') {
            if (i + 1 < text.length && text.charAt(i + 1) === '\n') {
                return '\r\n';
            }
            return '\r';
        }
        else if (ch === '\n') {
            return '\n';
        }
    }
    return (options && options.eol) || '\n';
}
function isEOL(text, offset) {
    return '\r\n'.indexOf(text.charAt(offset)) !== -1;
}


/***/ }),
/* 19 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   createScanner: () => (/* binding */ createScanner)
/* harmony export */ });
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Creates a JSON scanner on the given text.
 * If ignoreTrivia is set, whitespaces or comments are ignored.
 */
function createScanner(text, ignoreTrivia = false) {
    const len = text.length;
    let pos = 0, value = '', tokenOffset = 0, token = 16 /* SyntaxKind.Unknown */, lineNumber = 0, lineStartOffset = 0, tokenLineStartOffset = 0, prevTokenLineStartOffset = 0, scanError = 0 /* ScanError.None */;
    function scanHexDigits(count, exact) {
        let digits = 0;
        let value = 0;
        while (digits < count || !exact) {
            let ch = text.charCodeAt(pos);
            if (ch >= 48 /* CharacterCodes._0 */ && ch <= 57 /* CharacterCodes._9 */) {
                value = value * 16 + ch - 48 /* CharacterCodes._0 */;
            }
            else if (ch >= 65 /* CharacterCodes.A */ && ch <= 70 /* CharacterCodes.F */) {
                value = value * 16 + ch - 65 /* CharacterCodes.A */ + 10;
            }
            else if (ch >= 97 /* CharacterCodes.a */ && ch <= 102 /* CharacterCodes.f */) {
                value = value * 16 + ch - 97 /* CharacterCodes.a */ + 10;
            }
            else {
                break;
            }
            pos++;
            digits++;
        }
        if (digits < count) {
            value = -1;
        }
        return value;
    }
    function setPosition(newPosition) {
        pos = newPosition;
        value = '';
        tokenOffset = 0;
        token = 16 /* SyntaxKind.Unknown */;
        scanError = 0 /* ScanError.None */;
    }
    function scanNumber() {
        let start = pos;
        if (text.charCodeAt(pos) === 48 /* CharacterCodes._0 */) {
            pos++;
        }
        else {
            pos++;
            while (pos < text.length && isDigit(text.charCodeAt(pos))) {
                pos++;
            }
        }
        if (pos < text.length && text.charCodeAt(pos) === 46 /* CharacterCodes.dot */) {
            pos++;
            if (pos < text.length && isDigit(text.charCodeAt(pos))) {
                pos++;
                while (pos < text.length && isDigit(text.charCodeAt(pos))) {
                    pos++;
                }
            }
            else {
                scanError = 3 /* ScanError.UnexpectedEndOfNumber */;
                return text.substring(start, pos);
            }
        }
        let end = pos;
        if (pos < text.length && (text.charCodeAt(pos) === 69 /* CharacterCodes.E */ || text.charCodeAt(pos) === 101 /* CharacterCodes.e */)) {
            pos++;
            if (pos < text.length && text.charCodeAt(pos) === 43 /* CharacterCodes.plus */ || text.charCodeAt(pos) === 45 /* CharacterCodes.minus */) {
                pos++;
            }
            if (pos < text.length && isDigit(text.charCodeAt(pos))) {
                pos++;
                while (pos < text.length && isDigit(text.charCodeAt(pos))) {
                    pos++;
                }
                end = pos;
            }
            else {
                scanError = 3 /* ScanError.UnexpectedEndOfNumber */;
            }
        }
        return text.substring(start, end);
    }
    function scanString() {
        let result = '', start = pos;
        while (true) {
            if (pos >= len) {
                result += text.substring(start, pos);
                scanError = 2 /* ScanError.UnexpectedEndOfString */;
                break;
            }
            const ch = text.charCodeAt(pos);
            if (ch === 34 /* CharacterCodes.doubleQuote */) {
                result += text.substring(start, pos);
                pos++;
                break;
            }
            if (ch === 92 /* CharacterCodes.backslash */) {
                result += text.substring(start, pos);
                pos++;
                if (pos >= len) {
                    scanError = 2 /* ScanError.UnexpectedEndOfString */;
                    break;
                }
                const ch2 = text.charCodeAt(pos++);
                switch (ch2) {
                    case 34 /* CharacterCodes.doubleQuote */:
                        result += '\"';
                        break;
                    case 92 /* CharacterCodes.backslash */:
                        result += '\\';
                        break;
                    case 47 /* CharacterCodes.slash */:
                        result += '/';
                        break;
                    case 98 /* CharacterCodes.b */:
                        result += '\b';
                        break;
                    case 102 /* CharacterCodes.f */:
                        result += '\f';
                        break;
                    case 110 /* CharacterCodes.n */:
                        result += '\n';
                        break;
                    case 114 /* CharacterCodes.r */:
                        result += '\r';
                        break;
                    case 116 /* CharacterCodes.t */:
                        result += '\t';
                        break;
                    case 117 /* CharacterCodes.u */:
                        const ch3 = scanHexDigits(4, true);
                        if (ch3 >= 0) {
                            result += String.fromCharCode(ch3);
                        }
                        else {
                            scanError = 4 /* ScanError.InvalidUnicode */;
                        }
                        break;
                    default:
                        scanError = 5 /* ScanError.InvalidEscapeCharacter */;
                }
                start = pos;
                continue;
            }
            if (ch >= 0 && ch <= 0x1f) {
                if (isLineBreak(ch)) {
                    result += text.substring(start, pos);
                    scanError = 2 /* ScanError.UnexpectedEndOfString */;
                    break;
                }
                else {
                    scanError = 6 /* ScanError.InvalidCharacter */;
                    // mark as error but continue with string
                }
            }
            pos++;
        }
        return result;
    }
    function scanNext() {
        value = '';
        scanError = 0 /* ScanError.None */;
        tokenOffset = pos;
        lineStartOffset = lineNumber;
        prevTokenLineStartOffset = tokenLineStartOffset;
        if (pos >= len) {
            // at the end
            tokenOffset = len;
            return token = 17 /* SyntaxKind.EOF */;
        }
        let code = text.charCodeAt(pos);
        // trivia: whitespace
        if (isWhiteSpace(code)) {
            do {
                pos++;
                value += String.fromCharCode(code);
                code = text.charCodeAt(pos);
            } while (isWhiteSpace(code));
            return token = 15 /* SyntaxKind.Trivia */;
        }
        // trivia: newlines
        if (isLineBreak(code)) {
            pos++;
            value += String.fromCharCode(code);
            if (code === 13 /* CharacterCodes.carriageReturn */ && text.charCodeAt(pos) === 10 /* CharacterCodes.lineFeed */) {
                pos++;
                value += '\n';
            }
            lineNumber++;
            tokenLineStartOffset = pos;
            return token = 14 /* SyntaxKind.LineBreakTrivia */;
        }
        switch (code) {
            // tokens: []{}:,
            case 123 /* CharacterCodes.openBrace */:
                pos++;
                return token = 1 /* SyntaxKind.OpenBraceToken */;
            case 125 /* CharacterCodes.closeBrace */:
                pos++;
                return token = 2 /* SyntaxKind.CloseBraceToken */;
            case 91 /* CharacterCodes.openBracket */:
                pos++;
                return token = 3 /* SyntaxKind.OpenBracketToken */;
            case 93 /* CharacterCodes.closeBracket */:
                pos++;
                return token = 4 /* SyntaxKind.CloseBracketToken */;
            case 58 /* CharacterCodes.colon */:
                pos++;
                return token = 6 /* SyntaxKind.ColonToken */;
            case 44 /* CharacterCodes.comma */:
                pos++;
                return token = 5 /* SyntaxKind.CommaToken */;
            // strings
            case 34 /* CharacterCodes.doubleQuote */:
                pos++;
                value = scanString();
                return token = 10 /* SyntaxKind.StringLiteral */;
            // comments
            case 47 /* CharacterCodes.slash */:
                const start = pos - 1;
                // Single-line comment
                if (text.charCodeAt(pos + 1) === 47 /* CharacterCodes.slash */) {
                    pos += 2;
                    while (pos < len) {
                        if (isLineBreak(text.charCodeAt(pos))) {
                            break;
                        }
                        pos++;
                    }
                    value = text.substring(start, pos);
                    return token = 12 /* SyntaxKind.LineCommentTrivia */;
                }
                // Multi-line comment
                if (text.charCodeAt(pos + 1) === 42 /* CharacterCodes.asterisk */) {
                    pos += 2;
                    const safeLength = len - 1; // For lookahead.
                    let commentClosed = false;
                    while (pos < safeLength) {
                        const ch = text.charCodeAt(pos);
                        if (ch === 42 /* CharacterCodes.asterisk */ && text.charCodeAt(pos + 1) === 47 /* CharacterCodes.slash */) {
                            pos += 2;
                            commentClosed = true;
                            break;
                        }
                        pos++;
                        if (isLineBreak(ch)) {
                            if (ch === 13 /* CharacterCodes.carriageReturn */ && text.charCodeAt(pos) === 10 /* CharacterCodes.lineFeed */) {
                                pos++;
                            }
                            lineNumber++;
                            tokenLineStartOffset = pos;
                        }
                    }
                    if (!commentClosed) {
                        pos++;
                        scanError = 1 /* ScanError.UnexpectedEndOfComment */;
                    }
                    value = text.substring(start, pos);
                    return token = 13 /* SyntaxKind.BlockCommentTrivia */;
                }
                // just a single slash
                value += String.fromCharCode(code);
                pos++;
                return token = 16 /* SyntaxKind.Unknown */;
            // numbers
            case 45 /* CharacterCodes.minus */:
                value += String.fromCharCode(code);
                pos++;
                if (pos === len || !isDigit(text.charCodeAt(pos))) {
                    return token = 16 /* SyntaxKind.Unknown */;
                }
            // found a minus, followed by a number so
            // we fall through to proceed with scanning
            // numbers
            case 48 /* CharacterCodes._0 */:
            case 49 /* CharacterCodes._1 */:
            case 50 /* CharacterCodes._2 */:
            case 51 /* CharacterCodes._3 */:
            case 52 /* CharacterCodes._4 */:
            case 53 /* CharacterCodes._5 */:
            case 54 /* CharacterCodes._6 */:
            case 55 /* CharacterCodes._7 */:
            case 56 /* CharacterCodes._8 */:
            case 57 /* CharacterCodes._9 */:
                value += scanNumber();
                return token = 11 /* SyntaxKind.NumericLiteral */;
            // literals and unknown symbols
            default:
                // is a literal? Read the full word.
                while (pos < len && isUnknownContentCharacter(code)) {
                    pos++;
                    code = text.charCodeAt(pos);
                }
                if (tokenOffset !== pos) {
                    value = text.substring(tokenOffset, pos);
                    // keywords: true, false, null
                    switch (value) {
                        case 'true': return token = 8 /* SyntaxKind.TrueKeyword */;
                        case 'false': return token = 9 /* SyntaxKind.FalseKeyword */;
                        case 'null': return token = 7 /* SyntaxKind.NullKeyword */;
                    }
                    return token = 16 /* SyntaxKind.Unknown */;
                }
                // some
                value += String.fromCharCode(code);
                pos++;
                return token = 16 /* SyntaxKind.Unknown */;
        }
    }
    function isUnknownContentCharacter(code) {
        if (isWhiteSpace(code) || isLineBreak(code)) {
            return false;
        }
        switch (code) {
            case 125 /* CharacterCodes.closeBrace */:
            case 93 /* CharacterCodes.closeBracket */:
            case 123 /* CharacterCodes.openBrace */:
            case 91 /* CharacterCodes.openBracket */:
            case 34 /* CharacterCodes.doubleQuote */:
            case 58 /* CharacterCodes.colon */:
            case 44 /* CharacterCodes.comma */:
            case 47 /* CharacterCodes.slash */:
                return false;
        }
        return true;
    }
    function scanNextNonTrivia() {
        let result;
        do {
            result = scanNext();
        } while (result >= 12 /* SyntaxKind.LineCommentTrivia */ && result <= 15 /* SyntaxKind.Trivia */);
        return result;
    }
    return {
        setPosition: setPosition,
        getPosition: () => pos,
        scan: ignoreTrivia ? scanNextNonTrivia : scanNext,
        getToken: () => token,
        getTokenValue: () => value,
        getTokenOffset: () => tokenOffset,
        getTokenLength: () => pos - tokenOffset,
        getTokenStartLine: () => lineStartOffset,
        getTokenStartCharacter: () => tokenOffset - prevTokenLineStartOffset,
        getTokenError: () => scanError,
    };
}
function isWhiteSpace(ch) {
    return ch === 32 /* CharacterCodes.space */ || ch === 9 /* CharacterCodes.tab */;
}
function isLineBreak(ch) {
    return ch === 10 /* CharacterCodes.lineFeed */ || ch === 13 /* CharacterCodes.carriageReturn */;
}
function isDigit(ch) {
    return ch >= 48 /* CharacterCodes._0 */ && ch <= 57 /* CharacterCodes._9 */;
}
var CharacterCodes;
(function (CharacterCodes) {
    CharacterCodes[CharacterCodes["lineFeed"] = 10] = "lineFeed";
    CharacterCodes[CharacterCodes["carriageReturn"] = 13] = "carriageReturn";
    CharacterCodes[CharacterCodes["space"] = 32] = "space";
    CharacterCodes[CharacterCodes["_0"] = 48] = "_0";
    CharacterCodes[CharacterCodes["_1"] = 49] = "_1";
    CharacterCodes[CharacterCodes["_2"] = 50] = "_2";
    CharacterCodes[CharacterCodes["_3"] = 51] = "_3";
    CharacterCodes[CharacterCodes["_4"] = 52] = "_4";
    CharacterCodes[CharacterCodes["_5"] = 53] = "_5";
    CharacterCodes[CharacterCodes["_6"] = 54] = "_6";
    CharacterCodes[CharacterCodes["_7"] = 55] = "_7";
    CharacterCodes[CharacterCodes["_8"] = 56] = "_8";
    CharacterCodes[CharacterCodes["_9"] = 57] = "_9";
    CharacterCodes[CharacterCodes["a"] = 97] = "a";
    CharacterCodes[CharacterCodes["b"] = 98] = "b";
    CharacterCodes[CharacterCodes["c"] = 99] = "c";
    CharacterCodes[CharacterCodes["d"] = 100] = "d";
    CharacterCodes[CharacterCodes["e"] = 101] = "e";
    CharacterCodes[CharacterCodes["f"] = 102] = "f";
    CharacterCodes[CharacterCodes["g"] = 103] = "g";
    CharacterCodes[CharacterCodes["h"] = 104] = "h";
    CharacterCodes[CharacterCodes["i"] = 105] = "i";
    CharacterCodes[CharacterCodes["j"] = 106] = "j";
    CharacterCodes[CharacterCodes["k"] = 107] = "k";
    CharacterCodes[CharacterCodes["l"] = 108] = "l";
    CharacterCodes[CharacterCodes["m"] = 109] = "m";
    CharacterCodes[CharacterCodes["n"] = 110] = "n";
    CharacterCodes[CharacterCodes["o"] = 111] = "o";
    CharacterCodes[CharacterCodes["p"] = 112] = "p";
    CharacterCodes[CharacterCodes["q"] = 113] = "q";
    CharacterCodes[CharacterCodes["r"] = 114] = "r";
    CharacterCodes[CharacterCodes["s"] = 115] = "s";
    CharacterCodes[CharacterCodes["t"] = 116] = "t";
    CharacterCodes[CharacterCodes["u"] = 117] = "u";
    CharacterCodes[CharacterCodes["v"] = 118] = "v";
    CharacterCodes[CharacterCodes["w"] = 119] = "w";
    CharacterCodes[CharacterCodes["x"] = 120] = "x";
    CharacterCodes[CharacterCodes["y"] = 121] = "y";
    CharacterCodes[CharacterCodes["z"] = 122] = "z";
    CharacterCodes[CharacterCodes["A"] = 65] = "A";
    CharacterCodes[CharacterCodes["B"] = 66] = "B";
    CharacterCodes[CharacterCodes["C"] = 67] = "C";
    CharacterCodes[CharacterCodes["D"] = 68] = "D";
    CharacterCodes[CharacterCodes["E"] = 69] = "E";
    CharacterCodes[CharacterCodes["F"] = 70] = "F";
    CharacterCodes[CharacterCodes["G"] = 71] = "G";
    CharacterCodes[CharacterCodes["H"] = 72] = "H";
    CharacterCodes[CharacterCodes["I"] = 73] = "I";
    CharacterCodes[CharacterCodes["J"] = 74] = "J";
    CharacterCodes[CharacterCodes["K"] = 75] = "K";
    CharacterCodes[CharacterCodes["L"] = 76] = "L";
    CharacterCodes[CharacterCodes["M"] = 77] = "M";
    CharacterCodes[CharacterCodes["N"] = 78] = "N";
    CharacterCodes[CharacterCodes["O"] = 79] = "O";
    CharacterCodes[CharacterCodes["P"] = 80] = "P";
    CharacterCodes[CharacterCodes["Q"] = 81] = "Q";
    CharacterCodes[CharacterCodes["R"] = 82] = "R";
    CharacterCodes[CharacterCodes["S"] = 83] = "S";
    CharacterCodes[CharacterCodes["T"] = 84] = "T";
    CharacterCodes[CharacterCodes["U"] = 85] = "U";
    CharacterCodes[CharacterCodes["V"] = 86] = "V";
    CharacterCodes[CharacterCodes["W"] = 87] = "W";
    CharacterCodes[CharacterCodes["X"] = 88] = "X";
    CharacterCodes[CharacterCodes["Y"] = 89] = "Y";
    CharacterCodes[CharacterCodes["Z"] = 90] = "Z";
    CharacterCodes[CharacterCodes["asterisk"] = 42] = "asterisk";
    CharacterCodes[CharacterCodes["backslash"] = 92] = "backslash";
    CharacterCodes[CharacterCodes["closeBrace"] = 125] = "closeBrace";
    CharacterCodes[CharacterCodes["closeBracket"] = 93] = "closeBracket";
    CharacterCodes[CharacterCodes["colon"] = 58] = "colon";
    CharacterCodes[CharacterCodes["comma"] = 44] = "comma";
    CharacterCodes[CharacterCodes["dot"] = 46] = "dot";
    CharacterCodes[CharacterCodes["doubleQuote"] = 34] = "doubleQuote";
    CharacterCodes[CharacterCodes["minus"] = 45] = "minus";
    CharacterCodes[CharacterCodes["openBrace"] = 123] = "openBrace";
    CharacterCodes[CharacterCodes["openBracket"] = 91] = "openBracket";
    CharacterCodes[CharacterCodes["plus"] = 43] = "plus";
    CharacterCodes[CharacterCodes["slash"] = 47] = "slash";
    CharacterCodes[CharacterCodes["formFeed"] = 12] = "formFeed";
    CharacterCodes[CharacterCodes["tab"] = 9] = "tab";
})(CharacterCodes || (CharacterCodes = {}));


/***/ }),
/* 20 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   cachedBreakLinesWithSpaces: () => (/* binding */ cachedBreakLinesWithSpaces),
/* harmony export */   cachedSpaces: () => (/* binding */ cachedSpaces),
/* harmony export */   supportedEols: () => (/* binding */ supportedEols)
/* harmony export */ });
const cachedSpaces = new Array(20).fill(0).map((_, index) => {
    return ' '.repeat(index);
});
const maxCachedValues = 200;
const cachedBreakLinesWithSpaces = {
    ' ': {
        '\n': new Array(maxCachedValues).fill(0).map((_, index) => {
            return '\n' + ' '.repeat(index);
        }),
        '\r': new Array(maxCachedValues).fill(0).map((_, index) => {
            return '\r' + ' '.repeat(index);
        }),
        '\r\n': new Array(maxCachedValues).fill(0).map((_, index) => {
            return '\r\n' + ' '.repeat(index);
        }),
    },
    '\t': {
        '\n': new Array(maxCachedValues).fill(0).map((_, index) => {
            return '\n' + '\t'.repeat(index);
        }),
        '\r': new Array(maxCachedValues).fill(0).map((_, index) => {
            return '\r' + '\t'.repeat(index);
        }),
        '\r\n': new Array(maxCachedValues).fill(0).map((_, index) => {
            return '\r\n' + '\t'.repeat(index);
        }),
    }
};
const supportedEols = ['\n', '\r', '\r\n'];


/***/ }),
/* 21 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   applyEdit: () => (/* binding */ applyEdit),
/* harmony export */   isWS: () => (/* binding */ isWS),
/* harmony export */   removeProperty: () => (/* binding */ removeProperty),
/* harmony export */   setProperty: () => (/* binding */ setProperty)
/* harmony export */ });
/* harmony import */ var _format__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(18);
/* harmony import */ var _parser__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(22);
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/



function removeProperty(text, path, options) {
    return setProperty(text, path, void 0, options);
}
function setProperty(text, originalPath, value, options) {
    const path = originalPath.slice();
    const errors = [];
    const root = (0,_parser__WEBPACK_IMPORTED_MODULE_1__.parseTree)(text, errors);
    let parent = void 0;
    let lastSegment = void 0;
    while (path.length > 0) {
        lastSegment = path.pop();
        parent = (0,_parser__WEBPACK_IMPORTED_MODULE_1__.findNodeAtLocation)(root, path);
        if (parent === void 0 && value !== void 0) {
            if (typeof lastSegment === 'string') {
                value = { [lastSegment]: value };
            }
            else {
                value = [value];
            }
        }
        else {
            break;
        }
    }
    if (!parent) {
        // empty document
        if (value === void 0) { // delete
            throw new Error('Can not delete in empty document');
        }
        return withFormatting(text, { offset: root ? root.offset : 0, length: root ? root.length : 0, content: JSON.stringify(value) }, options);
    }
    else if (parent.type === 'object' && typeof lastSegment === 'string' && Array.isArray(parent.children)) {
        const existing = (0,_parser__WEBPACK_IMPORTED_MODULE_1__.findNodeAtLocation)(parent, [lastSegment]);
        if (existing !== void 0) {
            if (value === void 0) { // delete
                if (!existing.parent) {
                    throw new Error('Malformed AST');
                }
                const propertyIndex = parent.children.indexOf(existing.parent);
                let removeBegin;
                let removeEnd = existing.parent.offset + existing.parent.length;
                if (propertyIndex > 0) {
                    // remove the comma of the previous node
                    let previous = parent.children[propertyIndex - 1];
                    removeBegin = previous.offset + previous.length;
                }
                else {
                    removeBegin = parent.offset + 1;
                    if (parent.children.length > 1) {
                        // remove the comma of the next node
                        let next = parent.children[1];
                        removeEnd = next.offset;
                    }
                }
                return withFormatting(text, { offset: removeBegin, length: removeEnd - removeBegin, content: '' }, options);
            }
            else {
                // set value of existing property
                return withFormatting(text, { offset: existing.offset, length: existing.length, content: JSON.stringify(value) }, options);
            }
        }
        else {
            if (value === void 0) { // delete
                return []; // property does not exist, nothing to do
            }
            const newProperty = `${JSON.stringify(lastSegment)}: ${JSON.stringify(value)}`;
            const index = options.getInsertionIndex ? options.getInsertionIndex(parent.children.map(p => p.children[0].value)) : parent.children.length;
            let edit;
            if (index > 0) {
                let previous = parent.children[index - 1];
                edit = { offset: previous.offset + previous.length, length: 0, content: ',' + newProperty };
            }
            else if (parent.children.length === 0) {
                edit = { offset: parent.offset + 1, length: 0, content: newProperty };
            }
            else {
                edit = { offset: parent.offset + 1, length: 0, content: newProperty + ',' };
            }
            return withFormatting(text, edit, options);
        }
    }
    else if (parent.type === 'array' && typeof lastSegment === 'number' && Array.isArray(parent.children)) {
        const insertIndex = lastSegment;
        if (insertIndex === -1) {
            // Insert
            const newProperty = `${JSON.stringify(value)}`;
            let edit;
            if (parent.children.length === 0) {
                edit = { offset: parent.offset + 1, length: 0, content: newProperty };
            }
            else {
                const previous = parent.children[parent.children.length - 1];
                edit = { offset: previous.offset + previous.length, length: 0, content: ',' + newProperty };
            }
            return withFormatting(text, edit, options);
        }
        else if (value === void 0 && parent.children.length >= 0) {
            // Removal
            const removalIndex = lastSegment;
            const toRemove = parent.children[removalIndex];
            let edit;
            if (parent.children.length === 1) {
                // only item
                edit = { offset: parent.offset + 1, length: parent.length - 2, content: '' };
            }
            else if (parent.children.length - 1 === removalIndex) {
                // last item
                let previous = parent.children[removalIndex - 1];
                let offset = previous.offset + previous.length;
                let parentEndOffset = parent.offset + parent.length;
                edit = { offset, length: parentEndOffset - 2 - offset, content: '' };
            }
            else {
                edit = { offset: toRemove.offset, length: parent.children[removalIndex + 1].offset - toRemove.offset, content: '' };
            }
            return withFormatting(text, edit, options);
        }
        else if (value !== void 0) {
            let edit;
            const newProperty = `${JSON.stringify(value)}`;
            if (!options.isArrayInsertion && parent.children.length > lastSegment) {
                const toModify = parent.children[lastSegment];
                edit = { offset: toModify.offset, length: toModify.length, content: newProperty };
            }
            else if (parent.children.length === 0 || lastSegment === 0) {
                edit = { offset: parent.offset + 1, length: 0, content: parent.children.length === 0 ? newProperty : newProperty + ',' };
            }
            else {
                const index = lastSegment > parent.children.length ? parent.children.length : lastSegment;
                const previous = parent.children[index - 1];
                edit = { offset: previous.offset + previous.length, length: 0, content: ',' + newProperty };
            }
            return withFormatting(text, edit, options);
        }
        else {
            throw new Error(`Can not ${value === void 0 ? 'remove' : (options.isArrayInsertion ? 'insert' : 'modify')} Array index ${insertIndex} as length is not sufficient`);
        }
    }
    else {
        throw new Error(`Can not add ${typeof lastSegment !== 'number' ? 'index' : 'property'} to parent of type ${parent.type}`);
    }
}
function withFormatting(text, edit, options) {
    if (!options.formattingOptions) {
        return [edit];
    }
    // apply the edit
    let newText = applyEdit(text, edit);
    // format the new text
    let begin = edit.offset;
    let end = edit.offset + edit.content.length;
    if (edit.length === 0 || edit.content.length === 0) { // insert or remove
        while (begin > 0 && !(0,_format__WEBPACK_IMPORTED_MODULE_0__.isEOL)(newText, begin - 1)) {
            begin--;
        }
        while (end < newText.length && !(0,_format__WEBPACK_IMPORTED_MODULE_0__.isEOL)(newText, end)) {
            end++;
        }
    }
    const edits = (0,_format__WEBPACK_IMPORTED_MODULE_0__.format)(newText, { offset: begin, length: end - begin }, { ...options.formattingOptions, keepLines: false });
    // apply the formatting edits and track the begin and end offsets of the changes
    for (let i = edits.length - 1; i >= 0; i--) {
        const edit = edits[i];
        newText = applyEdit(newText, edit);
        begin = Math.min(begin, edit.offset);
        end = Math.max(end, edit.offset + edit.length);
        end += edit.content.length - edit.length;
    }
    // create a single edit with all changes
    const editLength = text.length - (newText.length - end) - begin;
    return [{ offset: begin, length: editLength, content: newText.substring(begin, end) }];
}
function applyEdit(text, edit) {
    return text.substring(0, edit.offset) + edit.content + text.substring(edit.offset + edit.length);
}
function isWS(text, offset) {
    return '\r\n \t'.indexOf(text.charAt(offset)) !== -1;
}


/***/ }),
/* 22 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   contains: () => (/* binding */ contains),
/* harmony export */   findNodeAtLocation: () => (/* binding */ findNodeAtLocation),
/* harmony export */   findNodeAtOffset: () => (/* binding */ findNodeAtOffset),
/* harmony export */   getLocation: () => (/* binding */ getLocation),
/* harmony export */   getNodePath: () => (/* binding */ getNodePath),
/* harmony export */   getNodeType: () => (/* binding */ getNodeType),
/* harmony export */   getNodeValue: () => (/* binding */ getNodeValue),
/* harmony export */   parse: () => (/* binding */ parse),
/* harmony export */   parseTree: () => (/* binding */ parseTree),
/* harmony export */   stripComments: () => (/* binding */ stripComments),
/* harmony export */   visit: () => (/* binding */ visit)
/* harmony export */ });
/* harmony import */ var _scanner__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(19);
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


var ParseOptions;
(function (ParseOptions) {
    ParseOptions.DEFAULT = {
        allowTrailingComma: false
    };
})(ParseOptions || (ParseOptions = {}));
/**
 * For a given offset, evaluate the location in the JSON document. Each segment in the location path is either a property name or an array index.
 */
function getLocation(text, position) {
    const segments = []; // strings or numbers
    const earlyReturnException = new Object();
    let previousNode = undefined;
    const previousNodeInst = {
        value: {},
        offset: 0,
        length: 0,
        type: 'object',
        parent: undefined
    };
    let isAtPropertyKey = false;
    function setPreviousNode(value, offset, length, type) {
        previousNodeInst.value = value;
        previousNodeInst.offset = offset;
        previousNodeInst.length = length;
        previousNodeInst.type = type;
        previousNodeInst.colonOffset = undefined;
        previousNode = previousNodeInst;
    }
    try {
        visit(text, {
            onObjectBegin: (offset, length) => {
                if (position <= offset) {
                    throw earlyReturnException;
                }
                previousNode = undefined;
                isAtPropertyKey = position > offset;
                segments.push(''); // push a placeholder (will be replaced)
            },
            onObjectProperty: (name, offset, length) => {
                if (position < offset) {
                    throw earlyReturnException;
                }
                setPreviousNode(name, offset, length, 'property');
                segments[segments.length - 1] = name;
                if (position <= offset + length) {
                    throw earlyReturnException;
                }
            },
            onObjectEnd: (offset, length) => {
                if (position <= offset) {
                    throw earlyReturnException;
                }
                previousNode = undefined;
                segments.pop();
            },
            onArrayBegin: (offset, length) => {
                if (position <= offset) {
                    throw earlyReturnException;
                }
                previousNode = undefined;
                segments.push(0);
            },
            onArrayEnd: (offset, length) => {
                if (position <= offset) {
                    throw earlyReturnException;
                }
                previousNode = undefined;
                segments.pop();
            },
            onLiteralValue: (value, offset, length) => {
                if (position < offset) {
                    throw earlyReturnException;
                }
                setPreviousNode(value, offset, length, getNodeType(value));
                if (position <= offset + length) {
                    throw earlyReturnException;
                }
            },
            onSeparator: (sep, offset, length) => {
                if (position <= offset) {
                    throw earlyReturnException;
                }
                if (sep === ':' && previousNode && previousNode.type === 'property') {
                    previousNode.colonOffset = offset;
                    isAtPropertyKey = false;
                    previousNode = undefined;
                }
                else if (sep === ',') {
                    const last = segments[segments.length - 1];
                    if (typeof last === 'number') {
                        segments[segments.length - 1] = last + 1;
                    }
                    else {
                        isAtPropertyKey = true;
                        segments[segments.length - 1] = '';
                    }
                    previousNode = undefined;
                }
            }
        });
    }
    catch (e) {
        if (e !== earlyReturnException) {
            throw e;
        }
    }
    return {
        path: segments,
        previousNode,
        isAtPropertyKey,
        matches: (pattern) => {
            let k = 0;
            for (let i = 0; k < pattern.length && i < segments.length; i++) {
                if (pattern[k] === segments[i] || pattern[k] === '*') {
                    k++;
                }
                else if (pattern[k] !== '**') {
                    return false;
                }
            }
            return k === pattern.length;
        }
    };
}
/**
 * Parses the given text and returns the object the JSON content represents. On invalid input, the parser tries to be as fault tolerant as possible, but still return a result.
 * Therefore always check the errors list to find out if the input was valid.
 */
function parse(text, errors = [], options = ParseOptions.DEFAULT) {
    let currentProperty = null;
    let currentParent = [];
    const previousParents = [];
    function onValue(value) {
        if (Array.isArray(currentParent)) {
            currentParent.push(value);
        }
        else if (currentProperty !== null) {
            currentParent[currentProperty] = value;
        }
    }
    const visitor = {
        onObjectBegin: () => {
            const object = {};
            onValue(object);
            previousParents.push(currentParent);
            currentParent = object;
            currentProperty = null;
        },
        onObjectProperty: (name) => {
            currentProperty = name;
        },
        onObjectEnd: () => {
            currentParent = previousParents.pop();
        },
        onArrayBegin: () => {
            const array = [];
            onValue(array);
            previousParents.push(currentParent);
            currentParent = array;
            currentProperty = null;
        },
        onArrayEnd: () => {
            currentParent = previousParents.pop();
        },
        onLiteralValue: onValue,
        onError: (error, offset, length) => {
            errors.push({ error, offset, length });
        }
    };
    visit(text, visitor, options);
    return currentParent[0];
}
/**
 * Parses the given text and returns a tree representation the JSON content. On invalid input, the parser tries to be as fault tolerant as possible, but still return a result.
 */
function parseTree(text, errors = [], options = ParseOptions.DEFAULT) {
    let currentParent = { type: 'array', offset: -1, length: -1, children: [], parent: undefined }; // artificial root
    function ensurePropertyComplete(endOffset) {
        if (currentParent.type === 'property') {
            currentParent.length = endOffset - currentParent.offset;
            currentParent = currentParent.parent;
        }
    }
    function onValue(valueNode) {
        currentParent.children.push(valueNode);
        return valueNode;
    }
    const visitor = {
        onObjectBegin: (offset) => {
            currentParent = onValue({ type: 'object', offset, length: -1, parent: currentParent, children: [] });
        },
        onObjectProperty: (name, offset, length) => {
            currentParent = onValue({ type: 'property', offset, length: -1, parent: currentParent, children: [] });
            currentParent.children.push({ type: 'string', value: name, offset, length, parent: currentParent });
        },
        onObjectEnd: (offset, length) => {
            ensurePropertyComplete(offset + length); // in case of a missing value for a property: make sure property is complete
            currentParent.length = offset + length - currentParent.offset;
            currentParent = currentParent.parent;
            ensurePropertyComplete(offset + length);
        },
        onArrayBegin: (offset, length) => {
            currentParent = onValue({ type: 'array', offset, length: -1, parent: currentParent, children: [] });
        },
        onArrayEnd: (offset, length) => {
            currentParent.length = offset + length - currentParent.offset;
            currentParent = currentParent.parent;
            ensurePropertyComplete(offset + length);
        },
        onLiteralValue: (value, offset, length) => {
            onValue({ type: getNodeType(value), offset, length, parent: currentParent, value });
            ensurePropertyComplete(offset + length);
        },
        onSeparator: (sep, offset, length) => {
            if (currentParent.type === 'property') {
                if (sep === ':') {
                    currentParent.colonOffset = offset;
                }
                else if (sep === ',') {
                    ensurePropertyComplete(offset);
                }
            }
        },
        onError: (error, offset, length) => {
            errors.push({ error, offset, length });
        }
    };
    visit(text, visitor, options);
    const result = currentParent.children[0];
    if (result) {
        delete result.parent;
    }
    return result;
}
/**
 * Finds the node at the given path in a JSON DOM.
 */
function findNodeAtLocation(root, path) {
    if (!root) {
        return undefined;
    }
    let node = root;
    for (let segment of path) {
        if (typeof segment === 'string') {
            if (node.type !== 'object' || !Array.isArray(node.children)) {
                return undefined;
            }
            let found = false;
            for (const propertyNode of node.children) {
                if (Array.isArray(propertyNode.children) && propertyNode.children[0].value === segment && propertyNode.children.length === 2) {
                    node = propertyNode.children[1];
                    found = true;
                    break;
                }
            }
            if (!found) {
                return undefined;
            }
        }
        else {
            const index = segment;
            if (node.type !== 'array' || index < 0 || !Array.isArray(node.children) || index >= node.children.length) {
                return undefined;
            }
            node = node.children[index];
        }
    }
    return node;
}
/**
 * Gets the JSON path of the given JSON DOM node
 */
function getNodePath(node) {
    if (!node.parent || !node.parent.children) {
        return [];
    }
    const path = getNodePath(node.parent);
    if (node.parent.type === 'property') {
        const key = node.parent.children[0].value;
        path.push(key);
    }
    else if (node.parent.type === 'array') {
        const index = node.parent.children.indexOf(node);
        if (index !== -1) {
            path.push(index);
        }
    }
    return path;
}
/**
 * Evaluates the JavaScript object of the given JSON DOM node
 */
function getNodeValue(node) {
    switch (node.type) {
        case 'array':
            return node.children.map(getNodeValue);
        case 'object':
            const obj = Object.create(null);
            for (let prop of node.children) {
                const valueNode = prop.children[1];
                if (valueNode) {
                    obj[prop.children[0].value] = getNodeValue(valueNode);
                }
            }
            return obj;
        case 'null':
        case 'string':
        case 'number':
        case 'boolean':
            return node.value;
        default:
            return undefined;
    }
}
function contains(node, offset, includeRightBound = false) {
    return (offset >= node.offset && offset < (node.offset + node.length)) || includeRightBound && (offset === (node.offset + node.length));
}
/**
 * Finds the most inner node at the given offset. If includeRightBound is set, also finds nodes that end at the given offset.
 */
function findNodeAtOffset(node, offset, includeRightBound = false) {
    if (contains(node, offset, includeRightBound)) {
        const children = node.children;
        if (Array.isArray(children)) {
            for (let i = 0; i < children.length && children[i].offset <= offset; i++) {
                const item = findNodeAtOffset(children[i], offset, includeRightBound);
                if (item) {
                    return item;
                }
            }
        }
        return node;
    }
    return undefined;
}
/**
 * Parses the given text and invokes the visitor functions for each object, array and literal reached.
 */
function visit(text, visitor, options = ParseOptions.DEFAULT) {
    const _scanner = (0,_scanner__WEBPACK_IMPORTED_MODULE_0__.createScanner)(text, false);
    // Important: Only pass copies of this to visitor functions to prevent accidental modification, and
    // to not affect visitor functions which stored a reference to a previous JSONPath
    const _jsonPath = [];
    // Depth of onXXXBegin() callbacks suppressed. onXXXEnd() decrements this if it isn't 0 already.
    // Callbacks are only called when this value is 0.
    let suppressedCallbacks = 0;
    function toNoArgVisit(visitFunction) {
        return visitFunction ? () => suppressedCallbacks === 0 && visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter()) : () => true;
    }
    function toOneArgVisit(visitFunction) {
        return visitFunction ? (arg) => suppressedCallbacks === 0 && visitFunction(arg, _scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter()) : () => true;
    }
    function toOneArgVisitWithPath(visitFunction) {
        return visitFunction ? (arg) => suppressedCallbacks === 0 && visitFunction(arg, _scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter(), () => _jsonPath.slice()) : () => true;
    }
    function toBeginVisit(visitFunction) {
        return visitFunction ?
            () => {
                if (suppressedCallbacks > 0) {
                    suppressedCallbacks++;
                }
                else {
                    let cbReturn = visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter(), () => _jsonPath.slice());
                    if (cbReturn === false) {
                        suppressedCallbacks = 1;
                    }
                }
            }
            : () => true;
    }
    function toEndVisit(visitFunction) {
        return visitFunction ?
            () => {
                if (suppressedCallbacks > 0) {
                    suppressedCallbacks--;
                }
                if (suppressedCallbacks === 0) {
                    visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter());
                }
            }
            : () => true;
    }
    const onObjectBegin = toBeginVisit(visitor.onObjectBegin), onObjectProperty = toOneArgVisitWithPath(visitor.onObjectProperty), onObjectEnd = toEndVisit(visitor.onObjectEnd), onArrayBegin = toBeginVisit(visitor.onArrayBegin), onArrayEnd = toEndVisit(visitor.onArrayEnd), onLiteralValue = toOneArgVisitWithPath(visitor.onLiteralValue), onSeparator = toOneArgVisit(visitor.onSeparator), onComment = toNoArgVisit(visitor.onComment), onError = toOneArgVisit(visitor.onError);
    const disallowComments = options && options.disallowComments;
    const allowTrailingComma = options && options.allowTrailingComma;
    function scanNext() {
        while (true) {
            const token = _scanner.scan();
            switch (_scanner.getTokenError()) {
                case 4 /* ScanError.InvalidUnicode */:
                    handleError(14 /* ParseErrorCode.InvalidUnicode */);
                    break;
                case 5 /* ScanError.InvalidEscapeCharacter */:
                    handleError(15 /* ParseErrorCode.InvalidEscapeCharacter */);
                    break;
                case 3 /* ScanError.UnexpectedEndOfNumber */:
                    handleError(13 /* ParseErrorCode.UnexpectedEndOfNumber */);
                    break;
                case 1 /* ScanError.UnexpectedEndOfComment */:
                    if (!disallowComments) {
                        handleError(11 /* ParseErrorCode.UnexpectedEndOfComment */);
                    }
                    break;
                case 2 /* ScanError.UnexpectedEndOfString */:
                    handleError(12 /* ParseErrorCode.UnexpectedEndOfString */);
                    break;
                case 6 /* ScanError.InvalidCharacter */:
                    handleError(16 /* ParseErrorCode.InvalidCharacter */);
                    break;
            }
            switch (token) {
                case 12 /* SyntaxKind.LineCommentTrivia */:
                case 13 /* SyntaxKind.BlockCommentTrivia */:
                    if (disallowComments) {
                        handleError(10 /* ParseErrorCode.InvalidCommentToken */);
                    }
                    else {
                        onComment();
                    }
                    break;
                case 16 /* SyntaxKind.Unknown */:
                    handleError(1 /* ParseErrorCode.InvalidSymbol */);
                    break;
                case 15 /* SyntaxKind.Trivia */:
                case 14 /* SyntaxKind.LineBreakTrivia */:
                    break;
                default:
                    return token;
            }
        }
    }
    function handleError(error, skipUntilAfter = [], skipUntil = []) {
        onError(error);
        if (skipUntilAfter.length + skipUntil.length > 0) {
            let token = _scanner.getToken();
            while (token !== 17 /* SyntaxKind.EOF */) {
                if (skipUntilAfter.indexOf(token) !== -1) {
                    scanNext();
                    break;
                }
                else if (skipUntil.indexOf(token) !== -1) {
                    break;
                }
                token = scanNext();
            }
        }
    }
    function parseString(isValue) {
        const value = _scanner.getTokenValue();
        if (isValue) {
            onLiteralValue(value);
        }
        else {
            onObjectProperty(value);
            // add property name afterwards
            _jsonPath.push(value);
        }
        scanNext();
        return true;
    }
    function parseLiteral() {
        switch (_scanner.getToken()) {
            case 11 /* SyntaxKind.NumericLiteral */:
                const tokenValue = _scanner.getTokenValue();
                let value = Number(tokenValue);
                if (isNaN(value)) {
                    handleError(2 /* ParseErrorCode.InvalidNumberFormat */);
                    value = 0;
                }
                onLiteralValue(value);
                break;
            case 7 /* SyntaxKind.NullKeyword */:
                onLiteralValue(null);
                break;
            case 8 /* SyntaxKind.TrueKeyword */:
                onLiteralValue(true);
                break;
            case 9 /* SyntaxKind.FalseKeyword */:
                onLiteralValue(false);
                break;
            default:
                return false;
        }
        scanNext();
        return true;
    }
    function parseProperty() {
        if (_scanner.getToken() !== 10 /* SyntaxKind.StringLiteral */) {
            handleError(3 /* ParseErrorCode.PropertyNameExpected */, [], [2 /* SyntaxKind.CloseBraceToken */, 5 /* SyntaxKind.CommaToken */]);
            return false;
        }
        parseString(false);
        if (_scanner.getToken() === 6 /* SyntaxKind.ColonToken */) {
            onSeparator(':');
            scanNext(); // consume colon
            if (!parseValue()) {
                handleError(4 /* ParseErrorCode.ValueExpected */, [], [2 /* SyntaxKind.CloseBraceToken */, 5 /* SyntaxKind.CommaToken */]);
            }
        }
        else {
            handleError(5 /* ParseErrorCode.ColonExpected */, [], [2 /* SyntaxKind.CloseBraceToken */, 5 /* SyntaxKind.CommaToken */]);
        }
        _jsonPath.pop(); // remove processed property name
        return true;
    }
    function parseObject() {
        onObjectBegin();
        scanNext(); // consume open brace
        let needsComma = false;
        while (_scanner.getToken() !== 2 /* SyntaxKind.CloseBraceToken */ && _scanner.getToken() !== 17 /* SyntaxKind.EOF */) {
            if (_scanner.getToken() === 5 /* SyntaxKind.CommaToken */) {
                if (!needsComma) {
                    handleError(4 /* ParseErrorCode.ValueExpected */, [], []);
                }
                onSeparator(',');
                scanNext(); // consume comma
                if (_scanner.getToken() === 2 /* SyntaxKind.CloseBraceToken */ && allowTrailingComma) {
                    break;
                }
            }
            else if (needsComma) {
                handleError(6 /* ParseErrorCode.CommaExpected */, [], []);
            }
            if (!parseProperty()) {
                handleError(4 /* ParseErrorCode.ValueExpected */, [], [2 /* SyntaxKind.CloseBraceToken */, 5 /* SyntaxKind.CommaToken */]);
            }
            needsComma = true;
        }
        onObjectEnd();
        if (_scanner.getToken() !== 2 /* SyntaxKind.CloseBraceToken */) {
            handleError(7 /* ParseErrorCode.CloseBraceExpected */, [2 /* SyntaxKind.CloseBraceToken */], []);
        }
        else {
            scanNext(); // consume close brace
        }
        return true;
    }
    function parseArray() {
        onArrayBegin();
        scanNext(); // consume open bracket
        let isFirstElement = true;
        let needsComma = false;
        while (_scanner.getToken() !== 4 /* SyntaxKind.CloseBracketToken */ && _scanner.getToken() !== 17 /* SyntaxKind.EOF */) {
            if (_scanner.getToken() === 5 /* SyntaxKind.CommaToken */) {
                if (!needsComma) {
                    handleError(4 /* ParseErrorCode.ValueExpected */, [], []);
                }
                onSeparator(',');
                scanNext(); // consume comma
                if (_scanner.getToken() === 4 /* SyntaxKind.CloseBracketToken */ && allowTrailingComma) {
                    break;
                }
            }
            else if (needsComma) {
                handleError(6 /* ParseErrorCode.CommaExpected */, [], []);
            }
            if (isFirstElement) {
                _jsonPath.push(0);
                isFirstElement = false;
            }
            else {
                _jsonPath[_jsonPath.length - 1]++;
            }
            if (!parseValue()) {
                handleError(4 /* ParseErrorCode.ValueExpected */, [], [4 /* SyntaxKind.CloseBracketToken */, 5 /* SyntaxKind.CommaToken */]);
            }
            needsComma = true;
        }
        onArrayEnd();
        if (!isFirstElement) {
            _jsonPath.pop(); // remove array index
        }
        if (_scanner.getToken() !== 4 /* SyntaxKind.CloseBracketToken */) {
            handleError(8 /* ParseErrorCode.CloseBracketExpected */, [4 /* SyntaxKind.CloseBracketToken */], []);
        }
        else {
            scanNext(); // consume close bracket
        }
        return true;
    }
    function parseValue() {
        switch (_scanner.getToken()) {
            case 3 /* SyntaxKind.OpenBracketToken */:
                return parseArray();
            case 1 /* SyntaxKind.OpenBraceToken */:
                return parseObject();
            case 10 /* SyntaxKind.StringLiteral */:
                return parseString(true);
            default:
                return parseLiteral();
        }
    }
    scanNext();
    if (_scanner.getToken() === 17 /* SyntaxKind.EOF */) {
        if (options.allowEmptyContent) {
            return true;
        }
        handleError(4 /* ParseErrorCode.ValueExpected */, [], []);
        return false;
    }
    if (!parseValue()) {
        handleError(4 /* ParseErrorCode.ValueExpected */, [], []);
        return false;
    }
    if (_scanner.getToken() !== 17 /* SyntaxKind.EOF */) {
        handleError(9 /* ParseErrorCode.EndOfFileExpected */, [], []);
    }
    return true;
}
/**
 * Takes JSON with JavaScript-style comments and remove
 * them. Optionally replaces every none-newline character
 * of comments with a replaceCharacter
 */
function stripComments(text, replaceCh) {
    let _scanner = (0,_scanner__WEBPACK_IMPORTED_MODULE_0__.createScanner)(text), parts = [], kind, offset = 0, pos;
    do {
        pos = _scanner.getPosition();
        kind = _scanner.scan();
        switch (kind) {
            case 12 /* SyntaxKind.LineCommentTrivia */:
            case 13 /* SyntaxKind.BlockCommentTrivia */:
            case 17 /* SyntaxKind.EOF */:
                if (offset !== pos) {
                    parts.push(text.substring(offset, pos));
                }
                if (replaceCh !== undefined) {
                    parts.push(_scanner.getTokenValue().replace(/[^\r\n]/g, replaceCh));
                }
                offset = _scanner.getPosition();
                break;
        }
    } while (kind !== 17 /* SyntaxKind.EOF */);
    return parts.join('');
}
function getNodeType(value) {
    switch (typeof value) {
        case 'boolean': return 'boolean';
        case 'number': return 'number';
        case 'string': return 'string';
        case 'object': {
            if (!value) {
                return 'null';
            }
            else if (Array.isArray(value)) {
                return 'array';
            }
            return 'object';
        }
        default: return 'null';
    }
}


/***/ }),
/* 23 */
/***/ ((module) => {

module.exports = require("node:fs/promises");

/***/ }),
/* 24 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.VersionsService = void 0;
/**
 * Version management singleton: stores version profiles (settings + target
 * branch) in the workspace data file, tracks the active version, and applies
 * default-value operations against odooDebugger.defaultVersion.*.
 */
const vscode = __importStar(__webpack_require__(1));
const version_1 = __webpack_require__(25);
const settingsStore_1 = __webpack_require__(6);
const utils_1 = __webpack_require__(8);
const logger_1 = __webpack_require__(12);
const notifications_1 = __webpack_require__(16);
const versionIdentity_1 = __webpack_require__(27);
class VersionsService {
    static instance;
    versions = new Map();
    activeVersionId;
    initialized = false;
    constructor() {
        // Initialization will be done via initialize() method
    }
    static getInstance() {
        if (!VersionsService.instance) {
            VersionsService.instance = new VersionsService();
        }
        return VersionsService.instance;
    }
    /**
     * Initialize the service by loading versions
     */
    async initialize() {
        if (!this.initialized) {
            await this.loadVersions();
            await this.validateAndRepairVersions();
            this.initialized = true;
        }
    }
    /**
     * Load versions from odoo-debugger-data.json
     */
    async loadVersions() {
        try {
            const data = await settingsStore_1.SettingsStore.load();
            const versionsData = data.versions || {};
            const activeVersionId = data.activeVersion;
            this.versions.clear();
            // Load existing versions
            Object.entries(versionsData).forEach(([id, versionData]) => {
                const version = version_1.VersionModel.fromJSON(versionData);
                if (version) {
                    this.versions.set(id, version);
                }
            });
            // Check if legacy settings exist - if so, skip auto-saving to preserve them for migration
            const hasLegacySettings = await this.hasLegacySettings();
            // Create default version if none exist
            if (this.versions.size === 0) {
                const defaultVersion = new version_1.VersionModel('Default Version', '17.0', // Odoo version
                (0, utils_1.getDefaultVersionSettings)());
                defaultVersion.isActive = true;
                this.versions.set(defaultVersion.id, defaultVersion);
                this.activeVersionId = defaultVersion.id;
                // Only save if no legacy settings exist (to avoid destroying them before migration)
                if (!hasLegacySettings) {
                    await this.saveVersions();
                }
            }
            else {
                this.activeVersionId = activeVersionId;
                // Ensure active version exists and update isActive flags
                if (!this.activeVersionId || !this.versions.has(this.activeVersionId)) {
                    this.activeVersionId = this.versions.keys().next().value;
                }
                // Update isActive flags for all versions
                this.versions.forEach((version, id) => {
                    version.isActive = (id === this.activeVersionId);
                });
                // Only save if no legacy settings exist (to avoid destroying them before migration)
                if (!hasLegacySettings) {
                    await this.saveVersions();
                }
            }
        }
        catch (error) {
            logger_1.logger.error('Failed to load versions:', error);
            // Create default version on error
            const defaultVersion = new version_1.VersionModel('Default Version', '17.0', (0, utils_1.getDefaultVersionSettings)());
            defaultVersion.isActive = true;
            this.versions.set(defaultVersion.id, defaultVersion);
            this.activeVersionId = defaultVersion.id;
        }
    }
    /**
     * Save all versions to odoo-debugger-data.json
     */
    async saveVersions() {
        try {
            const data = await settingsStore_1.SettingsStore.load();
            const versionsData = {};
            this.versions.forEach((version, id) => {
                versionsData[id] = version.toJSON();
            });
            data.versions = versionsData;
            data.activeVersion = this.activeVersionId;
            await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
            logger_1.logger.debug(`Saved ${this.versions.size} versions successfully`);
        }
        catch (error) {
            logger_1.logger.error('Failed to save versions:', error);
            throw error; // Re-throw to propagate error up the chain
        }
    }
    /**
     * Save versions during migration without stripping settings (they'll be cleared separately)
     */
    async saveVersionsDuringMigration() {
        try {
            const data = await settingsStore_1.SettingsStore.load();
            const versionsData = {};
            this.versions.forEach((version, id) => {
                versionsData[id] = version.toJSON();
            });
            data.versions = versionsData;
            data.activeVersion = this.activeVersionId;
            // During migration, don't strip settings - they'll be cleared by clearLegacySettings
            await settingsStore_1.SettingsStore.saveWithoutComments(data);
            logger_1.logger.debug(`Saved ${this.versions.size} versions during migration`);
        }
        catch (error) {
            logger_1.logger.error('Failed to save versions during migration:', error);
            throw error;
        }
    }
    /**
 * Get all versions
 */
    getVersions() {
        return Array.from(this.versions.values());
    }
    /**
     * Get a specific version by ID
     */
    getVersion(id) {
        return this.versions.get(id);
    }
    /**
     * Get the currently active version
     */
    getActiveVersion() {
        if (!this.activeVersionId) {
            return undefined;
        }
        return this.versions.get(this.activeVersionId);
    }
    /**
     * Get settings from the currently active version
     * Falls back to default settings if no active version
     */
    async getActiveVersionSettings() {
        await this.initialize(); // Ensure initialization
        const activeVersion = this.getActiveVersion();
        if (activeVersion?.settings) {
            logger_1.logger.debug(`Using settings from active version: ${activeVersion.name}`);
            return activeVersion.settings;
        }
        // Fallback: if no active version or no settings, create a temporary default
        logger_1.logger.warn('No active version or settings found, creating temporary default settings');
        // Create a version with default settings if none exists
        if (this.versions.size === 0) {
            const defaultVersion = new version_1.VersionModel('Default Version', '17.0', (0, utils_1.getDefaultVersionSettings)());
            defaultVersion.isActive = true;
            this.versions.set(defaultVersion.id, defaultVersion);
            this.activeVersionId = defaultVersion.id;
            await this.ensureIdentity(defaultVersion);
            await this.saveVersions();
            return defaultVersion.settings;
        }
        // Return configuration-backed defaults as fallback
        return (0, utils_1.getDefaultVersionSettings)();
    }
    /**
     * Set active version
     */
    async setActiveVersion(id) {
        await this.initialize(); // Ensure initialization
        if (!this.versions.has(id)) {
            logger_1.logger.error(`Version with id ${id} not found`);
            return false;
        }
        const oldActiveVersionId = this.activeVersionId;
        // Update isActive properties on all versions
        this.versions.forEach((version, versionId) => {
            version.isActive = (versionId === id);
        });
        this.activeVersionId = id;
        try {
            await this.saveVersions(); // Save all versions to update isActive flags
            // Fire event for UI updates
            vscode.commands.executeCommand('odoo.versionsChanged');
            logger_1.logger.debug(`Successfully set active version from ${oldActiveVersionId} to ${id}`);
            return true;
        }
        catch (error) {
            logger_1.logger.error('Error saving active version:', error);
            // Revert on error
            this.activeVersionId = oldActiveVersionId;
            this.versions.forEach((version, versionId) => {
                version.isActive = (versionId === oldActiveVersionId);
            });
            return false;
        }
    }
    /** Prefix for generated launch configuration names (`<prefix>:<branch>`). */
    getDebuggerNamePrefix() {
        const configured = vscode.workspace
            .getConfiguration('odooDebugger')
            .get('debuggerNamePrefix', 'odoo')
            .trim();
        return configured || 'odoo';
    }
    /**
     * A fresh identity for `odooVersion`, avoiding both the other versions'
     * values and any port something else is already listening on.
     */
    async deriveFreshIdentity(odooVersion, exceptId) {
        const taken = (0, versionIdentity_1.collectTaken)(Array.from(this.versions.values()), exceptId);
        for (const port of await (0, versionIdentity_1.probeBusyPorts)((0, versionIdentity_1.candidatePortsFor)(odooVersion))) {
            taken.ports.add(port);
        }
        return (0, versionIdentity_1.deriveIdentity)(odooVersion, this.getDebuggerNamePrefix(), taken);
    }
    /**
     * Gives `version` a derived identity when it has none. Every creation path
     * runs through this, so no version can reach launch.json carrying the
     * blank baseline or another version's name.
     */
    async ensureIdentity(version) {
        const { debuggerName, portNumber, shellPortNumber } = version.settings;
        if (debuggerName && portNumber > 0 && shellPortNumber > 0) {
            return;
        }
        version.settings = {
            ...version.settings,
            ...(await this.deriveFreshIdentity(version.odooVersion, version.id))
        };
    }
    /**
     * Create a new version
     */
    async createVersion(name, odooVersion, settingsOverrides = {}) {
        await this.initialize(); // Ensure initialization
        // Get default settings from VS Code configuration
        const defaultSettings = (0, utils_1.getDefaultVersionSettings)();
        // Identity is derived from the branch, so it wins over both the
        // configured defaults and any caller-supplied override: two versions
        // sharing a debuggerName would overwrite each other in launch.json.
        const identity = await this.deriveFreshIdentity(odooVersion);
        const mergedSettings = { ...defaultSettings, ...settingsOverrides, ...identity };
        const version = new version_1.VersionModel(name, odooVersion, mergedSettings);
        this.versions.set(version.id, version);
        await this.saveVersions();
        vscode.commands.executeCommand('odoo.versionsChanged');
        return version;
    }
    /**
     * Update an existing version
     */
    async updateVersion(id, updates) {
        await this.initialize(); // Ensure initialization
        const version = this.versions.get(id);
        if (!version) {
            return false;
        }
        const updatesCopy = { ...updates };
        let settingsPatch = updatesCopy.settings ? { ...updatesCopy.settings } : undefined;
        if (settingsPatch) {
            Object.assign(version.settings, settingsPatch);
        }
        const { settings: _settings, ...otherUpdates } = updatesCopy;
        Object.assign(version, otherUpdates);
        // Update the updatedAt timestamp
        version.updatedAt = new Date();
        await this.saveVersions();
        vscode.commands.executeCommand('odoo.versionsChanged');
        return true;
    }
    /**
     * Delete a version
     */
    async deleteVersion(id) {
        await this.initialize(); // Ensure initialization
        if (!this.versions.has(id)) {
            return false;
        }
        // Don't allow deleting the last version
        if (this.versions.size <= 1) {
            void (0, notifications_1.showWarning)('Cannot delete the last version. At least one version must exist.');
            return false;
        }
        // Clean up any database references to this version before deleting
        await this.cleanupDatabaseVersionReferences(id);
        this.versions.delete(id);
        // If this was the active version, switch to another one
        if (this.activeVersionId === id) {
            this.activeVersionId = this.versions.keys().next().value;
            // Update isActive flags for all versions
            this.versions.forEach((version, versionId) => {
                version.isActive = (versionId === this.activeVersionId);
            });
        }
        await this.saveVersions();
        vscode.commands.executeCommand('odoo.versionsChanged');
        return true;
    }
    /**
     * Clean up database references when a version is deleted
     */
    async cleanupDatabaseVersionReferences(deletedVersionId) {
        try {
            const data = await settingsStore_1.SettingsStore.load();
            let needsSave = false;
            if (data.projects && Array.isArray(data.projects)) {
                for (const project of data.projects) {
                    if (project.dbs && Array.isArray(project.dbs)) {
                        for (const db of project.dbs) {
                            if (db.versionId === deletedVersionId) {
                                logger_1.logger.debug(`Clearing version reference from database "${(0, utils_1.getDatabaseLabel)(db)}" (was using deleted version)`);
                                db.versionId = undefined;
                                // Don't touch odooVersion - let it remain as is for backward compatibility
                                needsSave = true;
                            }
                        }
                    }
                }
            }
            if (needsSave) {
                logger_1.logger.debug('Saving cleaned database references after version deletion');
                await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
            }
        }
        catch (error) {
            logger_1.logger.warn('Failed to clean up database version references:', error);
            // Don't throw - this shouldn't prevent version deletion
        }
    }
    /**
     * Clone a version
     */
    async cloneVersion(sourceId, newName) {
        await this.initialize(); // Ensure initialization
        const sourceVersion = this.versions.get(sourceId);
        if (!sourceVersion) {
            logger_1.logger.error(`Source version with id ${sourceId} not found`);
            return undefined;
        }
        try {
            const clonedVersion = sourceVersion.clone(newName);
            this.versions.set(clonedVersion.id, clonedVersion);
            // A clone must not inherit the source's identity - that is exactly
            // the collision this derivation exists to prevent.
            clonedVersion.settings = {
                ...clonedVersion.settings,
                ...(await this.deriveFreshIdentity(clonedVersion.odooVersion, clonedVersion.id))
            };
            await this.saveVersions();
            vscode.commands.executeCommand('odoo.versionsChanged');
            logger_1.logger.debug(`Successfully cloned version ${sourceVersion.name} to ${newName}`);
            return clonedVersion;
        }
        catch (error) {
            logger_1.logger.error('Error cloning version:', error);
            return undefined;
        }
    }
    /**
     * Update settings for active version
     */
    async updateActiveSettings(settings) {
        await this.initialize(); // Ensure initialization
        const activeVersion = this.getActiveVersion();
        if (!activeVersion) {
            logger_1.logger.warn('No active version is configured, cannot update settings');
            return;
        }
        Object.assign(activeVersion.settings, settings);
        activeVersion.updatedAt = new Date();
        await this.saveVersions();
        vscode.commands.executeCommand('odoo.versionsChanged');
    }
    /**
     * Refresh from odoo-debugger-data.json (useful when data changes externally)
     */
    async refresh() {
        await this.loadVersions();
        await this.validateAndRepairVersions();
        // Also attempt migration in case legacy settings were added externally
        await this.migrateFromLegacySettings().catch(error => {
            logger_1.logger.warn('Settings migration during refresh failed (this is non-critical):', error);
        });
        vscode.commands.executeCommand('odoo.versionsChanged');
    }
    /**
     * Validate and repair versions data structure
     */
    async validateAndRepairVersions() {
        let needsRepair = false;
        // Ensure we have at least one version
        if (this.versions.size === 0) {
            logger_1.logger.debug('No versions found, creating default version');
            const defaultVersion = new version_1.VersionModel('Default Version', '17.0', (0, utils_1.getDefaultVersionSettings)());
            defaultVersion.isActive = true;
            this.versions.set(defaultVersion.id, defaultVersion);
            this.activeVersionId = defaultVersion.id;
            await this.ensureIdentity(defaultVersion);
            needsRepair = true;
        }
        // Ensure we have an active version
        if (!this.activeVersionId || !this.versions.has(this.activeVersionId)) {
            logger_1.logger.debug('Invalid active version, selecting first available version');
            this.activeVersionId = this.versions.keys().next().value;
            needsRepair = true;
        }
        // Ensure only one version is marked as active
        let activeCount = 0;
        this.versions.forEach((version, id) => {
            if (version.isActive) {
                activeCount++;
                if (id !== this.activeVersionId) {
                    version.isActive = false;
                    needsRepair = true;
                }
            }
            else if (id === this.activeVersionId) {
                version.isActive = true;
                needsRepair = true;
            }
        });
        if (activeCount === 0) {
            const activeVersion = this.versions.get(this.activeVersionId);
            if (activeVersion) {
                activeVersion.isActive = true;
                needsRepair = true;
            }
        }
        // Identity is derived, but existing versions are healed rather than
        // rewritten: a stored name/port survives unless it is missing or
        // collides with an older version's - the case where every version
        // inherited one global default and they overwrote each other.
        const patches = (0, versionIdentity_1.healIdentities)(Array.from(this.versions.values()), this.getDebuggerNamePrefix());
        for (const patch of patches) {
            const version = this.versions.get(patch.id);
            if (!version) {
                continue;
            }
            logger_1.logger.info(`[identity] ${version.name}: ${version.settings.debuggerName ?? 'none'} -> ` +
                `${patch.identity.debuggerName} (ports ${patch.identity.portNumber}/${patch.identity.shellPortNumber})`);
            version.settings = { ...version.settings, ...patch.identity };
            needsRepair = true;
        }
        // Save if repairs were needed
        if (needsRepair) {
            logger_1.logger.debug('Version data repaired, saving...');
            await this.saveVersions();
        }
    }
    /**
 * Migrate existing settings from SettingsStore to a new version for backwards compatibility
 */
    async migrateFromLegacySettings() {
        try {
            logger_1.logger.debug('Starting migration check...');
            // Check if legacy settings actually exist in the file
            if (!(await this.hasLegacySettings())) {
                logger_1.logger.debug('No legacy settings found, migration not needed');
                return;
            }
            logger_1.logger.debug('Legacy settings found, proceeding with migration...');
            // Read raw legacy settings without model-default inflation so workspace defaults
            // can still apply for missing keys during migration.
            const rawData = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
            const existingSettings = rawData.settings;
            if (!existingSettings || Object.keys(existingSettings).length === 0) {
                logger_1.logger.debug('Legacy settings exist but are empty, clearing them');
                await this.clearLegacySettings();
                return;
            }
            logger_1.logger.debug('Retrieved legacy settings:', existingSettings);
            // Check if we already have a migrated version (avoid duplicate migration)
            if (this.getVersion('migrated-version')) {
                logger_1.logger.debug('Migration already completed, clearing legacy settings');
                await this.clearLegacySettings();
                return;
            }
            logger_1.logger.debug('Migrating legacy settings to version management...');
            const defaultSettings = (0, utils_1.getDefaultVersionSettings)();
            // Convert SettingsModel to VersionSettings format
            const versionSettings = {
                // Identity has no configured default any more: keep whatever the
                // legacy settings carried, and let ensureIdentity derive the rest.
                debuggerName: existingSettings.debuggerName ?? '',
                debuggerVersion: existingSettings.debuggerVersion ?? defaultSettings.debuggerVersion,
                portNumber: existingSettings.portNumber ?? 0,
                shellPortNumber: existingSettings.shellPortNumber ?? 0,
                limitTimeReal: existingSettings.limitTimeReal ?? defaultSettings.limitTimeReal,
                limitTimeCpu: existingSettings.limitTimeCpu ?? defaultSettings.limitTimeCpu,
                maxCronThreads: existingSettings.maxCronThreads ?? defaultSettings.maxCronThreads,
                extraParams: existingSettings.extraParams ?? defaultSettings.extraParams,
                devMode: existingSettings.devMode ?? defaultSettings.devMode,
                dumpsFolder: existingSettings.dumpsFolder ?? defaultSettings.dumpsFolder,
                odooPath: existingSettings.odooPath ?? defaultSettings.odooPath,
                enterprisePath: existingSettings.enterprisePath ?? defaultSettings.enterprisePath,
                designThemesPath: existingSettings.designThemesPath ?? defaultSettings.designThemesPath,
                customAddonsPath: existingSettings.customAddonsPath ?? defaultSettings.customAddonsPath,
                pythonPath: existingSettings.pythonPath ?? defaultSettings.pythonPath,
                subModulesPaths: existingSettings.subModulesPaths ?? defaultSettings.subModulesPaths,
                installApps: existingSettings.installApps ?? defaultSettings.installApps,
                upgradeApps: existingSettings.upgradeApps ?? defaultSettings.upgradeApps,
                postSwitchCommands: Array.isArray(existingSettings.postSwitchCommands)
                    ? existingSettings.postSwitchCommands
                    : defaultSettings.postSwitchCommands
            };
            // Create a new version with migrated settings
            const migratedVersion = new version_1.VersionModel('Migrated Settings', '17.0', // Default Odoo version
            versionSettings);
            migratedVersion.id = 'migrated-version';
            // Clear existing default version if it exists and replace with migrated version
            if (this.versions.size === 1) {
                const existingVersion = Array.from(this.versions.values())[0];
                if (existingVersion.name === 'Default Version') {
                    this.versions.clear();
                }
            }
            // Add the migrated version and set as active
            migratedVersion.isActive = true;
            this.versions.set(migratedVersion.id, migratedVersion);
            this.activeVersionId = migratedVersion.id;
            // Must happen before the save: this runs after initialize(), so
            // healIdentities would not otherwise see it until the next session.
            await this.ensureIdentity(migratedVersion);
            logger_1.logger.debug('Saving migrated version to versions system...');
            await this.saveVersionsDuringMigration();
            logger_1.logger.debug('Clearing legacy settings after successful version save...');
            // Clear the legacy settings to prevent repeated migration
            await this.clearLegacySettings();
            // Now that legacy settings are cleared, save versions normally to ensure proper state
            logger_1.logger.debug('Final save of versions with settings properly cleared...');
            await this.saveVersions();
            logger_1.logger.debug('Successfully migrated legacy settings to version management');
        }
        catch (error) {
            logger_1.logger.warn('Failed to migrate legacy settings:', error);
            // Don't throw - migration failure shouldn't break the extension
        }
    }
    /**
     * Clear legacy settings from odoo-debugger-data.json after successful migration
     */
    async clearLegacySettings() {
        try {
            const data = await settingsStore_1.SettingsStore.load();
            // Remove the settings property but keep projects
            if (data.settings) {
                delete data.settings;
                await settingsStore_1.SettingsStore.saveWithoutComments(data);
                logger_1.logger.debug('Legacy settings cleared after successful migration');
            }
        }
        catch (error) {
            logger_1.logger.warn('Failed to clear legacy settings:', error);
            // Don't throw - clearing failure shouldn't break anything
        }
    }
    /**
     * Check if legacy settings exist in the odoo-debugger-data.json file
     */
    async hasLegacySettings() {
        try {
            const data = await settingsStore_1.SettingsStore.load();
            return !!(data.settings && Object.keys(data.settings).length > 0);
        }
        catch (error) {
            logger_1.logger.warn('Failed to check for legacy settings:', error);
            return false;
        }
    }
    /**
     * Set a specific setting to its default value for a version
     */
    async setSettingToDefault(versionId, settingKey) {
        const version = this.versions.get(versionId);
        if (!version) {
            void (0, notifications_1.showError)('The selected version could not be found.');
            return false;
        }
        if ((0, versionIdentity_1.isDerivedSetting)(settingKey)) {
            void (0, notifications_1.showInfo)(`"${settingKey}" is derived from the version's branch and has no default to restore.`);
            return false;
        }
        try {
            // Get the default value for this setting
            const defaultSettings = (0, utils_1.getDefaultVersionSettings)();
            const defaultValue = defaultSettings[settingKey];
            if (defaultValue === undefined) {
                void (0, notifications_1.showError)('Default value not found for this setting.');
                return false;
            }
            // Update the setting
            const updatedSettings = { ...version.settings, [settingKey]: defaultValue };
            version.updateSettings(updatedSettings);
            await this.saveVersions();
            vscode.commands.executeCommand('odoo.versionsChanged');
            void (0, notifications_1.showInfo)(`Setting "${settingKey}" reset to default value.`);
            return true;
        }
        catch (error) {
            logger_1.logger.error('Failed to set setting to default:', error);
            void (0, notifications_1.showError)('Failed to set setting to default value.');
            return false;
        }
    }
    /**
     * Set a specific setting's current value as the new default
     */
    async setSettingAsDefault(versionId, settingKey) {
        const version = this.versions.get(versionId);
        if (!version) {
            void (0, notifications_1.showError)('The selected version could not be found.');
            return false;
        }
        try {
            const currentValue = version.settings[settingKey];
            if (currentValue === undefined) {
                void (0, notifications_1.showError)('Setting value not found.');
                return false;
            }
            // Update the VS Code configuration
            const config = vscode.workspace.getConfiguration('odooDebugger.defaultVersion');
            await config.update(settingKey, currentValue, vscode.ConfigurationTarget.Workspace);
            void (0, notifications_1.showInfo)(`Setting "${settingKey}" value saved as new default.`);
            return true;
        }
        catch (error) {
            logger_1.logger.error('Unable to save this setting as the default:', error);
            void (0, notifications_1.showError)('Unable to save this setting as the default.');
            return false;
        }
    }
    /**
     * Set all settings to their default values for a version
     */
    async setAllSettingsToDefault(versionId) {
        const version = this.versions.get(versionId);
        if (!version) {
            void (0, notifications_1.showError)('The selected version could not be found.');
            return false;
        }
        try {
            // Get all default settings from VS Code configuration
            const defaultSettings = (0, utils_1.getDefaultVersionSettings)();
            // Identity is derived from the branch; resetting to defaults must
            // not clear it, or two versions collide again.
            version.updateSettings({
                ...defaultSettings,
                debuggerName: version.settings.debuggerName,
                portNumber: version.settings.portNumber,
                shellPortNumber: version.settings.shellPortNumber
            });
            await this.saveVersions();
            vscode.commands.executeCommand('odoo.versionsChanged');
            void (0, notifications_1.showInfo)(`All settings reset to default values for version "${version.name}".`);
            return true;
        }
        catch (error) {
            logger_1.logger.error('Failed to set all settings to default:', error);
            void (0, notifications_1.showError)('Unable to reset all settings to their default values.');
            return false;
        }
    }
    /**
     * Set all current settings as new defaults
     */
    async setAllSettingsAsDefault(versionId) {
        const version = this.versions.get(versionId);
        if (!version) {
            void (0, notifications_1.showError)('The selected version could not be found.');
            return false;
        }
        try {
            const config = vscode.workspace.getConfiguration('odooDebugger.defaultVersion');
            const settings = version.settings;
            // Update all settings in configuration
            for (const [key, value] of Object.entries(settings)) {
                // No configuration keys exist for derived identity.
                if ((0, versionIdentity_1.isDerivedSetting)(key)) {
                    continue;
                }
                await config.update(key, value, vscode.ConfigurationTarget.Workspace);
            }
            void (0, notifications_1.showInfo)(`All settings from version "${version.name}" saved as new defaults.`);
            return true;
        }
        catch (error) {
            logger_1.logger.error('Failed to set all settings as default:', error);
            void (0, notifications_1.showError)('Unable to save these settings as the new defaults.');
            return false;
        }
    }
}
exports.VersionsService = VersionsService;


/***/ }),
/* 25 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.VersionModel = void 0;
/**
 * Version model: a named settings profile bound to a target Odoo branch.
 */
const crypto_1 = __webpack_require__(26);
class VersionModel {
    id;
    name; // User-friendly name like "Odoo 17.0", "Saas 17.4"
    odooVersion; // Branch name like "17.0", "saas-17.4", "master"
    settings;
    isActive = false; // Currently active version
    createdAt;
    updatedAt;
    constructor(name, odooVersion, settings = {}, id = (0, crypto_1.randomUUID)(), isActive = false) {
        this.id = id;
        this.name = name;
        this.odooVersion = odooVersion;
        this.isActive = isActive;
        this.createdAt = new Date();
        this.updatedAt = new Date();
        // Baseline settings for partial payloads (full defaults are managed by VersionsService/config).
        this.settings = {
            // Identity is derived from the branch by VersionsService; these
            // blanks mark "not derived yet" so healIdentities fills them in
            // rather than a plausible-looking default surviving unnoticed.
            debuggerName: '',
            debuggerVersion: "1.0.0",
            portNumber: 0,
            shellPortNumber: 0,
            limitTimeReal: 0,
            limitTimeCpu: 0,
            maxCronThreads: 0,
            extraParams: "--log-handler,odoo.addons.base.models.ir_attachment:WARNING",
            devMode: "--dev=all",
            dumpsFolder: "/dumps",
            odooPath: "./odoo",
            enterprisePath: "./enterprise",
            designThemesPath: "./design-themes",
            customAddonsPath: "./custom-addons",
            pythonPath: "./venv/bin/python",
            subModulesPaths: "",
            installApps: "",
            upgradeApps: "",
            postSwitchCommands: [],
            managedPaths: [],
            ...settings
        };
        this.settings.postSwitchCommands = Array.isArray(this.settings.postSwitchCommands) ? this.settings.postSwitchCommands : [];
        this.settings.managedPaths = Array.isArray(this.settings.managedPaths) ? this.settings.managedPaths : [];
    }
    updateSettings(newSettings) {
        this.settings = { ...this.settings, ...newSettings };
        this.updatedAt = new Date();
    }
    clone(newName) {
        return new VersionModel(newName || `${this.name} (Copy)`, this.odooVersion, { ...this.settings }, (0, crypto_1.randomUUID)(), false);
    }
    toJSON() {
        return {
            id: this.id,
            name: this.name,
            odooVersion: this.odooVersion,
            settings: this.settings,
            isActive: this.isActive,
            createdAt: this.createdAt.toISOString(),
            updatedAt: this.updatedAt.toISOString()
        };
    }
    static fromJSON(data) {
        const version = new VersionModel(data.name, data.odooVersion, data.settings, data.id, data.isActive);
        version.createdAt = new Date(data.createdAt);
        version.updatedAt = new Date(data.updatedAt);
        return version;
    }
}
exports.VersionModel = VersionModel;


/***/ }),
/* 26 */
/***/ ((module) => {

module.exports = require("crypto");

/***/ }),
/* 27 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.SHELL_PORT_BASE = exports.SERVER_PORT_BASE = exports.DERIVED_SETTING_KEYS = void 0;
exports.isDerivedSetting = isDerivedSetting;
exports.parseSeriesMajor = parseSeriesMajor;
exports.deriveIdentity = deriveIdentity;
exports.collectTaken = collectTaken;
exports.healIdentities = healIdentities;
exports.candidatePortsFor = candidatePortsFor;
exports.probeBusyPorts = probeBusyPorts;
/**
 * Derives a version's debugger identity - launch configuration name, HTTP
 * port and shell port - from its branch, so two versions can run at once
 * without overwriting each other's launch.json entry.
 *
 * The derivation rules are pure and unit-tested; only the live-socket probe
 * at the bottom does I/O, mirroring how pythonToolchain.ts keeps
 * `rankInterpreters` pure and `discoverInterpreters` impure.
 */
const net = __importStar(__webpack_require__(28));
/** Settings computed from the branch: visible in the tree, never editable. */
exports.DERIVED_SETTING_KEYS = ['debuggerName', 'portNumber', 'shellPortNumber'];
exports.SERVER_PORT_BASE = 8000;
exports.SHELL_PORT_BASE = 5000;
/** Branch names carry the series first: `17.0`, `saas-17.4`, `17.0-fix-abc`. */
const SERIES_PATTERN = /^(?:saas[~-])?(\d+)\.\d+/;
function isDerivedSetting(key) {
    return exports.DERIVED_SETTING_KEYS.includes(key);
}
function parseSeriesMajor(branch) {
    const match = SERIES_PATTERN.exec(branch.trim());
    return match ? Number(match[1]) : undefined;
}
function nextFreePort(base, taken) {
    let port = base;
    while (taken.has(port)) {
        port += 1;
    }
    return port;
}
function nextFreeName(base, taken) {
    if (!taken.has(base)) {
        return base;
    }
    let suffix = 2;
    while (taken.has(`${base} (${suffix})`)) {
        suffix += 1;
    }
    return `${base} (${suffix})`;
}
/**
 * The identity for `branch`, avoiding everything in `taken`. A branch with no
 * numeric series (`master`) starts from the bases and walks up from there.
 */
function deriveIdentity(branch, prefix, taken) {
    const major = parseSeriesMajor(branch);
    const serverBase = major === undefined ? exports.SERVER_PORT_BASE : exports.SERVER_PORT_BASE + major;
    const shellBase = major === undefined ? exports.SHELL_PORT_BASE : exports.SHELL_PORT_BASE + major;
    return {
        debuggerName: nextFreeName(`${prefix}:${branch}`, taken.names),
        portNumber: nextFreePort(serverBase, taken.ports),
        shellPortNumber: nextFreePort(shellBase, taken.ports)
    };
}
function collectTaken(candidates, exceptId) {
    const names = new Set();
    const ports = new Set();
    for (const candidate of candidates) {
        if (candidate.id === exceptId) {
            continue;
        }
        const { debuggerName, portNumber, shellPortNumber } = candidate.settings ?? {};
        if (debuggerName) {
            names.add(debuggerName);
        }
        if (typeof portNumber === 'number') {
            ports.add(portNumber);
        }
        if (typeof shellPortNumber === 'number') {
            ports.add(shellPortNumber);
        }
    }
    return { names, ports };
}
function timestamp(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}
/**
 * Existing versions are healed, not rewritten: a stored identity is kept
 * unless it collides with an older version's, or is missing entirely. Returns
 * a patch per version that needs changing, in creation order.
 */
function healIdentities(candidates, prefix) {
    const ordered = [...candidates].sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt));
    const taken = { names: new Set(), ports: new Set() };
    const patches = [];
    for (const candidate of ordered) {
        const stored = candidate.settings ?? {};
        const complete = !!stored.debuggerName
            && typeof stored.portNumber === 'number'
            && typeof stored.shellPortNumber === 'number';
        const collides = complete && (taken.names.has(stored.debuggerName)
            || taken.ports.has(stored.portNumber)
            || taken.ports.has(stored.shellPortNumber));
        if (complete && !collides) {
            taken.names.add(stored.debuggerName);
            taken.ports.add(stored.portNumber);
            taken.ports.add(stored.shellPortNumber);
            continue;
        }
        const identity = deriveIdentity(candidate.odooVersion, prefix, taken);
        taken.names.add(identity.debuggerName);
        taken.ports.add(identity.portNumber);
        taken.ports.add(identity.shellPortNumber);
        patches.push({ id: candidate.id, identity });
    }
    return patches;
}
/** The ports a new version for `branch` could land on, both ranges. */
function candidatePortsFor(branch, window = 10) {
    const major = parseSeriesMajor(branch);
    const serverBase = major === undefined ? exports.SERVER_PORT_BASE : exports.SERVER_PORT_BASE + major;
    const shellBase = major === undefined ? exports.SHELL_PORT_BASE : exports.SHELL_PORT_BASE + major;
    const ports = [];
    for (let offset = 0; offset < window; offset += 1) {
        ports.push(serverBase + offset);
    }
    for (let offset = 0; offset < window; offset += 1) {
        ports.push(shellBase + offset);
    }
    return ports;
}
/**
 * Which of `ports` already have something listening. Other versions are the
 * primary authority, but a port can also be held by an unrelated process -
 * another project's server, a stray container - and deriving onto it would
 * produce a version that cannot start.
 */
async function probeBusyPorts(ports) {
    const results = await Promise.all(ports.map(port => new Promise(resolve => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        const finish = (busy) => {
            socket.destroy();
            resolve(busy ? port : undefined);
        };
        socket.setTimeout(250, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    })));
    return new Set(results.filter((port) => port !== undefined));
}


/***/ }),
/* 28 */
/***/ ((module) => {

module.exports = require("node:net");

/***/ }),
/* 29 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.SORT_OPTIONS = void 0;
exports.getDefaultSortOption = getDefaultSortOption;
exports.getSortOptions = getSortOptions;
exports.SORT_OPTIONS = {
    projectSelector: [
        { id: 'project:name:asc', label: 'Name (A → Z)' },
        { id: 'project:name:desc', label: 'Name (Z → A)' },
        { id: 'project:created:newest', label: 'Creation Date (Newest first)' },
        { id: 'project:created:oldest', label: 'Creation Date (Oldest first)' }
    ],
    repoSelector: [
        { id: 'repo:name:asc', label: 'Name (A → Z)' },
        { id: 'repo:name:desc', label: 'Name (Z → A)' },
        { id: 'repo:created:newest', label: 'Creation Date (Newest first)', description: 'Uses filesystem creation time' },
        { id: 'repo:created:oldest', label: 'Creation Date (Oldest first)', description: 'Uses filesystem creation time' },
        { id: 'repo:branch:asc', label: 'Branch (A → Z)' },
        { id: 'repo:branch:desc', label: 'Branch (Z → A)' }
    ],
    dbSelector: [
        { id: 'db:name:asc', label: 'Name (A → Z)' },
        { id: 'db:name:desc', label: 'Name (Z → A)' },
        { id: 'db:created:newest', label: 'Creation Date (Newest first)' },
        { id: 'db:created:oldest', label: 'Creation Date (Oldest first)' },
        { id: 'db:branch:asc', label: 'Branch (A → Z)' },
        { id: 'db:branch:desc', label: 'Branch (Z → A)' }
    ],
    moduleSelector: [
        { id: 'module:state:active-first', label: 'State (Install/Upgrade first)' },
        { id: 'module:state:active-last', label: 'State (Install/Upgrade last)' },
        { id: 'module:installed:first', label: 'Installed in Database first' },
        { id: 'module:name:asc', label: 'Name (A → Z)' },
        { id: 'module:name:desc', label: 'Name (Z → A)' },
        { id: 'module:repo:asc', label: 'Repository (A → Z)' },
        { id: 'module:repo:desc', label: 'Repository (Z → A)' }
    ],
    versionsManager: [
        { id: 'version:name:asc', label: 'Name (A → Z)' },
        { id: 'version:name:desc', label: 'Name (Z → A)' },
        { id: 'version:created:newest', label: 'Creation Date (Newest first)' },
        { id: 'version:created:oldest', label: 'Creation Date (Oldest first)' },
        { id: 'version:odoo:asc', label: 'Odoo Version (A → Z)' },
        { id: 'version:odoo:desc', label: 'Odoo Version (Z → A)' }
    ],
    projectRepos: [
        { id: 'projectRepos:name:asc', label: 'Name (A → Z)' },
        { id: 'projectRepos:name:desc', label: 'Name (Z → A)' },
        { id: 'projectRepos:added:newest', label: 'Date Added (Newest first)' },
        { id: 'projectRepos:added:oldest', label: 'Date Added (Oldest first)' }
    ]
};
function getDefaultSortOption(viewId) {
    return exports.SORT_OPTIONS[viewId][0].id;
}
function getSortOptions(viewId) {
    return exports.SORT_OPTIONS[viewId];
}


/***/ }),
/* 30 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.disabledIcon = exports.excludeIcon = exports.includeIcon = exports.unselectedIcon = exports.selectedIcon = exports.activeIcon = void 0;
/**
 * Shared ThemeIcon constants so every view marks state the same way:
 * a green check-circle for the currently active item, a green filled
 * circle for "included in the current selection", and an outline when
 * not selected (mirrors the Modules view convention).
 */
const vscode = __importStar(__webpack_require__(1));
const GREEN = new vscode.ThemeColor('charts.green');
const RED = new vscode.ThemeColor('charts.red');
/** The single currently-active item of a view (project, database, version). */
exports.activeIcon = new vscode.ThemeIcon('pass-filled', GREEN);
// A check (included) vs an empty circle (not) so the state reads by SHAPE:
// when a row is selected VS Code repaints the icon with the selection
// foreground and the green tint is lost, but check-vs-circle still differs.
/** Item included in the current selection (repos, toggles). */
exports.selectedIcon = new vscode.ThemeIcon('check', GREEN);
/** Item not included in the current selection. */
exports.unselectedIcon = new vscode.ThemeIcon('circle-outline');
/** Test target states. */
exports.includeIcon = new vscode.ThemeIcon('check', GREEN);
exports.excludeIcon = new vscode.ThemeIcon('close', RED);
exports.disabledIcon = new vscode.ThemeIcon('circle-slash');


/***/ }),
/* 31 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.getDatabaseSwitchBehavior = getDatabaseSwitchBehavior;
exports.migrateLegacySwitchBehaviorSetting = migrateLegacySwitchBehaviorSetting;
exports.sanitizeProjectRepoBranchAssignments = sanitizeProjectRepoBranchAssignments;
exports.resolveProjectRepoBranchAssignments = resolveProjectRepoBranchAssignments;
exports.captureCurrentRepoBranches = captureCurrentRepoBranches;
exports.buildDatabaseEnvironmentTarget = buildDatabaseEnvironmentTarget;
exports.describeSwitch = describeSwitch;
exports.alignEnvironment = alignEnvironment;
const vscode = __importStar(__webpack_require__(1));
const fs = __importStar(__webpack_require__(9));
const path = __importStar(__webpack_require__(10));
const settings_1 = __webpack_require__(7);
const versionsService_1 = __webpack_require__(24);
const utils_1 = __webpack_require__(8);
const branches_1 = __webpack_require__(32);
const checkout_1 = __webpack_require__(33);
const worktree_1 = __webpack_require__(35);
const logger_1 = __webpack_require__(12);
const notifications_1 = __webpack_require__(16);
const LEGACY_BEHAVIOR_MAP = {
    'auto-both': 'auto',
    'auto-version-only': 'auto',
    'auto-branch-only': 'auto'
};
/**
 * Normalizes the databaseSwitchBehavior setting, mapping pre-1.2 values
 * (auto-both / auto-version-only / auto-branch-only) onto the new enum.
 */
function getDatabaseSwitchBehavior() {
    const raw = vscode.workspace.getConfiguration('odooDebugger').get('databaseSwitchBehavior', 'auto') ?? 'auto';
    if (raw === 'auto' || raw === 'ask' || raw === 'never') {
        return raw;
    }
    return LEGACY_BEHAVIOR_MAP[raw] ?? 'auto';
}
/**
 * One-time write-back of legacy databaseSwitchBehavior values in whichever
 * scope defines them, so users' settings match the new enum.
 */
async function migrateLegacySwitchBehaviorSetting() {
    try {
        const config = vscode.workspace.getConfiguration('odooDebugger');
        const inspection = config.inspect('databaseSwitchBehavior');
        if (!inspection) {
            return;
        }
        const scopes = [
            [inspection.globalValue, vscode.ConfigurationTarget.Global],
            [inspection.workspaceValue, vscode.ConfigurationTarget.Workspace],
            [inspection.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder]
        ];
        for (const [value, target] of scopes) {
            if (typeof value === 'string' && LEGACY_BEHAVIOR_MAP[value]) {
                await config.update('databaseSwitchBehavior', LEGACY_BEHAVIOR_MAP[value], target);
            }
        }
    }
    catch (error) {
        logger_1.logger.warn('Failed to migrate databaseSwitchBehavior setting:', error);
    }
}
function sanitizeProjectRepoBranchAssignments(source) {
    if (!Array.isArray(source)) {
        return [];
    }
    return source
        .filter(entry => !!entry && typeof entry.branch === 'string' && entry.branch.trim() !== '')
        .map(entry => ({
        repoName: entry.repoName || '',
        repoPath: entry.repoPath ? (0, utils_1.normalizePath)(entry.repoPath) : '',
        branch: entry.branch.trim()
    }));
}
function resolveProjectRepoBranchAssignments(database, projectRepos) {
    const assignments = sanitizeProjectRepoBranchAssignments(database?.projectRepoBranches);
    if (assignments.length === 0 || projectRepos.length === 0) {
        return [];
    }
    const byPath = new Map();
    const byName = new Map();
    for (const entry of assignments) {
        if (entry.repoPath) {
            byPath.set((0, utils_1.normalizePath)(entry.repoPath), entry);
        }
        if (entry.repoName) {
            byName.set(entry.repoName.toLowerCase(), entry);
        }
    }
    const resolved = [];
    const seenPaths = new Set();
    for (const repo of projectRepos) {
        const repoPath = (0, utils_1.normalizePath)(repo.path);
        const assignment = byPath.get(repoPath) ?? byName.get(repo.name.toLowerCase());
        if (!assignment || !assignment.branch || seenPaths.has(repoPath)) {
            continue;
        }
        seenPaths.add(repoPath);
        resolved.push({
            repoName: repo.name,
            repoPath,
            branch: assignment.branch
        });
    }
    return resolved;
}
/**
 * Captures the current branch of each project repository, used to attach the
 * developer's present working state to a newly created database.
 */
async function captureCurrentRepoBranches(projectRepos) {
    const captured = await Promise.all(projectRepos.map(async (repo) => {
        const repoPath = (0, utils_1.normalizePath)(repo.path);
        const branch = await (0, branches_1.getRepoBranch)(repoPath);
        if (!branch) {
            return undefined;
        }
        return { repoName: repo.name, repoPath, branch };
    }));
    return captured.filter((entry) => !!entry);
}
/**
 * Builds the environment a database expects: its version, the version's core
 * branch (or the legacy per-DB branch for unmigrated data), and its project
 * repo branch mapping.
 */
function buildDatabaseEnvironmentTarget(database, projectRepos) {
    const legacyBranch = typeof database?.odooVersion === 'string' && database.odooVersion.trim() !== ''
        ? database.odooVersion.trim()
        : undefined;
    return {
        versionId: database?.versionId || undefined,
        coreBranch: database?.versionId ? undefined : legacyBranch,
        repoAssignments: resolveProjectRepoBranchAssignments(database, projectRepos)
    };
}
/**
 * How a pending switch is described to the user. A provisioned version's
 * worktree is already on the right branch, so nothing is checked out - saying
 * nothing there reads as though a branch switch were about to happen, which is
 * what this wording exists to avoid.
 */
function describeSwitch(input) {
    const parts = [];
    if (input.versionName) {
        parts.push(`version "${input.versionName}"`);
    }
    if (input.core?.missingEnvironment) {
        parts.push(`core repositories for "${input.core.branch}" are missing`);
    }
    else if (input.core?.needsCheckout) {
        parts.push(`core branch "${input.core.branch}"`);
    }
    else if (input.core) {
        parts.push(`its existing "${input.core.branch}" worktree`);
    }
    if (input.repoBranchCount > 0) {
        parts.push(`${input.repoBranchCount} project repo branch(es)`);
    }
    return parts;
}
async function computeEnvironmentDiff(target) {
    const versionsService = versionsService_1.VersionsService.getInstance();
    await versionsService.initialize();
    const targetVersion = target.versionId ? versionsService.getVersion(target.versionId) : undefined;
    const versionToActivate = targetVersion && !targetVersion.isActive ? targetVersion : undefined;
    const settings = new settings_1.SettingsModel(targetVersion?.settings ?? await versionsService.getActiveVersionSettings());
    const coreBranchTarget = target.coreBranch?.trim() || targetVersion?.odooVersion?.trim() || undefined;
    let coreRepoPipeline;
    if (coreBranchTarget) {
        const configuredPaths = [settings.odooPath, settings.enterprisePath, settings.designThemesPath]
            .filter(entry => entry && entry.trim() !== '')
            .map(entry => (0, utils_1.normalizePath)(entry));
        const existingPaths = configuredPaths.filter(entry => fs.existsSync(entry));
        // Configured but absent is "not provisioned", not "needs a checkout":
        // promising a branch switch into directories that do not exist is the
        // misleading message this distinction removes.
        const missingEnvironment = configuredPaths.length > 0 && existingPaths.length === 0;
        let needsCheckout = false;
        for (const repoPath of existingPaths) {
            // A provisioned worktree reports its managed branch (odt/19.0) while
            // the version targets the series (19.0); asking git to check out
            // 19.0 there would fail, since the source repo still holds it.
            if (!(0, worktree_1.branchSatisfiesTarget)(await (0, branches_1.getRepoBranch)(repoPath), coreBranchTarget)) {
                needsCheckout = true;
                break;
            }
        }
        // A version change alone is enough: post-switch hooks must run even
        // when every worktree is already on the right branch.
        if (needsCheckout || missingEnvironment || versionToActivate) {
            coreRepoPipeline = { branch: coreBranchTarget, needsCheckout, missingEnvironment };
        }
    }
    const repoCheckouts = [];
    for (const assignment of target.repoAssignments ?? []) {
        if (!assignment.repoPath) {
            continue;
        }
        if (!fs.existsSync(assignment.repoPath)) {
            // Keep missing repos so the failure is reported instead of silently skipped.
            repoCheckouts.push(assignment);
            continue;
        }
        const current = await (0, branches_1.getRepoBranch)(assignment.repoPath);
        if (current !== assignment.branch) {
            repoCheckouts.push(assignment);
        }
    }
    const descriptions = describeSwitch({
        versionName: versionToActivate?.name,
        core: coreRepoPipeline,
        repoBranchCount: repoCheckouts.length
    });
    return { versionToActivate, settings, coreRepoPipeline, repoCheckouts, descriptions };
}
async function applyRepoCheckouts(assignments) {
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Switching project repository branches',
        cancellable: false
    }, async (progress) => {
        const total = assignments.length;
        let completed = 0;
        const results = [];
        for (const assignment of assignments) {
            completed += 1;
            const repoLabel = assignment.repoName || path.basename(assignment.repoPath);
            progress.report({
                message: `${repoLabel} (${completed}/${total})`,
                increment: total > 0 ? (100 / total) : 0
            });
            if (!fs.existsSync(assignment.repoPath)) {
                results.push({ assignment, ok: false, message: `Repository path not found: ${assignment.repoPath}` });
                continue;
            }
            if (!fs.existsSync(path.join(assignment.repoPath, '.git'))) {
                results.push({ assignment, ok: false, message: 'Not a git repository' });
                continue;
            }
            const checkoutResult = await (0, checkout_1.checkoutRepoBranch)(assignment.repoPath, assignment.branch);
            results.push({ assignment, ok: checkoutResult.ok, message: checkoutResult.message });
        }
        return results;
    });
}
/**
 * Aligns the workbench (active version, core repo branches, project repo
 * branches) to the given target. This is the single switch pipeline used by
 * database selection, project selection, and version activation.
 *
 * No-ops silently when everything already matches. Failures never throw; they
 * are summarized in a single warning.
 */
async function alignEnvironment(target, options) {
    const behavior = options.behavior ?? getDatabaseSwitchBehavior();
    if (behavior === 'never') {
        return;
    }
    const diff = await computeEnvironmentDiff(target);
    if (isEmptyDiff(diff)) {
        return;
    }
    if (behavior === 'ask') {
        // Fire-and-forget so the selection itself (and the tree refresh) is not
        // held hostage by an unanswered notification.
        void (0, notifications_1.showInfo)(`${options.label} targets ${diff.descriptions.join(', ')}. Align your workspace?`, 'Switch', 'Keep Current').then(async (choice) => {
            if (choice !== 'Switch') {
                return;
            }
            try {
                // Recompute: the workspace may have changed while the
                // notification sat unanswered.
                const freshDiff = await computeEnvironmentDiff(target);
                if (!isEmptyDiff(freshDiff)) {
                    await applyEnvironmentDiff(freshDiff, options.label);
                }
                await vscode.commands.executeCommand('projectSelector.refresh');
            }
            catch (error) {
                void (0, utils_1.showWarning)(`${options.label}: environment switch failed: ${error.message}`);
            }
        });
        return;
    }
    await applyEnvironmentDiff(diff, options.label);
}
function isEmptyDiff(diff) {
    return !diff.versionToActivate && !diff.coreRepoPipeline && diff.repoCheckouts.length === 0;
}
async function applyEnvironmentDiff(diff, label) {
    const applied = [];
    const failures = [];
    if (diff.versionToActivate) {
        const versionsService = versionsService_1.VersionsService.getInstance();
        const ok = await versionsService.setActiveVersion(diff.versionToActivate.id);
        if (ok) {
            applied.push(`version "${diff.versionToActivate.name}"`);
        }
        else {
            failures.push(`could not activate version "${diff.versionToActivate.name}"`);
        }
    }
    if (diff.coreRepoPipeline) {
        const { branch, needsCheckout, missingEnvironment } = diff.coreRepoPipeline;
        if (missingEnvironment) {
            failures.push(`the core repositories for "${branch}" are missing - provision this version again`);
        }
        const results = await (0, checkout_1.alignCoreRepos)(diff.settings, branch, needsCheckout);
        const failed = results.filter(result => !result.success);
        if (failed.length === 0) {
            if (needsCheckout) {
                applied.push(`branch "${branch}"`);
            }
        }
        else {
            if (failed.length < results.length && needsCheckout) {
                applied.push(`branch "${branch}" (partially)`);
            }
            failures.push(...failed.map(result => `${result.name}: ${result.message}`));
        }
    }
    if (diff.repoCheckouts.length > 0) {
        const results = await applyRepoCheckouts(diff.repoCheckouts);
        const failed = results.filter(result => !result.ok);
        const succeeded = results.length - failed.length;
        if (succeeded > 0) {
            applied.push(`${succeeded} project repo branch(es)`);
        }
        failures.push(...failed.map(result => `${result.assignment.repoName || path.basename(result.assignment.repoPath)}: ${result.message}`));
    }
    if (failures.length === 0) {
        // A hooks-only run applies nothing visible; staying silent is correct.
        if (applied.length > 0) {
            (0, utils_1.showAutoInfo)(`${label}: switched ${applied.join(', ')}`, 3000);
        }
    }
    else {
        failures.forEach(failure => logger_1.logger.error(`[environment] ${label}: ${failure}`));
        void (0, utils_1.showWarning)(`${label}: environment switch finished with issues — ${failures.join('; ')}`);
    }
}


/***/ }),
/* 32 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.getRepoBranch = getRepoBranch;
const vscode = __importStar(__webpack_require__(1));
const path = __importStar(__webpack_require__(4));
const fs = __importStar(__webpack_require__(23));
const gitService_1 = __webpack_require__(11);
const runtimeCache_1 = __webpack_require__(15);
const logger_1 = __webpack_require__(12);
/**
 * The single branch reader for the extension. Prefers the built-in git
 * extension's API (accurate for worktrees, detached heads, etc.), falls back
 * to reading .git/HEAD directly, and caches results briefly via runtimeCache.
 * Checkout flows invalidate the cache through invalidateGitBranchCache.
 */
function resolveRepoPath(repoPath) {
    if (path.isAbsolute(repoPath)) {
        return path.normalize(repoPath);
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
        return path.normalize(path.join(workspaceRoot, repoPath));
    }
    return path.normalize(path.resolve(repoPath));
}
async function readBranchFromHeadFile(repoPath) {
    const gitHeadPath = path.join(repoPath, '.git', 'HEAD');
    try {
        const headContent = (await fs.readFile(gitHeadPath, 'utf-8')).trim();
        const match = /^ref: refs\/heads\/(.+)$/.exec(headContent);
        return match ? match[1] : headContent;
    }
    catch (error) {
        logger_1.logger.debug(`Failed to read branch for ${repoPath}`, error);
        return null;
    }
}
/**
 * Returns the current branch of the repository at `repoPath` (relative paths
 * resolve against the first workspace folder), or null when unavailable.
 */
async function getRepoBranch(repoPath) {
    if (!repoPath) {
        return null;
    }
    const resolved = resolveRepoPath(repoPath);
    return runtimeCache_1.runtimeCache.getGitBranch(resolved, async () => {
        const sourceControlBranch = await (0, gitService_1.getCurrentBranchViaSourceControl)(resolved);
        if (sourceControlBranch) {
            return sourceControlBranch;
        }
        return readBranchFromHeadFile(resolved);
    });
}


/***/ }),
/* 33 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.checkoutRepoBranch = checkoutRepoBranch;
exports.alignCoreRepos = alignCoreRepos;
const vscode = __importStar(__webpack_require__(1));
const fs = __importStar(__webpack_require__(9));
const child_process_1 = __webpack_require__(34);
const utils_1 = __webpack_require__(8);
const gitService_1 = __webpack_require__(11);
const runtimeCache_1 = __webpack_require__(15);
const checkoutHooksOutput = vscode.window.createOutputChannel('Odoo Debugger: Branch Hooks');
function quoteForSingleQuotedShell(value) {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
function buildHookExecutionScript(commands, phase, contextLabel) {
    const lines = ['set -e'];
    commands.forEach((command, index) => {
        const prefix = `[${phase}] ${contextLabel}: [${index + 1}/${commands.length}]`;
        lines.push(`__odt_cmd=${quoteForSingleQuotedShell(command)}`);
        lines.push(`__odt_prefix=${quoteForSingleQuotedShell(prefix)}`);
        lines.push('printf \'%s\\n\' "$__odt_prefix START $__odt_cmd"');
        lines.push('set +e');
        lines.push('eval "$__odt_cmd"');
        lines.push('__odt_exit=$?');
        lines.push('set -e');
        lines.push('printf \'%s\\n\' "$__odt_prefix END exit=$__odt_exit"');
        lines.push('if [ $__odt_exit -ne 0 ]; then');
        lines.push('  exit $__odt_exit');
        lines.push('fi');
    });
    return lines.join('\n');
}
async function runCheckoutHookCommands(commands, phase, cwd, contextLabel, progress) {
    if (!Array.isArray(commands) || commands.length === 0) {
        return true;
    }
    const normalizedCommands = commands.map(cmd => cmd.trim()).filter(Boolean);
    if (normalizedCommands.length === 0) {
        return true;
    }
    progress?.report({ message: `${contextLabel}: ${phase} (${normalizedCommands.length} command(s))` });
    checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: running ${normalizedCommands.length} command(s) in: ${cwd}`);
    normalizedCommands.forEach((command, index) => {
        checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: [${index + 1}/${normalizedCommands.length}] $ ${command}`);
    });
    const script = buildHookExecutionScript(normalizedCommands, phase, contextLabel);
    const taskStartedAt = Date.now();
    let stderrTail = '';
    const exitCode = await new Promise((resolve) => {
        const child = (0, child_process_1.spawn)('/bin/bash', ['-lc', script], {
            cwd,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const stdoutBuffer = { pending: '' };
        const stderrBuffer = { pending: '' };
        const appendBufferedLines = (chunk, buffer) => {
            const text = chunk.toString();
            if (!text) {
                return;
            }
            const combined = buffer.pending + text;
            const lines = combined.split(/\r?\n/);
            buffer.pending = lines.pop() ?? '';
            for (const line of lines) {
                checkoutHooksOutput.appendLine(line);
            }
        };
        const flushBuffer = (buffer) => {
            if (!buffer.pending) {
                return;
            }
            checkoutHooksOutput.appendLine(buffer.pending);
            buffer.pending = '';
        };
        child.stdout?.on('data', chunk => {
            appendBufferedLines(chunk, stdoutBuffer);
        });
        child.stderr?.on('data', chunk => {
            appendBufferedLines(chunk, stderrBuffer);
            stderrTail += chunk.toString();
            if (stderrTail.length > 2000) {
                stderrTail = stderrTail.slice(-2000);
            }
        });
        child.on('error', error => {
            stderrTail = error.message;
            resolve(undefined);
        });
        child.on('close', code => {
            flushBuffer(stdoutBuffer);
            flushBuffer(stderrBuffer);
            resolve(code ?? undefined);
        });
    });
    const durationMs = Date.now() - taskStartedAt;
    if (exitCode !== 0) {
        const failureReason = exitCode === undefined ? 'no exit code' : `exit ${exitCode}`;
        if (stderrTail.trim()) {
            checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: stderr tail:\n${stderrTail.trim()}`);
        }
        checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: FAILED (${failureReason}, duration=${durationMs}ms)`);
        checkoutHooksOutput.show(true);
        return false;
    }
    checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: OK (duration=${durationMs}ms)`);
    return true;
}
async function runGitCheckoutCli(repoPath, branch) {
    return new Promise((resolve) => {
        const child = (0, child_process_1.spawn)('git', ['checkout', branch], { cwd: repoPath, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr?.on('data', chunk => {
            stderr += chunk.toString();
        });
        child.on('error', error => {
            resolve({ ok: false, message: error.message });
        });
        child.on('close', code => {
            const details = stderr.trim();
            if (code === 0 || details.includes(`Already on '${branch}'`)) {
                resolve({
                    ok: true,
                    message: details.includes(`Already on '${branch}'`)
                        ? `Already on branch "${branch}"`
                        : `Switched to branch "${branch}"`
                });
                return;
            }
            resolve({
                ok: false,
                message: details || `git checkout exited with code ${code ?? 'unknown'}`
            });
        });
    });
}
/**
 * Checks out a branch on a single repository, preferring the VS Code Git API
 * and falling back to the git CLI.
 */
async function checkoutRepoBranch(repoPath, branch) {
    const sourceControlSucceeded = await (0, gitService_1.checkoutBranchViaSourceControl)(repoPath, branch);
    if (sourceControlSucceeded) {
        (0, runtimeCache_1.invalidateGitBranchCache)(repoPath);
        return { ok: true, message: `Switched to branch "${branch}"` };
    }
    const result = await runGitCheckoutCli(repoPath, branch);
    if (result.ok) {
        (0, runtimeCache_1.invalidateGitBranchCache)(repoPath);
        try {
            await vscode.commands.executeCommand('git.refresh');
        }
        catch {
            // Best-effort SCM refresh after external checkout.
        }
    }
    return result;
}
/**
 * Aligns the core Odoo repositories (odoo / enterprise / design-themes) to the
 * given branch, running the version's post-switch commands per repository.
 * When `needsCheckout` is false the repositories are already on the right
 * branch - each version owns its worktree - and only the hooks run.
 * Returns per-repo results; callers own the summary messaging.
 */
async function alignCoreRepos(settings, branch, needsCheckout) {
    const repos = [
        { name: 'Odoo', path: settings.odooPath },
        { name: 'Enterprise', path: settings.enterprisePath },
        { name: 'Design Themes', path: settings.designThemesPath }
    ]
        .filter(repo => repo.path && repo.path.trim() !== '')
        .map(repo => ({ name: repo.name, path: (0, utils_1.normalizePath)(repo.path) }));
    if (repos.length === 0) {
        return [{ name: 'Odoo', success: false, message: 'No core repository paths are configured' }];
    }
    // The version's own commands win; the global default is the fallback, so a
    // version that defines none still behaves as configured.
    const configured = vscode.workspace
        .getConfiguration('odooDebugger.defaultVersion')
        .get('postSwitchCommands', []);
    const postSwitchCommands = settings.postSwitchCommands.length > 0 ? settings.postSwitchCommands : configured;
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: needsCheckout ? `Switching to branch: ${branch}` : `Aligning ${branch}`,
        cancellable: false
    }, async (progress) => {
        const operationStartedAt = Date.now();
        const elapsed = () => `${Date.now() - operationStartedAt}ms`;
        const totalRepos = repos.length;
        let completedRepos = 0;
        const processRepository = async (repo) => {
            checkoutHooksOutput.appendLine(`[checkout] ${repo.name}: pipeline start t+${elapsed()}`);
            progress.report({ message: `${repo.name}: processing` });
            if (!fs.existsSync(repo.path)) {
                return {
                    name: repo.name,
                    success: false,
                    message: `Repository path does not exist: ${repo.path}`
                };
            }
            let checkoutMessage = 'Already on the target branch';
            if (needsCheckout) {
                checkoutHooksOutput.appendLine(`[checkout] ${repo.name}: checkout start t+${elapsed()}`);
                const checkoutResult = await checkoutRepoBranch(repo.path, branch);
                if (!checkoutResult.ok) {
                    checkoutHooksOutput.appendLine(`[checkout] ${repo.name}: pipeline failed during checkout t+${elapsed()}`);
                    return {
                        name: repo.name,
                        success: false,
                        message: checkoutResult.message || 'Failed to checkout branch'
                    };
                }
                checkoutMessage = checkoutResult.message;
            }
            const postOk = await runCheckoutHookCommands(postSwitchCommands, 'post-switch', repo.path, repo.name, progress);
            checkoutHooksOutput.appendLine(`[checkout] ${repo.name}: pipeline ${postOk ? 'complete' : 'complete-with-post-failure'} t+${elapsed()}`);
            return {
                name: repo.name,
                success: postOk,
                message: postOk ? checkoutMessage : `${checkoutMessage} (but post-switch hook(s) failed)`
            };
        };
        const results = await Promise.all(repos.map(async (repo) => {
            const result = await processRepository(repo);
            completedRepos += 1;
            progress.report({
                message: `${repo.name}: completed (${completedRepos}/${totalRepos})`,
                increment: totalRepos > 0 ? (100 / totalRepos) : 0
            });
            checkoutHooksOutput.appendLine(`[checkout] ${repo.name}: ${result.success ? 'SUCCESS' : 'FAILED'} - ${result.message}`);
            return result;
        }));
        const successCount = results.filter(r => r.success).length;
        checkoutHooksOutput.appendLine(`[checkout] Completed branch switch "${branch}" in ${Date.now() - operationStartedAt}ms (${successCount}/${results.length} succeeded)`);
        return results;
    });
}


/***/ }),
/* 34 */
/***/ ((module) => {

module.exports = require("child_process");

/***/ }),
/* 35 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.managedBranchName = managedBranchName;
exports.branchSatisfiesTarget = branchSatisfiesTarget;
exports.parseWorktreeList = parseWorktreeList;
exports.findWorktreeForBranch = findWorktreeForBranch;
exports.classifyBranchConflict = classifyBranchConflict;
exports.ensureWorktree = ensureWorktree;
exports.ensureRealBranchWorktree = ensureRealBranchWorktree;
exports.resolveSourceRepo = resolveSourceRepo;
exports.removeWorktree = removeWorktree;
exports.removeManagedBranch = removeManagedBranch;
/**
 * git worktree operations. Each version gets its own worktree of the core
 * repositories, so versions never compete for one checkout. Worktrees share
 * the repository object store, so an extra version costs one working tree
 * rather than a full clone.
 *
 * The source repository is only ever a source: a version never runs out of it,
 * even when it happens to sit on the right branch, because that directory is
 * user-controlled and can be switched away underneath the version. Worktrees
 * therefore always get their own `odt/<branch>` local branch tracking
 * `origin/<branch>` - git refuses to check the same branch out twice, and a
 * conditional name would make provisioning depend on whatever the source repo
 * happened to be on at the time.
 */
const fs = __importStar(__webpack_require__(2));
const path = __importStar(__webpack_require__(4));
const process_1 = __webpack_require__(13);
const logger_1 = __webpack_require__(12);
/** The extension-managed local branch a worktree for `branch` checks out. */
function managedBranchName(branch) {
    return `odt/${branch}`;
}
/**
 * Whether a worktree currently on `current` is already correct for `target`.
 * A managed worktree reports `odt/19.0` while its version targets `19.0`;
 * without this the environment diff would ask git to check out `19.0` inside
 * the worktree, which fails because the source repo still holds that branch.
 */
function branchSatisfiesTarget(current, target) {
    if (!current) {
        return false;
    }
    return current === target || current === managedBranchName(target);
}
function parseWorktreeList(output) {
    const entries = [];
    let current;
    for (const rawLine of output.split('\n')) {
        const line = rawLine.trim();
        if (line.startsWith('worktree ')) {
            current = { path: line.slice('worktree '.length), branch: undefined };
            entries.push(current);
            continue;
        }
        if (current && line.startsWith('branch ')) {
            current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
        }
    }
    return entries;
}
function findWorktreeForBranch(entries, branch) {
    return entries.find(entry => entry.branch === branch);
}
function classifyBranchConflict(entries, managedBranch, destPath, exists) {
    const holder = findWorktreeForBranch(entries, managedBranch);
    if (!holder || samePath(holder.path, destPath)) {
        return { kind: 'none' };
    }
    return exists(holder.path)
        ? { kind: 'live', path: holder.path }
        : { kind: 'stale', path: holder.path };
}
async function listWorktrees(repoPath) {
    const { stdout } = await (0, process_1.runCommand)('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
    return parseWorktreeList(stdout);
}
async function hasRef(repoPath, ref) {
    try {
        await (0, process_1.runCommand)('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: repoPath });
        return true;
    }
    catch {
        return false;
    }
}
function samePath(a, b) {
    return path.resolve(a) === path.resolve(b);
}
/**
 * Ensures a worktree for `branch` exists at `destPath`, checked out on its
 * managed branch.
 *
 * Only `destPath` is ever adopted - that is the "already provisioned" case.
 * A worktree elsewhere holding the branch (typically the source repo itself)
 * is deliberately not reused; see the module comment.
 */
async function ensureWorktree(repoPath, branch, destPath, token) {
    const managedBranch = managedBranchName(branch);
    const existing = await listWorktrees(repoPath);
    const atDestination = existing.find(entry => samePath(entry.path, destPath));
    if (atDestination) {
        logger_1.logger.info(`[worktree] reusing existing worktree at ${destPath}`);
        return { path: destPath, created: false, adopted: true, branch: atDestination.branch ?? managedBranch };
    }
    // git keeps the branch reserved for a worktree whose directory has been
    // deleted, so re-provisioning a version whose folder was removed by hand -
    // or that was built under an older provisioning root - fails without this.
    const conflict = classifyBranchConflict(existing, managedBranch, destPath, fs.existsSync);
    if (conflict.kind === 'stale') {
        logger_1.logger.info(`[worktree] pruning the stale record for ${conflict.path}`);
        await (0, process_1.runCommand)('git', ['worktree', 'prune'], { cwd: repoPath, token });
    }
    else if (conflict.kind === 'live') {
        // Rebuilding would need a second branch and a duplicate checkout;
        // adopting matches provisioning's "adopt rather than rebuild" rule.
        logger_1.logger.warn(`[worktree] ${managedBranch} is already checked out at ${conflict.path}; reusing it`);
        return { path: conflict.path, created: false, adopted: true, branch: managedBranch };
    }
    if (fs.existsSync(destPath)) {
        throw new Error(`Cannot create a worktree at ${destPath}: the path already exists and is not a worktree of ${repoPath}.`);
    }
    // A managed branch left over from a removed worktree is reused rather than
    // recreated - `git worktree add -b` refuses an existing branch name.
    if (await hasRef(repoPath, `refs/heads/${managedBranch}`)) {
        await (0, process_1.runCommand)('git', ['worktree', 'add', destPath, managedBranch], { cwd: repoPath, token });
        return { path: destPath, created: true, adopted: false, branch: managedBranch };
    }
    let startPoint = `refs/remotes/origin/${branch}`;
    if (!(await hasRef(repoPath, startPoint))) {
        // Valid and cheap on a shallow clone; the explicit refspec also works
        // on a --single-branch clone, where the default one would not fetch it.
        logger_1.logger.info(`[worktree] fetching ${branch} into ${repoPath}`);
        const fetched = await (0, process_1.runCommand)('git', ['fetch', '--depth', '1', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: repoPath, token }).then(() => true).catch(() => false);
        if (!fetched || !(await hasRef(repoPath, startPoint))) {
            // No remote, or the branch only exists locally.
            if (!(await hasRef(repoPath, `refs/heads/${branch}`))) {
                throw new Error(`Branch "${branch}" was not found locally or on origin in ${repoPath}.`);
            }
            startPoint = `refs/heads/${branch}`;
        }
    }
    // Branching from a remote-tracking ref sets upstream, so `git pull` works
    // inside the worktree without further setup.
    await (0, process_1.runCommand)('git', ['worktree', 'add', '-b', managedBranch, destPath, startPoint], { cwd: repoPath, token });
    return { path: destPath, created: true, adopted: false, branch: managedBranch };
}
/**
 * A worktree checked out on `branch` itself, not on a managed `odt/` alias.
 *
 * Custom repositories are committed to and pushed from, so their worktrees
 * must hold the real branch. The caller is responsible for having freed the
 * branch from the source checkout first (see sourceConflict.ts); this function
 * surfaces git's refusal rather than working around it.
 */
async function ensureRealBranchWorktree(repoPath, branch, destPath, token) {
    const existing = await listWorktrees(repoPath);
    const atDestination = existing.find(entry => samePath(entry.path, destPath));
    if (atDestination) {
        logger_1.logger.info(`[worktree] reusing existing worktree at ${destPath}`);
        return { path: destPath, created: false, adopted: true, branch: atDestination.branch ?? branch };
    }
    const conflict = classifyBranchConflict(existing, branch, destPath, fs.existsSync);
    if (conflict.kind === 'stale') {
        logger_1.logger.info(`[worktree] pruning the stale record for ${conflict.path}`);
        await (0, process_1.runCommand)('git', ['worktree', 'prune'], { cwd: repoPath, token });
    }
    else if (conflict.kind === 'live') {
        logger_1.logger.warn(`[worktree] ${branch} is already checked out at ${conflict.path}; reusing it`);
        return { path: conflict.path, created: false, adopted: true, branch };
    }
    if (fs.existsSync(destPath)) {
        throw new Error(`Cannot create a worktree at ${destPath}: the path already exists and is not a worktree of ${repoPath}.`);
    }
    if (await hasRef(repoPath, `refs/heads/${branch}`)) {
        await (0, process_1.runCommand)('git', ['worktree', 'add', destPath, branch], { cwd: repoPath, token });
        return { path: destPath, created: true, adopted: false, branch };
    }
    const remote = `refs/remotes/origin/${branch}`;
    if (!(await hasRef(repoPath, remote))) {
        throw new Error(`Branch "${branch}" was not found locally or on origin in ${repoPath}.`);
    }
    // Branching from the remote-tracking ref sets upstream, so push and pull
    // work inside the worktree without further setup.
    await (0, process_1.runCommand)('git', ['worktree', 'add', '-b', branch, destPath, remote], { cwd: repoPath, token });
    return { path: destPath, created: true, adopted: false, branch };
}
/** The main repository a worktree belongs to, or undefined when it is not one. */
async function resolveSourceRepo(worktreePath) {
    try {
        const { stdout } = await (0, process_1.runCommand)('git', ['rev-parse', '--git-common-dir'], { cwd: worktreePath });
        const commonDir = stdout.trim();
        if (!commonDir) {
            return undefined;
        }
        const absolute = path.isAbsolute(commonDir) ? commonDir : path.resolve(worktreePath, commonDir);
        return path.dirname(absolute);
    }
    catch {
        return undefined;
    }
}
async function removeWorktree(repoPath, worktreePath) {
    await (0, process_1.runCommand)('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoPath });
}
/**
 * Deletes the managed branch a removed worktree left behind. Best effort:
 * `git worktree remove` does not delete it, but a branch the user has since
 * taken over must not disappear silently either, so failures are logged only.
 */
async function removeManagedBranch(repoPath, branch) {
    try {
        await (0, process_1.runCommand)('git', ['branch', '-D', managedBranchName(branch)], { cwd: repoPath });
    }
    catch (error) {
        logger_1.logger.warn(`[worktree] could not delete ${managedBranchName(branch)}:`, error);
    }
}


/***/ }),
/* 36 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.getEffectiveOdooVersion = getEffectiveOdooVersion;
exports.promptProjectRepoBranchAssignments = promptProjectRepoBranchAssignments;
exports.extractDatabaseFromEvent = extractDatabaseFromEvent;
exports.createDb = createDb;
exports.cloneDatabaseFromTemplate = cloneDatabaseFromTemplate;
exports.restoreDb = restoreDb;
exports.selectDatabase = selectDatabase;
exports.deleteDb = deleteDb;
exports.cloneDatabaseFlow = cloneDatabaseFlow;
exports.reconcileDatabasesFlow = reconcileDatabasesFlow;
exports.changeDatabaseVersion = changeDatabaseVersion;
exports.changeDatabaseProjectRepoBranches = changeDatabaseProjectRepoBranches;
exports.manageDatabaseTemplates = manageDatabaseTemplates;
const vscode = __importStar(__webpack_require__(1));
const path = __importStar(__webpack_require__(4));
const os = __importStar(__webpack_require__(37));
const node_crypto_1 = __webpack_require__(38);
const db_1 = __webpack_require__(39);
const utils_1 = __webpack_require__(8);
const notifications_1 = __webpack_require__(16);
const logger_1 = __webpack_require__(12);
const branches_1 = __webpack_require__(32);
const settingsStore_1 = __webpack_require__(6);
const versionsService_1 = __webpack_require__(24);
const dbResolution_1 = __webpack_require__(40);
const dbNaming_1 = __webpack_require__(41);
const database_1 = __webpack_require__(42);
const postgres_1 = __webpack_require__(44);
const dumpImport_1 = __webpack_require__(45);
const templates_1 = __webpack_require__(48);
const reconcile_1 = __webpack_require__(49);
const environment_1 = __webpack_require__(31);
/**
 * Database UI flows: creation wizard, selection, deletion, restore, version
 * and branch-mapping edits, and template management. All PostgreSQL / dump
 * work is delegated to services/postgres.ts and services/dumpImport.ts.
 */
/**
 * Gets the effective Odoo version for a database object.
 * Works with both DatabaseModel instances and plain database objects.
 */
function getEffectiveOdooVersion(db) {
    if (db && typeof db.getEffectiveOdooVersion === 'function') {
        return db.getEffectiveOdooVersion();
    }
    if (db && db.versionId) {
        try {
            const versionsService = versionsService_1.VersionsService.getInstance();
            const version = versionsService.getVersion(db.versionId);
            if (version) {
                return version.odooVersion;
            }
        }
        catch (error) {
            logger_1.logger.warn(`Failed to get version for database ${(0, utils_1.getDatabaseLabel)(db)}:`, error);
        }
    }
    // Fall back to legacy odooVersion property
    return db?.odooVersion || undefined;
}
async function collectExistingDatabaseIdentifiers() {
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    const identifiers = new Set();
    for (const project of data.projects ?? []) {
        for (const db of project.dbs ?? []) {
            if (db && typeof db.id === 'string') {
                identifiers.add(db.id.toLowerCase());
            }
        }
    }
    return identifiers;
}
async function promptProjectRepoBranchAssignments(repos, existingAssignments = [], mode = 'create') {
    if (repos.length === 0) {
        return [];
    }
    const normalizedExisting = (0, environment_1.sanitizeProjectRepoBranchAssignments)(existingAssignments);
    const existingByPath = new Map();
    const existingByName = new Map();
    for (const entry of normalizedExisting) {
        if (entry.repoPath) {
            existingByPath.set((0, utils_1.normalizePath)(entry.repoPath), entry);
        }
        if (entry.repoName) {
            existingByName.set(entry.repoName.toLowerCase(), entry);
        }
    }
    const setupChoices = [
        {
            label: 'Use current branches for all project repos',
            description: 'Capture each selected repo current branch and attach it to this DB',
            action: 'use-current'
        },
        {
            label: 'Choose branch per repository',
            description: 'Select an explicit branch for each selected repo',
            action: 'choose-per-repo'
        },
        {
            label: mode === 'edit' ? 'Clear project repo branch mapping' : 'Skip project repo branch mapping',
            description: mode === 'edit'
                ? 'Remove all project repo branch assignments from this DB'
                : 'Do not attach project repo branch assignments to this DB',
            action: 'clear'
        }
    ];
    if (mode === 'edit') {
        setupChoices.unshift({
            label: 'Keep existing project repo branch mapping',
            description: `Keep ${normalizedExisting.length} currently mapped repo branch assignment(s)`,
            action: 'keep'
        });
    }
    const setupChoice = await vscode.window.showQuickPick(setupChoices, {
        placeHolder: mode === 'edit'
            ? 'Edit project repository branches for this database'
            : 'Attach project repository branches to this database?',
        ignoreFocusOut: true
    });
    if (!setupChoice) {
        return undefined;
    }
    if (setupChoice.action === 'keep') {
        return normalizedExisting;
    }
    if (setupChoice.action === 'clear') {
        return [];
    }
    if (setupChoice.action === 'use-current') {
        const mapped = await Promise.all(repos.map(async (repo) => {
            const repoPath = (0, utils_1.normalizePath)(repo.path);
            const branch = await (0, branches_1.getRepoBranch)(repoPath);
            if (!branch) {
                return undefined;
            }
            return {
                repoName: repo.name,
                repoPath,
                branch
            };
        }));
        return mapped.filter((entry) => !!entry);
    }
    const assignments = [];
    for (let i = 0; i < repos.length; i++) {
        const repo = repos[i];
        const repoPath = (0, utils_1.normalizePath)(repo.path);
        const existing = existingByPath.get(repoPath) ?? existingByName.get(repo.name.toLowerCase());
        const existingBranch = existing?.branch;
        const currentBranch = await (0, branches_1.getRepoBranch)(repoPath);
        const branches = await (0, utils_1.getGitBranches)(repoPath);
        const uniqueBranches = Array.from(new Set([
            ...(existingBranch ? [existingBranch] : []),
            ...(currentBranch ? [currentBranch] : []),
            ...branches
        ]));
        const selectableBranches = uniqueBranches.filter(branch => branch !== currentBranch && branch !== existingBranch);
        const options = [
            ...(existingBranch ? [{
                    label: `$(bookmark) Keep mapped branch (${existingBranch})`,
                    description: repo.name,
                    action: 'use',
                    branch: existingBranch
                }] : []),
            ...(currentBranch ? [{
                    label: `$(git-branch) Keep current branch (${currentBranch})`,
                    description: repo.name,
                    action: 'use',
                    branch: currentBranch
                }] : []),
            ...selectableBranches.map(branch => ({
                label: branch,
                description: repo.name,
                action: 'use',
                branch
            })),
            {
                label: '$(pencil) Enter a custom branch',
                description: repo.name,
                action: 'custom'
            },
            {
                label: mode === 'edit' && existingBranch
                    ? '$(close) Keep existing mapping for this repository'
                    : '$(close) Skip this repository',
                description: repo.name,
                action: 'skip'
            }
        ];
        const picked = await vscode.window.showQuickPick(options, {
            placeHolder: `[${i + 1}/${repos.length}] Select branch for repository "${repo.name}"${existingBranch ? ` (mapped: ${existingBranch})` : ''}`,
            ignoreFocusOut: true
        });
        if (!picked) {
            return undefined;
        }
        if (picked.action === 'skip') {
            if (mode === 'edit' && existingBranch) {
                assignments.push({
                    repoName: repo.name,
                    repoPath,
                    branch: existingBranch
                });
            }
            continue;
        }
        let branch = picked.branch;
        if (picked.action === 'custom') {
            const customBranchInput = await vscode.window.showInputBox({
                placeHolder: existingBranch ?? currentBranch ?? 'Enter branch name',
                value: existingBranch ?? currentBranch ?? '',
                prompt: `Enter the branch to checkout for "${repo.name}" when this DB is selected`,
                ignoreFocusOut: true
            });
            if (customBranchInput === undefined) {
                return undefined;
            }
            branch = customBranchInput.trim();
        }
        if (!branch) {
            continue;
        }
        assignments.push({
            repoName: repo.name,
            repoPath,
            branch
        });
    }
    return assignments;
}
/**
 * Helper function to extract DatabaseModel from various event sources
 * (direct database object, VS Code TreeItem, or command arguments)
 */
function extractDatabaseFromEvent(event) {
    if (!event || typeof event !== 'object') {
        return null;
    }
    const candidate = event;
    // Check if we received a VS Code TreeItem (context menu call)
    // TreeItems have properties like collapsibleState, label, and our custom database property
    if ('collapsibleState' in candidate && 'label' in candidate && candidate.database) {
        return candidate.database;
    }
    // Check if it's a direct database object (has required DatabaseModel properties)
    if (typeof candidate.name === 'string' && typeof candidate.id === 'string') {
        return event;
    }
    return null;
}
async function getDbDumpFolder(dumpsFolder, searchFilter) {
    dumpsFolder = (0, utils_1.normalizePath)(dumpsFolder);
    if (!(await (0, dumpImport_1.pathExists)(dumpsFolder))) {
        void (0, notifications_1.showError)(`Dumps folder not found: ${dumpsFolder}`);
        return undefined;
    }
    const matches = await (0, dumpImport_1.collectDumpSources)(dumpsFolder);
    if (matches.length === 0) {
        void (0, notifications_1.showInfo)(`No dump directories or zip archives found in ${path.basename(dumpsFolder)}.`);
        return undefined;
    }
    let foldersToShow = matches.map(item => ({
        label: item.label,
        description: item.path,
        detail: item.kind === 'zip' ? 'Zip archive' : item.kind === 'file' ? 'SQL dump file' : 'Folder',
        item
    }));
    if (searchFilter && searchFilter.trim() !== '') {
        const filterTerm = searchFilter.toLowerCase();
        const exact = foldersToShow.filter(item => item.label.toLowerCase() === filterTerm);
        const partial = foldersToShow.filter(item => item.label.toLowerCase().includes(filterTerm) && item.label.toLowerCase() !== filterTerm);
        const rest = foldersToShow.filter(item => !item.label.toLowerCase().includes(filterTerm));
        foldersToShow = [...exact, ...partial, ...rest];
    }
    const selected = await vscode.window.showQuickPick(foldersToShow, {
        placeHolder: searchFilter
            ? `Select a dump source (showing "${searchFilter}" matches first)`
            : 'Select a folder or zip archive containing dump.sql',
        ignoreFocusOut: true
    });
    return selected?.item;
}
const CREATION_METHOD_ITEMS = {
    fresh: {
        label: 'Fresh Database',
        description: 'Create a new empty database and install modules',
        detail: 'Start with a clean Odoo installation',
        method: 'fresh'
    },
    dump: {
        label: 'From Dump File',
        description: 'Restore database from a dump/backup file',
        detail: 'Import an existing database backup',
        method: 'dump'
    },
    existing: {
        label: 'Connect to Existing',
        description: 'Reference an already existing database',
        detail: 'Use a database that already exists in PostgreSQL',
        method: 'existing'
    },
    template: {
        label: 'From Template',
        description: 'Create a database by cloning a saved template',
        detail: 'Fast DB creation using createdb -T <template>',
        method: 'template'
    }
};
const NEW_DB_NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;
async function pickExistingPostgresDatabase() {
    const linkedIdentifiers = await collectExistingDatabaseIdentifiers();
    const candidates = (await (0, postgres_1.listPostgresDatabases)())
        .filter(name => !postgres_1.RESERVED_DATABASE_NAMES.has(name.toLowerCase()));
    const choices = [
        ...candidates.map(name => ({
            label: name,
            description: linkedIdentifiers.has(name.toLowerCase()) ? 'Already linked to a project' : undefined,
            action: 'select',
            dbName: name
        })),
        {
            label: '$(pencil) Enter database name manually',
            detail: 'Use this if the database is not listed.',
            action: 'manual'
        }
    ];
    const selection = await vscode.window.showQuickPick(choices, {
        placeHolder: 'Select the existing PostgreSQL database to connect',
        ignoreFocusOut: true
    });
    if (!selection) {
        return undefined;
    }
    if (selection.action === 'select') {
        return selection.dbName;
    }
    const manual = await vscode.window.showInputBox({
        placeHolder: 'Enter the name of the existing PostgreSQL database',
        prompt: 'Make sure the database exists in your PostgreSQL instance',
        ignoreFocusOut: true,
        validateInput: value => value.trim() ? null : 'Enter a database name to continue.'
    });
    return manual?.trim() || undefined;
}
async function linkDatabaseToVersion(dbId, versionId) {
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    let changed = false;
    for (const project of data.projects ?? []) {
        for (const db of project.dbs ?? []) {
            if (db?.id === dbId && !db.versionId) {
                db.versionId = versionId;
                changed = true;
            }
        }
    }
    if (changed) {
        await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
    }
}
/**
 * Resolves which version profile a new database should use, without prompting:
 * fresh databases inherit the active version; restored/connected databases are
 * probed for their Odoo series (base module version) and matched to a version.
 */
async function resolveVersionForNewDatabase(dbName, method) {
    const versionsService = versionsService_1.VersionsService.getInstance();
    await versionsService.initialize();
    const activeVersion = versionsService.getActiveVersion();
    if (method === 'fresh') {
        return { versionId: activeVersion?.id, branchLabel: activeVersion?.odooVersion };
    }
    const series = await (0, database_1.detectOdooSeries)(dbName);
    if (!series) {
        return { versionId: activeVersion?.id, branchLabel: activeVersion?.odooVersion };
    }
    const match = versionsService.getVersions().find(version => (version.odooVersion ?? '').trim() === series);
    if (match) {
        return { versionId: match.id, branchLabel: series };
    }
    // Non-blocking offer to create the missing version profile.
    void (0, notifications_1.showInfo)(`Database "${dbName}" runs Odoo ${series}, but no matching version profile exists.`, 'Create Version', 'Ignore').then(async (choice) => {
        if (choice !== 'Create Version') {
            return;
        }
        try {
            const created = await versionsService.createVersion(`Odoo ${series}`, series);
            await linkDatabaseToVersion(dbName, created.id);
            (0, notifications_1.showAutoInfo)(`Created version "Odoo ${series}" and linked it to "${dbName}"`, 3000);
            await vscode.commands.executeCommand('dbSelector.refresh');
        }
        catch (error) {
            void (0, notifications_1.showError)(`Failed to create version for Odoo ${series}: ${(0, logger_1.errorMessage)(error)}`);
        }
    });
    return { versionId: undefined, branchLabel: series };
}
async function createDb(projectName, repos, dumpFolderPath, _settings, options = {}) {
    // Step 1: creation method — the only decision that cannot be inferred.
    let creationMethod;
    if (options.initialMethod) {
        creationMethod = options.initialMethod;
    }
    else {
        const methodItems = Object.values(CREATION_METHOD_ITEMS)
            .filter(item => options.allowExistingOption !== false || item.method !== 'existing');
        const selection = await vscode.window.showQuickPick(methodItems, {
            placeHolder: 'How do you want to create this database?',
            ignoreFocusOut: true
        });
        if (!selection) {
            return undefined;
        }
        creationMethod = selection.method;
    }
    // Step 2: method-specific source.
    let sqlDumpPath;
    let selectedTemplate;
    let existingDbName;
    switch (creationMethod) {
        case 'dump': {
            const selection = await getDbDumpFolder(dumpFolderPath, projectName);
            if (!selection) {
                return undefined;
            }
            if (selection.kind === 'folder') {
                const candidate = path.join(selection.path, 'dump.sql');
                if (!(await (0, dumpImport_1.pathExists)(candidate))) {
                    void (0, notifications_1.showError)(`dump.sql not found inside ${selection.path}`);
                    return undefined;
                }
                sqlDumpPath = candidate;
            }
            else {
                sqlDumpPath = selection.path;
            }
            break;
        }
        case 'template': {
            const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
            const templates = (0, templates_1.sanitizeDatabaseTemplates)(data.dbTemplates);
            if (templates.length === 0) {
                void (0, notifications_1.showInfo)('No database templates found. Use "Manage Database Templates" to create one first.');
                return undefined;
            }
            selectedTemplate = await promptTemplateSelection(templates, 'Select a template to clone into the new database');
            if (!selectedTemplate) {
                return undefined;
            }
            break;
        }
        case 'existing': {
            existingDbName = await pickExistingPostgresDatabase();
            if (!existingDbName) {
                return undefined;
            }
            break;
        }
        case 'fresh':
            break;
    }
    // Step 3: database name — pre-filled suggestion, one Enter to accept.
    const creationTimestamp = new Date();
    const existingIdentifiers = await collectExistingDatabaseIdentifiers();
    const dbKind = creationMethod;
    let dbName;
    if (existingDbName) {
        dbName = existingDbName;
    }
    else {
        const suggestion = (0, dbNaming_1.generateDatabaseIdentifiers)({
            projectName,
            kind: dbKind,
            timestamp: creationTimestamp,
            existingInternalNames: existingIdentifiers
        }).internalName;
        const nameInput = await vscode.window.showInputBox({
            prompt: 'Database name (used as the PostgreSQL identifier)',
            value: suggestion,
            ignoreFocusOut: true,
            validateInput: value => {
                const trimmed = value.trim();
                if (!trimmed) {
                    return 'Database name cannot be empty.';
                }
                if (!NEW_DB_NAME_PATTERN.test(trimmed)) {
                    return 'Use letters, numbers, "-" or "_" only. The name must not start with "-".';
                }
                if (postgres_1.RESERVED_DATABASE_NAMES.has(trimmed.toLowerCase())) {
                    return `"${trimmed}" is a reserved database name.`;
                }
                if (existingIdentifiers.has(trimmed.toLowerCase())) {
                    return 'A database with this name is already linked to a project.';
                }
                return null;
            }
        });
        if (nameInput === undefined) {
            return undefined;
        }
        dbName = nameInput.trim();
    }
    // Step 4: create/restore the PostgreSQL database.
    if (creationMethod === 'dump' && sqlDumpPath) {
        await setupDatabase(dbName, sqlDumpPath);
    }
    else if (creationMethod === 'template' && selectedTemplate) {
        await cloneDatabaseFromTemplate(dbName, selectedTemplate.templateDbName);
    }
    else if (creationMethod === 'fresh') {
        await setupDatabase(dbName, undefined);
    }
    // Step 5: infer the environment instead of prompting for it. The version is
    // auto-detected from the database itself; the current branch of every
    // project repo is captured as the database's working state.
    const { versionId, branchLabel } = await resolveVersionForNewDatabase(dbName, creationMethod);
    const projectRepoBranches = await (0, environment_1.captureCurrentRepoBranches)(repos);
    return new db_1.DatabaseModel(dbName, creationTimestamp, {
        isSelected: true,
        isItABackup: creationMethod === 'dump',
        sqlFilePath: sqlDumpPath,
        isExisting: creationMethod === 'existing',
        branchName: branchLabel ?? '',
        versionId,
        displayName: dbName,
        internalName: dbName,
        kind: dbKind,
        projectRepoBranches
    });
}
/** Clones `templateDbName` into `targetDbName`, replacing any existing DB. */
async function cloneDatabaseFromTemplate(targetDbName, templateDbName) {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Setting up database ${targetDbName}`,
        cancellable: false
    }, async (progress) => {
        progress.report({ message: 'Checking database existence...', increment: 20 });
        if (await (0, postgres_1.databaseExists)(targetDbName)) {
            progress.report({ message: 'Dropping existing database...', increment: 20 });
            await (0, postgres_1.dropDatabase)(targetDbName);
        }
        progress.report({ message: `Cloning from template "${templateDbName}"...`, increment: 50 });
        await (0, postgres_1.createDatabase)(targetDbName, templateDbName);
        progress.report({ message: 'Complete!', increment: 30 });
    });
}
/**
 * Creates (or drops, with `remove`) the PostgreSQL database, importing and
 * neutralizing a dump when one is provided.
 */
async function setupDatabase(dbName, dumpPath, remove = false) {
    if (dumpPath && !(await (0, dumpImport_1.pathExists)(dumpPath))) {
        void (0, notifications_1.showError)(`Dump file not found at: ${dumpPath}`);
        return;
    }
    let preparedDump;
    try {
        preparedDump = dumpPath ? await (0, dumpImport_1.prepareDumpForImport)(dumpPath) : undefined;
    }
    catch (error) {
        void (0, notifications_1.showError)(`Unable to read dump file: ${(0, logger_1.errorMessage)(error)}`);
        return;
    }
    const operation = remove ? 'Removing' : preparedDump ? 'Setting up' : 'Creating';
    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `${operation} database ${dbName}`,
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ message: 'Checking database existence...', increment: 10 });
                if (await (0, postgres_1.databaseExists)(dbName)) {
                    progress.report({ message: 'Dropping existing database...', increment: 20 });
                    logger_1.logger.debug(`Dropping existing database: ${dbName}`);
                    await (0, postgres_1.dropDatabase)(dbName);
                }
                if (remove) {
                    progress.report({ message: 'Complete!', increment: 100 });
                    return;
                }
                progress.report({ message: 'Creating database...', increment: 40 });
                logger_1.logger.debug(`Creating database: ${dbName}`);
                await (0, postgres_1.createDatabase)(dbName);
                if (preparedDump) {
                    progress.report({
                        message: preparedDump.progressMessage ?? 'Importing dump file...',
                        increment: 50
                    });
                    logger_1.logger.debug(`Importing SQL dump into ${dbName}`);
                    try {
                        await (0, dumpImport_1.importPreparedDump)(dbName, preparedDump);
                    }
                    catch (error) {
                        if (dumpPath && preparedDump.kind === 'stream' && (0, dumpImport_1.isToolchainUnavailableError)(error)) {
                            logger_1.logger.warn('Streaming import unavailable. Falling back to temporary dump extraction.');
                            progress.report({
                                message: dumpPath.toLowerCase().endsWith('.zip')
                                    ? 'Streaming unavailable. Extracting archive to temporary SQL file...'
                                    : 'Streaming unavailable. Decompressing dump to temporary SQL file...'
                            });
                            const fallbackDump = await (0, dumpImport_1.prepareDumpViaTempFile)(dumpPath);
                            try {
                                progress.report({ message: 'Importing extracted SQL dump...' });
                                await (0, dumpImport_1.importPreparedDump)(dbName, fallbackDump);
                            }
                            finally {
                                fallbackDump.cleanup?.();
                            }
                        }
                        else {
                            throw error;
                        }
                    }
                    progress.report({ message: 'Configuring database for development...', increment: 70 });
                    await (0, postgres_1.neutralizeDatabase)(dbName, (0, node_crypto_1.randomUUID)());
                    progress.report({ message: 'Database configured for development', increment: 90 });
                }
                else {
                    progress.report({ message: 'Database created (empty)...', increment: 90 });
                    logger_1.logger.debug(`Empty database created: ${dbName}`);
                }
                progress.report({ message: 'Complete!', increment: 100 });
                logger_1.logger.debug(`Database "${dbName}" is ready.`);
            }
            catch (error) {
                logger_1.logger.error(`Database setup failed for ${dbName}:`, error);
                void (0, notifications_1.showError)(`Failed to setup database: ${(0, logger_1.errorMessage)(error)}`);
            }
        });
    }
    finally {
        if (preparedDump?.cleanup) {
            try {
                preparedDump.cleanup();
            }
            catch (cleanupError) {
                logger_1.logger.warn('Failed to cleanup temporary dump files:', cleanupError);
            }
        }
    }
}
async function restoreDb(event) {
    const database = extractDatabaseFromEvent(event);
    if (!database) {
        throw new Error('Invalid database object for restoration');
    }
    const databaseLabel = (0, utils_1.getDatabaseLabel)(database);
    // Check if database has a backup file path
    if (!database.sqlFilePath || database.sqlFilePath.trim() === '') {
        throw new Error('No backup file path defined for this database');
    }
    // Ask for confirmation
    const confirm = await (0, notifications_1.showModalWarning)(`Are you sure you want to restore the database "${databaseLabel}"? This will overwrite the existing database.`, 'Restore');
    if (confirm !== 'Restore') {
        return; // User cancelled
    }
    await setupDatabase(database.id, database.sqlFilePath);
    (0, notifications_1.showAutoInfo)(`Database "${databaseLabel}" restored successfully`, 3000);
}
async function selectDatabase(event) {
    const database = extractDatabaseFromEvent(event);
    if (!database) {
        void (0, notifications_1.showError)('Could not identify the database to select.');
        return;
    }
    const databaseLabel = (0, utils_1.getDatabaseLabel)(database);
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    const projectIndex = data.projects.findIndex(p => p.uid === project.uid);
    if (projectIndex === -1) {
        void (0, notifications_1.showError)('The selected project could not be found.');
        return;
    }
    // Update database selection
    const oldSelectedDbIndex = project.dbs.findIndex((db) => db.isSelected);
    if (oldSelectedDbIndex !== -1) {
        project.dbs[oldSelectedDbIndex].isSelected = false;
    }
    const newSelectedDbIndex = project.dbs.findIndex((db) => db.id === database.id);
    if (newSelectedDbIndex !== -1) {
        project.dbs[newSelectedDbIndex].isSelected = true;
    }
    const selectedDatabase = newSelectedDbIndex !== -1 ? project.dbs[newSelectedDbIndex] : database;
    // Remember the choice against the version this database runs under - the
    // one alignEnvironment is about to activate, not the one being left. Keying
    // it off the outgoing active version would file the database under the
    // wrong version whenever the selection also switches versions.
    // `project` is the object inside `data.projects`, so mutating it here is
    // what the save below persists.
    project.selectedDbByVersion = (0, dbResolution_1.rememberDbForVersion)(project.selectedDbByVersion, selectedDatabase.versionId || versionsService_1.VersionsService.getInstance().getActiveVersion()?.id, selectedDatabase.id);
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
    // Align the workbench (active version, core branches, project repo
    // branches) to the database through the single switch pipeline.
    try {
        await (0, environment_1.alignEnvironment)((0, environment_1.buildDatabaseEnvironmentTarget)(selectedDatabase, project.repos ?? []), { label: `Database "${databaseLabel}"` });
    }
    catch (error) {
        logger_1.logger.error('Error while aligning environment for database selection:', error);
        void (0, notifications_1.showWarning)(`Database selected, but environment switching failed: ${(0, logger_1.errorMessage)(error)}`);
    }
    (0, notifications_1.showBriefStatus)(`Database switched to: ${databaseLabel}`, 2000);
}
async function deleteDb(event) {
    const db = extractDatabaseFromEvent(event);
    if (!db) {
        void (0, notifications_1.showError)('Could not identify the database to delete.');
        return;
    }
    const dbLabel = (0, utils_1.getDatabaseLabel)(db);
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    // Find the project index in the projects array
    const projectIndex = data.projects.findIndex(p => p.uid === project.uid);
    if (projectIndex === -1) {
        void (0, notifications_1.showError)('The selected project could not be found.');
        return;
    }
    // Ask for confirmation
    const confirm = await (0, notifications_1.showModalWarning)(`Are you sure you want to delete the database "${dbLabel}"?`, 'Delete');
    if (confirm !== 'Delete') {
        return; // User cancelled
    }
    // Delete the database from PostgreSQL
    await setupDatabase(db.id, undefined, true);
    // Remove from project data
    project.dbs = project.dbs.filter((database) => database.id !== db.id);
    // If the deleted database was selected and there are other databases, select the first one
    if (db.isSelected && project.dbs.length > 0) {
        project.dbs[0].isSelected = true;
    }
    // Save the updated data without settings
    const updatedData = (0, utils_1.stripSettings)(data);
    await settingsStore_1.SettingsStore.saveWithoutComments(updatedData);
    (0, notifications_1.showAutoInfo)(`Database "${dbLabel}" deleted successfully`, 2500);
    if (db.isSelected && project.dbs.length > 0) {
        (0, notifications_1.showBriefStatus)(`Switched to database: ${(0, utils_1.getDatabaseLabel)(project.dbs[0])}`, 2000);
    }
}
/**
 * Clones an existing linked database into a new one (createdb -T) and adds
 * the clone to the current project with the same version/branch metadata.
 */
async function cloneDatabaseFlow(event) {
    const db = extractDatabaseFromEvent(event);
    if (!db) {
        void (0, notifications_1.showError)('Could not identify the database to clone.');
        return;
    }
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    const existingIdentifiers = await collectExistingDatabaseIdentifiers();
    let suggestion = `${db.id}-copy`;
    for (let i = 2; existingIdentifiers.has(suggestion.toLowerCase()); i++) {
        suggestion = `${db.id}-copy${i}`;
    }
    const nameInput = await vscode.window.showInputBox({
        prompt: `Clone "${db.id}" into a new database`,
        value: suggestion,
        ignoreFocusOut: true,
        validateInput: value => {
            const trimmed = value.trim();
            if (!trimmed) {
                return 'Database name cannot be empty.';
            }
            if (!NEW_DB_NAME_PATTERN.test(trimmed)) {
                return 'Use letters, numbers, "-" or "_" only. The name must not start with "-".';
            }
            if (postgres_1.RESERVED_DATABASE_NAMES.has(trimmed.toLowerCase())) {
                return `"${trimmed}" is a reserved database name.`;
            }
            if (existingIdentifiers.has(trimmed.toLowerCase())) {
                return 'A database with this name is already linked to a project.';
            }
            return null;
        }
    });
    if (nameInput === undefined) {
        return;
    }
    const targetName = nameInput.trim();
    await cloneDatabaseFromTemplate(targetName, db.id);
    const projectRepoBranches = await (0, environment_1.captureCurrentRepoBranches)(project.repos ?? []);
    const clone = new db_1.DatabaseModel(targetName, new Date(), {
        isSelected: false,
        isItABackup: false,
        isExisting: false,
        branchName: db.branchName ?? '',
        versionId: db.versionId,
        displayName: targetName,
        internalName: targetName,
        kind: 'template',
        projectRepoBranches
    });
    project.dbs.push(clone);
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
    (0, notifications_1.showAutoInfo)(`Cloned "${db.id}" into "${targetName}" and added it to project "${project.name}"`, 3500);
}
/**
 * Compares stored database/template references against the live PostgreSQL
 * instance and offers to remove the ones that no longer exist.
 */
async function reconcileDatabasesFlow() {
    const stale = await (0, reconcile_1.findStaleReferences)();
    if (!stale) {
        void (0, notifications_1.showWarning)('Could not query PostgreSQL to verify database references.');
        return;
    }
    const total = stale.databases.length + stale.templates.length;
    if (total === 0) {
        (0, notifications_1.showAutoInfo)('All linked databases and templates exist in PostgreSQL.', 2500);
        return;
    }
    const picks = [
        ...stale.databases.map(entry => ({
            label: `$(database) ${(0, utils_1.getDatabaseLabel)(entry.db)}`,
            description: `Database in project "${entry.projectName}"`,
            detail: `PostgreSQL database "${entry.db.id}" no longer exists`,
            picked: true,
            staleKind: 'db',
            key: entry.db.id,
            projectName: entry.projectName
        })),
        ...stale.templates.map(template => ({
            label: `$(file-symlink-directory) ${template.name}`,
            description: 'Database template',
            detail: `Template database "${template.templateDbName}" no longer exists`,
            picked: true,
            staleKind: 'template',
            key: template.templateDbName
        }))
    ];
    const chosen = await vscode.window.showQuickPick(picks, {
        canPickMany: true,
        placeHolder: 'These references point to PostgreSQL databases that no longer exist - select which to remove',
        ignoreFocusOut: true
    });
    if (!chosen || chosen.length === 0) {
        return;
    }
    const dbKeys = new Map();
    const templateKeys = new Set();
    for (const pick of chosen) {
        if (pick.staleKind === 'db' && pick.projectName) {
            const set = dbKeys.get(pick.projectName) ?? new Set();
            set.add(pick.key.toLowerCase());
            dbKeys.set(pick.projectName, set);
        }
        else if (pick.staleKind === 'template') {
            templateKeys.add(pick.key.toLowerCase());
        }
    }
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    for (const project of data.projects ?? []) {
        const staleForProject = dbKeys.get(project.name);
        if (!staleForProject || !Array.isArray(project.dbs)) {
            continue;
        }
        const hadSelected = project.dbs.some((db) => db.isSelected);
        project.dbs = project.dbs.filter((db) => !staleForProject.has(db.id.toLowerCase()));
        if (hadSelected && project.dbs.length > 0 && !project.dbs.some((db) => db.isSelected)) {
            project.dbs[0].isSelected = true;
        }
    }
    if (templateKeys.size > 0) {
        data.dbTemplates = (data.dbTemplates ?? []).filter(template => !templateKeys.has(template.templateDbName.toLowerCase()));
    }
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
    (0, notifications_1.showAutoInfo)(`Removed ${chosen.length} stale database reference(s)`, 3000);
}
async function changeDatabaseVersion(event) {
    try {
        const db = extractDatabaseFromEvent(event);
        if (!db) {
            void (0, notifications_1.showError)('Could not identify the database whose version should change.');
            return;
        }
        const dbLabel = (0, utils_1.getDatabaseLabel)(db);
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            return;
        }
        const { data, project } = result;
        // Find the project index in the projects array
        const projectIndex = data.projects.findIndex(p => p.uid === project.uid);
        if (projectIndex === -1) {
            void (0, notifications_1.showError)('The selected project could not be found.');
            return;
        }
        // Find the database index
        const dbIndex = project.dbs.findIndex((database) => database.id === db.id);
        if (dbIndex === -1) {
            void (0, notifications_1.showError)('The selected database could not be found.');
            return;
        }
        // Get available versions
        const versionsService = versionsService_1.VersionsService.getInstance();
        await versionsService.initialize();
        const availableVersions = versionsService.getVersions();
        // Create version choices including "No Version" option
        const versionChoices = [
            {
                label: '$(close) No Version',
                description: 'Remove version association',
                detail: 'Database will use current branch settings without version',
                versionId: undefined
            },
            ...availableVersions.map(version => ({
                label: `$(versions) ${version.name}`,
                description: `Odoo ${version.odooVersion}`,
                detail: `Use settings and configuration from ${version.name}`,
                versionId: version.id
            }))
        ];
        // Show current version in the placeholder
        let currentVersionText = 'No version';
        if (db.versionId) {
            const currentVersion = versionsService.getVersion(db.versionId);
            currentVersionText = currentVersion ? currentVersion.name : 'Unknown version';
        }
        else {
            const effectiveOdooVersion = getEffectiveOdooVersion(db);
            if (effectiveOdooVersion) {
                currentVersionText = `Branch: ${effectiveOdooVersion}`;
            }
        }
        const selectedChoice = await vscode.window.showQuickPick(versionChoices, {
            placeHolder: `Current: ${currentVersionText}. Select a new version for database "${dbLabel}"`,
            ignoreFocusOut: true
        });
        if (!selectedChoice) {
            return; // User cancelled
        }
        // Update the database version - modify the existing database object in place
        // to avoid date serialization issues
        if (selectedChoice.versionId) {
            const selectedVersion = versionsService.getVersion(selectedChoice.versionId);
            if (selectedVersion) {
                project.dbs[dbIndex].versionId = selectedChoice.versionId;
                // Don't set odooVersion when version is assigned - it should come from the version
                project.dbs[dbIndex].odooVersion = undefined;
                // branchName records the core branch this database runs. Leaving
                // the old one behind makes the row read "17.0 • Odoo 19.0", since
                // the view shows branchName whenever it differs from the version.
                project.dbs[dbIndex].branchName = selectedVersion.odooVersion ?? '';
            }
        }
        else {
            // Remove version association but preserve original branch name
            project.dbs[dbIndex].versionId = undefined;
            // When no version, we can fall back to empty odooVersion (will use branchName if available)
            project.dbs[dbIndex].odooVersion = undefined;
            // Keep branchName - it's independent of version management
        }
        // Save only the databases array to avoid touching settings
        const updatedData = (0, utils_1.stripSettings)(data);
        await settingsStore_1.SettingsStore.saveWithoutComments(updatedData);
        // Show confirmation message
        const updatedDb = project.dbs[dbIndex]; // Use the updated database object
        const dbNameForMessage = (0, utils_1.getDatabaseLabel)(updatedDb) || dbLabel;
        const newVersionText = selectedChoice.versionId
            ? `version "${availableVersions.find(v => v.id === selectedChoice.versionId)?.name}"`
            : 'no version';
        (0, notifications_1.showAutoInfo)(`Database "${dbNameForMessage}" updated to use ${newVersionText}`, 3000);
        // If this is the currently selected database, align the workbench to the new version.
        if (db.isSelected && selectedChoice.versionId) {
            await (0, environment_1.alignEnvironment)((0, environment_1.buildDatabaseEnvironmentTarget)(project.dbs[dbIndex], project.repos ?? []), { label: `Database "${dbNameForMessage}"` });
        }
    }
    catch (error) {
        void (0, notifications_1.showError)(`Failed to change database version: ${(0, logger_1.errorMessage)(error)}`);
        logger_1.logger.error('Error in changeDatabaseVersion:', error);
    }
}
async function changeDatabaseProjectRepoBranches(event) {
    try {
        const db = extractDatabaseFromEvent(event);
        if (!db) {
            void (0, notifications_1.showError)('Could not identify the database whose project repo branches should change.');
            return;
        }
        const dbLabel = (0, utils_1.getDatabaseLabel)(db);
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            return;
        }
        const { data, project } = result;
        const projectIndex = data.projects.findIndex(p => p.uid === project.uid);
        if (projectIndex === -1) {
            void (0, notifications_1.showError)('The selected project could not be found.');
            return;
        }
        const dbIndex = project.dbs.findIndex((database) => database.id === db.id);
        if (dbIndex === -1) {
            void (0, notifications_1.showError)('The selected database could not be found.');
            return;
        }
        const existingAssignments = (0, environment_1.sanitizeProjectRepoBranchAssignments)(project.dbs[dbIndex].projectRepoBranches);
        const updatedAssignments = await promptProjectRepoBranchAssignments(project.repos ?? [], existingAssignments, 'edit');
        if (updatedAssignments === undefined) {
            return;
        }
        project.dbs[dbIndex].projectRepoBranches = updatedAssignments;
        const updatedData = (0, utils_1.stripSettings)(data);
        await settingsStore_1.SettingsStore.saveWithoutComments(updatedData);
        if (updatedAssignments.length > 0) {
            (0, notifications_1.showAutoInfo)(`Updated project repo branch mapping for "${dbLabel}" (${updatedAssignments.length} repo(s))`, 3000);
        }
        else {
            (0, notifications_1.showAutoInfo)(`Cleared project repo branch mapping for "${dbLabel}"`, 3000);
        }
        if (project.dbs[dbIndex].isSelected && updatedAssignments.length > 0) {
            // The user explicitly configured this mapping; apply it right away.
            await (0, environment_1.alignEnvironment)({ repoAssignments: (0, environment_1.resolveProjectRepoBranchAssignments)(project.dbs[dbIndex], project.repos ?? []) }, { label: `Database "${dbLabel}"`, behavior: 'auto' });
        }
    }
    catch (error) {
        void (0, notifications_1.showError)(`Failed to update project repo branch mapping: ${(0, logger_1.errorMessage)(error)}`);
        logger_1.logger.error('Error in changeDatabaseProjectRepoBranches:', error);
    }
}
// ---------------------------------------------------------------------------
// Database templates
// ---------------------------------------------------------------------------
function getTemplateQuickPickItems(templates) {
    return templates.map(template => ({
        label: template.name,
        description: template.templateDbName,
        detail: template.sourceDbName ? `Source DB: ${template.sourceDbName}` : 'Source DB not recorded',
        template
    }));
}
async function promptTemplateSelection(templates, placeHolder) {
    if (templates.length === 0) {
        return undefined;
    }
    const selected = await vscode.window.showQuickPick(getTemplateQuickPickItems(templates), {
        placeHolder,
        ignoreFocusOut: true
    });
    return selected?.template;
}
function collectProjectDatabaseNames(data) {
    if (!Array.isArray(data.projects)) {
        return [];
    }
    const projectDbNames = data.projects.flatMap(project => Array.isArray(project?.dbs)
        ? project.dbs
            .map(db => typeof db?.id === 'string' ? db.id.trim() : '')
            .filter((name) => name.length > 0)
        : []);
    return Array.from(new Set(projectDbNames)).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
async function promptTemplateSourceDatabase(data) {
    const projectDbNames = collectProjectDatabaseNames(data);
    const postgresDbNames = (await (0, postgres_1.listPostgresDatabases)())
        .filter(name => !postgres_1.RESERVED_DATABASE_NAMES.has(name.toLowerCase()));
    const mergedNames = Array.from(new Set([
        ...projectDbNames,
        ...postgresDbNames
    ])).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const choices = [
        ...mergedNames.map(dbName => ({
            label: dbName,
            description: projectDbNames.includes(dbName) ? 'Linked project database' : 'PostgreSQL database',
            action: 'select',
            dbName
        })),
        {
            label: '$(pencil) Enter database name manually',
            detail: 'Use this if the source database is not listed.',
            action: 'manual'
        }
    ];
    const selection = await vscode.window.showQuickPick(choices, {
        placeHolder: 'Select the source database to clone into a template',
        ignoreFocusOut: true
    });
    if (!selection) {
        return undefined;
    }
    if (selection.action === 'select') {
        return selection.dbName;
    }
    const customInput = await vscode.window.showInputBox({
        prompt: 'Enter source PostgreSQL database name',
        placeHolder: 'e.g. my_migrated_dump',
        ignoreFocusOut: true,
        validateInput: (value) => {
            if (!value || value.trim().length === 0) {
                return 'Database name cannot be empty.';
            }
            if (value.trim().startsWith('-')) {
                return 'Database name cannot start with "-".';
            }
            return null;
        }
    });
    if (customInput === undefined) {
        return undefined;
    }
    return customInput.trim();
}
async function createTemplateFromSource(data, templates) {
    const sourceDbName = await promptTemplateSourceDatabase(data);
    if (!sourceDbName) {
        return templates;
    }
    const templateDbNames = new Set(templates.map(template => template.templateDbName.toLowerCase()));
    const suggestedName = sourceDbName.startsWith('tpl_') ? sourceDbName : `tpl_${sourceDbName}`;
    const templateNameInput = await vscode.window.showInputBox({
        prompt: `Enter template database name cloned from "${sourceDbName}"`,
        placeHolder: 'e.g. tpl_migration_base',
        value: suggestedName,
        ignoreFocusOut: true,
        validateInput: (value) => (0, templates_1.validateTemplateDatabaseName)(value, templateDbNames)
    });
    if (templateNameInput === undefined) {
        return templates;
    }
    const templateDbName = templateNameInput.trim();
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Creating template ${templateDbName}`,
        cancellable: false
    }, async (progress) => {
        progress.report({ message: `Cloning "${sourceDbName}"...`, increment: 30 });
        await (0, postgres_1.createDatabase)(templateDbName, sourceDbName);
        progress.report({ message: 'Saving template metadata...', increment: 70 });
    });
    const now = new Date().toISOString();
    const updated = await (0, templates_1.persistDatabaseTemplates)(data, [
        ...templates,
        {
            name: templateDbName,
            templateDbName,
            sourceDbName,
            createdAt: now,
            updatedAt: now
        }
    ]);
    (0, notifications_1.showAutoInfo)(`Template "${templateDbName}" created from "${sourceDbName}"`, 3000);
    return updated;
}
async function importTemplatesFromPostgres(data, templates) {
    const postgresDbNames = (await (0, postgres_1.listPostgresDatabases)())
        .filter(name => !postgres_1.RESERVED_DATABASE_NAMES.has(name.toLowerCase()));
    const existingTemplateDbNames = new Set(templates.map(template => template.templateDbName.toLowerCase()));
    const importCandidates = postgresDbNames.filter(name => !existingTemplateDbNames.has(name.toLowerCase()));
    if (importCandidates.length === 0) {
        void (0, notifications_1.showInfo)('No PostgreSQL databases available to import as templates.');
        return templates;
    }
    const selectedCandidates = await vscode.window.showQuickPick(importCandidates.map(name => ({
        label: name,
        description: 'PostgreSQL database',
        dbName: name
    })), {
        placeHolder: 'Select database(s) to register as templates',
        canPickMany: true,
        ignoreFocusOut: true
    });
    if (!selectedCandidates || selectedCandidates.length === 0) {
        return templates;
    }
    const now = new Date().toISOString();
    const updated = await (0, templates_1.persistDatabaseTemplates)(data, [
        ...templates,
        ...selectedCandidates.map(candidate => ({
            name: candidate.dbName,
            templateDbName: candidate.dbName,
            createdAt: now,
            updatedAt: now
        }))
    ]);
    (0, notifications_1.showAutoInfo)(`Imported ${selectedCandidates.length} template(s)`, 2500);
    return updated;
}
async function importTemplatesFromJson(data, templates) {
    const selectedFiles = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
            'JSON Files': ['json'],
            'All Files': ['*']
        },
        openLabel: 'Import Templates'
    });
    if (!selectedFiles || selectedFiles.length === 0) {
        return templates;
    }
    try {
        const content = await vscode.workspace.fs.readFile(selectedFiles[0]);
        const parsed = JSON.parse(Buffer.from(content).toString('utf8'));
        const imported = Array.isArray(parsed) ? parsed : parsed.templates;
        const sanitizedImported = (0, templates_1.sanitizeDatabaseTemplates)(imported);
        if (sanitizedImported.length === 0) {
            void (0, notifications_1.showInfo)('No valid templates found in the selected file.');
            return templates;
        }
        const existingTemplateDbNames = new Set(templates.map(template => template.templateDbName.toLowerCase()));
        const toAdd = sanitizedImported.filter(template => !existingTemplateDbNames.has(template.templateDbName.toLowerCase()));
        if (toAdd.length === 0) {
            void (0, notifications_1.showInfo)('All templates in the selected file already exist.');
            return templates;
        }
        const updated = await (0, templates_1.persistDatabaseTemplates)(data, [...templates, ...toAdd]);
        (0, notifications_1.showAutoInfo)(`Imported ${toAdd.length} template(s) from JSON`, 2500);
        return updated;
    }
    catch (error) {
        void (0, notifications_1.showError)(`Failed to import templates: ${(0, logger_1.errorMessage)(error)}`);
        return templates;
    }
}
async function exportTemplatesToJson(templates) {
    if (templates.length === 0) {
        void (0, notifications_1.showInfo)('No templates available to export.');
        return;
    }
    const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(), 'odoo-db-templates.json')),
        filters: {
            'JSON Files': ['json'],
            'All Files': ['*']
        },
        saveLabel: 'Export Templates'
    });
    if (!saveUri) {
        return;
    }
    const payload = {
        exportedAt: new Date().toISOString(),
        templates
    };
    await vscode.workspace.fs.writeFile(saveUri, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
    (0, notifications_1.showAutoInfo)(`Exported ${templates.length} template(s)`, 2500);
}
async function manageSingleTemplate(data, templates, selectedTemplate) {
    const templateAction = await vscode.window.showQuickPick([
        {
            label: '$(edit) Rename Template',
            description: `Current DB name: ${selectedTemplate.templateDbName}`,
            action: 'rename'
        },
        {
            label: '$(trash) Delete Template',
            description: `Remove "${selectedTemplate.name}"`,
            action: 'delete'
        },
        {
            label: '$(arrow-left) Back',
            action: 'back'
        }
    ], {
        placeHolder: `Manage template "${selectedTemplate.name}"`,
        ignoreFocusOut: true
    });
    if (!templateAction || templateAction.action === 'back') {
        return templates;
    }
    if (templateAction.action === 'rename') {
        const templateDbNames = new Set(templates.map(template => template.templateDbName.toLowerCase()));
        const newNameInput = await vscode.window.showInputBox({
            prompt: `Rename template "${selectedTemplate.templateDbName}"`,
            value: selectedTemplate.templateDbName,
            ignoreFocusOut: true,
            validateInput: (value) => (0, templates_1.validateTemplateDatabaseName)(value, templateDbNames, selectedTemplate.templateDbName)
        });
        if (newNameInput === undefined) {
            return templates;
        }
        const newTemplateDbName = newNameInput.trim();
        if (newTemplateDbName.toLowerCase() === selectedTemplate.templateDbName.toLowerCase()) {
            return templates;
        }
        await (0, postgres_1.renameDatabase)(selectedTemplate.templateDbName, newTemplateDbName);
        const now = new Date().toISOString();
        const updated = await (0, templates_1.persistDatabaseTemplates)(data, templates.map(template => template.templateDbName.toLowerCase() === selectedTemplate.templateDbName.toLowerCase()
            ? {
                ...template,
                name: newTemplateDbName,
                templateDbName: newTemplateDbName,
                updatedAt: now
            }
            : template));
        (0, notifications_1.showAutoInfo)(`Template renamed to "${newTemplateDbName}"`, 2500);
        return updated;
    }
    const deleteChoice = await (0, notifications_1.showModalWarning)(`Delete template "${selectedTemplate.name}" (${selectedTemplate.templateDbName})?`, 'Delete Template DB + Metadata', 'Delete Metadata Only');
    if (!deleteChoice) {
        return templates;
    }
    if (deleteChoice === 'Delete Template DB + Metadata') {
        await (0, postgres_1.dropDatabaseIfExists)(selectedTemplate.templateDbName);
    }
    const updated = await (0, templates_1.persistDatabaseTemplates)(data, templates.filter(template => template.templateDbName.toLowerCase() !== selectedTemplate.templateDbName.toLowerCase()));
    (0, notifications_1.showAutoInfo)(`Template "${selectedTemplate.name}" deleted`, 2500);
    return updated;
}
async function manageDatabaseTemplates() {
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    let templates = (0, templates_1.sanitizeDatabaseTemplates)(data.dbTemplates);
    while (true) {
        const templateCount = templates.length;
        const actions = [
            {
                label: '$(add) Create New Template from Existing DB',
                description: 'Clone a source DB into a new template database',
                action: 'create'
            },
            {
                label: '$(cloud-download) Import Existing Template DB',
                description: 'Register an already-created template database (no cloning)',
                action: 'importDb'
            },
            {
                label: '$(folder-opened) Import Templates from JSON',
                description: 'Merge templates from an exported template file',
                action: 'importFile'
            },
            {
                label: '$(export) Export Templates to JSON',
                description: templateCount > 0 ? `${templateCount} template(s) will be exported` : 'No templates to export',
                action: 'exportFile'
            },
            ...templates.map(template => ({
                label: `$(database) ${template.name}`,
                description: template.templateDbName,
                detail: template.sourceDbName ? `Source DB: ${template.sourceDbName}` : 'No source DB metadata',
                action: 'template',
                template
            })),
            {
                label: '$(check) Done',
                action: 'done'
            }
        ];
        const selectedAction = await vscode.window.showQuickPick(actions, {
            placeHolder: 'Manage database templates',
            ignoreFocusOut: true
        });
        if (!selectedAction || selectedAction.action === 'done') {
            return;
        }
        switch (selectedAction.action) {
            case 'create':
                templates = await createTemplateFromSource(data, templates);
                break;
            case 'importDb':
                templates = await importTemplatesFromPostgres(data, templates);
                break;
            case 'importFile':
                templates = await importTemplatesFromJson(data, templates);
                break;
            case 'exportFile':
                await exportTemplatesToJson(templates);
                break;
            case 'template':
                if (selectedAction.template) {
                    templates = await manageSingleTemplate(data, templates, selectedAction.template);
                }
                break;
        }
    }
}


/***/ }),
/* 37 */
/***/ ((module) => {

module.exports = require("node:os");

/***/ }),
/* 38 */
/***/ ((module) => {

module.exports = require("node:crypto");

/***/ }),
/* 39 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.DatabaseModel = void 0;
const versionsService_1 = __webpack_require__(24);
const logger_1 = __webpack_require__(12);
class DatabaseModel {
    name;
    isItABackup;
    createdAt;
    modules;
    isSelected = false;
    sqlFilePath = '';
    id = '';
    isExisting = false;
    branchName = '';
    odooVersion; // Optional - only used when no version is assigned
    versionId; // Reference to the VersionModel
    displayName;
    internalName;
    kind;
    projectRepoBranches = [];
    constructor(name, createdAt, options = {}) {
        this.displayName = options.displayName || name;
        this.name = this.displayName;
        this.createdAt = createdAt;
        this.modules = options.modules || [];
        this.isItABackup = options.isItABackup || false;
        this.isSelected = options.isSelected || false;
        this.sqlFilePath = options.sqlFilePath || '';
        this.isExisting = options.isExisting || false;
        this.branchName = options.branchName || '';
        this.odooVersion = options.odooVersion; // Optional - undefined when version is assigned
        this.versionId = options.versionId;
        this.kind = options.kind;
        this.projectRepoBranches = Array.isArray(options.projectRepoBranches)
            ? options.projectRepoBranches
                .filter(entry => !!entry && typeof entry.branch === 'string' && entry.branch.trim() !== '')
                .map(entry => ({
                repoName: entry.repoName || '',
                repoPath: entry.repoPath || '',
                branch: entry.branch.trim()
            }))
            : [];
        if (options.internalName) {
            this.internalName = options.internalName;
        }
        else if (this.isExisting) {
            this.internalName = name;
        }
        else {
            this.internalName = `${name}-${createdAt.toISOString().split('T')[0]}`;
        }
        this.id = this.internalName;
    }
    /**
     * Gets the effective Odoo version for this database.
     * First checks if there's a version assigned, then falls back to legacy odooVersion property.
     */
    getEffectiveOdooVersion() {
        if (this.versionId) {
            try {
                const versionsService = versionsService_1.VersionsService.getInstance();
                const version = versionsService.getVersion(this.versionId);
                if (version) {
                    return version.odooVersion;
                }
            }
            catch (error) {
                logger_1.logger.warn(`Failed to get version for database ${this.name}:`, error);
                // Fall through to legacy property
            }
        }
        // Fall back to legacy odooVersion property for backward compatibility
        return this.odooVersion || undefined;
    }
}
exports.DatabaseModel = DatabaseModel;


/***/ }),
/* 40 */
/***/ ((__unused_webpack_module, exports) => {


/**
 * Which database a version launches against. Selection used to be one flag
 * per project, so two versions running at once shared a single `-d`; each
 * version now remembers its own, falling back to the project selection.
 */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.resolveDbForVersion = resolveDbForVersion;
exports.rememberDbForVersion = rememberDbForVersion;
/**
 * Resolution order: the database remembered for this version, then the
 * selected database when it belongs to this version, then the selected
 * database regardless - which is the behaviour that existed before.
 */
function resolveDbForVersion(dbs, selectedDbByVersion, versionId) {
    const selected = dbs.find(db => db.isSelected);
    if (versionId) {
        const rememberedId = selectedDbByVersion?.[versionId];
        const remembered = rememberedId ? dbs.find(db => db.id === rememberedId) : undefined;
        if (remembered) {
            return remembered;
        }
        if (selected?.versionId === versionId) {
            return selected;
        }
    }
    return selected;
}
/** Records `dbId` against `versionId`, leaving other versions' memory intact. */
function rememberDbForVersion(existing, versionId, dbId) {
    const base = { ...(existing ?? {}) };
    if (!versionId) {
        return base;
    }
    base[versionId] = dbId;
    return base;
}


/***/ }),
/* 41 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.generateDatabaseIdentifiers = generateDatabaseIdentifiers;
/**
 * Deterministic database name suggestions (slugified project + kind + date
 * + collision-resolving hash).
 */
const crypto = __importStar(__webpack_require__(26));
const MAX_IDENTIFIER_LENGTH = 63;
const KIND_LABELS = {
    dump: 'Dump',
    fresh: 'Fresh',
    dev: 'Dev',
    test: 'Test',
    feature: 'Feature',
    clone: 'Clone',
    temp: 'Temp',
    shell: 'Shell',
    existing: 'Existing',
    template: 'Template'
};
function slugifySegment(value, fallback) {
    if (!value || value.trim().length === 0) {
        return fallback;
    }
    const normalized = value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    return normalized || fallback;
}
function shortHash(input) {
    return crypto.createHash('sha1').update(input).digest('hex').slice(0, 6);
}
function formatDateStamp(date) {
    const day = `${date.getUTCDate()}`.padStart(2, '0');
    const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
    const year = `${date.getUTCFullYear()}`;
    return `${day}${month}${year}`;
}
function formatDisplayDate(date) {
    try {
        return new Intl.DateTimeFormat(undefined, {
            year: 'numeric',
            month: 'short',
            day: '2-digit'
        }).format(date);
    }
    catch {
        return date.toISOString().split('T')[0];
    }
}
function buildInternalIdentifier(projectSlug, kindSlug, dateStamp, hash) {
    const suffix = `_${hash}`;
    let prefix = `${projectSlug}_${kindSlug}_${dateStamp}`;
    if (prefix.length + suffix.length > MAX_IDENTIFIER_LENGTH) {
        const allowed = MAX_IDENTIFIER_LENGTH - suffix.length;
        prefix = prefix.slice(0, Math.max(1, allowed));
        prefix = prefix.replace(/_+$/g, '');
        if (!prefix) {
            prefix = 'db';
        }
    }
    return `${prefix}${suffix}`;
}
function buildDisplayName(projectName, kindSlug, date, hash) {
    const trimmedName = projectName.trim() || 'Odoo Database';
    const kindLabel = KIND_LABELS[kindSlug] || kindSlug.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
    const prettyDate = formatDisplayDate(date);
    return `${trimmedName} • ${kindLabel} • ${prettyDate} • #${hash}`;
}
function generateDatabaseIdentifiers(options) {
    const timestamp = options.timestamp ?? new Date();
    const projectSlug = slugifySegment(options.projectName, 'project');
    const kindSlug = slugifySegment(options.kind, 'db');
    const dateStamp = formatDateStamp(timestamp);
    const existing = options.existingInternalNames ?? new Set();
    const baseSeed = options.deterministicSeed ?? `${projectSlug}|${kindSlug}|${timestamp.toISOString()}|${crypto.randomUUID()}`;
    let attempt = 0;
    let internalName;
    let hash;
    do {
        const attemptSeed = attempt === 0 ? baseSeed : `${baseSeed}|${attempt}`;
        hash = shortHash(attemptSeed);
        internalName = buildInternalIdentifier(projectSlug, kindSlug, dateStamp, hash);
        attempt++;
    } while (existing.has(internalName.toLowerCase()));
    return {
        internalName,
        displayName: buildDisplayName(options.projectName, kindSlug, timestamp, hash),
        hash
    };
}


/***/ }),
/* 42 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.databaseHasModuleTable = databaseHasModuleTable;
exports.getInstalledModules = getInstalledModules;
exports.getInstalledModuleNames = getInstalledModuleNames;
exports.clearInstalledModuleCache = clearInstalledModuleCache;
exports.parseOdooSeries = parseOdooSeries;
exports.detectOdooSeries = detectOdooSeries;
exports.parseActiveDatabaseNames = parseActiveDatabaseNames;
exports.getActiveDatabaseNames = getActiveDatabaseNames;
/**
 * Read-only PostgreSQL probes for Odoo databases: installed modules and
 * Odoo series detection via the base module version.
 */
const node_child_process_1 = __webpack_require__(14);
const util = __importStar(__webpack_require__(43));
const runtimeCache_1 = __webpack_require__(15);
const logger_1 = __webpack_require__(12);
const execFileAsync = util.promisify(node_child_process_1.execFile);
const INSTALLED_MODULES_QUERY = `
    SELECT id, name, shortdesc, latest_version, state, application
    FROM ir_module_module
    WHERE state IN ('installed', 'to upgrade')
    ORDER BY name;
`.trim();
const INSTALLED_MODULE_NAMES_QUERY = `
    SELECT name
    FROM ir_module_module
    WHERE state IN ('installed', 'to upgrade')
    ORDER BY name;
`.trim();
const TABLE_EXISTS_QUERY = `
    SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'ir_module_module'
    );
`.trim();
const ACTIVE_DATABASES_QUERY = `
    SELECT datname
    FROM pg_stat_activity
    WHERE datname IS NOT NULL
    GROUP BY datname;
`.trim();
const BASE_MODULE_VERSION_QUERY = `
    SELECT latest_version
    FROM ir_module_module
    WHERE name = 'base';
`.trim();
function validateDatabaseName(dbName) {
    // Basic sanity check to avoid shell injection when invoking psql
    if (!/^[\w\-.:]+$/.test(dbName)) {
        throw new Error(`Invalid database identifier: ${dbName}`);
    }
}
async function runPsqlQuery(dbName, query, fieldSeparator = '|') {
    validateDatabaseName(dbName);
    try {
        const args = [
            '--no-psqlrc',
            '--no-align',
            '--tuples-only',
            '-F',
            fieldSeparator,
            '-d',
            dbName,
            '-c',
            query
        ];
        const { stdout } = await execFileAsync('psql', args, {
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024 // Allow reasonably large result sets
        });
        return stdout.trim();
    }
    catch (error) {
        logger_1.logger.warn(`psql command failed for database "${dbName}":`, error);
        throw error;
    }
}
async function databaseHasModuleTable(dbName) {
    try {
        const result = await runPsqlQuery(dbName, TABLE_EXISTS_QUERY);
        return result === 't';
    }
    catch {
        return false;
    }
}
async function getInstalledModules(dbName) {
    return runtimeCache_1.runtimeCache.getInstalledModules(dbName, async () => {
        const modules = [];
        if (!(await databaseHasModuleTable(dbName))) {
            logger_1.logger.debug(`Database ${dbName} does not contain Odoo tables yet.`);
            return modules;
        }
        let output;
        try {
            output = await runPsqlQuery(dbName, INSTALLED_MODULES_QUERY);
        }
        catch (error) {
            logger_1.logger.warn(`Failed to fetch installed modules for database "${dbName}":`, error);
            return modules;
        }
        if (!output) {
            return modules;
        }
        for (const line of output.split('\n').map(entry => entry.trim()).filter(Boolean)) {
            const [id, name, shortdesc, latestVersion, state, application] = line.split('|');
            let description = shortdesc || '';
            if (shortdesc) {
                try {
                    const parsed = JSON.parse(shortdesc);
                    const locales = Object.keys(parsed);
                    if (locales.length > 0) {
                        description = parsed.en_US ?? parsed[locales[0]] ?? '';
                    }
                }
                catch {
                    // Keep original string when JSON parsing fails
                    description = shortdesc;
                }
            }
            modules.push({
                id: Number.parseInt(id ?? '', 10),
                name: name ?? '',
                shortdesc: description ?? '',
                installed_version: latestVersion || null,
                latest_version: latestVersion || null,
                state: state ?? '',
                application: application === 't'
            });
        }
        return modules;
    });
}
async function getInstalledModuleNames(dbName) {
    const names = await runtimeCache_1.runtimeCache.getInstalledModuleNames(dbName, async () => {
        if (!(await databaseHasModuleTable(dbName))) {
            return [];
        }
        let output;
        try {
            output = await runPsqlQuery(dbName, INSTALLED_MODULE_NAMES_QUERY);
        }
        catch (error) {
            logger_1.logger.warn(`Failed to fetch installed module names for database "${dbName}":`, error);
            return [];
        }
        if (!output) {
            return [];
        }
        return output
            .split('\n')
            .map(entry => entry.trim())
            .filter(Boolean);
    });
    return new Set(names);
}
function clearInstalledModuleCache(dbName) {
    (0, runtimeCache_1.invalidateInstalledModulesCache)(dbName);
}
/**
 * Extracts the Odoo series (branch name) from a base module version string:
 * "17.0.1.3" -> "17.0", "saas~17.4.1.2" -> "saas-17.4".
 */
function parseOdooSeries(baseModuleVersion) {
    if (!baseModuleVersion) {
        return undefined;
    }
    const match = /^(saas[~-])?(\d+)\.(\d+)/.exec(baseModuleVersion.trim());
    if (!match) {
        return undefined;
    }
    const series = `${match[2]}.${match[3]}`;
    return match[1] ? `saas-${series}` : series;
}
/**
 * Detects which Odoo series (e.g. "17.0", "saas-17.4") a database runs by
 * reading the base module's version. Best-effort: returns undefined for
 * non-Odoo databases or when psql is unavailable.
 */
async function detectOdooSeries(dbName) {
    try {
        if (!(await databaseHasModuleTable(dbName))) {
            return undefined;
        }
        const output = await runPsqlQuery(dbName, BASE_MODULE_VERSION_QUERY);
        return parseOdooSeries(output);
    }
    catch (error) {
        logger_1.logger.warn(`Failed to detect Odoo series for database "${dbName}":`, error);
        return undefined;
    }
}
function parseActiveDatabaseNames(output) {
    return output
        .split('\n')
        .map(entry => entry.trim())
        .filter(Boolean);
}
/**
 * Databases with at least one live backend, which catches servers started
 * from a terminal or another window - not just the ones this extension
 * launched. Queried through the `postgres` maintenance database because the
 * view is cluster-wide. Best-effort: an unreachable cluster reports nothing.
 */
async function getActiveDatabaseNames() {
    return runtimeCache_1.runtimeCache.getActiveDatabases(async () => {
        try {
            return parseActiveDatabaseNames(await runPsqlQuery('postgres', ACTIVE_DATABASES_QUERY));
        }
        catch (error) {
            logger_1.logger.debug('Could not read active databases from pg_stat_activity:', error);
            return [];
        }
    });
}


/***/ }),
/* 43 */
/***/ ((module) => {

module.exports = require("node:util");

/***/ }),
/* 44 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.RESERVED_DATABASE_NAMES = void 0;
exports.quotePgIdentifier = quotePgIdentifier;
exports.runSql = runSql;
exports.listPostgresDatabases = listPostgresDatabases;
exports.databaseExists = databaseExists;
exports.createDatabase = createDatabase;
exports.dropDatabase = dropDatabase;
exports.dropDatabaseIfExists = dropDatabaseIfExists;
exports.renameDatabase = renameDatabase;
exports.neutralizeDatabase = neutralizeDatabase;
const process_1 = __webpack_require__(13);
const database_1 = __webpack_require__(42);
const logger_1 = __webpack_require__(12);
/**
 * All PostgreSQL CLI operations (psql/createdb/dropdb). Every call passes
 * arguments as arrays with no shell, so database names and paths can never be
 * interpreted by a shell regardless of their content.
 */
exports.RESERVED_DATABASE_NAMES = new Set(['postgres', 'template0', 'template1']);
/** Quotes a PostgreSQL identifier for embedding in SQL text. */
function quotePgIdentifier(identifier) {
    return `"${identifier.replace(/"/g, '""')}"`;
}
/** Runs a single SQL statement against `dbName` and returns trimmed stdout. */
async function runSql(dbName, sql) {
    const { stdout } = await (0, process_1.runCommand)('psql', [
        '--no-psqlrc',
        '-v', 'ON_ERROR_STOP=1',
        '-d', dbName,
        '-tAc', sql
    ]);
    return stdout.trim();
}
/** Lists all databases on the local PostgreSQL instance. */
async function listPostgresDatabases() {
    try {
        const output = await runSql('postgres', 'SELECT datname FROM pg_database ORDER BY datname;');
        return output
            .split('\n')
            .map(name => name.trim())
            .filter(name => name.length > 0);
    }
    catch (error) {
        logger_1.logger.warn('Failed to query PostgreSQL database list:', error);
        return [];
    }
}
async function databaseExists(dbName) {
    const result = await runSql('postgres', `SELECT 1 FROM pg_database WHERE datname = '${dbName.replace(/'/g, "''")}'`);
    return result === '1';
}
/** Creates a database, optionally cloning from a template (createdb -T). */
async function createDatabase(dbName, templateDbName) {
    const args = templateDbName ? ['-T', templateDbName, dbName] : [dbName];
    await (0, process_1.runCommand)('createdb', args);
    (0, database_1.clearInstalledModuleCache)(dbName);
}
async function dropDatabase(dbName, options = {}) {
    const args = options.ifExists ? ['--if-exists', dbName] : [dbName];
    await (0, process_1.runCommand)('dropdb', args);
    (0, database_1.clearInstalledModuleCache)(dbName);
}
/** Drops `dbName` if it exists (no error when missing). */
async function dropDatabaseIfExists(dbName) {
    await dropDatabase(dbName, { ifExists: true });
}
async function renameDatabase(oldName, newName) {
    const sql = `ALTER DATABASE ${quotePgIdentifier(oldName)} RENAME TO ${quotePgIdentifier(newName)};`;
    await (0, process_1.runCommand)('psql', ['-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
    (0, database_1.clearInstalledModuleCache)(oldName);
    (0, database_1.clearInstalledModuleCache)(newName);
}
/**
 * Development-mode neutralization applied after restoring a dump: disables
 * crons and outgoing mail, resets logins/passwords, regenerates the database
 * UUID and extends the enterprise expiration date.
 */
async function neutralizeDatabase(dbName, newUuid) {
    const statements = [
        { description: 'Disabling cron jobs', sql: "UPDATE ir_cron SET active='f';" },
        { description: 'Disabling mail servers', sql: 'UPDATE ir_mail_server SET active=false;' },
        { description: 'Extending database expiry', sql: "UPDATE ir_config_parameter SET value = '2090-09-21 00:00:00' WHERE key = 'database.expiration_date';" },
        { description: 'Updating database UUID', sql: `UPDATE ir_config_parameter SET value = '${newUuid}' WHERE key = 'database.uuid';` },
        { description: 'Adding mailcatcher server', sql: "INSERT INTO ir_mail_server(active,name,smtp_host,smtp_port,smtp_encryption) VALUES (true,'mailcatcher','localhost',1025,false);" },
        { description: 'Resetting user passwords to login names', sql: 'UPDATE res_users SET password=login;' },
        { description: 'Configuring admin password', sql: "UPDATE res_users SET password='admin' WHERE id=2;" },
        { description: 'Configuring admin login', sql: "UPDATE res_users SET login='admin' WHERE id=2;" },
        { description: 'Clearing admin TOTP', sql: "UPDATE res_users SET totp_secret='' WHERE id=2;" },
        { description: 'Activating admin user', sql: 'UPDATE res_users SET active=true WHERE id=2;' },
        { description: 'Clearing employee PINs', sql: "UPDATE hr_employee SET pin = '';" }
    ];
    // Every statement is tolerant: dumps vary (e.g. no hr_employee without the
    // hr module), and a failed tweak must never abort the whole restore.
    for (const statement of statements) {
        logger_1.logger.debug(`${statement.description} on ${dbName}`);
        try {
            await runSql(dbName, statement.sql);
        }
        catch (error) {
            logger_1.logger.warn(`${statement.description} failed (continuing setup):`, error);
        }
    }
}


/***/ }),
/* 45 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.collectDumpSources = collectDumpSources;
exports.pathExists = pathExists;
exports.isToolchainUnavailableError = isToolchainUnavailableError;
exports.prepareDumpForImport = prepareDumpForImport;
exports.importPreparedDump = importPreparedDump;
exports.prepareDumpViaTempFile = prepareDumpViaTempFile;
const fs = __importStar(__webpack_require__(2));
const fsp = __importStar(__webpack_require__(23));
const path = __importStar(__webpack_require__(4));
const os = __importStar(__webpack_require__(37));
const node_child_process_1 = __webpack_require__(14);
const node_stream_1 = __webpack_require__(46);
const promises_1 = __webpack_require__(47);
const process_1 = __webpack_require__(13);
const logger_1 = __webpack_require__(12);
/** Recursively finds restorable dump sources under `root` (bounded depth). */
async function collectDumpSources(root, maxDepth = 2) {
    const results = [];
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length > 0) {
        const { dir, depth } = stack.pop();
        let entries;
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        }
        catch (error) {
            logger_1.logger.warn(`Failed to read dumps directory ${dir}:`, error);
            continue;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativeLabel = path.relative(root, fullPath) || entry.name;
            if (entry.isDirectory()) {
                const dumpSqlPath = path.join(fullPath, 'dump.sql');
                if (await pathExists(dumpSqlPath)) {
                    results.push({ label: relativeLabel, kind: 'folder', path: fullPath });
                }
                if (depth < maxDepth) {
                    stack.push({ dir: fullPath, depth: depth + 1 });
                }
            }
            else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
                results.push({ label: relativeLabel, kind: 'zip', path: fullPath });
            }
            else if (entry.isFile() && (entry.name.toLowerCase().endsWith('.sql') || entry.name.toLowerCase().endsWith('.gz'))) {
                results.push({ label: relativeLabel, kind: 'file', path: fullPath });
            }
        }
    }
    return results;
}
async function pathExists(target) {
    try {
        await fsp.access(target);
        return true;
    }
    catch {
        return false;
    }
}
function isToolchainUnavailableError(error) {
    const message = (0, logger_1.errorMessage)(error).toLowerCase();
    return message.includes('enoent')
        || message.includes('not found')
        || message.includes('failed to start unzip')
        || message.includes('failed to start gunzip');
}
function createProcessStream(child, label) {
    if (!child.stdout || !child.stderr) {
        throw new Error(`${label} process did not expose readable stdio streams.`);
    }
    const output = new node_stream_1.PassThrough();
    let stderr = '';
    child.stderr.on('data', chunk => {
        stderr += chunk.toString();
    });
    child.stdout.pipe(output);
    child.on('error', error => {
        output.destroy(new Error(`Failed to start ${label}: ${(0, logger_1.errorMessage)(error)}`));
    });
    child.on('close', code => {
        if (code !== 0) {
            const details = stderr.trim();
            output.destroy(new Error(`${label} exited with code ${code}${details ? `: ${details}` : ''}`));
        }
    });
    return {
        stream: output,
        dispose: () => {
            if (!child.killed) {
                child.kill('SIGTERM');
            }
            output.destroy();
        }
    };
}
function createCommandStream(command, args, label) {
    const child = (0, node_child_process_1.spawn)(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    return createProcessStream(child, label);
}
function createZipGzipStream(dumpPath, entry) {
    const unzipProcess = (0, node_child_process_1.spawn)('unzip', ['-p', dumpPath, entry], { stdio: ['ignore', 'pipe', 'pipe'] });
    const gunzipProcess = (0, node_child_process_1.spawn)('gunzip', ['-c'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = new node_stream_1.PassThrough();
    let unzipStderr = '';
    let gunzipStderr = '';
    unzipProcess.stderr.on('data', chunk => {
        unzipStderr += chunk.toString();
    });
    gunzipProcess.stderr.on('data', chunk => {
        gunzipStderr += chunk.toString();
    });
    unzipProcess.stdout.pipe(gunzipProcess.stdin);
    gunzipProcess.stdout.pipe(output);
    unzipProcess.on('error', error => {
        output.destroy(new Error(`Failed to start unzip: ${(0, logger_1.errorMessage)(error)}`));
    });
    gunzipProcess.on('error', error => {
        output.destroy(new Error(`Failed to start gunzip: ${(0, logger_1.errorMessage)(error)}`));
    });
    unzipProcess.on('close', code => {
        if (code !== 0) {
            const details = unzipStderr.trim();
            output.destroy(new Error(`unzip exited with code ${code}${details ? `: ${details}` : ''}`));
            if (!gunzipProcess.killed) {
                gunzipProcess.kill('SIGTERM');
            }
        }
    });
    gunzipProcess.on('close', code => {
        if (code !== 0) {
            const details = gunzipStderr.trim();
            output.destroy(new Error(`gunzip exited with code ${code}${details ? `: ${details}` : ''}`));
        }
    });
    return {
        stream: output,
        dispose: () => {
            if (!unzipProcess.killed) {
                unzipProcess.kill('SIGTERM');
            }
            if (!gunzipProcess.killed) {
                gunzipProcess.kill('SIGTERM');
            }
            output.destroy();
        }
    };
}
async function listZipEntries(dumpPath) {
    const { stdout } = await (0, process_1.runCommand)('unzip', ['-Z1', dumpPath]);
    return stdout.split('\n').map(line => line.trim()).filter(Boolean);
}
/** Prepares a dump source for import, preferring streaming pipelines. */
async function prepareDumpForImport(dumpPath) {
    if (dumpPath.endsWith('.zip')) {
        const entries = await listZipEntries(dumpPath);
        if (entries.length === 0) {
            throw new Error('Archive is empty.');
        }
        const sqlEntry = entries.find(entry => entry.toLowerCase().endsWith('.sql') && !entry.toLowerCase().endsWith('.sql.gz'));
        const gzEntry = entries.find(entry => entry.toLowerCase().endsWith('.sql.gz'));
        const selectedEntry = sqlEntry ?? gzEntry ?? entries[0];
        if (selectedEntry.toLowerCase().endsWith('.sql.gz')) {
            return {
                kind: 'stream',
                originalPath: dumpPath,
                progressMessage: 'Unzipping, decompressing, and importing dump archive...',
                openStream: () => createZipGzipStream(dumpPath, selectedEntry)
            };
        }
        return {
            kind: 'stream',
            originalPath: dumpPath,
            progressMessage: 'Unzipping and importing dump archive...',
            openStream: () => createCommandStream('unzip', ['-p', dumpPath, selectedEntry], 'unzip')
        };
    }
    if (dumpPath.endsWith('.gz')) {
        return {
            kind: 'stream',
            originalPath: dumpPath,
            progressMessage: 'Decompressing and importing dump file...',
            openStream: () => createCommandStream('gunzip', ['-c', dumpPath], 'gunzip')
        };
    }
    return {
        kind: 'file',
        originalPath: dumpPath,
        progressMessage: 'Importing dump file...',
        sqlPath: dumpPath
    };
}
async function importDumpStream(dbName, stream) {
    await new Promise((resolve, reject) => {
        const psqlProcess = (0, node_child_process_1.spawn)('psql', ['-d', dbName], { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        let settled = false;
        const finish = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            if (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            resolve();
        };
        psqlProcess.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });
        psqlProcess.on('error', error => {
            finish(new Error(`Failed to start psql: ${(0, logger_1.errorMessage)(error)}`));
        });
        psqlProcess.on('close', code => {
            if (code === 0) {
                finish();
                return;
            }
            const details = stderr.trim();
            finish(new Error(`psql exited with code ${code}${details ? `: ${details}` : ''}`));
        });
        stream.on('error', error => {
            if (!psqlProcess.killed) {
                psqlProcess.kill('SIGTERM');
            }
            finish(error);
        });
        psqlProcess.stdin.on('error', error => {
            const ioError = error;
            if (ioError.code !== 'EPIPE') {
                finish(error);
            }
        });
        stream.pipe(psqlProcess.stdin);
    });
}
/** Imports a prepared dump into `dbName` (file via psql -f, or streamed). */
async function importPreparedDump(dbName, preparedDump) {
    if (preparedDump.kind === 'file') {
        if (!preparedDump.sqlPath) {
            throw new Error('No dump path available for file-based import.');
        }
        await (0, process_1.runCommand)('psql', ['-d', dbName, '-q', '-f', preparedDump.sqlPath]);
        return;
    }
    if (!preparedDump.openStream) {
        throw new Error('No stream provider configured for this dump source.');
    }
    const openedStream = preparedDump.openStream();
    try {
        await importDumpStream(dbName, openedStream.stream);
    }
    finally {
        openedStream.dispose();
    }
}
async function extractStreamToFile(opened, targetPath) {
    try {
        await (0, promises_1.pipeline)(opened.stream, fs.createWriteStream(targetPath));
    }
    finally {
        opened.dispose();
    }
}
/**
 * Fallback used when the streaming pipeline is unavailable: extracts the dump
 * into a temporary SQL file and imports from there. The returned PreparedDump
 * owns the temp directory via cleanup().
 */
async function prepareDumpViaTempFile(dumpPath) {
    if (!dumpPath.endsWith('.zip') && !dumpPath.endsWith('.gz')) {
        return { kind: 'file', originalPath: dumpPath, sqlPath: dumpPath };
    }
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'odoo-dump-'));
    const tempSqlPath = path.join(tempDir, 'dump.sql');
    const cleanup = () => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        catch (cleanupError) {
            logger_1.logger.warn('Failed to cleanup temporary dump folder:', cleanupError);
        }
    };
    try {
        if (dumpPath.endsWith('.zip')) {
            const entries = await listZipEntries(dumpPath);
            if (entries.length === 0) {
                throw new Error('Archive is empty.');
            }
            const sqlEntry = entries.find(entry => entry.toLowerCase().endsWith('.sql') && !entry.toLowerCase().endsWith('.sql.gz'));
            const gzEntry = entries.find(entry => entry.toLowerCase().endsWith('.sql.gz'));
            if (sqlEntry) {
                await extractStreamToFile(createCommandStream('unzip', ['-p', dumpPath, sqlEntry], 'unzip'), tempSqlPath);
            }
            else if (gzEntry) {
                await extractStreamToFile(createZipGzipStream(dumpPath, gzEntry), tempSqlPath);
            }
            else {
                await extractStreamToFile(createCommandStream('unzip', ['-p', dumpPath], 'unzip'), tempSqlPath);
            }
        }
        else {
            await extractStreamToFile(createCommandStream('gunzip', ['-c', dumpPath], 'gunzip'), tempSqlPath);
        }
        return { kind: 'file', originalPath: dumpPath, sqlPath: tempSqlPath, cleanup };
    }
    catch (error) {
        cleanup();
        throw error;
    }
}


/***/ }),
/* 46 */
/***/ ((module) => {

module.exports = require("node:stream");

/***/ }),
/* 47 */
/***/ ((module) => {

module.exports = require("node:stream/promises");

/***/ }),
/* 48 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.TEMPLATE_DB_NAME_PATTERN = void 0;
exports.sanitizeDatabaseTemplates = sanitizeDatabaseTemplates;
exports.validateTemplateDatabaseName = validateTemplateDatabaseName;
exports.persistDatabaseTemplates = persistDatabaseTemplates;
const settingsStore_1 = __webpack_require__(6);
const utils_1 = __webpack_require__(8);
const postgres_1 = __webpack_require__(44);
/**
 * Database-template metadata management. A template is a PostgreSQL database
 * (cloned via `createdb -T`) plus a metadata record stored in the workspace
 * data file. `templateDbName` is the real PostgreSQL name; `name` is a label
 * kept in sync with it (legacy records that only carry `name` are healed on
 * load by sanitizeDatabaseTemplates).
 */
exports.TEMPLATE_DB_NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;
/** Normalizes raw stored/imported template records, deduping by DB name. */
function sanitizeDatabaseTemplates(source) {
    if (!Array.isArray(source)) {
        return [];
    }
    const seenTemplateDbNames = new Set();
    const normalized = [];
    for (const entry of source) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const candidate = entry;
        const templateDbName = typeof candidate.templateDbName === 'string'
            ? candidate.templateDbName.trim()
            : typeof candidate.name === 'string'
                ? candidate.name.trim()
                : '';
        if (!templateDbName) {
            continue;
        }
        const dedupeKey = templateDbName.toLowerCase();
        if (seenTemplateDbNames.has(dedupeKey)) {
            continue;
        }
        seenTemplateDbNames.add(dedupeKey);
        const name = typeof candidate.name === 'string' && candidate.name.trim() !== ''
            ? candidate.name.trim()
            : templateDbName;
        const sourceDbName = typeof candidate.sourceDbName === 'string' && candidate.sourceDbName.trim() !== ''
            ? candidate.sourceDbName.trim()
            : undefined;
        const createdAt = typeof candidate.createdAt === 'string' && candidate.createdAt.trim() !== ''
            ? candidate.createdAt
            : new Date().toISOString();
        const updatedAt = typeof candidate.updatedAt === 'string' && candidate.updatedAt.trim() !== ''
            ? candidate.updatedAt
            : undefined;
        normalized.push({
            name,
            templateDbName,
            sourceDbName,
            createdAt,
            updatedAt
        });
    }
    return normalized.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
/** Input validation for template PostgreSQL names. */
function validateTemplateDatabaseName(value, existingTemplateNames, originalName) {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return 'Template name cannot be empty.';
    }
    if (!exports.TEMPLATE_DB_NAME_PATTERN.test(trimmed)) {
        return 'Use letters, numbers, "-" or "_" only. The name must not start with "-".';
    }
    if (postgres_1.RESERVED_DATABASE_NAMES.has(trimmed.toLowerCase())) {
        return `"${trimmed}" is reserved and cannot be used as a template name.`;
    }
    const isRenamingSameTemplate = originalName && originalName.toLowerCase() === trimmed.toLowerCase();
    if (!isRenamingSameTemplate && existingTemplateNames.has(trimmed.toLowerCase())) {
        return 'A template with this PostgreSQL name already exists.';
    }
    return null;
}
/** Persists a normalized template list into the workspace data file. */
async function persistDatabaseTemplates(data, templates) {
    const normalized = sanitizeDatabaseTemplates(templates);
    data.dbTemplates = normalized;
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
    return normalized;
}


/***/ }),
/* 49 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.findStaleReferences = findStaleReferences;
exports.logStaleReferences = logStaleReferences;
const settingsStore_1 = __webpack_require__(6);
const postgres_1 = __webpack_require__(44);
const logger_1 = __webpack_require__(12);
/**
 * Returns references to PostgreSQL databases that no longer exist, or
 * undefined when PostgreSQL is unreachable (nothing can be verified then).
 */
async function findStaleReferences() {
    const existing = await (0, postgres_1.listPostgresDatabases)();
    if (existing.length === 0) {
        // psql unavailable or no databases at all: treat as unverifiable
        // rather than flagging everything as stale.
        return undefined;
    }
    const existingLower = new Set(existing.map(name => name.toLowerCase()));
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    const databases = [];
    for (const project of data.projects ?? []) {
        for (const db of project.dbs ?? []) {
            if (db?.id && !existingLower.has(db.id.toLowerCase())) {
                databases.push({ projectName: project.name, db });
            }
        }
    }
    const templates = (data.dbTemplates ?? []).filter(template => template.templateDbName && !existingLower.has(template.templateDbName.toLowerCase()));
    return { databases, templates };
}
/** Activation-time check: logs stale references, never prompts. */
async function logStaleReferences() {
    try {
        const stale = await findStaleReferences();
        if (!stale) {
            return;
        }
        const total = stale.databases.length + stale.templates.length;
        if (total === 0) {
            return;
        }
        logger_1.logger.warn(`${total} stored reference(s) point to PostgreSQL databases that no longer exist ` +
            `(${stale.databases.map(entry => entry.db.id).join(', ')}${stale.templates.length ? `; templates: ${stale.templates.map(t => t.templateDbName).join(', ')}` : ''}). ` +
            'Run "Reconcile Databases" from the Databases view to clean them up.');
    }
    catch (error) {
        logger_1.logger.debug('Stale-reference check failed:', error);
    }
}


/***/ }),
/* 50 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.mergeRunningInstances = mergeRunningInstances;
exports.getRunningInstances = getRunningInstances;
exports.runningDescriptionPart = runningDescriptionPart;
exports.invalidateRunningState = invalidateRunningState;
/**
 * Which Odoo databases are live right now, from two merged signals: the
 * extension's own debug sessions (authoritative for what it started) and a
 * pg_stat_activity probe (catches servers started from a terminal or another
 * window). Exists as a service, not tree-decoration logic, so later features -
 * split-view comparison of two running instances - share one state source.
 */
const settingsStore_1 = __webpack_require__(6);
const versionsService_1 = __webpack_require__(24);
const database_1 = __webpack_require__(42);
const debugSessions_1 = __webpack_require__(51);
const dbResolution_1 = __webpack_require__(40);
const runtimeCache_1 = __webpack_require__(15);
const logger_1 = __webpack_require__(12);
/**
 * One entry per database. A managed instance always wins: it knows the
 * version and port, which the external probe cannot report.
 */
function mergeRunningInstances(managed, external) {
    const byDb = new Map();
    for (const instance of external) {
        byDb.set(instance.dbName, instance);
    }
    for (const instance of managed) {
        byDb.set(instance.dbName, instance);
    }
    return Array.from(byDb.values());
}
/** Sessions this extension started, resolved to the database each runs. */
async function collectManaged() {
    const names = new Set((0, debugSessions_1.runningDebuggerNames)());
    if (names.size === 0) {
        return [];
    }
    // Read without getSelectedProject(): this runs on every tree refresh and
    // that helper toasts when no project is selected.
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json').catch(() => undefined);
    const project = data?.projects?.find(entry => entry.isSelected);
    const dbs = project?.dbs ?? [];
    const selectedDbByVersion = project?.selectedDbByVersion;
    const instances = [];
    for (const version of versionsService_1.VersionsService.getInstance().getVersions()) {
        const debuggerName = version.settings?.debuggerName;
        if (!debuggerName || !names.has(debuggerName)) {
            continue;
        }
        const db = (0, dbResolution_1.resolveDbForVersion)(dbs, selectedDbByVersion, version.id);
        if (!db) {
            continue;
        }
        instances.push({
            versionId: version.id,
            debuggerName,
            dbName: db.id,
            port: Number(version.settings.portNumber) || undefined,
            origin: 'managed'
        });
    }
    return instances;
}
async function getRunningInstances() {
    try {
        const [managed, activeNames] = await Promise.all([collectManaged(), (0, database_1.getActiveDatabaseNames)()]);
        const external = activeNames.map(dbName => ({ dbName, origin: 'external' }));
        return mergeRunningInstances(managed, external);
    }
    catch (error) {
        logger_1.logger.debug('Could not resolve running instances:', error);
        return [];
    }
}
/**
 * The running marker for a database row, as plain text. TreeItem.description
 * does not render codicons - unlike a QuickPickItem - so state is carried by
 * words here, leaving the row's icon free to keep showing selection.
 */
function runningDescriptionPart(instance) {
    if (!instance) {
        return undefined;
    }
    if (instance.origin === 'external') {
        return 'running (external)';
    }
    return instance.port ? `running :${instance.port}` : 'running';
}
/** Drops the cached PostgreSQL probe so the next read is fresh. */
function invalidateRunningState() {
    (0, runtimeCache_1.invalidateActiveDatabasesCache)();
}


/***/ }),
/* 51 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.trackSession = trackSession;
exports.untrackSession = untrackSession;
exports.getSessionByName = getSessionByName;
exports.runningDebuggerNames = runningDebuggerNames;
exports.anySessionRunning = anySessionRunning;
exports.clearSessions = clearSessions;
exports.resolveStopTarget = resolveStopTarget;
const sessions = new Map();
function nameOf(session) {
    const name = session.configuration?.name;
    return typeof name === 'string' && name.length > 0 ? name : undefined;
}
function trackSession(session) {
    const name = nameOf(session);
    if (name) {
        sessions.set(name, session);
    }
}
function untrackSession(session) {
    const name = nameOf(session);
    if (name) {
        sessions.delete(name);
    }
}
function getSessionByName(name) {
    return sessions.get(name);
}
function runningDebuggerNames() {
    return Array.from(sessions.keys());
}
function anySessionRunning() {
    return sessions.size > 0;
}
/** Test seam: the registry is module state that outlives a single suite. */
function clearSessions() {
    sessions.clear();
}
/**
 * What "Stop Server" should act on. The active version's session wins
 * outright; otherwise a lone session is unambiguous and anything else needs
 * the user to choose.
 */
function resolveStopTarget(running, activeName) {
    if (running.length === 0) {
        return { kind: 'none' };
    }
    if (activeName && running.includes(activeName)) {
        return { kind: 'single', name: activeName };
    }
    if (running.length === 1) {
        return { kind: 'single', name: running[0] };
    }
    return { kind: 'prompt', names: [...running] };
}


/***/ }),
/* 52 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.collectLegacyBranchesNeedingVersions = collectLegacyBranchesNeedingVersions;
exports.applyDatabaseFieldMigration = applyDatabaseFieldMigration;
exports.migrateDebuggerData = migrateDebuggerData;
exports.applyHookMigration = applyHookMigration;
exports.migrateHookSettings = migrateHookSettings;
const vscode = __importStar(__webpack_require__(1));
const settingsStore_1 = __webpack_require__(6);
const versionsService_1 = __webpack_require__(24);
const version_1 = __webpack_require__(25);
const utils_1 = __webpack_require__(8);
const logger_1 = __webpack_require__(12);
const notifications_1 = __webpack_require__(16);
/** Branch names that denote a real Odoo series, e.g. "17.0", "saas-17.4", "master". */
const ODOO_SERIES_PATTERN = /^((saas-)?\d+(\.\d+)?|master)$/i;
function findMatchingVersionId(versions, branch) {
    return versions.find(version => version?.odooVersion === branch)?.id;
}
/**
 * Finds legacy per-database branches that still drive branch switching but
 * have no version profile to carry them. These need a profile created so the
 * database keeps switching branches after the migration removes the legacy
 * field. Pure function for unit testing.
 */
function collectLegacyBranchesNeedingVersions(data) {
    const versions = Object.values(data.versions ?? {});
    const branches = new Set();
    for (const project of data.projects ?? []) {
        for (const db of project.dbs ?? []) {
            if (!db || typeof db !== 'object' || db.versionId) {
                continue;
            }
            const legacyBranch = typeof db.odooVersion === 'string' ? db.odooVersion.trim() : '';
            if (legacyBranch && ODOO_SERIES_PATTERN.test(legacyBranch) && !findMatchingVersionId(versions, legacyBranch)) {
                branches.add(legacyBranch);
            }
        }
    }
    return Array.from(branches);
}
/**
 * Folds the legacy per-database `odooVersion` field into the current model:
 * link the database to the Version whose branch matches, otherwise keep the
 * string as the display label. Returns true when anything changed.
 *
 * Pure transform so it can be unit-tested without VS Code.
 */
function applyDatabaseFieldMigration(data) {
    let changed = false;
    const versions = Object.values(data.versions ?? {});
    for (const project of data.projects ?? []) {
        for (const db of project.dbs ?? []) {
            if (!db || typeof db !== 'object' || !('odooVersion' in db)) {
                continue;
            }
            const legacyBranch = typeof db.odooVersion === 'string' ? db.odooVersion.trim() : '';
            if (legacyBranch && !db.versionId) {
                const matchId = findMatchingVersionId(versions, legacyBranch);
                if (matchId) {
                    db.versionId = matchId;
                }
                else if (!db.branchName) {
                    db.branchName = legacyBranch;
                }
            }
            delete db.odooVersion;
            changed = true;
        }
    }
    return changed;
}
/**
 * One-time, non-fatal migration of odoo-debugger-data.json to the v1.2 shape.
 * Runs at activation after the legacy-settings migration and after the tree
 * providers are constructed (so the versions-changed refresh command exists).
 */
async function migrateDebuggerData() {
    try {
        const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
        // Legacy branches with no profile keep driving branch switching only
        // through a version, so create the missing profiles first.
        const missingBranches = collectLegacyBranchesNeedingVersions(data);
        if (missingBranches.length > 0) {
            data.versions = data.versions ?? {};
            for (const branch of missingBranches) {
                const version = new version_1.VersionModel(`Odoo ${branch}`, branch, (0, utils_1.getDefaultVersionSettings)());
                data.versions[version.id] = version.toJSON();
            }
        }
        const changed = applyDatabaseFieldMigration(data);
        const hookResult = applyHookMigration(data);
        const droppedFromSettings = await migrateHookSettings();
        const dropped = [...new Set([...hookResult.droppedCommands, ...droppedFromSettings])];
        if (dropped.length > 0) {
            // Named explicitly: a pre-checkout guard has no post-switch
            // equivalent, so the user has to decide whether it still applies.
            void (0, notifications_1.showWarning)(`Pre-checkout commands are no longer supported and were removed: ${dropped.map(command => `"${command}"`).join(', ')}. ` +
                'They ran before a branch switch; there is no longer one to run before. ' +
                'Add them to postSwitchCommands only if they still make sense after the switch.');
        }
        if (changed || hookResult.changed || missingBranches.length > 0) {
            // Save as-is (no settings strip): if the legacy-settings migration
            // has not run yet, its data must survive this write.
            await settingsStore_1.SettingsStore.saveWithoutComments(data);
        }
        if (missingBranches.length > 0) {
            // Reload the in-memory versions so the new profiles are usable now.
            await versionsService_1.VersionsService.getInstance().refresh();
        }
    }
    catch (error) {
        logger_1.logger.warn('Debugger data migration skipped:', error);
    }
}
/**
 * Migrates the legacy hook arrays onto `postSwitchCommands`.
 *
 * `postCheckoutCommands` is renamed; `preCheckoutCommands` is **dropped**, not
 * moved. A pre-checkout entry guards a checkout that is about to happen - the
 * canonical one is `git restore .`, clearing the way so the switch can proceed.
 * Running that after the switch does not guard anything; it discards work. The
 * dropped commands are reported so the caller can tell the user what to re-add
 * if they still want it.
 */
function applyHookMigration(data) {
    let changed = false;
    const dropped = new Set();
    for (const version of Object.values(data.versions ?? {})) {
        const settings = version?.settings;
        if (!settings || typeof settings !== 'object') {
            continue;
        }
        const hasPre = 'preCheckoutCommands' in settings;
        const hasPost = 'postCheckoutCommands' in settings;
        if (!hasPre && !hasPost) {
            continue;
        }
        const post = Array.isArray(settings.postCheckoutCommands) ? settings.postCheckoutCommands : [];
        const existing = Array.isArray(settings.postSwitchCommands) ? settings.postSwitchCommands : [];
        if (Array.isArray(settings.preCheckoutCommands)) {
            for (const command of settings.preCheckoutCommands) {
                if (typeof command === 'string' && command.trim()) {
                    dropped.add(command);
                }
            }
        }
        settings.postSwitchCommands = [...post, ...existing];
        delete settings.preCheckoutCommands;
        delete settings.postCheckoutCommands;
        changed = true;
    }
    return { changed, droppedCommands: [...dropped] };
}
/**
 * The settings half of the same migration. `odooDebugger.defaultVersion.`
 * `postCheckoutCommands` becomes `postSwitchCommands` in whichever scope
 * defines it, and `preCheckoutCommands` is removed - following the write-back
 * pattern used by migrateLegacySwitchBehaviorSetting.
 */
async function migrateHookSettings() {
    const dropped = new Set();
    try {
        const config = vscode.workspace.getConfiguration('odooDebugger.defaultVersion');
        const scopes = (inspection) => [
            [inspection?.globalValue, vscode.ConfigurationTarget.Global],
            [inspection?.workspaceValue, vscode.ConfigurationTarget.Workspace],
            [inspection?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder]
        ];
        const post = config.inspect('postCheckoutCommands');
        for (const [value, target] of scopes(post)) {
            if (!Array.isArray(value)) {
                continue;
            }
            const existing = config.inspect('postSwitchCommands');
            const alreadySet = [existing?.globalValue, existing?.workspaceValue, existing?.workspaceFolderValue]
                .some(entry => Array.isArray(entry) && entry.length > 0);
            if (!alreadySet && value.length > 0) {
                await config.update('postSwitchCommands', value, target);
            }
            await config.update('postCheckoutCommands', undefined, target);
        }
        const pre = config.inspect('preCheckoutCommands');
        for (const [value, target] of scopes(pre)) {
            if (!Array.isArray(value)) {
                continue;
            }
            value.filter(command => typeof command === 'string' && command.trim()).forEach(command => dropped.add(command));
            await config.update('preCheckoutCommands', undefined, target);
        }
    }
    catch (error) {
        logger_1.logger.warn('Failed to migrate checkout hook settings:', error);
    }
    return [...dropped];
}


/***/ }),
/* 53 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ProjectTreeProvider = void 0;
exports.detectProjectTickets = detectProjectTickets;
exports.createProject = createProject;
exports.selectProject = selectProject;
exports.getRepo = getRepo;
exports.getProjectName = getProjectName;
exports.deleteProject = deleteProject;
exports.duplicateProject = duplicateProject;
exports.editProjectSettings = editProjectSettings;
exports.manageProjectTickets = manageProjectTickets;
exports.openProjectTicket = openProjectTicket;
exports.exportProject = exportProject;
exports.importProject = importProject;
exports.quickProjectSearch = quickProjectSearch;
/**
 * Projects view and project lifecycle: create/select/delete/duplicate,
 * import/export, ticket management and quick project search.
 */
const vscode = __importStar(__webpack_require__(1));
const os = __importStar(__webpack_require__(54));
const project_1 = __webpack_require__(55);
const repo_1 = __webpack_require__(57);
const utils_1 = __webpack_require__(8);
const icons_1 = __webpack_require__(30);
const settingsStore_1 = __webpack_require__(6);
const versionsService_1 = __webpack_require__(24);
const crypto_1 = __webpack_require__(26);
const environment_1 = __webpack_require__(31);
const sortOptions_1 = __webpack_require__(29);
const logger_1 = __webpack_require__(12);
const notifications_1 = __webpack_require__(16);
const notifications_2 = __webpack_require__(16);
const baseTreeProvider_1 = __webpack_require__(5);
const branches_1 = __webpack_require__(32);
const manifest_1 = __webpack_require__(58);
const psaeInternal_1 = __webpack_require__(59);
let projectMetadataMigrationCompleted = false;
function sanitizeProjectTickets(rawTickets) {
    if (!Array.isArray(rawTickets)) {
        return [];
    }
    const result = [];
    const seen = new Set();
    for (const rawTicket of rawTickets) {
        const id = (rawTicket?.id ?? '').toString().trim();
        if (!id) {
            continue;
        }
        const normalized = id.toLowerCase();
        if (seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        const title = typeof rawTicket?.title === 'string' ? rawTicket.title.trim() : '';
        result.push({
            id,
            title: title || undefined
        });
    }
    return result;
}
function resolveTicketBaseUrl() {
    const configured = vscode.workspace.getConfiguration('odooDebugger').get('ticketBaseUrl', 'https://www.odoo.com') ?? 'https://www.odoo.com';
    const trimmed = configured.trim();
    if (!trimmed) {
        return 'https://www.odoo.com';
    }
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return withScheme.replace(/\/+$/, '');
}
function buildTicketUrl(ticketId) {
    const baseUrl = resolveTicketBaseUrl();
    return `${baseUrl}/odoo/all-tasks/${encodeURIComponent(ticketId)}`;
}
function formatTicketLabel(ticket) {
    return ticket.title ? `${ticket.id} - ${ticket.title}` : ticket.id;
}
/**
 * Scans the project's repo branches and module manifests for ticket/task ids
 * (Odoo PS conventions) and offers to add the new ones to the project.
 */
async function detectProjectTickets() {
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    project.tickets = sanitizeProjectTickets(project.tickets);
    const known = new Set(project.tickets.map(ticket => ticket.id.toLowerCase()));
    const candidates = new Map();
    const offer = (id, source) => {
        if (!known.has(id.toLowerCase()) && !candidates.has(id)) {
            candidates.set(id, source);
        }
    };
    for (const repo of project.repos ?? []) {
        const branch = await (0, branches_1.getRepoBranch)((0, utils_1.normalizePath)(repo.path));
        for (const id of (0, manifest_1.extractTicketIdsFromBranch)(branch)) {
            offer(id, `branch "${branch}" (${repo.name})`);
        }
    }
    const discovery = (0, psaeInternal_1.collectModuleDiscovery)(project);
    for (const module of discovery.modules) {
        const manifest = await (0, manifest_1.readModuleManifest)(module.path);
        for (const id of manifest?.ticketIds ?? []) {
            offer(id, `manifest of "${module.name}"`);
        }
    }
    if (candidates.size === 0) {
        (0, utils_1.showAutoInfo)('No new ticket ids found in repo branches or module manifests.', 3000);
        return;
    }
    const picks = Array.from(candidates.entries()).map(([id, source]) => ({
        label: id,
        description: `Found in ${source}`,
        picked: true,
        id
    }));
    const chosen = await vscode.window.showQuickPick(picks, {
        canPickMany: true,
        placeHolder: 'Add detected ticket ids to the project?',
        ignoreFocusOut: true
    });
    if (!chosen || chosen.length === 0) {
        return;
    }
    project.tickets.push(...chosen.map(pick => ({ id: pick.id })));
    project.tickets = sanitizeProjectTickets(project.tickets);
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
    const action = await (0, utils_1.showInfo)(`Added ${chosen.length} ticket(s) to "${project.name}".`, 'Open Ticket');
    if (action === 'Open Ticket') {
        await vscode.commands.executeCommand('projectSelector.openTicket');
    }
}
class ProjectTreeProvider extends baseTreeProvider_1.BaseTreeProvider {
    sortPreferences;
    constructor(_context, sortPreferences) {
        super();
        this.sortPreferences = sortPreferences;
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren(_element) {
        const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
        if (!data) {
            return [];
        }
        // Empty list: the view's welcome content offers "Create Project".
        const projects = data.projects;
        if (!projects) {
            return [];
        }
        if (!projectMetadataMigrationCompleted) {
            // Ensure project metadata migration happens only once per session.
            const needsSave = await ensureProjectUIDs(data);
            if (needsSave) {
                await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
            }
            projectMetadataMigrationCompleted = true;
        }
        const sortId = this.sortPreferences.get('projectSelector', (0, sortOptions_1.getDefaultSortOption)('projectSelector'));
        const sortedProjects = [...projects].sort((a, b) => this.compareProjects(a, b, sortId));
        return sortedProjects.map(project => {
            const treeItem = new vscode.TreeItem(project.name);
            treeItem.id = project.uid; // Use UID instead of name for uniqueness
            treeItem.iconPath = project.isSelected ? icons_1.activeIcon : new vscode.ThemeIcon('folder');
            treeItem.description = `${project.repos?.length ?? 0} repos • ${project.dbs?.length ?? 0} dbs`;
            treeItem.tooltip = this.buildProjectTooltip(project);
            // Set context value for menu commands
            treeItem.contextValue = 'project';
            treeItem.command = {
                command: 'projectSelector.selectProject',
                title: 'Select Project',
                arguments: [project.uid] // Pass just the UID instead of the whole object
            };
            // Store the project UID in a custom property for easier access
            treeItem.projectUid = project.uid;
            return treeItem;
        });
    }
    buildProjectTooltip(project) {
        const lines = [`**${project.name}**${project.isSelected ? ' (active)' : ''}`];
        const repos = project.repos ?? [];
        if (repos.length > 0) {
            const shown = repos.slice(0, 8).map(repo => `- ${repo.name}`);
            if (repos.length > 8) {
                shown.push(`- … ${repos.length - 8} more`);
            }
            lines.push(`**Repositories (${repos.length}):**\n${shown.join('\n')}`);
        }
        else {
            lines.push('**Repositories:** none');
        }
        const dbs = project.dbs ?? [];
        const selectedDb = dbs.find(db => db.isSelected);
        lines.push(`**Databases:** ${dbs.length}${selectedDb ? ` (active: ${(0, utils_1.getDatabaseLabel)(selectedDb)})` : ''}`);
        if (project.tickets && project.tickets.length > 0) {
            lines.push(`**Tickets:** ${project.tickets.length}`);
        }
        if (project.testingConfig?.isEnabled) {
            lines.push('**Testing mode:** enabled');
        }
        const created = project.createdAt ? new Date(project.createdAt) : undefined;
        if (created && !Number.isNaN(created.getTime())) {
            lines.push(`**Created:** ${created.toISOString().split('T')[0]}`);
        }
        return new vscode.MarkdownString(lines.join('\n\n'));
    }
    compareProjects(a, b, sortId) {
        const activeDelta = Number(b.isSelected) - Number(a.isSelected);
        if (activeDelta !== 0) {
            return activeDelta;
        }
        switch (sortId) {
            case 'project:name:asc':
                return a.name.localeCompare(b.name);
            case 'project:name:desc':
                return b.name.localeCompare(a.name);
            case 'project:created:newest':
                return this.getProjectTimestamp(b) - this.getProjectTimestamp(a);
            case 'project:created:oldest':
                return this.getProjectTimestamp(a) - this.getProjectTimestamp(b);
            default:
                return a.name.localeCompare(b.name);
        }
    }
    getProjectTimestamp(project) {
        const value = project.createdAt instanceof Date ? project.createdAt : new Date(project.createdAt);
        const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
        return isNaN(timestamp) ? 0 : timestamp;
    }
}
exports.ProjectTreeProvider = ProjectTreeProvider;
async function createProject(name, repos, db) {
    // Get current data first to check for existing selected projects
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    if (!data.projects) {
        data.projects = [];
    }
    else {
        // Deselect any currently selected project if there are existing projects
        const currentSelectedIndex = data.projects.findIndex((p) => p.isSelected);
        if (currentSelectedIndex !== -1) {
            data.projects[currentSelectedIndex].isSelected = false;
        }
    }
    let project;
    if (!db) {
        project = new project_1.ProjectModel(name, new Date(), [], repos, true, (0, crypto_1.randomUUID)(), []);
    }
    else {
        project = new project_1.ProjectModel(name, new Date(), [db], repos, true, (0, crypto_1.randomUUID)(), []);
    }
    // Add the new project to the array
    data.projects.push(project);
    // Save the entire updated data
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
    // Environment alignment happens when the database is selected right after
    // creation, so no branch switching is needed here.
    const databaseMessage = db ? ` and database ${(0, utils_1.getDatabaseLabel)(db)}` : '';
    (0, utils_1.showAutoInfo)(`Created project "${project.name}" with ${repos.length} repositories${databaseMessage}`, 4000); // Force a small delay to ensure data is persisted before refresh
    await new Promise(resolve => setTimeout(resolve, 100));
}
async function ensureProjectUIDs(data) {
    let needsSave = false;
    if (data.projects && Array.isArray(data.projects)) {
        for (const project of data.projects) {
            if (!project.uid) {
                project.uid = (0, crypto_1.randomUUID)();
                needsSave = true;
            }
            // Migration: Add includedPsaeInternalPaths field if it doesn't exist
            if (project.includedPsaeInternalPaths === undefined) {
                project.includedPsaeInternalPaths = [];
                needsSave = true;
            }
            const originalTickets = Array.isArray(project.tickets) ? project.tickets : [];
            const sanitizedTickets = sanitizeProjectTickets(originalTickets);
            if (JSON.stringify(originalTickets) !== JSON.stringify(sanitizedTickets)) {
                needsSave = true;
            }
            project.tickets = sanitizedTickets;
            if (!project.createdAt) {
                project.createdAt = new Date().toISOString();
                needsSave = true;
            }
            else if (project.createdAt instanceof Date) {
                project.createdAt = project.createdAt.toISOString();
                needsSave = true;
            }
            if (Array.isArray(project.repos)) {
                for (const repo of project.repos) {
                    if (!repo.addedAt) {
                        repo.addedAt = project.createdAt || new Date().toISOString();
                        needsSave = true;
                    }
                }
            }
        }
    }
    return needsSave;
}
async function selectProject(projectUid) {
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    const projects = data.projects;
    if (!projects) {
        void (0, utils_1.showError)('Unable to load projects.');
        return;
    }
    // Ensure all projects have UIDs (migration for existing data)
    const needsSave = await ensureProjectUIDs(data);
    if (needsSave) {
        await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
    }
    // Find and deselect the currently selected project
    const oldSelectedIndex = projects.findIndex((p) => p.isSelected);
    if (oldSelectedIndex !== -1) {
        await settingsStore_1.SettingsStore.saveWithComments(false, ["projects", oldSelectedIndex, "isSelected"], 'odoo-debugger-data.json');
    }
    // Find and select the new project by UID
    const newSelectedIndex = projects.findIndex((p) => p.uid === projectUid);
    if (newSelectedIndex !== -1) {
        await settingsStore_1.SettingsStore.saveWithComments(true, ["projects", newSelectedIndex, "isSelected"], 'odoo-debugger-data.json');
        // Get the newly selected project
        const selectedProject = projects[newSelectedIndex];
        // Align the workbench to the project's selected database, if any.
        const selectedDb = selectedProject.dbs?.find((db) => db.isSelected);
        if (selectedDb) {
            await (0, environment_1.alignEnvironment)((0, environment_1.buildDatabaseEnvironmentTarget)(selectedDb, selectedProject.repos ?? []), { label: `Project "${selectedProject.name}"` });
        }
        void (0, utils_1.showInfo)(`Project switched to: ${selectedProject.name}`);
        // Force a small delay and refresh to ensure UI is updated
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    else {
        void (0, utils_1.showError)('The selected project could not be found.');
    }
}
async function getRepo(targetPath, searchFilter) {
    const devsRepos = (0, utils_1.findRepositories)(targetPath);
    if (devsRepos.length === 0) {
        void (0, utils_1.showInfo)('No repositories found in the custom-addons path.');
        throw new Error('No repositories found in the custom-addons path.');
    }
    // Show QuickPick with both name and path as label and description
    const quickPickItems = devsRepos.map(entry => ({
        label: entry.name,
        description: entry.path
    }));
    // Filter and sort items if search filter is provided
    let itemsToShow = quickPickItems;
    if (searchFilter && searchFilter.trim() !== '') {
        const filterTerm = searchFilter.toLowerCase();
        // Separate exact matches, partial matches, and no matches for sorting
        const exactMatches = quickPickItems.filter(item => item.label.toLowerCase() === filterTerm);
        const partialMatches = quickPickItems.filter(item => item.label.toLowerCase().includes(filterTerm) &&
            item.label.toLowerCase() !== filterTerm);
        const noMatches = quickPickItems.filter(item => !item.label.toLowerCase().includes(filterTerm));
        // Show exact matches first, then partial matches, then everything else
        itemsToShow = [...exactMatches, ...partialMatches, ...noMatches];
    }
    const selectedItems = await vscode.window.showQuickPick(itemsToShow, {
        placeHolder: searchFilter
            ? `Select folders from custom-addons (showing "${searchFilter}" matches first)`
            : 'Select a folder from custom-addons',
        canPickMany: true,
        matchOnDescription: true,
        matchOnDetail: true
    });
    if (selectedItems) {
        return selectedItems.map(item => {
            return new repo_1.RepoModel(item.label, item.description, true);
        });
    }
    else {
        void (0, utils_1.showError)("Select at least one folder to continue.");
        throw new Error("Select at least one folder to continue.");
    }
}
async function getProjectName(_workspaceFolder) {
    const name = await vscode.window.showInputBox({
        prompt: "Enter a name for your new project",
        title: "Project Name",
        placeHolder: "e.g., My Odoo Project"
    });
    if (!name) {
        void (0, utils_1.showError)('Enter a project name to continue.');
        throw new Error('Enter a project name to continue.');
    }
    return name;
}
async function deleteProject(event) {
    // Handle different types of event data:
    // 1. Direct project object (with uid property)
    // 2. Tree item from context menu (with id property containing the uid)
    // 3. String uid directly
    let projectUid;
    if (typeof event === 'string') {
        // Direct UID string
        projectUid = event;
    }
    else if (event && event.uid) {
        // Project object
        projectUid = event.uid;
    }
    else if (event && event.id) {
        // Tree item from context menu
        projectUid = event.id;
    }
    else if (event && event.projectUid) {
        // Tree item with custom projectUid property
        projectUid = event.projectUid;
    }
    else {
        void (0, utils_1.showError)('The project data is invalid for deletion');
        return;
    }
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    const projects = data.projects;
    if (!projects) {
        void (0, utils_1.showError)('Unable to load projects.');
        return;
    }
    // Find the project index in the array by UID
    const projectIndex = projects.findIndex((p) => p.uid === projectUid);
    if (projectIndex !== -1) {
        const projectToDelete = projects[projectIndex];
        // Ask for confirmation
        const confirm = await (0, notifications_2.showModalWarning)(`Are you sure you want to delete the project "${projectToDelete.name}"?`, 'Delete');
        if (confirm !== 'Delete') {
            return; // User cancelled
        }
        // Remove the project from the array and save the updated data
        data.projects.splice(projectIndex, 1);
        await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
        void (0, utils_1.showInfo)(`Project "${projectToDelete.name}" deleted successfully`);
        // If the deleted project was selected and there are other projects, select the first one
        if (projectToDelete.isSelected && data.projects.length > 0) {
            // Use the command to properly select the first project
            await vscode.commands.executeCommand('projectSelector.selectProject', data.projects[0].uid);
        }
    }
    else {
        void (0, utils_1.showError)('The selected project could not be found. It may have already been deleted.');
    }
}
async function duplicateProject(event) {
    // Get project UID from event
    let projectUid;
    if (typeof event === 'string') {
        projectUid = event;
    }
    else if (event && event.uid) {
        projectUid = event.uid;
    }
    else if (event && event.id) {
        projectUid = event.id;
    }
    else if (event && event.projectUid) {
        projectUid = event.projectUid;
    }
    else {
        void (0, utils_1.showError)('The project data is invalid.');
        return;
    }
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    const projects = data.projects;
    if (!projects) {
        void (0, utils_1.showError)('Unable to load projects.');
        return;
    }
    const projectIndex = projects.findIndex((p) => p.uid === projectUid);
    if (projectIndex === -1) {
        void (0, utils_1.showError)('The selected project could not be found.');
        return;
    }
    const sourceProject = projects[projectIndex];
    // Get a new name for the duplicate
    const duplicateName = await vscode.window.showInputBox({
        prompt: 'Enter a name for the duplicate project',
        value: `${sourceProject.name} - Copy`,
        ignoreFocusOut: true
    });
    if (!duplicateName) {
        return; // User cancelled
    }
    // Check if name already exists
    if (projects.some(p => p.name === duplicateName)) {
        void (0, utils_1.showError)('A project with this name already exists. Choose a different name.');
        return;
    }
    // Deselect all projects
    projects.forEach(p => p.isSelected = false);
    // Create duplicate project
    const duplicateProject = new project_1.ProjectModel(duplicateName, new Date(), [...sourceProject.dbs], // Copy databases array
    [...sourceProject.repos], // Copy repositories array
    true, // Set as selected
    (0, crypto_1.randomUUID)(), // New unique ID
    [...(sourceProject.includedPsaeInternalPaths || [])], // Copy included psae-internal paths
    sourceProject.testingConfig, [...sanitizeProjectTickets(sourceProject.tickets)] // Copy project tickets
    );
    projects.push(duplicateProject);
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
    void (0, utils_1.showInfo)(`Project "${duplicateName}" created as a duplicate of "${sourceProject.name}"`);
}
async function getProjectContextFromEvent(event) {
    let projectUid;
    if (typeof event === 'string') {
        projectUid = event;
    }
    else if (event && event.uid) {
        projectUid = event.uid;
    }
    else if (event && event.id) {
        projectUid = event.id;
    }
    else if (event && event.projectUid) {
        projectUid = event.projectUid;
    }
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    const projects = data.projects ?? [];
    if (projects.length === 0) {
        void (0, utils_1.showError)('No projects are configured.');
        return null;
    }
    if (!projectUid) {
        const selectedProject = projects.find((p) => p.isSelected);
        if (!selectedProject) {
            void (0, utils_1.showError)('Select a project first.');
            return null;
        }
        projectUid = selectedProject.uid;
    }
    const projectIndex = projects.findIndex((p) => p.uid === projectUid);
    if (projectIndex === -1) {
        void (0, utils_1.showError)('The selected project could not be found.');
        return null;
    }
    const project = projects[projectIndex];
    project.tickets = sanitizeProjectTickets(project.tickets);
    return { data, project, projectIndex };
}
async function editProjectSettings(event) {
    const context = await getProjectContextFromEvent(event);
    if (!context) {
        return;
    }
    const { project, data } = context;
    // Show project settings options
    const settingsOptions = [
        {
            label: "Edit Project Name",
            description: `Current: ${project.name}`,
            detail: "Change the display name of this project",
            action: 'editName'
        },
        {
            label: "View Project Info",
            description: `Created: ${new Date(project.createdAt).toLocaleDateString()}`,
            detail: "View detailed project information",
            action: 'viewInfo'
        },
        {
            label: "Manage Tickets",
            description: `${project.tickets?.length ?? 0} ticket(s) linked`,
            detail: "Add, edit, and remove project ticket references",
            action: 'manageTickets'
        },
        {
            label: "Open Ticket",
            description: `Open a ticket in ${resolveTicketBaseUrl()}`,
            detail: "Choose and open a linked ticket in your browser",
            action: 'openTicket'
        }
    ];
    const selectedOption = await vscode.window.showQuickPick(settingsOptions, {
        placeHolder: `Edit settings for project "${project.name}"`,
        ignoreFocusOut: true
    });
    if (!selectedOption) {
        return; // User cancelled
    }
    switch (selectedOption.action) {
        case 'editName':
            await editProjectName(project, data);
            break;
        case 'viewInfo':
            await viewProjectInfo(project);
            break;
        case 'manageTickets':
            await manageProjectTicketsForProject(project, data);
            break;
        case 'openTicket':
            await openProjectTicket(project.uid);
            break;
    }
}
async function editProjectName(project, data) {
    const newName = await vscode.window.showInputBox({
        prompt: 'Enter new project name',
        value: project.name,
        placeHolder: 'e.g., My Updated Project',
        ignoreFocusOut: true,
        validateInput: (value) => {
            if (!value || value.trim().length === 0) {
                return 'Project name cannot be empty';
            }
            // Check if name already exists (excluding current project)
            const existingProject = data.projects.find((p) => p.name === value.trim() && p.uid !== project.uid);
            if (existingProject) {
                return 'A project with this name already exists. Choose a different name.';
            }
            return null;
        }
    });
    if (newName && newName.trim() !== project.name) {
        const oldName = project.name;
        project.name = newName.trim();
        await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
        void (0, utils_1.showInfo)(`Project renamed from "${oldName}" to "${project.name}"`);
    }
}
async function manageProjectTicketsForProject(project, data) {
    while (true) {
        project.tickets = sanitizeProjectTickets(project.tickets);
        const tickets = project.tickets;
        const ticketOptions = [
            {
                label: '$(add) Add Ticket',
                detail: 'Add a ticket ID and optional short title/description',
                action: 'add'
            },
            {
                label: '$(link-external) Open Ticket',
                description: tickets.length > 0 ? `${tickets.length} saved ticket(s)` : 'No tickets saved yet',
                detail: `Open a linked ticket in ${resolveTicketBaseUrl()}`,
                action: 'open'
            },
            {
                label: '$(edit) Edit Ticket',
                description: tickets.length > 0 ? `${tickets.length} saved ticket(s)` : 'No tickets to edit',
                action: 'edit'
            },
            {
                label: '$(trash) Remove Ticket',
                description: tickets.length > 0 ? `${tickets.length} saved ticket(s)` : 'No tickets to remove',
                action: 'remove'
            },
            {
                label: '$(check) Done',
                action: 'done'
            }
        ];
        const selectedAction = await vscode.window.showQuickPick(ticketOptions, {
            placeHolder: `Manage tickets for project "${project.name}"`,
            ignoreFocusOut: true
        });
        if (!selectedAction || selectedAction.action === 'done') {
            return;
        }
        if (selectedAction.action === 'open') {
            await openProjectTicket(project.uid);
            continue;
        }
        if (selectedAction.action === 'add') {
            const ticketIdInput = await vscode.window.showInputBox({
                prompt: 'Enter ticket ID',
                placeHolder: 'e.g. 123456 or OPW-1234567',
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'Ticket ID cannot be empty';
                    }
                    const exists = tickets.some(ticket => ticket.id.toLowerCase() === value.trim().toLowerCase());
                    if (exists) {
                        return 'This ticket ID is already linked to the project';
                    }
                    return null;
                }
            });
            if (ticketIdInput === undefined) {
                continue;
            }
            const ticketTitleInput = await vscode.window.showInputBox({
                prompt: 'Enter ticket name/short description (optional)',
                placeHolder: 'e.g. Fix onboarding flow',
                ignoreFocusOut: true
            });
            if (ticketTitleInput === undefined) {
                continue;
            }
            project.tickets = sanitizeProjectTickets([
                ...tickets,
                {
                    id: ticketIdInput.trim(),
                    title: ticketTitleInput.trim() || undefined
                }
            ]);
            await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
            (0, utils_1.showAutoInfo)(`Ticket "${ticketIdInput.trim()}" added to project "${project.name}"`, 2500);
            continue;
        }
        if (tickets.length === 0) {
            void (0, utils_1.showInfo)('No project tickets available. Add one first.');
            continue;
        }
        const ticketToModify = await vscode.window.showQuickPick(tickets.map(ticket => ({
            label: formatTicketLabel(ticket),
            description: ticket.id,
            detail: buildTicketUrl(ticket.id),
            ticket
        })), {
            placeHolder: selectedAction.action === 'edit'
                ? 'Select a ticket to edit'
                : 'Select a ticket to remove',
            ignoreFocusOut: true
        });
        if (!ticketToModify) {
            continue;
        }
        if (selectedAction.action === 'remove') {
            project.tickets = tickets.filter(ticket => ticket.id.toLowerCase() !== ticketToModify.ticket.id.toLowerCase());
            await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
            (0, utils_1.showAutoInfo)(`Removed ticket "${ticketToModify.ticket.id}" from project "${project.name}"`, 2500);
            continue;
        }
        const newIdInput = await vscode.window.showInputBox({
            prompt: 'Edit ticket ID',
            value: ticketToModify.ticket.id,
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return 'Ticket ID cannot be empty';
                }
                const exists = tickets.some(ticket => ticket.id.toLowerCase() === value.trim().toLowerCase() &&
                    ticket.id.toLowerCase() !== ticketToModify.ticket.id.toLowerCase());
                if (exists) {
                    return 'Another ticket with this ID already exists';
                }
                return null;
            }
        });
        if (newIdInput === undefined) {
            continue;
        }
        const newTitleInput = await vscode.window.showInputBox({
            prompt: 'Edit ticket name/short description (optional)',
            value: ticketToModify.ticket.title ?? '',
            ignoreFocusOut: true
        });
        if (newTitleInput === undefined) {
            continue;
        }
        const updatedTickets = tickets.map(ticket => ticket.id.toLowerCase() === ticketToModify.ticket.id.toLowerCase()
            ? { id: newIdInput.trim(), title: newTitleInput.trim() || undefined }
            : ticket);
        project.tickets = sanitizeProjectTickets(updatedTickets);
        await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
        (0, utils_1.showAutoInfo)(`Updated ticket "${newIdInput.trim()}" for project "${project.name}"`, 2500);
    }
}
async function manageProjectTickets(event) {
    const context = await getProjectContextFromEvent(event);
    if (!context) {
        return;
    }
    await manageProjectTicketsForProject(context.project, context.data);
}
async function openProjectTicket(event) {
    const context = await getProjectContextFromEvent(event);
    if (!context) {
        return;
    }
    const { project } = context;
    project.tickets = sanitizeProjectTickets(project.tickets);
    const tickets = project.tickets;
    if (tickets.length === 0) {
        const addNow = await (0, utils_1.showInfo)(`Project "${project.name}" has no linked tickets yet.`, 'Add Ticket', 'Cancel');
        if (addNow === 'Add Ticket') {
            await manageProjectTicketsForProject(project, context.data);
        }
        return;
    }
    const selectedTicket = await vscode.window.showQuickPick(tickets.map(ticket => ({
        label: formatTicketLabel(ticket),
        description: ticket.id,
        detail: buildTicketUrl(ticket.id),
        ticket
    })), {
        placeHolder: `Select a ticket for project "${project.name}"`,
        ignoreFocusOut: true
    });
    if (!selectedTicket) {
        return;
    }
    const ticketUrl = buildTicketUrl(selectedTicket.ticket.id);
    await vscode.env.openExternal(vscode.Uri.parse(ticketUrl));
    (0, utils_1.showAutoInfo)(`Opened ticket "${selectedTicket.ticket.id}"`, 2000);
}
async function viewProjectInfo(project) {
    const dbCount = project.dbs?.length || 0;
    const selectedDb = project.dbs?.find((db) => db.isSelected);
    const tickets = sanitizeProjectTickets(project.tickets);
    const ticketLines = tickets.length > 0
        ? tickets.map(ticket => `  • ${formatTicketLabel(ticket)}`).join('\n')
        : '  • None';
    let infoMessage = `Project Information

Name: ${project.name}
Created: ${new Date(project.createdAt).toLocaleString()}

Repositories (${project.repos.length}):
${project.repos.map(r => `  • ${r.name}`).join('\n')}

Tickets (${tickets.length}):
${ticketLines}

Databases: ${dbCount}${selectedDb ? `
Active Database: ${selectedDb.name}` : `
No active database`}`;
    await (0, notifications_1.showModalInfo)(infoMessage, 'OK');
}
async function exportProject(event) {
    try {
        // Get project UID from event
        let projectUid;
        if (typeof event === 'string') {
            projectUid = event;
        }
        else if (event && event.uid) {
            projectUid = event.uid;
        }
        else if (event && event.id) {
            projectUid = event.id;
        }
        else if (event && event.projectUid) {
            projectUid = event.projectUid;
        }
        else {
            void (0, utils_1.showError)('The project data is invalid.');
            return;
        }
        const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
        const projects = data.projects;
        if (!projects) {
            void (0, utils_1.showError)('No projects are configured.');
            return;
        }
        const project = projects.find(p => p.uid === projectUid);
        if (!project) {
            void (0, utils_1.showError)('The selected project could not be found.');
            return;
        }
        // Let user choose export location
        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${project.name}.json`),
            filters: {
                'JSON Files': ['json'],
                'All Files': ['*']
            },
            saveLabel: 'Export Project'
        });
        if (!saveUri) {
            return; // User cancelled
        }
        // Create export data with sanitized paths
        const exportData = {
            name: project.name,
            repositories: project.repos.map((repo) => ({
                name: repo.name,
                path: repo.path.replace(os.homedir(), '~') // Use ~ for home directory
            })),
            tickets: sanitizeProjectTickets(project.tickets),
            exportedAt: new Date().toISOString(),
            exportVersion: '1.0'
        };
        // Write to file
        const content = JSON.stringify(exportData, null, 2);
        await vscode.workspace.fs.writeFile(saveUri, Buffer.from(content, 'utf8'));
        const action = await (0, utils_1.showInfo)(`Project "${project.name}" exported successfully!`, 'Open Export Location', 'Import Instructions');
        if (action === 'Open Export Location') {
            await vscode.commands.executeCommand('revealFileInOS', saveUri);
        }
        else if (action === 'Import Instructions') {
            const instructions = `To import this project:
1. Copy the exported file to the target machine
2. Use Command Palette > "Import Odoo Project"
3. Select the exported JSON file
4. Adjust repository paths as needed

Note: Repository paths use ~ for home directory and may need adjustment on different systems.`;
            await (0, notifications_1.showModalInfo)(instructions);
        }
    }
    catch (error) {
        logger_1.logger.error('Error exporting project:', error);
        void (0, utils_1.showError)(`Failed to export project: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
async function importProject() {
    try {
        // Let user choose import file
        const openUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'JSON Files': ['json'],
                'All Files': ['*']
            },
            openLabel: 'Import Project'
        });
        if (!openUri || openUri.length === 0) {
            return; // User cancelled
        }
        // Read and parse import file
        const fileContent = await vscode.workspace.fs.readFile(openUri[0]);
        const importData = JSON.parse(fileContent.toString());
        // Validate import data
        if (!importData.name || !importData.repositories || !Array.isArray(importData.repositories)) {
            void (0, utils_1.showError)('The selected file is not a valid project export.');
            return;
        }
        const importedTickets = sanitizeProjectTickets(importData.tickets);
        // Load existing data
        const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
        const projects = data.projects || [];
        // Get settings from active version
        const versionsService = versionsService_1.VersionsService.getInstance();
        const settings = await versionsService.getActiveVersionSettings();
        // Check if project name already exists and suggest alternative
        let projectName = importData.name;
        let counter = 1;
        while (projects.some(p => p.name === projectName)) {
            projectName = `${importData.name} (${counter})`;
            counter++;
        }
        if (projectName !== importData.name) {
            const useNewName = await (0, notifications_1.showWarning)(`A project named "${importData.name}" already exists. Import as "${projectName}"?`, 'Yes, Import with New Name', 'Cancel');
            if (useNewName !== 'Yes, Import with New Name') {
                return;
            }
        }
        const customAddonsPath = (0, utils_1.normalizePath)(settings.customAddonsPath);
        // Process repositories and expand ~ to home directory
        const availableRepos = (0, utils_1.findRepositories)(customAddonsPath);
        const validRepos = [];
        const missingRepos = [];
        for (const repo of importData.repositories) {
            // Expand ~ to home directory if present
            const expandedPath = repo.path.startsWith('~')
                ? repo.path.replace('~', os.homedir())
                : repo.path;
            // Try to find the repository in the current custom-addons directory
            const localRepo = availableRepos.find(r => r.name === repo.name);
            if (localRepo) {
                validRepos.push(new repo_1.RepoModel(localRepo.name, localRepo.path, true));
            }
            else {
                missingRepos.push(`${repo.name} (originally at: ${expandedPath})`);
            }
        }
        // Create new project
        const newProject = new project_1.ProjectModel(projectName, new Date(), [], // No databases in export
        validRepos, false, // Not selected by default
        (0, crypto_1.randomUUID)(), [], // No included psae-internal paths on import
        undefined, importedTickets);
        // Add to projects and save
        projects.push(newProject);
        data.projects = projects;
        await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
        // Show import results
        let message = `Project "${projectName}" imported successfully!`;
        if (missingRepos.length > 0) {
            message += `\n\nMissing repositories (not found in current custom-addons):\n${missingRepos.join('\n')}`;
            message += `\n\nYou can manage repositories from the Repositories tab.`;
        }
        await (0, utils_1.showInfo)(message, 'OK');
    }
    catch (error) {
        logger_1.logger.error('Error importing project:', error);
        if (error instanceof SyntaxError) {
            void (0, utils_1.showError)('The selected file is not valid JSON.');
        }
        else {
            void (0, utils_1.showError)(`Failed to import project: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
}
async function quickProjectSearch() {
    try {
        const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
        const projects = data.projects;
        if (!projects || projects.length === 0) {
            void (0, utils_1.showError)('No projects are configured. Create a project first.');
            return;
        }
        // The quick pick filters on label + description + detail, so pack the
        // project's searchable metadata (repos, databases, selected modules,
        // tickets) into those fields — typing a repo, database, module or
        // ticket id finds the project that owns it.
        const listSome = (values, max = 8) => values.length > max ? `${values.slice(0, max).join(', ')} +${values.length - max}` : values.join(', ');
        const quickPickItems = projects.map(project => {
            const selectedDb = project.dbs?.find((db) => db.isSelected);
            const repoNames = (project.repos ?? []).map((repo) => repo.name);
            const dbNames = (project.dbs ?? []).map((db) => (0, utils_1.getDatabaseLabel)(db));
            const moduleNames = (selectedDb?.modules ?? []).map(module => module.name);
            const ticketIds = sanitizeProjectTickets(project.tickets).map(ticket => ticket.id);
            const detailParts = [
                repoNames.length ? `Repos: ${listSome(repoNames)}` : '',
                dbNames.length ? `DBs: ${listSome(dbNames)}` : '',
                moduleNames.length ? `Modules: ${listSome(moduleNames)}` : '',
                ticketIds.length ? `Tickets: ${listSome(ticketIds)}` : ''
            ].filter(Boolean);
            return {
                label: `${project.isSelected ? '$(arrow-right) ' : ''}${project.name}`,
                description: `${repoNames.length} repos • ${dbNames.length} dbs${selectedDb ? ` • DB: ${(0, utils_1.getDatabaseLabel)(selectedDb)}` : ''}`,
                detail: detailParts.join('  |  ') || `Created: ${new Date(project.createdAt).toLocaleDateString()}`,
                projectUid: project.uid
            };
        });
        const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
            placeHolder: 'Search and select a project...',
            matchOnDescription: true,
            matchOnDetail: true,
            ignoreFocusOut: true,
            canPickMany: false,
            title: 'Select Project'
        });
        if (selectedItem) {
            // Use the VS Code command to trigger proper refresh
            await vscode.commands.executeCommand('projectSelector.selectProject', selectedItem.projectUid);
        }
    }
    catch (error) {
        logger_1.logger.error('Error in quick project search:', error);
        void (0, utils_1.showError)('Unable to load projects for search.');
    }
}


/***/ }),
/* 54 */
/***/ ((module) => {

module.exports = require("os");

/***/ }),
/* 55 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ProjectModel = void 0;
const testing_1 = __webpack_require__(56);
const crypto_1 = __webpack_require__(26);
class ProjectModel {
    name; // project sh name
    createdAt;
    dbs;
    repos = [];
    isSelected = false;
    uid; // unique identifier for the project
    includedPsaeInternalPaths = []; // Manually included psae-internal paths
    testingConfig; // Testing configuration
    tickets = [];
    /** versionId -> dbId: which database each version last launched against. */
    selectedDbByVersion = {};
    constructor(name, createdAt, dbs = [], repos = [], isSelected = false, uid = (0, crypto_1.randomUUID)(), includedPsaeInternalPaths = [], testingConfig = new testing_1.TestingConfigModel(), tickets = []) {
        this.name = name;
        this.dbs = dbs;
        this.repos = repos;
        this.createdAt = createdAt;
        this.isSelected = isSelected;
        this.uid = uid;
        this.includedPsaeInternalPaths = includedPsaeInternalPaths;
        this.testingConfig = testingConfig;
        this.tickets = Array.isArray(tickets) ? tickets : [];
    }
}
exports.ProjectModel = ProjectModel;


/***/ }),
/* 56 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.TestingConfigModel = void 0;
exports.ensureTestingConfigModel = ensureTestingConfigModel;
/**
 * Testing configuration model: test targets, file, log level and the
 * stashed module states used while testing mode is on.
 */
const logger_1 = __webpack_require__(12);
class TestingConfigModel {
    isEnabled;
    testTags;
    testFile;
    stopAfterInit;
    logLevel;
    savedModuleStates;
    constructor(isEnabled = false, testTags = [], testFile, stopAfterInit = false, logLevel = 'disabled', savedModuleStates) {
        this.isEnabled = isEnabled;
        this.testTags = testTags;
        this.testFile = testFile;
        this.stopAfterInit = stopAfterInit;
        this.logLevel = logLevel;
        this.savedModuleStates = savedModuleStates;
    }
    /**
     * Generates the test tags string for the --test-tags option
     * Converts user-friendly format to proper Odoo syntax: [-][tag][/module][:class][.method]
     */
    getTestTagsString() {
        const activeTags = this.testTags.filter(tag => tag.state !== 'disabled');
        if (activeTags.length === 0) {
            return '';
        }
        return activeTags
            .map(tag => {
            const prefix = tag.state === 'exclude' ? '-' : '';
            let formattedValue = '';
            switch (tag.type) {
                case 'tag':
                    // Simple tags remain as-is: "post_install"
                    formattedValue = tag.value;
                    break;
                case 'module':
                    // Module tests need "/" prefix: "/account"
                    formattedValue = `/${tag.value}`;
                    break;
                case 'class':
                    // Class tests: user enters "TestSalesAccessRights", we format as ":TestSalesAccessRights"
                    formattedValue = `:${tag.value}`;
                    break;
                case 'method':
                    // Method tests: user enters "test_workflow_invoice", we format as ".test_workflow_invoice"
                    formattedValue = `.${tag.value}`;
                    break;
                default:
                    formattedValue = tag.value;
            }
            return prefix + formattedValue;
        })
            .join(',');
    }
}
exports.TestingConfigModel = TestingConfigModel;
/**
 * Normalizes stored testing configuration objects into TestingConfigModel instances.
 */
function ensureTestingConfigModel(testingConfig) {
    if (!testingConfig) {
        return new TestingConfigModel();
    }
    if (testingConfig instanceof TestingConfigModel) {
        return testingConfig;
    }
    try {
        return new TestingConfigModel(Boolean(testingConfig.isEnabled), Array.isArray(testingConfig.testTags) ? testingConfig.testTags : [], testingConfig.testFile, Boolean(testingConfig.stopAfterInit), testingConfig.logLevel ?? 'disabled', Array.isArray(testingConfig.savedModuleStates) ? testingConfig.savedModuleStates : undefined);
    }
    catch (error) {
        logger_1.logger.warn('Error converting testing config, creating new instance:', error);
        return new TestingConfigModel();
    }
}


/***/ }),
/* 57 */
/***/ ((__unused_webpack_module, exports) => {


/**
 * Repository model: a git repo belonging to a project.
 */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.RepoModel = void 0;
exports.normalizeBranchMode = normalizeBranchMode;
function normalizeBranchMode(value) {
    return value === 'worktree' ? 'worktree' : 'checkout';
}
class RepoModel {
    name;
    path;
    isSelected = false;
    addedAt;
    branchMode;
    constructor(name, path, isSelected = false, addedAt, branchMode = 'checkout') {
        this.name = name;
        this.path = path;
        this.isSelected = isSelected;
        this.addedAt = addedAt ?? new Date().toISOString();
        this.branchMode = normalizeBranchMode(branchMode);
    }
}
exports.RepoModel = RepoModel;


/***/ }),
/* 58 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.readModuleManifest = readModuleManifest;
exports.findModuleForFile = findModuleForFile;
exports.extractTicketIdsFromBranch = extractTicketIdsFromBranch;
const fs = __importStar(__webpack_require__(23));
const path = __importStar(__webpack_require__(4));
const logger_1 = __webpack_require__(12);
const manifestCache = new Map();
const TICKET_KEYS = ['task_id', 'task_ids', 'ticket', 'ticket_id', 'ticket_number'];
function extractQuotedStrings(source) {
    const values = [];
    const regex = /['"]([^'"]+)['"]/g;
    let match;
    while ((match = regex.exec(source)) !== null) {
        values.push(match[1].trim());
    }
    return values.filter(Boolean);
}
function parseDepends(content) {
    const match = /['"]depends['"]\s*:\s*\[([^\]]*)\]/s.exec(content);
    if (!match) {
        return [];
    }
    return Array.from(new Set(extractQuotedStrings(match[1])));
}
function parseTicketIds(content) {
    const ids = new Set();
    for (const key of TICKET_KEYS) {
        // Value forms: 1234567, '1234567', or a [list, of, them].
        const keyRegex = new RegExp(`['"]${key}['"]\\s*:\\s*(\\[[^\\]]*\\]|['"][^'"]+['"]|\\d+)`, 'g');
        let match;
        while ((match = keyRegex.exec(content)) !== null) {
            const raw = match[1];
            const digits = raw.match(/\d{4,}/g);
            for (const digit of digits ?? []) {
                ids.add(digit);
            }
        }
    }
    // Free-form mentions like "task 1234567" / "task-id: 1234567" in the
    // description or comments.
    const mentionRegex = /task[-_ ]?(?:id)?\s*[:#]?\s*(\d{5,})/gi;
    let mention;
    while ((mention = mentionRegex.exec(content)) !== null) {
        ids.add(mention[1]);
    }
    return Array.from(ids);
}
/**
 * Reads a module's manifest (depends + ticket ids), or undefined when the
 * module has no readable __manifest__.py.
 */
async function readModuleManifest(modulePath) {
    const manifestPath = path.join(modulePath, '__manifest__.py');
    let mtimeMs;
    try {
        mtimeMs = (await fs.stat(manifestPath)).mtimeMs;
    }
    catch {
        return undefined;
    }
    const cached = manifestCache.get(manifestPath);
    if (cached && cached.mtimeMs === mtimeMs) {
        return cached.info;
    }
    try {
        const content = await fs.readFile(manifestPath, 'utf-8');
        const info = {
            depends: parseDepends(content),
            ticketIds: parseTicketIds(content)
        };
        manifestCache.set(manifestPath, { mtimeMs, info });
        return info;
    }
    catch (error) {
        logger_1.logger.debug(`Failed to read manifest for ${modulePath}:`, error);
        return undefined;
    }
}
/**
 * Extracts ticket-id candidates from a branch name (PS convention:
 * "17.0-project-1234567-dev" carries the task id as a long digit run).
 */
/**
 * Finds the Odoo module a file belongs to by walking up the directory
 * tree until a folder containing __manifest__.py is found.
 */
async function findModuleForFile(filePath) {
    let dir = path.dirname(filePath);
    // Bounded walk so a weird path can never loop forever.
    for (let depth = 0; depth < 40; depth++) {
        try {
            await fs.access(path.join(dir, '__manifest__.py'));
            return { name: path.basename(dir), path: dir };
        }
        catch {
            // not a module root - keep walking up
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
    return undefined;
}
function extractTicketIdsFromBranch(branchName) {
    if (!branchName) {
        return [];
    }
    return Array.from(new Set(branchName.match(/\d{5,}/g) ?? []));
}


/***/ }),
/* 59 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.PSAE_INTERNAL_REGEX = void 0;
exports.collectModuleDiscovery = collectModuleDiscovery;
exports.parsePsaeOverrides = parsePsaeOverrides;
exports.resolvePsaeDirectories = resolvePsaeDirectories;
exports.setPsaeDirectoryIncluded = setPsaeDirectoryIncluded;
const utils_1 = __webpack_require__(8);
const repoPaths_1 = __webpack_require__(60);
/**
 * Single source of truth for "psae-internal" module directories (Odoo PS
 * convention: directories matching ps*-internal hold internal modules that
 * are only added to the addons path when needed). Both the Modules tree and
 * the debugger arg builder resolve inclusion through this module, and the
 * project's `includedPsaeInternalPaths` override list ("path" to force
 * include, "!path" to force exclude) is only interpreted here.
 */
exports.PSAE_INTERNAL_REGEX = /^ps[a-z]*-internal$/i;
/** Runs module discovery for the project, honoring its manual includes. */
function collectModuleDiscovery(project, resolved) {
    const manualIncludes = (project.includedPsaeInternalPaths ?? []).filter(entry => !entry.startsWith('!'));
    // Resolved repos point at the active version's worktrees; without them
    // discovery falls back to the source checkouts, which is correct for
    // checkout-mode projects and for callers that have no version in hand.
    const repos = resolved ? (0, repoPaths_1.toDiscoveryRepos)(resolved) : project.repos;
    return (0, utils_1.discoverModulesInRepos)(repos, { manualIncludePaths: manualIncludes });
}
/** Splits the raw override list into normalized include/exclude path sets. */
function parsePsaeOverrides(includedPsaeInternalPaths) {
    const manualIncludes = new Set();
    const manualExcludes = new Set();
    for (const entry of includedPsaeInternalPaths ?? []) {
        if (entry.startsWith('!')) {
            manualExcludes.add((0, utils_1.normalizePath)(entry.substring(1)));
        }
        else {
            manualIncludes.add((0, utils_1.normalizePath)(entry));
        }
    }
    return { manualIncludes, manualExcludes };
}
/**
 * Resolves the inclusion state of every discovered psae-internal directory.
 * A directory is included when it is manually included, or when it contains
 * selected or installed modules and is not manually excluded.
 */
function resolvePsaeDirectories(args) {
    const { manualIncludes, manualExcludes } = parsePsaeOverrides(args.includedPsaeInternalPaths);
    return args.psaeDirectories.map(dir => {
        const normalized = (0, utils_1.normalizePath)(dir.path);
        const isManuallyIncluded = manualIncludes.has(normalized);
        const isManuallyExcluded = manualExcludes.has(normalized);
        const hasSelectedModules = dir.moduleNames.some(name => args.selectedModuleNames.has(name));
        const hasDbModules = dir.moduleNames.some(name => args.installedModuleNames.has(name));
        return {
            ...dir,
            path: normalized,
            isManuallyIncluded,
            isManuallyExcluded,
            hasSelectedModules,
            hasDbModules,
            isIncluded: isManuallyIncluded || (!isManuallyExcluded && (hasSelectedModules || hasDbModules))
        };
    });
}
/**
 * Rewrites the project's override list so that `dir` resolves to `include`.
 * Intent-based: clears any contradicting override first, then adds a manual
 * include/exclude only when the automatic resolution would not already give
 * the requested result. Returns the module names whose selections must be
 * dropped (when excluding a directory that has selected modules).
 */
function setPsaeDirectoryIncluded(project, dir, include) {
    const overrides = (project.includedPsaeInternalPaths ?? []).filter(entry => {
        const normalized = (0, utils_1.normalizePath)(entry.startsWith('!') ? entry.substring(1) : entry);
        return normalized !== dir.path;
    });
    let removedModuleNames = [];
    if (include) {
        // Auto-inclusion only triggers with selected/installed modules;
        // otherwise pin the directory with a manual include.
        if (!dir.hasSelectedModules && !dir.hasDbModules) {
            overrides.push(dir.path);
        }
    }
    else {
        if (dir.hasSelectedModules || dir.hasDbModules) {
            overrides.push(`!${dir.path}`);
        }
        if (dir.hasSelectedModules) {
            removedModuleNames = [...dir.moduleNames];
        }
    }
    project.includedPsaeInternalPaths = overrides;
    return { removedModuleNames };
}


/***/ }),
/* 60 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.worktreeDirName = worktreeDirName;
exports.resolveRepoPath = resolveRepoPath;
exports.resolveProjectRepos = resolveProjectRepos;
exports.toDiscoveryRepos = toDiscoveryRepos;
exports.identifyWorktreeOwner = identifyWorktreeOwner;
exports.describeModeChange = describeModeChange;
/**
 * Where a repository's code actually lives for a given branch.
 *
 * In `checkout` mode that is always the repository itself - the behaviour that
 * predates this module. In `worktree` mode each branch gets its own directory
 * under the provisioning root, so two versions can run against their own
 * custom code at once, and the original checkout becomes a source only.
 *
 * Pure: mapping is decided here, creating directories is not.
 */
const path = __importStar(__webpack_require__(4));
const repo_1 = __webpack_require__(57);
const utils_1 = __webpack_require__(8);
/** Anything illegal or confusing in a directory name becomes a dash. */
function slug(value) {
    return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}
function worktreeDirName(repoName, branch) {
    return `${slug(repoName)}@${slug(branch)}`;
}
function resolveRepoPath(repo, branch, root) {
    const mode = (0, repo_1.normalizeBranchMode)(repo.branchMode);
    const trimmedBranch = branch?.trim() || undefined;
    // No branch to key a worktree on: the source is all there is.
    if (mode !== 'worktree' || !trimmedBranch) {
        return {
            repo,
            path: (0, utils_1.normalizePath)(repo.path),
            branch: trimmedBranch,
            mode,
            isWorktree: false
        };
    }
    return {
        repo,
        path: path.join(root, worktreeDirName(repo.name, trimmedBranch)),
        branch: trimmedBranch,
        mode,
        isWorktree: true
    };
}
function resolveProjectRepos(repos, assignments, root) {
    const byPath = new Map();
    const byName = new Map();
    for (const assignment of assignments) {
        if (!assignment.branch) {
            continue;
        }
        if (assignment.repoPath) {
            byPath.set((0, utils_1.normalizePath)(assignment.repoPath), assignment.branch);
        }
        if (assignment.repoName) {
            byName.set(assignment.repoName.toLowerCase(), assignment.branch);
        }
    }
    return repos.map(repo => {
        // Path first: a renamed repo still matches. Name second: a moved one does.
        const branch = byPath.get((0, utils_1.normalizePath)(repo.path)) ?? byName.get(repo.name.toLowerCase());
        return resolveRepoPath(repo, branch, root);
    });
}
/**
 * Resolved repos in the shape `discoverModulesInRepos` expects, so module
 * discovery and the addons path see worktrees rather than source checkouts
 * without every downstream signature changing.
 */
function toDiscoveryRepos(resolved) {
    return resolved.map(entry => new repo_1.RepoModel(entry.repo.name, entry.path, entry.repo.isSelected, entry.repo.addedAt, entry.mode));
}
/** Whether `child` is `parent` itself or sits inside it. */
function isInside(child, parent) {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
/**
 * Which repo and branch a file on disk belongs to, for the wrong-copy warning.
 * Only worktrees are considered: a file in a source checkout is not "the wrong
 * copy", it is simply not part of what any version runs.
 */
function identifyWorktreeOwner(filePath, resolved) {
    const target = path.resolve(filePath);
    for (const entry of resolved) {
        if (entry.isWorktree && entry.branch && isInside(target, path.resolve(entry.path))) {
            return { repo: entry.repo, branch: entry.branch };
        }
    }
    return undefined;
}
/** The confirmation shown before a repository changes branch mode. */
function describeModeChange(repoName, mode, root, branches) {
    if (mode === 'checkout') {
        return `Switch "${repoName}" back to a single checkout?\n\n`
            + `The worktrees the extension created for it will be removed. `
            + `Any with uncommitted changes are kept and reported.`;
    }
    const dirs = branches.map(branch => `  ${path.join(root, worktreeDirName(repoName, branch))}`).join('\n');
    return `Give "${repoName}" one working copy per branch?\n\n`
        + `These directories will be created, and this is where you will edit that branch's code:\n\n${dirs}\n\n`
        + `The original checkout at ${repoName} becomes a source only: it stays yours to switch freely, `
        + `and nothing that happens to it changes what a version runs.`;
}


/***/ }),
/* 61 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.RepoTreeProvider = void 0;
exports.selectRepo = selectRepo;
/**
 * Repos view: lists git repositories discovered under the version's custom
 * addons folder and toggles their membership in the active project.
 */
const repo_1 = __webpack_require__(57);
const vscode = __importStar(__webpack_require__(1));
const utils_1 = __webpack_require__(8);
const settingsStore_1 = __webpack_require__(6);
const versionsService_1 = __webpack_require__(24);
const path = __importStar(__webpack_require__(10));
const fs = __importStar(__webpack_require__(9));
const sortOptions_1 = __webpack_require__(29);
const branches_1 = __webpack_require__(32);
const runtimeCache_1 = __webpack_require__(15);
const baseTreeProvider_1 = __webpack_require__(5);
const icons_1 = __webpack_require__(30);
async function mapWithConcurrency(items, limit, worker) {
    if (items.length === 0) {
        return [];
    }
    const normalizedLimit = Math.max(1, limit);
    const results = new Array(items.length);
    let cursor = 0;
    const runNext = async () => {
        const index = cursor++;
        if (index >= items.length) {
            return;
        }
        results[index] = await worker(items[index]);
        await runNext();
    };
    const workers = Array.from({ length: Math.min(normalizedLimit, items.length) }, () => runNext());
    await Promise.all(workers);
    return results;
}
class RepoTreeProvider extends baseTreeProvider_1.BaseTreeProvider {
    sortPreferences;
    constructor(_context, sortPreferences) {
        super();
        this.sortPreferences = sortPreferences;
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren(_element) {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            return [];
        }
        const { project } = result;
        const workspacePath = (0, utils_1.getWorkspacePath)();
        if (!workspacePath) {
            return [];
        }
        const repos = project.repos;
        // Get settings from active version
        const versionsService = versionsService_1.VersionsService.getInstance();
        const settings = await versionsService.getActiveVersionSettings();
        const customAddonsPath = (0, utils_1.normalizePath)(settings.customAddonsPath);
        // Empty lists fall through to the view's welcome content, which
        // points at the version's custom addons folder setting.
        if (!fs.existsSync(customAddonsPath)) {
            return [];
        }
        const devsRepos = (0, utils_1.findRepositories)(customAddonsPath);
        if (devsRepos.length === 0 || !repos) {
            return [];
        }
        const repoEntries = await mapWithConcurrency(devsRepos, 6, async (repo) => {
            const existingRepo = repos.find(r => r.name === repo.name);
            let branch = null;
            const isGitRepo = fs.existsSync(path.join(repo.path, '.git'));
            if (isGitRepo) {
                try {
                    branch = await (0, branches_1.getRepoBranch)(repo.path);
                }
                catch {
                    branch = null;
                }
            }
            let fsCreatedAt = 0;
            try {
                const stats = fs.statSync(repo.path);
                fsCreatedAt = stats.birthtimeMs || stats.ctimeMs || 0;
            }
            catch {
                fsCreatedAt = 0;
            }
            return {
                name: repo.name,
                path: repo.path,
                isSelected: !!existingRepo,
                branch,
                isGitRepo,
                repoModel: existingRepo,
                fsCreatedAt
            };
        });
        const sortId = this.sortPreferences.get('repoSelector', (0, sortOptions_1.getDefaultSortOption)('repoSelector'));
        repoEntries.sort((a, b) => this.compareRepos(a, b, sortId));
        return repoEntries.map(entry => {
            const treeItem = new vscode.TreeItem(entry.name);
            treeItem.iconPath = entry.isSelected ? icons_1.selectedIcon : icons_1.unselectedIcon;
            treeItem.tooltip = new vscode.MarkdownString([
                `**${entry.name}**${entry.isSelected ? ' (in project)' : ''}`,
                `**Path:** ${entry.path}`,
                entry.branch ? `**Branch:** ${entry.branch}` : '',
                entry.isGitRepo ? '' : '**Type:** addons folder (not a git repository)'
            ].filter(Boolean).join('\n\n'));
            treeItem.id = entry.path;
            treeItem.description = entry.isGitRepo ? (entry.branch ?? '') : 'addons folder';
            treeItem.contextValue = 'repo';
            // Carried for the shared reveal/copy-path/terminal commands (extractUri).
            treeItem.uri = vscode.Uri.file(entry.path);
            treeItem.command = {
                command: 'repoSelector.selectRepo',
                title: 'Select Module',
                arguments: [{ isSelected: entry.isSelected, path: entry.path, name: entry.name }]
            };
            return treeItem;
        });
    }
    compareRepos(a, b, sortId) {
        const selectedDelta = Number(b.isSelected) - Number(a.isSelected);
        if (selectedDelta !== 0) {
            return selectedDelta;
        }
        switch (sortId) {
            case 'repo:name:asc':
                return a.name.localeCompare(b.name);
            case 'repo:name:desc':
                return b.name.localeCompare(a.name);
            case 'repo:created:newest':
                return this.getRepoTimestamp(b) - this.getRepoTimestamp(a);
            case 'repo:created:oldest':
                return this.getRepoTimestamp(a) - this.getRepoTimestamp(b);
            case 'repo:branch:asc':
                return (a.branch ?? '').localeCompare(b.branch ?? '') || a.name.localeCompare(b.name);
            case 'repo:branch:desc':
                return (b.branch ?? '').localeCompare(a.branch ?? '') || a.name.localeCompare(b.name);
            default:
                return a.name.localeCompare(b.name);
        }
    }
    getRepoTimestamp(entry) {
        if (entry.repoModel?.addedAt) {
            const added = new Date(entry.repoModel.addedAt).getTime();
            if (!isNaN(added)) {
                return added;
            }
        }
        return entry.fsCreatedAt ?? 0;
    }
}
exports.RepoTreeProvider = RepoTreeProvider;
async function selectRepo(event) {
    const selectedRepo = event;
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    const repoInProject = project.repos.find((repo) => repo.name === selectedRepo.name);
    if (!repoInProject) {
        project.repos.push(new repo_1.RepoModel(selectedRepo.name, selectedRepo.path, selectedRepo.isSelected));
    }
    else {
        project.repos = project.repos.filter((repo) => repo.name !== selectedRepo.name);
    }
    (0, runtimeCache_1.invalidateModuleDiscoveryCache)();
    (0, runtimeCache_1.invalidateRepositoryDiscoveryCache)();
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
}


/***/ }),
/* 62 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ModuleTreeProvider = void 0;
exports.selectModule = selectModule;
exports.quickConfigureModules = quickConfigureModules;
exports.createModuleFromScaffold = createModuleFromScaffold;
exports.setModuleToInstall = setModuleToInstall;
exports.setModuleToUpgrade = setModuleToUpgrade;
exports.clearModuleState = clearModuleState;
exports.togglePsaeInternalModule = togglePsaeInternalModule;
exports.updateAllModules = updateAllModules;
exports.updateInstalledModules = updateInstalledModules;
exports.installAllModules = installAllModules;
exports.clearAllModuleSelections = clearAllModuleSelections;
exports.viewInstalledModules = viewInstalledModules;
/**
 * Modules view and module workflows: discovery across project repos,
 * install/upgrade state management, psae-internal groups, manifest
 * dependencies, bulk actions and odoo-bin scaffolding.
 */
const module_1 = __webpack_require__(63);
const vscode = __importStar(__webpack_require__(1));
const utils_1 = __webpack_require__(8);
const psaeInternal_1 = __webpack_require__(59);
const fs = __importStar(__webpack_require__(2));
const path = __importStar(__webpack_require__(4));
const settingsStore_1 = __webpack_require__(6);
const database_1 = __webpack_require__(42);
const sortOptions_1 = __webpack_require__(29);
const versionsService_1 = __webpack_require__(24);
const repoPaths_1 = __webpack_require__(60);
const environment_1 = __webpack_require__(31);
const setupState_1 = __webpack_require__(64);
const notifications_1 = __webpack_require__(16);
const baseTreeProvider_1 = __webpack_require__(5);
const process_1 = __webpack_require__(13);
const logger_1 = __webpack_require__(12);
const manifest_1 = __webpack_require__(58);
const CORE_HINT = 'Core/other module (not in this project\'s repos)';
class ModuleTreeProvider extends baseTreeProvider_1.BaseTreeProvider {
    sortPreferences;
    constructor(_context, sortPreferences) {
        super();
        this.sortPreferences = sortPreferences;
    }
    getTreeItem(element) {
        return element;
    }
    /** Module names discovered in the project's repos (for dependency hints). */
    knownModuleNames = new Set();
    async getChildren(element) {
        if (element) {
            const node = element;
            if (node.psaeChildren) {
                return node.psaeChildren;
            }
            if (node.moduleData) {
                return this.buildDependencyItems(node.moduleData);
            }
            return [];
        }
        // Empty lists fall through to the view's welcome content, which
        // explains that a project and database must be selected first.
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            return [];
        }
        const { project } = result;
        const db = project.dbs.find((db) => db.isSelected === true);
        if (!db) {
            return [];
        }
        const modules = db.modules;
        if (!modules) {
            return [];
        }
        const isTestingEnabled = !!(project.testingConfig && project.testingConfig.isEnabled);
        const { modules: allModules, psaeDirectories } = (0, psaeInternal_1.collectModuleDiscovery)(project);
        this.knownModuleNames = new Set(allModules.map(module => module.name));
        const installedModuleNames = await (0, database_1.getInstalledModuleNames)(db.id);
        const dbModulesByName = new Map(modules.map(module => [module.name, module]));
        const selectedDbModuleNames = new Set(modules
            .filter(module => module.state === 'install' || module.state === 'upgrade')
            .map(module => module.name));
        const psaeStates = (0, psaeInternal_1.resolvePsaeDirectories)({
            psaeDirectories,
            includedPsaeInternalPaths: project.includedPsaeInternalPaths,
            selectedModuleNames: selectedDbModuleNames,
            installedModuleNames
        });
        const buildModuleNode = (module) => {
            const repoPath = module.isPsaeInternal ? `${module.repoName}/${module.psInternalDirName}` : module.repoName;
            const managed = dbModulesByName.get(module.name);
            const isInstalledInDb = installedModuleNames.has(module.name);
            if (managed) {
                managed.isInstalled = isInstalledInDb;
            }
            const state = managed?.state ?? 'none';
            // Collapsed: expanding a module lazily lists its manifest dependencies.
            const item = new vscode.TreeItem(module.name, vscode.TreeItemCollapsibleState.Collapsed);
            item.id = module.path;
            item.iconPath = this.getModuleIcon(state, isInstalledInDb);
            item.description = repoPath;
            item.contextValue = 'module';
            const stateLabel = state !== 'none' ? state : isInstalledInDb ? 'Installed' : 'none';
            item.tooltip = new vscode.MarkdownString([
                `**Module:** ${module.name}`,
                `**State:** ${stateLabel}`,
                `**Source:** ${repoPath}`,
                `**Path:** ${module.path}`
            ].join('\n\n'));
            const moduleData = {
                name: module.name,
                path: module.path,
                state,
                repoName: module.repoName,
                isPsaeInternal: module.isPsaeInternal,
                isInstalled: isInstalledInDb
            };
            item.moduleData = moduleData;
            item.command = isTestingEnabled ? undefined : {
                command: 'moduleSelector.select',
                title: 'Select Module',
                arguments: [moduleData]
            };
            return item;
        };
        const treeItems = [];
        if (isTestingEnabled) {
            const testingModeItem = new vscode.TreeItem('Module management disabled (testing mode)', vscode.TreeItemCollapsibleState.None);
            testingModeItem.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
            testingModeItem.tooltip = 'Testing is enabled. Disable testing in the Testing view to manage modules again.';
            testingModeItem.contextValue = 'info';
            treeItems.push(testingModeItem);
        }
        // psae-internal directories become collapsible groups with their
        // modules as children; the toggle lives on the group.
        const modulesByPsaeDir = new Map();
        for (const module of allModules) {
            if (!module.isPsaeInternal || !module.psInternalDirPath) {
                continue;
            }
            const key = (0, utils_1.normalizePath)(module.psInternalDirPath);
            const existing = modulesByPsaeDir.get(key) ?? [];
            existing.push(module);
            modulesByPsaeDir.set(key, existing);
        }
        for (const psaeState of psaeStates) {
            const members = (modulesByPsaeDir.get(psaeState.path) ?? [])
                .filter(m => !psaeInternal_1.PSAE_INTERNAL_REGEX.test(m.name))
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
            const parent = new vscode.TreeItem(psaeState.dirName, vscode.TreeItemCollapsibleState.Collapsed);
            parent.id = psaeState.path;
            parent.iconPath = psaeState.isIncluded
                ? new vscode.ThemeIcon('package', new vscode.ThemeColor('charts.green'))
                : new vscode.ThemeIcon('package');
            parent.description = `${psaeState.repoName} • ${members.length} modules • ${psaeState.isIncluded ? 'in addons path' : 'excluded'}`;
            parent.contextValue = isTestingEnabled ? 'psaeDirectoryDisabled' : 'psaeDirectory';
            const reasons = [];
            if (psaeState.isManuallyIncluded) {
                reasons.push('manually included');
            }
            if (psaeState.isManuallyExcluded) {
                reasons.push('manually excluded');
            }
            if (psaeState.hasSelectedModules) {
                reasons.push('has selected modules');
            }
            if (psaeState.hasDbModules) {
                reasons.push('has database modules');
            }
            parent.tooltip = [
                `${psaeState.dirName}: ${psaeState.isIncluded ? 'Included in addons path' : 'Not included'}${reasons.length ? ` (${reasons.join(' + ')})` : ''}`,
                `Repo: ${psaeState.repoName}`,
                `Path: ${psaeState.path}`,
                isTestingEnabled ? 'Module management disabled while testing is enabled' : 'Use the toggle action to include/exclude it'
            ].join('\n');
            parent.psaeState = psaeState;
            parent.psaeChildren = members.map(buildModuleNode);
            parent.psaeChildren.forEach(child => (child.parentNode = parent));
            treeItems.push(parent);
        }
        // Regular (non-psae) modules at the root.
        const regularModules = allModules
            .filter(m => !m.isPsaeInternal && !psaeInternal_1.PSAE_INTERNAL_REGEX.test(m.name))
            .map(buildModuleNode);
        const sortId = this.sortPreferences.get('moduleSelector', (0, sortOptions_1.getDefaultSortOption)('moduleSelector'));
        regularModules.sort((a, b) => this.compareModules(a, b, sortId));
        treeItems.push(...regularModules);
        this.lastRootNodes = treeItems;
        return treeItems;
    }
    /** Root nodes from the latest build, used by getParent/findModuleNode. */
    lastRootNodes = [];
    /** Required for TreeView.reveal: psae children report their group node. */
    getParent(element) {
        return element.parentNode;
    }
    /** Locates the tree node for a module by name (for TreeView.reveal). */
    async findModuleNode(moduleName) {
        if (this.lastRootNodes.length === 0) {
            await this.getChildren();
        }
        for (const node of this.lastRootNodes) {
            if (node.moduleData?.name === moduleName) {
                return node;
            }
            const child = node.psaeChildren?.find(entry => entry.moduleData?.name === moduleName);
            if (child) {
                return child;
            }
        }
        return undefined;
    }
    /** Lazily lists a module's manifest dependencies (one level deep). */
    async buildDependencyItems(moduleData) {
        const manifest = await (0, manifest_1.readModuleManifest)(moduleData.path);
        if (!manifest || manifest.depends.length === 0) {
            const empty = new vscode.TreeItem(manifest ? 'No dependencies' : 'No __manifest__.py found', vscode.TreeItemCollapsibleState.None);
            empty.contextValue = 'info';
            empty.iconPath = new vscode.ThemeIcon('info');
            return [empty];
        }
        return manifest.depends.map(dep => {
            const isLocal = this.knownModuleNames.has(dep);
            const item = new vscode.TreeItem(dep, vscode.TreeItemCollapsibleState.None);
            item.id = `${moduleData.path}::dep::${dep}`;
            item.contextValue = 'moduleDependency';
            item.iconPath = isLocal
                ? new vscode.ThemeIcon('package', new vscode.ThemeColor('charts.blue'))
                : new vscode.ThemeIcon('library');
            item.description = isLocal ? 'project module' : 'core/other';
            item.tooltip = isLocal ? `Dependency "${dep}" is available in this project's repos.` : `${dep}: ${CORE_HINT}`;
            return item;
        });
    }
    getModuleIcon(state, isInstalled) {
        // State is encoded by glyph SHAPE, not just color: when a tree row is
        // selected VS Code repaints the icon with list.activeSelectionForeground
        // and the charts.* tint is lost, so install/upgrade/installed must stay
        // distinguishable without color. Directional arrows for the pending
        // actions, filled vs outline circle for installed vs absent.
        switch (state) {
            case 'install':
                return new vscode.ThemeIcon('arrow-circle-down', new vscode.ThemeColor('charts.green'));
            case 'upgrade':
                return new vscode.ThemeIcon('arrow-circle-up', new vscode.ThemeColor('charts.yellow'));
            default:
                return isInstalled
                    ? new vscode.ThemeIcon('circle-filled')
                    : new vscode.ThemeIcon('circle-outline');
        }
    }
    compareModules(itemA, itemB, sortId) {
        const dataA = itemA.moduleData;
        const dataB = itemB.moduleData;
        if (!dataA || !dataB) {
            return 0;
        }
        const nameCompare = dataA.name.localeCompare(dataB.name);
        const repoCompare = (dataA.repoName || '').localeCompare(dataB.repoName || '');
        const statePriority = (state) => {
            if (state === 'install') {
                return 0;
            }
            if (state === 'upgrade') {
                return 1;
            }
            return 2;
        };
        switch (sortId) {
            case 'module:state:active-first': {
                const diff = statePriority(dataA.state) - statePriority(dataB.state);
                if (diff !== 0) {
                    return diff;
                }
                return nameCompare;
            }
            case 'module:state:active-last': {
                const diff = statePriority(dataB.state) - statePriority(dataA.state);
                if (diff !== 0) {
                    return diff;
                }
                return nameCompare;
            }
            case 'module:installed:first': {
                const diff = Number(dataB.isInstalled) - Number(dataA.isInstalled);
                if (diff !== 0) {
                    return diff;
                }
                return nameCompare;
            }
            case 'module:name:asc':
                return nameCompare;
            case 'module:name:desc':
                return -nameCompare;
            case 'module:repo:asc':
                if (repoCompare !== 0) {
                    return repoCompare;
                }
                return nameCompare;
            case 'module:repo:desc':
                if (repoCompare !== 0) {
                    return -repoCompare;
                }
                return nameCompare;
            default:
                return nameCompare;
        }
    }
}
exports.ModuleTreeProvider = ModuleTreeProvider;
async function selectModule(event) {
    const module = event;
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    const db = project.dbs.find((db) => db.isSelected === true);
    if (!db) {
        void (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        void (0, utils_1.showError)('Disable testing mode before changing module selections.');
        return;
    }
    const moduleExistsInDb = db.modules.find(mod => mod.name === module.name);
    if (!moduleExistsInDb) {
        db.modules.push(new module_1.ModuleModel(module.name, 'install'));
    }
    else {
        if (moduleExistsInDb.state === 'install') {
            moduleExistsInDb.state = 'upgrade';
        }
        else {
            db.modules = db.modules.filter(mod => mod.name !== module.name);
        }
    }
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
}
/**
 * Quick-configure picker for module states: lists every discovered module
 * with its current state, Enter cycles install → upgrade → unmanaged (like
 * clicking in the tree) and the per-item buttons set a state directly. The
 * picker stays open across changes; the caller refreshes views afterwards.
 */
async function quickConfigureModules() {
    const installButton = {
        iconPath: new vscode.ThemeIcon('desktop-download'),
        tooltip: 'Set to install'
    };
    const upgradeButton = {
        iconPath: new vscode.ThemeIcon('arrow-up'),
        tooltip: 'Set to upgrade'
    };
    const clearButton = {
        iconPath: new vscode.ThemeIcon('circle-slash'),
        tooltip: 'Clear state'
    };
    const loadItems = async () => {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            void (0, utils_1.showInfo)('Select a project before configuring modules.');
            return undefined;
        }
        const { project } = result;
        const db = project.dbs.find((db) => db.isSelected === true);
        if (!db) {
            void (0, utils_1.showError)('Select a database before configuring modules.');
            return undefined;
        }
        if (project.testingConfig && project.testingConfig.isEnabled) {
            void (0, utils_1.showError)('Disable testing mode before changing module selections.');
            return undefined;
        }
        const { modules } = (0, psaeInternal_1.collectModuleDiscovery)(project);
        const statesByName = new Map((db.modules ?? []).map(module => [module.name, module.state]));
        let installedNames = new Set();
        try {
            installedNames = await (0, database_1.getInstalledModuleNames)(db.id);
        }
        catch {
            // Database unreachable: still list modules, just without the installed hint.
        }
        const stateRank = (name) => {
            const state = statesByName.get(name);
            if (state === 'install' || state === 'upgrade') {
                return 0;
            }
            return installedNames.has(name) ? 1 : 2;
        };
        return modules
            .filter(module => !psaeInternal_1.PSAE_INTERNAL_REGEX.test(module.name))
            .sort((a, b) => stateRank(a.name) - stateRank(b.name) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
            .map(module => {
            const state = statesByName.get(module.name);
            const statusParts = [];
            if (state) {
                statusParts.push(state);
            }
            if (installedNames.has(module.name)) {
                statusParts.push('installed');
            }
            const marker = state === 'install'
                ? '$(arrow-circle-down)'
                : state === 'upgrade'
                    ? '$(arrow-circle-up)'
                    : installedNames.has(module.name)
                        ? '$(circle-filled)'
                        : '$(circle-outline)';
            return {
                label: `${marker} ${module.name}`,
                description: statusParts.join(' • '),
                detail: module.repoName,
                moduleName: module.name,
                buttons: [installButton, upgradeButton, clearButton]
            };
        });
    };
    const initialItems = await loadItems();
    if (!initialItems) {
        return;
    }
    const picker = vscode.window.createQuickPick();
    picker.title = 'Configure Modules';
    picker.placeholder = 'Enter cycles install → upgrade → unmanaged; item buttons set a state directly';
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    picker.ignoreFocusOut = true;
    picker.keepScrollPosition = true;
    picker.items = initialItems;
    const applyAndReload = async (action) => {
        picker.busy = true;
        try {
            await action();
            const items = await loadItems();
            if (!items) {
                picker.hide();
                return;
            }
            picker.items = items;
        }
        finally {
            picker.busy = false;
        }
    };
    picker.onDidAccept(() => {
        const active = picker.selectedItems[0] ?? picker.activeItems[0];
        if (!active) {
            return;
        }
        void applyAndReload(() => selectModule({ name: active.moduleName }));
    });
    picker.onDidTriggerItemButton(event => {
        const target = { name: event.item.moduleName };
        if (event.button === installButton) {
            void applyAndReload(() => setModuleToInstall(target));
        }
        else if (event.button === upgradeButton) {
            void applyAndReload(() => setModuleToUpgrade(target));
        }
        else {
            void applyAndReload(() => clearModuleState(target));
        }
    });
    await new Promise(resolve => {
        picker.onDidHide(() => {
            picker.dispose();
            resolve();
        });
        picker.show();
    });
}
async function runScaffoldCommand(pythonPath, odooBinPath, moduleName, targetPath) {
    try {
        await (0, process_1.runCommand)(pythonPath, [odooBinPath, 'scaffold', moduleName, targetPath]);
    }
    catch (error) {
        throw new Error(`Scaffold command failed: ${(0, logger_1.errorMessage)(error)}`);
    }
}
async function resolveRepositoryRoot(repoPath) {
    const resolved = await (0, process_1.tryRunCommand)('git', ['-C', repoPath, 'rev-parse', '--show-toplevel']);
    if (resolved && fs.existsSync(resolved)) {
        return resolved;
    }
    // Fall back to the selected path if git resolution is unavailable.
    return repoPath;
}
async function createModuleFromScaffold() {
    const projectResult = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!projectResult) {
        return;
    }
    const targetProject = projectResult.project;
    const projectRepos = (targetProject.repos ?? []);
    if (projectRepos.length === 0) {
        void (0, utils_1.showError)(`Project "${targetProject.name}" has no selected repositories.`);
        return;
    }
    // Resolved once: in worktree mode the source checkout is not what any
    // version runs, so scaffolding into it would put the module nowhere useful.
    const selectedDb = targetProject.dbs?.find(entry => entry.isSelected);
    const resolvedRepos = (0, repoPaths_1.resolveProjectRepos)(projectRepos, selectedDb ? (0, environment_1.resolveProjectRepoBranchAssignments)(selectedDb, projectRepos) : [], (0, setupState_1.readSetupState)().provisioningRoot);
    const resolvedPathFor = (repo) => resolvedRepos.find(entry => entry.repo === repo)?.path ?? (0, utils_1.normalizePath)(repo.path);
    let targetRepo;
    if (projectRepos.length === 1) {
        targetRepo = projectRepos[0];
    }
    else {
        const selectedRepo = await vscode.window.showQuickPick(projectRepos.map(repo => ({
            label: repo.name,
            description: resolvedPathFor(repo),
            detail: 'Scaffold destination repository',
            repo
        })), {
            placeHolder: `Select destination repository for "${targetProject.name}"`,
            ignoreFocusOut: true
        });
        if (!selectedRepo) {
            return;
        }
        targetRepo = selectedRepo.repo;
    }
    if (!targetRepo) {
        void (0, utils_1.showError)('Select a destination repository.');
        return;
    }
    const versionsService = versionsService_1.VersionsService.getInstance();
    const settings = await versionsService.getActiveVersionSettings();
    const normalizedPythonPath = (0, utils_1.normalizePath)(settings.pythonPath);
    const normalizedOdooPath = (0, utils_1.normalizePath)(settings.odooPath);
    const destinationPath = resolvedPathFor(targetRepo);
    const repositoryRootPath = await resolveRepositoryRoot(destinationPath);
    const odooBinPath = path.join(normalizedOdooPath, 'odoo-bin');
    if (!normalizedPythonPath || !fs.existsSync(normalizedPythonPath)) {
        void (0, utils_1.showError)(`Python executable not found: ${normalizedPythonPath}`);
        return;
    }
    if (!normalizedOdooPath || !fs.existsSync(normalizedOdooPath)) {
        void (0, utils_1.showError)(`Odoo path not found: ${normalizedOdooPath}`);
        return;
    }
    if (!fs.existsSync(odooBinPath)) {
        void (0, utils_1.showError)(`odoo-bin not found at: ${odooBinPath}`);
        return;
    }
    if (!repositoryRootPath || !fs.existsSync(repositoryRootPath)) {
        void (0, utils_1.showError)(`Destination repository path not found: ${repositoryRootPath}`);
        return;
    }
    const moduleName = await vscode.window.showInputBox({
        placeHolder: 'e.g. my_custom_module',
        prompt: `Enter module name to scaffold in ${targetRepo.name} (${repositoryRootPath})`,
        ignoreFocusOut: true,
        validateInput: (value) => {
            const trimmed = value.trim();
            if (!trimmed) {
                return 'Module name cannot be empty.';
            }
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
                return 'Use letters, numbers, and underscores only. Must start with a letter or underscore.';
            }
            const targetPath = path.join(repositoryRootPath, trimmed);
            if (fs.existsSync(targetPath)) {
                return `A folder named "${trimmed}" already exists in destination repo.`;
            }
            return null;
        }
    });
    if (moduleName === undefined) {
        return;
    }
    const sanitizedModuleName = moduleName.trim();
    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Creating module ${sanitizedModuleName}`,
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Running odoo-bin scaffold...' });
            await runScaffoldCommand(normalizedPythonPath, odooBinPath, sanitizedModuleName, repositoryRootPath);
        });
        (0, utils_1.showAutoInfo)(`Module "${sanitizedModuleName}" created in ${repositoryRootPath}`, 3500);
    }
    catch (error) {
        void (0, utils_1.showError)(`Failed to scaffold module "${sanitizedModuleName}": ${error.message}`);
    }
}
/**
 * Set a module to 'install' state
 */
async function setModuleToInstall(event) {
    const moduleData = event.moduleData || event;
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    const db = project.dbs.find((db) => db.isSelected === true);
    if (!db) {
        void (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    // Check if testing is enabled
    if (project.testingConfig && project.testingConfig.isEnabled) {
        void (0, utils_1.showError)('Disable testing mode before changing module selections.');
        return;
    }
    const moduleExistsInDb = db.modules.find(mod => mod.name === moduleData.name);
    if (!moduleExistsInDb) {
        db.modules.push(new module_1.ModuleModel(moduleData.name, 'install'));
    }
    else {
        moduleExistsInDb.state = 'install';
    }
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
}
/**
 * Set a module to 'upgrade' state
 */
async function setModuleToUpgrade(event) {
    const moduleData = event.moduleData || event;
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        return false;
    }
    const { data, project } = result;
    const db = project.dbs.find((db) => db.isSelected === true);
    if (!db) {
        void (0, utils_1.showError)('Select a database before running this action.');
        return false;
    }
    // Check if testing is enabled
    if (project.testingConfig && project.testingConfig.isEnabled) {
        void (0, utils_1.showError)('Disable testing mode before changing module selections.');
        return false;
    }
    const moduleExistsInDb = db.modules.find(mod => mod.name === moduleData.name);
    if (!moduleExistsInDb) {
        db.modules.push(new module_1.ModuleModel(moduleData.name, 'upgrade'));
    }
    else {
        moduleExistsInDb.state = 'upgrade';
    }
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
    return true;
}
/**
 * Clear a module's state (remove from managed modules)
 */
async function clearModuleState(event) {
    const moduleData = event.moduleData || event;
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    const db = project.dbs.find((db) => db.isSelected === true);
    if (!db) {
        void (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    // Check if testing is enabled
    if (project.testingConfig && project.testingConfig.isEnabled) {
        void (0, utils_1.showError)('Disable testing mode before changing module selections.');
        return;
    }
    const moduleExistsInDb = db.modules.find(mod => mod.name === moduleData.name);
    if (moduleExistsInDb) {
        db.modules = db.modules.filter(mod => mod.name !== moduleData.name);
    }
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
}
async function togglePsaeInternalModule(event) {
    const state = event?.psaeState;
    if (!state) {
        void (0, utils_1.showError)('Could not identify the psae-internal directory to toggle.');
        return;
    }
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    const db = project.dbs.find((db) => db.isSelected === true);
    if (!db) {
        void (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    if (project.testingConfig && project.testingConfig.isEnabled) {
        void (0, utils_1.showError)('Disable testing mode before changing module selections.');
        return;
    }
    const include = !state.isIncluded;
    const { removedModuleNames } = (0, psaeInternal_1.setPsaeDirectoryIncluded)(project, state, include);
    if (removedModuleNames.length > 0) {
        db.modules = db.modules.filter(dbModule => !removedModuleNames.includes(dbModule.name));
    }
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
    if (include) {
        (0, utils_1.showAutoInfo)(`Included ${state.dirName} (${state.repoName}) in the addons path`, 2500);
    }
    else if (removedModuleNames.length > 0) {
        (0, utils_1.showAutoInfo)(`Excluded ${state.dirName} (${state.repoName}) and cleared ${removedModuleNames.length} selected module(s)`, 3000);
    }
    else {
        (0, utils_1.showAutoInfo)(`Excluded ${state.dirName} (${state.repoName}) from the addons path`, 2500);
    }
}
async function updateAllModules() {
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        void (0, utils_1.showError)('Select a project before running this action.');
        return;
    }
    const { data, project } = result;
    const db = project.dbs.find((db) => db.isSelected === true);
    if (!db) {
        void (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        void (0, utils_1.showError)('Disable testing mode before changing module selections.');
        return;
    }
    const { modules: allModules } = (0, psaeInternal_1.collectModuleDiscovery)(project);
    const availableModules = allModules.filter(m => !psaeInternal_1.PSAE_INTERNAL_REGEX.test(m.name));
    if (availableModules.length === 0) {
        void (0, utils_1.showInfo)('No modules are available to update.');
        return;
    }
    // Confirm action
    const confirm = await (0, notifications_1.showModalWarning)(`Are you sure you want to set all ${availableModules.length} available modules to "upgrade" state regardless of their current state?`, 'Update All');
    if (confirm !== 'Update All') {
        return;
    }
    // Set all modules to upgrade state (add new ones or update existing ones)
    let addedCount = 0;
    let updatedCount = 0;
    for (const module of availableModules) {
        const existingModule = db.modules.find(mod => mod.name === module.name);
        if (!existingModule) {
            db.modules.push(new module_1.ModuleModel(module.name, 'upgrade'));
            addedCount++;
        }
        else if (existingModule.state !== 'upgrade') {
            existingModule.state = 'upgrade';
            updatedCount++;
        }
    }
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
    const message = addedCount > 0 && updatedCount > 0
        ? `Added ${addedCount} new modules and updated ${updatedCount} existing modules to "upgrade" state (${db.modules.length} total)`
        : addedCount > 0
            ? `Added ${addedCount} modules for upgrade (${db.modules.length} total modules selected)`
            : updatedCount > 0
                ? `Updated ${updatedCount} modules to "upgrade" state`
                : `All ${availableModules.length} modules already set to "upgrade" state`;
    (0, utils_1.showAutoInfo)(message, 4000);
}
async function updateInstalledModules() {
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        void (0, utils_1.showError)('Select a project before running this action.');
        return;
    }
    const { data, project } = result;
    const db = project.dbs.find((db) => db.isSelected === true);
    if (!db) {
        void (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        void (0, utils_1.showError)('Disable testing mode before changing module selections.');
        return;
    }
    if (!db.modules || db.modules.length === 0) {
        void (0, utils_1.showInfo)('No modules are configured for this database to update');
        return;
    }
    const installedModules = db.modules.filter(module => module.state === 'install');
    if (installedModules.length === 0) {
        void (0, utils_1.showInfo)('No modules are currently marked with the "install" state.');
        return;
    }
    // Confirm action
    const confirm = await (0, notifications_1.showModalWarning)(`Are you sure you want to set all ${installedModules.length} modules with "install" state to "upgrade" state?`, 'Update Installed');
    if (confirm !== 'Update Installed') {
        return;
    }
    // Set only installed modules to upgrade state
    installedModules.forEach(module => {
        module.state = 'upgrade';
    });
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
    (0, utils_1.showAutoInfo)(`${installedModules.length} installed modules set to upgrade state`, 3000);
}
async function installAllModules() {
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        void (0, utils_1.showError)('Select a project before running this action.');
        return;
    }
    const { data, project } = result;
    const db = project.dbs.find((db) => db.isSelected === true);
    if (!db) {
        void (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        void (0, utils_1.showError)('Disable testing mode before changing module selections.');
        return;
    }
    const { modules: allModules } = (0, psaeInternal_1.collectModuleDiscovery)(project);
    const availableModules = allModules.filter(m => !psaeInternal_1.PSAE_INTERNAL_REGEX.test(m.name));
    if (availableModules.length === 0) {
        void (0, utils_1.showInfo)('No modules are available to install.');
        return;
    }
    // Confirm action
    const confirm = await (0, notifications_1.showModalWarning)(`Are you sure you want to set all ${availableModules.length} available modules to "install" state?`, 'Install All');
    if (confirm !== 'Install All') {
        return;
    }
    // Set all modules to install state (add new ones or update existing ones)
    let addedCount = 0;
    let updatedCount = 0;
    for (const module of availableModules) {
        const existingModule = db.modules.find(mod => mod.name === module.name);
        if (!existingModule) {
            db.modules.push(new module_1.ModuleModel(module.name, 'install'));
            addedCount++;
        }
        else if (existingModule.state !== 'install') {
            existingModule.state = 'install';
            updatedCount++;
        }
    }
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
    const message = addedCount > 0 && updatedCount > 0
        ? `Added ${addedCount} new modules and updated ${updatedCount} existing modules to "install" state (${db.modules.length} total)`
        : addedCount > 0
            ? `Added ${addedCount} modules for installation (${db.modules.length} total modules selected)`
            : updatedCount > 0
                ? `Updated ${updatedCount} modules to "install" state`
                : `All ${availableModules.length} modules already set to "install" state`;
    (0, utils_1.showAutoInfo)(message, 4000);
}
async function clearAllModuleSelections() {
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        void (0, utils_1.showError)('Select a project before running this action.');
        return;
    }
    const { data, project } = result;
    const db = project.dbs.find((db) => db.isSelected === true);
    if (!db) {
        void (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        void (0, utils_1.showError)('Disable testing mode before changing module selections.');
        return;
    }
    if (!db.modules || db.modules.length === 0) {
        return; // Silently return if no modules to clear
    }
    // Confirm action
    const confirm = await (0, notifications_1.showModalWarning)(`Are you sure you want to clear all ${db.modules.length} selected modules?`, 'Clear All');
    if (confirm !== 'Clear All') {
        return;
    }
    // Clear all module selections
    const clearedCount = db.modules.length;
    db.modules = [];
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
    (0, utils_1.showAutoInfo)(`Cleared ${clearedCount} module selections`, 3000);
}
async function viewInstalledModules() {
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        void (0, utils_1.showError)('Select a project before running this action.');
        return;
    }
    const { project } = result;
    const db = project.dbs.find((db) => db.isSelected === true);
    if (!db) {
        void (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    try {
        // Get all installed modules from database
        const installedModules = await (0, database_1.getInstalledModules)(db.id);
        if (installedModules.length === 0) {
            void (0, utils_1.showInfo)('No installed modules were found in the database');
            return;
        }
        // Create quick pick items with detailed information
        const quickPickItems = installedModules.map((module) => ({
            label: `$(${module.application ? 'device-mobile' : 'diff-added'}) ${module.name}`,
            description: `$(check) Installed | v${module.latest_version || 'unknown'}`,
            detail: module.shortdesc || 'No description available',
            module: module
        }));
        await vscode.window.showQuickPick(quickPickItems, {
            placeHolder: `Browse installed modules (${installedModules.length} total)`,
            matchOnDescription: true,
            matchOnDetail: true,
            ignoreFocusOut: true,
            canPickMany: false,
            title: `Installed Modules in ${(0, utils_1.getDatabaseLabel)(db)}`
        });
    }
    catch (error) {
        void (0, utils_1.showError)(`Failed to retrieve installed modules: ${error}`);
    }
}


/***/ }),
/* 63 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ModuleModel = void 0;
class ModuleModel {
    name;
    state;
    isInstalled;
    constructor(name, state = 'none', isInstalled = false) {
        this.name = name;
        this.state = state;
        this.isInstalled = isInstalled;
    }
}
exports.ModuleModel = ModuleModel;


/***/ }),
/* 64 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.DEFAULT_PROVISIONING_DIRNAME = void 0;
exports.defaultProvisioningRoot = defaultProvisioningRoot;
exports.isOdooSourceRepo = isOdooSourceRepo;
exports.evaluateSetup = evaluateSetup;
exports.readRawSetupSettings = readRawSetupSettings;
exports.readSetupState = readSetupState;
exports.writeSetupSettings = writeSetupSettings;
exports.shouldAdoptLegacySourceRepo = shouldAdoptLegacySourceRepo;
/**
 * Whether this machine is set up: where the Odoo source repository lives and
 * where per-version environments are built. Both are infrastructure rather
 * than per-version defaults, so they are stored at user scope - one setup
 * covers every workspace - with a workspace override available.
 *
 * The predicates are pure and take an `exists` probe so they can be tested;
 * only the read/write helpers at the bottom touch vscode and the filesystem.
 */
const fs = __importStar(__webpack_require__(2));
const os = __importStar(__webpack_require__(37));
const path = __importStar(__webpack_require__(4));
const vscode = __importStar(__webpack_require__(1));
const logger_1 = __webpack_require__(12);
exports.DEFAULT_PROVISIONING_DIRNAME = 'odoo-dev';
/** Where environments are built when nothing is configured. */
function defaultProvisioningRoot(home = os.homedir()) {
    return path.join(home, exports.DEFAULT_PROVISIONING_DIRNAME);
}
/**
 * An Odoo source repository is a directory holding `odoo-bin`. Checking the
 * contents rather than just the path means a repo that was moved or deleted
 * reads as unconfigured, which routes the user back to setup instead of into
 * a provisioning failure.
 */
function isOdooSourceRepo(dir, exists) {
    const trimmed = dir?.trim();
    return !!trimmed && exists(path.join(trimmed, 'odoo-bin'));
}
/** A configured path only counts when it is actually there. */
function presentDir(dir, exists) {
    const trimmed = dir?.trim();
    return trimmed && exists(trimmed) ? trimmed : undefined;
}
function evaluateSetup(raw, exists, home = os.homedir()) {
    const sourceRepo = raw.sourceRepo?.trim() || undefined;
    const configured = isOdooSourceRepo(sourceRepo, exists);
    return {
        sourceRepo: configured ? sourceRepo : undefined,
        enterpriseRepo: presentDir(raw.enterpriseRepo, exists),
        designThemesRepo: presentDir(raw.designThemesRepo, exists),
        provisioningRoot: raw.provisioningRoot?.trim() || defaultProvisioningRoot(home),
        isConfigured: configured
    };
}
// ---------------------------------------------------------------------------
// vscode-backed accessors
// ---------------------------------------------------------------------------
function config() {
    return vscode.workspace.getConfiguration('odooDebugger');
}
function readRawSetupSettings() {
    const settings = config();
    return {
        sourceRepo: settings.get('sourceRepo.odoo', ''),
        enterpriseRepo: settings.get('sourceRepo.enterprise', ''),
        designThemesRepo: settings.get('sourceRepo.designThemes', ''),
        provisioningRoot: settings.get('provisioning.root', '')
    };
}
function readSetupState() {
    return evaluateSetup(readRawSetupSettings(), candidate => fs.existsSync(candidate));
}
/**
 * Writes the setup at user scope so it survives into every other workspace -
 * the "set up once and forget" model. A workspace that already overrides a
 * key keeps its override; overwriting it here would silently retarget a
 * client folder that was deliberately pointed elsewhere.
 */
async function writeSetupSettings(values) {
    const settings = config();
    const entries = [
        ['sourceRepo.odoo', values.sourceRepo],
        ['sourceRepo.enterprise', values.enterpriseRepo],
        ['sourceRepo.designThemes', values.designThemesRepo],
        ['provisioning.root', values.provisioningRoot]
    ];
    for (const [key, value] of entries) {
        if (value === undefined) {
            continue;
        }
        await settings.update(key, value, vscode.ConfigurationTarget.Global);
    }
    logger_1.logger.info(`[setup] wrote source repo ${values.sourceRepo ?? '(unchanged)'} at user scope`);
}
/**
 * Adopts a pre-existing `defaultVersion.odooPath` as the source repo. Before
 * this design that key doubled as the repo worktrees were cut from, so anyone
 * already working has it pointed at a real checkout; adopting it means the
 * upgrade does not interrupt them.
 */
function shouldAdoptLegacySourceRepo(raw, legacyOdooPath, exists) {
    if (raw.sourceRepo?.trim()) {
        return undefined;
    }
    return isOdooSourceRepo(legacyOdooPath, exists) ? legacyOdooPath.trim() : undefined;
}


/***/ }),
/* 65 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.TestingTreeProvider = void 0;
exports.toggleTesting = toggleTesting;
exports.prepareTestRunForFile = prepareTestRunForFile;
exports.toggleStopAfterInit = toggleStopAfterInit;
exports.setTestFile = setTestFile;
exports.addTestTag = addTestTag;
exports.cycleTestTagState = cycleTestTagState;
exports.removeTestTag = removeTestTag;
exports.toggleLogLevel = toggleLogLevel;
exports.setSpecificLogLevel = setSpecificLogLevel;
/**
 * Testing view and testing mode: toggling stashes/restores module
 * selections and injects --test-enable/--test-tags/--test-file/
 * --stop-after-init/--log-level into the launch configuration.
 */
const vscode = __importStar(__webpack_require__(1));
const settingsStore_1 = __webpack_require__(6);
const testing_1 = __webpack_require__(56);
const module_1 = __webpack_require__(63);
const utils_1 = __webpack_require__(8);
const context_1 = __webpack_require__(66);
const debugger_1 = __webpack_require__(67);
const database_1 = __webpack_require__(42);
const logger_1 = __webpack_require__(12);
const notifications_1 = __webpack_require__(16);
const baseTreeProvider_1 = __webpack_require__(5);
const icons_1 = __webpack_require__(30);
class TestingTreeProvider extends baseTreeProvider_1.BaseTreeProvider {
    constructor(_context) {
        super();
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren(element) {
        // Empty lists fall through to the view's welcome content, which
        // explains that a project and database must be selected first.
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            return [];
        }
        const { data, project } = result;
        const db = project.dbs.find(db => db.isSelected === true);
        if (!db) {
            return [];
        }
        let testingConfig = (0, testing_1.ensureTestingConfigModel)(project.testingConfig);
        if (testingConfig !== project.testingConfig) {
            // Save the converted model back to persist the conversion
            project.testingConfig = testingConfig;
            await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data)).catch(error => {
                logger_1.logger.warn('Failed to save converted testing config:', error);
            });
        }
        // Handle test tags section expansion
        if (element && element.contextValue === 'testTagsSection') {
            const tagItems = [];
            for (const tag of testingConfig.testTags) {
                let stateIcon;
                let stateText;
                switch (tag.state) {
                    case 'include':
                        stateIcon = icons_1.includeIcon;
                        stateText = 'included';
                        break;
                    case 'exclude':
                        stateIcon = icons_1.excludeIcon;
                        stateText = 'excluded';
                        break;
                    default:
                        stateIcon = icons_1.disabledIcon;
                        stateText = 'disabled';
                        break;
                }
                const tagItem = new vscode.TreeItem(tag.value, vscode.TreeItemCollapsibleState.None);
                tagItem.id = tag.id; // Store the tag ID for context menu actions
                tagItem.iconPath = stateIcon;
                tagItem.description = tag.type;
                tagItem.tooltip = `${tag.type}: ${tag.value} (${stateText})`;
                tagItem.contextValue = 'testTag';
                tagItem.command = {
                    command: 'testingSelector.cycleTestTagState',
                    title: 'Cycle Test Tag State',
                    arguments: [tag]
                };
                tagItems.push(tagItem);
            }
            if (tagItems.length === 0) {
                tagItems.push((0, utils_1.createInfoTreeItem)('No test targets configured.'));
            }
            return tagItems;
        }
        const treeItems = [];
        // Testing enabled/disabled toggle
        const enableToggle = new vscode.TreeItem(testingConfig.isEnabled ? 'Testing Enabled' : 'Testing Disabled', vscode.TreeItemCollapsibleState.None);
        enableToggle.iconPath = testingConfig.isEnabled
            ? new vscode.ThemeIcon('beaker', new vscode.ThemeColor('charts.green'))
            : new vscode.ThemeIcon('beaker');
        enableToggle.command = {
            command: 'testingSelector.toggleTesting',
            title: 'Toggle Testing',
            arguments: [{ isEnabled: testingConfig.isEnabled }]
        };
        enableToggle.tooltip = testingConfig.isEnabled
            ? 'Click to disable testing and restore module states'
            : 'Click to enable testing (will clear module selections)';
        treeItems.push(enableToggle);
        if (testingConfig.isEnabled) {
            // Test Tags section - Auto-expand if there are test tags
            const activeTags = testingConfig.testTags.filter(tag => tag.state !== 'disabled');
            const testTagsSection = new vscode.TreeItem(`Test Targets (${testingConfig.testTags.length} total, ${activeTags.length} active)`, testingConfig.testTags.length > 0
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed);
            testTagsSection.iconPath = new vscode.ThemeIcon('list-unordered');
            testTagsSection.contextValue = 'testTagsSection';
            testTagsSection.tooltip = 'Test targets - Click targets to cycle states: Include → Exclude → Disabled. Right-click to remove.';
            treeItems.push(testTagsSection);
            // Test File section
            const testFileSection = new vscode.TreeItem(testingConfig.testFile ? `Test File: ${testingConfig.testFile}` : 'No Test File Set', vscode.TreeItemCollapsibleState.None);
            testFileSection.iconPath = new vscode.ThemeIcon('file-code');
            testFileSection.command = {
                command: 'testingSelector.setTestFile',
                title: 'Set Test File'
            };
            testFileSection.tooltip = 'Click to set or change test file path';
            treeItems.push(testFileSection);
            // Stop After Init toggle
            const stopAfterInitToggle = new vscode.TreeItem('Stop After Init', vscode.TreeItemCollapsibleState.None);
            stopAfterInitToggle.iconPath = testingConfig.stopAfterInit ? icons_1.selectedIcon : icons_1.unselectedIcon;
            stopAfterInitToggle.description = testingConfig.stopAfterInit ? 'on' : 'off';
            stopAfterInitToggle.command = {
                command: 'testingSelector.toggleStopAfterInit',
                title: 'Toggle Stop After Init'
            };
            stopAfterInitToggle.tooltip = 'Toggle --stop-after-init option';
            treeItems.push(stopAfterInitToggle);
            // Log Level toggle
            const getLogLevelIcon = (level) => {
                switch (level) {
                    case 'critical': return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red'));
                    case 'error': return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.orange'));
                    case 'warn': return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow'));
                    case 'debug': return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'));
                    default: return new vscode.ThemeIcon('circle-outline');
                }
            };
            const logLevelDisplay = testingConfig.logLevel === 'disabled' ? 'Log Level: Disabled' : `Log Level: ${testingConfig.logLevel.charAt(0).toUpperCase() + testingConfig.logLevel.slice(1)}`;
            const logLevelToggle = new vscode.TreeItem(logLevelDisplay, vscode.TreeItemCollapsibleState.None);
            logLevelToggle.iconPath = getLogLevelIcon(testingConfig.logLevel);
            logLevelToggle.command = {
                command: 'testingSelector.toggleLogLevel',
                title: 'Toggle Log Level'
            };
            logLevelToggle.contextValue = 'logLevel';
            logLevelToggle.tooltip = 'Click to cycle through log levels: disabled → critical → error → warn → debug. Right-click for specific level.';
            treeItems.push(logLevelToggle);
            // Current command preview
            const commandPreview = this.generateCommandPreview(testingConfig);
            if (commandPreview) {
                const previewItem = new vscode.TreeItem(`Command: ${commandPreview}`, vscode.TreeItemCollapsibleState.None);
                previewItem.iconPath = new vscode.ThemeIcon('terminal');
                previewItem.tooltip = `Full command: ${commandPreview}`;
                treeItems.push(previewItem);
            }
        }
        else if (testingConfig.savedModuleStates && testingConfig.savedModuleStates.length > 0) {
            // Show info about saved states when testing is disabled
            const savedStatesInfo = new vscode.TreeItem(`${testingConfig.savedModuleStates.length} module states saved`, vscode.TreeItemCollapsibleState.None);
            savedStatesInfo.iconPath = new vscode.ThemeIcon('save');
            savedStatesInfo.tooltip = 'Module states from before enabling testing are saved and will be restored';
            treeItems.push(savedStatesInfo);
        }
        return treeItems;
    }
    generateCommandPreview(testingConfig) {
        const parts = ['--test-enable'];
        // Use the proper formatting method from the model
        const tagsString = testingConfig.getTestTagsString();
        if (tagsString) {
            parts.push(`--test-tags "${tagsString}"`);
        }
        if (testingConfig.testFile) {
            parts.push(`--test-file "${testingConfig.testFile}"`);
        }
        if (testingConfig.stopAfterInit) {
            parts.push('--stop-after-init');
        }
        if (testingConfig.logLevel && testingConfig.logLevel !== 'disabled') {
            parts.push(`--log-level ${testingConfig.logLevel}`);
        }
        return parts.join(' ');
    }
}
exports.TestingTreeProvider = TestingTreeProvider;
async function toggleTesting(event) {
    try {
        const { isEnabled } = event;
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            void (0, utils_1.showError)('Select a project before running this action.');
            return;
        }
        const { data, project } = result;
        const db = project.dbs.find(db => db.isSelected === true);
        if (!db) {
            void (0, utils_1.showError)('Select a database before running this action.');
            return;
        }
        // Ensure we have a proper TestingConfigModel instance
        project.testingConfig = (0, testing_1.ensureTestingConfigModel)(project.testingConfig);
        if (isEnabled) {
            // Disable testing - restore module states
            const confirm = await (0, notifications_1.showModalWarning)('Are you sure you want to disable testing? This will restore the previous module states.', 'Disable Testing');
            if (confirm !== 'Disable Testing') {
                return;
            }
            project.testingConfig.isEnabled = false;
            // Restore saved module states
            if (project.testingConfig.savedModuleStates) {
                db.modules = project.testingConfig.savedModuleStates.map(saved => new module_1.ModuleModel(saved.name, saved.state));
                project.testingConfig.savedModuleStates = undefined;
            }
            await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
            (0, context_1.updateTestingContext)(false);
            (0, utils_1.showAutoInfo)('Testing disabled. Previous module states restored.', 3000);
            await (0, debugger_1.setupDebugger)();
        }
        else {
            // Enable testing - save current states and clear modules
            const confirm = await (0, notifications_1.showModalWarning)('Enabling testing will clear all current module selections (install/upgrade). The current states will be saved and can be restored when testing is disabled. Continue?', 'Enable Testing');
            if (confirm !== 'Enable Testing') {
                return;
            }
            // Save current module states
            project.testingConfig.savedModuleStates = db.modules.map(module => ({
                name: module.name,
                state: module.state
            }));
            // Clear all modules
            db.modules = [];
            project.testingConfig.isEnabled = true;
            await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
            (0, context_1.updateTestingContext)(true);
            (0, utils_1.showAutoInfo)('Testing enabled. Current module selections saved and cleared.', 4000);
            await (0, debugger_1.setupDebugger)();
        }
    }
    catch (error) {
        logger_1.logger.error('Error in toggleTesting:', error);
        void (0, utils_1.showError)(`Failed to toggle testing: ${error}`);
    }
}
/**
 * Programmatic testing setup used by "Run Odoo Tests for Current File":
 * enables testing mode (with the usual confirmation) if needed, points
 * --test-file at the given file and includes the module as a test target.
 * Returns false when the user cancels or prerequisites are missing.
 */
async function prepareTestRunForFile(filePath, moduleName) {
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        void (0, utils_1.showError)('Select a project before running this action.');
        return false;
    }
    const { data, project } = result;
    const db = project.dbs.find(db => db.isSelected === true);
    if (!db) {
        void (0, utils_1.showError)('Select a database before running tests.');
        return false;
    }
    project.testingConfig = (0, testing_1.ensureTestingConfigModel)(project.testingConfig);
    if (!project.testingConfig.isEnabled) {
        const confirm = await (0, notifications_1.showModalWarning)('Enable testing mode? Current module selections (install/upgrade) will be saved and cleared, and restored when testing is disabled.', 'Enable Testing');
        if (confirm !== 'Enable Testing') {
            return false;
        }
        project.testingConfig.savedModuleStates = db.modules.map(module => ({
            name: module.name,
            state: module.state
        }));
        db.modules = [];
        project.testingConfig.isEnabled = true;
        (0, context_1.updateTestingContext)(true);
    }
    project.testingConfig.testFile = filePath;
    const existingTag = project.testingConfig.testTags.find(tag => tag.type === 'module' && tag.value === moduleName);
    if (existingTag) {
        existingTag.state = 'include';
    }
    else {
        project.testingConfig.testTags.push({
            id: `tag-${Date.now()}`,
            value: moduleName,
            state: 'include',
            type: 'module'
        });
    }
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
    await (0, debugger_1.setupDebugger)();
    return true;
}
async function toggleStopAfterInit() {
    try {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            void (0, utils_1.showError)('Select a project before running this action.');
            return;
        }
        const { data, project } = result;
        project.testingConfig = (0, testing_1.ensureTestingConfigModel)(project.testingConfig);
        project.testingConfig.stopAfterInit = !project.testingConfig.stopAfterInit;
        await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
        const status = project.testingConfig.stopAfterInit ? 'enabled' : 'disabled';
        (0, utils_1.showAutoInfo)(`Stop after init ${status}`, 2000);
        // Update launch.json with new test configuration
        await (0, debugger_1.setupDebugger)();
    }
    catch (error) {
        logger_1.logger.error('Error in toggleStopAfterInit:', error);
        void (0, utils_1.showError)(`Failed to toggle stop after init: ${error}`);
    }
}
async function setTestFile() {
    try {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            void (0, utils_1.showError)('Select a project before running this action.');
            return;
        }
        const { data, project } = result;
        project.testingConfig = (0, testing_1.ensureTestingConfigModel)(project.testingConfig);
        const currentPath = project.testingConfig.testFile || '';
        const newPath = await vscode.window.showInputBox({
            prompt: 'Enter test file path (relative to project root)',
            value: currentPath,
            placeHolder: 'e.g., addons/my_module/tests/test_example.py'
        });
        if (newPath !== undefined) {
            project.testingConfig.testFile = newPath.trim() || undefined;
            await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
            if (project.testingConfig.testFile) {
                (0, utils_1.showAutoInfo)(`Test file set to: ${project.testingConfig.testFile}`, 2000);
            }
            else {
                (0, utils_1.showAutoInfo)('Cleared the test file path.', 2000);
            }
            // Update launch.json with new test configuration
            await (0, debugger_1.setupDebugger)();
        }
    }
    catch (error) {
        logger_1.logger.error('Error in setTestFile:', error);
        void (0, utils_1.showError)(`Failed to set test file: ${error}`);
    }
}
async function addTestTag() {
    try {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            void (0, utils_1.showError)('Select a project before running this action.');
            return;
        }
        const { data, project } = result;
        project.testingConfig = (0, testing_1.ensureTestingConfigModel)(project.testingConfig);
        if (!project.testingConfig.isEnabled) {
            void (0, utils_1.showError)('Enable testing before running this command.');
            return;
        }
        const db = project.dbs.find(db => db.isSelected === true);
        if (!db) {
            void (0, utils_1.showError)('Select a database before running this action.');
            return;
        }
        // Create a comprehensive quick pick with examples and better descriptions
        const options = [
            {
                label: '$(tag) Test Tag',
                detail: 'Standard Odoo test tags like "post_install", "at_install", etc.',
                value: 'tag',
                examples: ['post_install', 'at_install', 'standard', 'migration']
            },
            {
                label: '$(package) Module Tests',
                detail: 'Run all tests for specific modules',
                value: 'module',
                examples: ['account', 'sale', 'stock', 'website']
            },
            {
                label: '$(symbol-class) Test Class',
                detail: 'Target specific test classes (enter class name only)',
                value: 'class',
                examples: ['TestAccountMove', 'TestSaleOrder', 'TestStockPicking']
            },
            {
                label: '$(symbol-method) Test Method',
                detail: 'Target specific test methods (enter method name only)',
                value: 'method',
                examples: ['test_create_invoice', 'test_confirm_sale', 'test_workflow_invoice']
            }
        ];
        const selectedType = await vscode.window.showQuickPick(options, {
            placeHolder: 'What type of test target would you like to add?',
            matchOnDetail: true,
            ignoreFocusOut: true
        });
        if (!selectedType) {
            return;
        }
        if (selectedType.value === 'module') {
            // For modules, show the installed modules list
            try {
                const installedModules = await (0, database_1.getInstalledModules)(db.id);
                if (installedModules.length === 0) {
                    void (0, utils_1.showInfo)('No installed modules were found.');
                    return;
                }
                // Create better module selection with grouping
                const moduleOptions = installedModules.map((module) => ({
                    label: module.name,
                    detail: module.shortdesc || 'No description available',
                    description: module.application ? '$(device-mobile) App' : '$(package) Module',
                    moduleName: module.name,
                    picked: false
                }));
                const selectedModules = await vscode.window.showQuickPick(moduleOptions, {
                    canPickMany: true,
                    placeHolder: 'Select modules to add as test targets (click them later to change include/exclude)',
                    matchOnDetail: true,
                    ignoreFocusOut: true
                });
                if (selectedModules && selectedModules.length > 0) {
                    // Add all selected modules with default "include" state
                    for (const selected of selectedModules) {
                        const newTag = {
                            id: `tag-${Date.now()}-${Math.random()}`,
                            value: selected.moduleName, // Store just the module name
                            state: 'include', // Default to include
                            type: 'module'
                        };
                        project.testingConfig.testTags.push(newTag);
                    }
                    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
                    (0, utils_1.showAutoInfo)(`Added ${selectedModules.length} module test targets.`, 4000);
                    // Update launch.json with new test configuration
                    await (0, debugger_1.setupDebugger)();
                }
            }
            catch (error) {
                void (0, utils_1.showError)(`Failed to get installed modules: ${error}`);
            }
        }
        else {
            // For other types, show a smart input with examples
            const typeInfo = selectedType;
            const examplesText = typeInfo.examples.join(', ');
            const userInput = await vscode.window.showInputBox({
                prompt: `Enter ${selectedType.label.replace(/\$\([^)]*\)\s*/, '')}`, // Remove VS Code icons from prompt
                placeHolder: selectedType.value === 'class'
                    ? `Enter just the class name (e.g., ${typeInfo.examples[0]})`
                    : selectedType.value === 'method'
                        ? `Enter just the method name (e.g., ${typeInfo.examples[0]})`
                        : `Examples: ${examplesText}`,
                value: '',
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (!value.trim()) {
                        return 'Please enter a value';
                    }
                    const trimmed = value.trim();
                    // Basic validation based on type; naming-convention hints
                    // are shown inline but never block accepting the input.
                    switch (selectedType.value) {
                        case 'tag':
                            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
                                return 'Tag names should contain only letters, numbers, and underscores';
                            }
                            break;
                        case 'class':
                            if (!trimmed.includes('Test')) {
                                return {
                                    message: 'Class names typically start with "Test" (e.g. "TestSalesAccessRights")',
                                    severity: vscode.InputBoxValidationSeverity.Info
                                };
                            }
                            break;
                        case 'method':
                            if (!trimmed.startsWith('test_')) {
                                return {
                                    message: 'Method names typically start with "test_" (e.g. "test_workflow_invoice")',
                                    severity: vscode.InputBoxValidationSeverity.Info
                                };
                            }
                            break;
                    }
                    return null;
                }
            });
            if (userInput && userInput.trim()) {
                const newTag = {
                    id: `tag-${Date.now()}`,
                    value: userInput.trim(),
                    state: 'include', // Default to include
                    type: selectedType.value
                };
                project.testingConfig.testTags.push(newTag);
                await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
                let formatInfo = '';
                if (selectedType.value === 'class') {
                    formatInfo = ` (will be formatted as :${userInput.trim()})`;
                }
                else if (selectedType.value === 'method') {
                    formatInfo = ` (will be formatted as .${userInput.trim()})`;
                }
                (0, utils_1.showAutoInfo)(`Added ${selectedType.value} "${userInput.trim()}"${formatInfo} as test target.`, 4000);
                // Update launch.json with new test configuration
                await (0, debugger_1.setupDebugger)();
            }
        }
    }
    catch (error) {
        logger_1.logger.error('Error in addTestTag:', error);
        void (0, utils_1.showError)(`Failed to add test tag: ${error}`);
    }
}
async function cycleTestTagState(tag) {
    try {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            void (0, utils_1.showError)('Select a project before running this action.');
            return;
        }
        const { data, project } = result;
        project.testingConfig = (0, testing_1.ensureTestingConfigModel)(project.testingConfig);
        const tagIndex = project.testingConfig.testTags.findIndex(t => t.id === tag.id);
        if (tagIndex > -1) {
            const currentTag = project.testingConfig.testTags[tagIndex];
            // Cycle through states: include -> exclude -> disabled -> include
            switch (currentTag.state) {
                case 'include':
                    currentTag.state = 'exclude';
                    break;
                case 'exclude':
                    currentTag.state = 'disabled';
                    break;
                case 'disabled':
                    currentTag.state = 'include';
                    break;
            }
            await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
            // Update launch.json with new test configuration
            await (0, debugger_1.setupDebugger)();
        }
        else {
            void (0, utils_1.showError)('Could not find that test tag.');
        }
    }
    catch (error) {
        logger_1.logger.error('Error in cycleTestTagState:', error);
        void (0, utils_1.showError)(`Failed to cycle test tag state: ${error}`);
    }
}
async function removeTestTag(tagOrTreeItem) {
    try {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            void (0, utils_1.showError)('Select a project before running this action.');
            return;
        }
        const { data, project } = result;
        project.testingConfig = (0, testing_1.ensureTestingConfigModel)(project.testingConfig);
        // Handle both direct tag objects and tree items from context menu
        let tagId;
        let tagValue = 'unknown';
        // Check if it's a TestTag object (has all required properties)
        if (tagOrTreeItem && typeof tagOrTreeItem === 'object' &&
            'id' in tagOrTreeItem && 'value' in tagOrTreeItem &&
            'state' in tagOrTreeItem && 'type' in tagOrTreeItem) {
            // Direct TestTag object
            const tag = tagOrTreeItem;
            tagId = tag.id;
            tagValue = tag.value;
        }
        else if (tagOrTreeItem && typeof tagOrTreeItem === 'object' &&
            'id' in tagOrTreeItem && typeof tagOrTreeItem.id === 'string') {
            // Tree item from context menu
            tagId = tagOrTreeItem.id;
            const tag = project.testingConfig.testTags.find(t => t.id === tagId);
            if (tag) {
                tagValue = tag.value;
            }
        }
        else {
            logger_1.logger.error('Could not find the referenced test tag:', tagOrTreeItem);
            void (0, utils_1.showError)('Could not find the referenced test tag.');
            return;
        }
        const tagIndex = project.testingConfig.testTags.findIndex(t => t.id === tagId);
        if (tagIndex > -1) {
            project.testingConfig.testTags.splice(tagIndex, 1);
            await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
            (0, utils_1.showAutoInfo)(`Removed test target: ${tagValue}`, 2000);
            // Update launch.json with new test configuration
            await (0, debugger_1.setupDebugger)();
        }
        else {
            void (0, utils_1.showError)('Could not find that test tag.');
        }
    }
    catch (error) {
        logger_1.logger.error('Error in removeTestTag:', error);
        void (0, utils_1.showError)(`Failed to remove test tag: ${error}`);
    }
}
async function toggleLogLevel() {
    try {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            void (0, utils_1.showError)('Select a project before running this action.');
            return;
        }
        const { data, project } = result;
        project.testingConfig = (0, testing_1.ensureTestingConfigModel)(project.testingConfig);
        // Cycle through log levels: disabled -> critical -> error -> warn -> debug -> disabled
        const logLevels = ['disabled', 'critical', 'error', 'warn', 'debug'];
        const currentIndex = logLevels.indexOf(project.testingConfig.logLevel);
        const nextIndex = (currentIndex + 1) % logLevels.length;
        project.testingConfig.logLevel = logLevels[nextIndex];
        await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
        const displayLevel = project.testingConfig.logLevel === 'disabled' ? 'disabled (no --log-level argument)' : project.testingConfig.logLevel;
        (0, utils_1.showAutoInfo)(`Log level set to: ${displayLevel}`, 2000);
        // Update launch.json with new test configuration
        await (0, debugger_1.setupDebugger)();
    }
    catch (error) {
        logger_1.logger.error('Error in toggleLogLevel:', error);
        void (0, utils_1.showError)(`Failed to toggle log level: ${error}`);
    }
}
async function setSpecificLogLevel() {
    try {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            void (0, utils_1.showError)('Select a project before running this action.');
            return;
        }
        const { data, project } = result;
        project.testingConfig = (0, testing_1.ensureTestingConfigModel)(project.testingConfig);
        const logLevelOptions = [
            {
                label: 'Disabled',
                detail: 'No --log-level argument (default Odoo logging)',
                value: 'disabled'
            },
            {
                label: 'Critical',
                detail: 'Only critical errors',
                value: 'critical'
            },
            {
                label: 'Error',
                detail: 'Critical and error messages',
                value: 'error'
            },
            {
                label: 'Warn',
                detail: 'Critical, error, and warning messages',
                value: 'warn'
            },
            {
                label: 'Debug',
                detail: 'All messages including debug information',
                value: 'debug'
            }
        ];
        const selectedOption = await vscode.window.showQuickPick(logLevelOptions, {
            placeHolder: 'Select log level for testing',
            matchOnDetail: true,
            ignoreFocusOut: true
        });
        if (selectedOption) {
            project.testingConfig.logLevel = selectedOption.value;
            await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
            const displayLevel = selectedOption.value === 'disabled' ? 'disabled (no --log-level argument)' : selectedOption.value;
            (0, utils_1.showAutoInfo)(`Log level set to: ${displayLevel}`, 2000);
            // Update launch.json with new test configuration
            await (0, debugger_1.setupDebugger)();
        }
    }
    catch (error) {
        logger_1.logger.error('Error in setSpecificLogLevel:', error);
        void (0, utils_1.showError)(`Failed to set log level: ${error}`);
    }
}


/***/ }),
/* 66 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.updateTestingContext = updateTestingContext;
exports.updateActiveContext = updateActiveContext;
exports.updateServerRunningContext = updateServerRunningContext;
exports.updateConfiguredContext = updateConfiguredContext;
/**
 * VS Code context keys ('odoo-debugger.is_active', 'odoo-debugger.testing_enabled') used by when-clauses.
 */
const vscode = __importStar(__webpack_require__(1));
/**
 * Updates VS Code context keys used by the extension.
 * Exported separately to avoid circular imports between modules.
 */
function updateTestingContext(isTestingEnabled) {
    void vscode.commands.executeCommand('setContext', 'odoo-debugger.testing_enabled', isTestingEnabled);
}
function updateActiveContext(isActive) {
    void vscode.commands.executeCommand('setContext', 'odoo-debugger.is_active', isActive);
}
function updateServerRunningContext(isRunning) {
    void vscode.commands.executeCommand('setContext', 'odoo-debugger.server_running', isRunning);
}
function updateConfiguredContext(isConfigured) {
    void vscode.commands.executeCommand('setContext', 'odoo-debugger.is_configured', isConfigured);
}


/***/ }),
/* 67 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.setupDebugger = setupDebugger;
exports.buildOdooCommandLine = buildOdooCommandLine;
exports.startDebugShell = startDebugShell;
exports.stopDebugServer = stopDebugServer;
exports.startDebugServer = startDebugServer;
/**
 * Debugger integration: keeps the managed launch.json entry in sync with the
 * active version/database/module selections, builds odoo-bin arguments
 * (addons path, -i/-u, testing flags), and starts/stops the server and shell.
 */
const vscode = __importStar(__webpack_require__(1));
const path = __importStar(__webpack_require__(4));
const utils_1 = __webpack_require__(8);
const psaeInternal_1 = __webpack_require__(59);
const settingsStore_1 = __webpack_require__(6);
const versionsService_1 = __webpack_require__(24);
const testing_1 = __webpack_require__(56);
const database_1 = __webpack_require__(42);
const logger_1 = __webpack_require__(12);
const launchConfig_1 = __webpack_require__(68);
const debugSessions_1 = __webpack_require__(51);
const dbResolution_1 = __webpack_require__(40);
const provisioning_1 = __webpack_require__(69);
const repoPaths_1 = __webpack_require__(60);
const customWorktree_1 = __webpack_require__(73);
const setupState_1 = __webpack_require__(64);
const environment_1 = __webpack_require__(31);
// Databases we already told the user about; prepareArgs re-runs on every
// debounced sync, so without this the toast repeats until the DB is initialized.
const baseInstallNotifiedDbs = new Set();
async function selectPythonInterpreter(pythonPath) {
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
    }
    catch (error) {
        logger_1.logger.warn(`Failed to set Python interpreter to "${pythonPath}":`, error);
    }
}
async function setupDebugger() {
    const workspacePath = (0, utils_1.getWorkspacePath)();
    if (!workspacePath) {
        return undefined;
    }
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        return undefined;
    }
    const { project } = result;
    const versionsService = versionsService_1.VersionsService.getInstance();
    await versionsService.initialize();
    const activeVersion = versionsService.getActiveVersion();
    const activeSettings = await versionsService.getActiveVersionSettings();
    // One entry per provisioned version, each with its own name, ports and
    // database: launch.json accumulates durable entries instead of one being
    // renamed out from under the Run and Debug dropdown, and two versions can
    // run at once. Unprovisioned versions have no interpreter to launch.
    const targets = versionsService.getVersions()
        .filter(version => (0, provisioning_1.isVersionProvisioned)((0, utils_1.resolveOptionalPath)(version.settings.pythonPath)));
    if (activeVersion && !targets.some(version => version.id === activeVersion.id)) {
        targets.push(activeVersion);
    }
    // Worktrees are created once per sync rather than per launch entry: the
    // same branch is often shared by several versions.
    const setupRoot = (0, setupState_1.readSetupState)().provisioningRoot;
    const worktreeProblems = new Set();
    let activeConfig;
    for (const version of targets) {
        const settings = version.settings;
        const normalizedOdooPath = (0, utils_1.normalizePath)(settings.odooPath);
        const normalizedPythonPath = (0, utils_1.normalizePath)(settings.pythonPath);
        const versionDb = (0, dbResolution_1.resolveDbForVersion)(project.dbs, project.selectedDbByVersion, version.id);
        if (versionDb) {
            const { problems } = await (0, customWorktree_1.ensureCustomWorktrees)((0, repoPaths_1.resolveProjectRepos)(project.repos ?? [], (0, environment_1.resolveProjectRepoBranchAssignments)(versionDb, project.repos ?? []), setupRoot));
            problems.forEach(problem => worktreeProblems.add(problem));
        }
        let args;
        try {
            args = await prepareArgs(project, settings, { versionId: version.id });
        }
        catch (error) {
            // A version with no resolvable database is skipped rather than
            // failing the sync for every other version. Only the active one is
            // worth telling the user about.
            if (version.id === activeVersion?.id) {
                logger_1.logger.warn('Could not prepare debugger launch arguments:', error);
                if (error instanceof Error && error.message === 'Select a database before running this action.') {
                    void (0, utils_1.showInfo)('Select a database before configuring the debugger.');
                }
                else {
                    void (0, utils_1.showError)(error instanceof Error ? error.message : 'Could not prepare debugger launch arguments.');
                }
            }
            else {
                logger_1.logger.debug(`Skipping launch entry for "${version.name}": ${(0, logger_1.errorMessage)(error)}`);
            }
            continue;
        }
        try {
            // Only the extension's own entries in launch.json are rewritten;
            // user comments and other configurations are preserved.
            const config = await (0, launchConfig_1.updateManagedLaunchConfig)(workspacePath, {
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
        }
        catch (error) {
            void (0, utils_1.showError)(`Unable to update launch.json: ${(0, logger_1.errorMessage)(error)}`);
            return undefined;
        }
    }
    if (worktreeProblems.size > 0) {
        void (0, utils_1.showWarning)(`Some repositories fell back to their source checkout — ${Array.from(worktreeProblems).join('; ')}`);
    }
    await selectPythonInterpreter(activeSettings.pythonPath);
    return activeConfig;
}
async function prepareArgs(project, settings, options = {}) {
    const isShell = options.isShell === true;
    // Build addons path using settings paths
    const addonsPaths = [];
    const addonPathSet = new Set();
    const addAddonPath = (rawPath) => {
        if (!rawPath) {
            return;
        }
        const normalized = (0, utils_1.normalizePath)(rawPath);
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
    const db = (0, dbResolution_1.resolveDbForVersion)(project.dbs, project.selectedDbByVersion, options.versionId);
    if (!db) {
        throw new Error('Select a database before running this action.');
    }
    const projectModules = db.modules ?? [];
    // psae-internal directories: resolved through the shared service so the
    // Modules tree and the launch args always agree on what is included.
    // Resolve every project repo to the directory this version runs from, so
    // two versions on different branches never share one copy of the code.
    const resolvedRepos = (0, repoPaths_1.resolveProjectRepos)(project.repos ?? [], (0, environment_1.resolveProjectRepoBranchAssignments)(db, project.repos ?? []), (0, setupState_1.readSetupState)().provisioningRoot);
    const discovery = (0, psaeInternal_1.collectModuleDiscovery)(project, resolvedRepos);
    const containerPathMap = new Map();
    const recordContainerPath = (rawContainerPath) => {
        const normalized = (0, utils_1.normalizePath)(rawContainerPath);
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
        }
        else {
            recordContainerPath(path.dirname(moduleInfo.path));
        }
    }
    for (const containerPath of containerPathMap.values()) {
        addAddonPath(containerPath);
    }
    const selectedModuleNames = new Set(projectModules
        .filter(module => module.state === 'install' || module.state === 'upgrade')
        .map(module => module.name));
    let installedModuleNames = new Set();
    try {
        installedModuleNames = await (0, database_1.getInstalledModuleNames)(db.id);
    }
    catch (error) {
        logger_1.logger.warn('Failed to get installed modules from database:', error);
    }
    const psaeStates = (0, psaeInternal_1.resolvePsaeDirectories)({
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
            .map(p => (0, utils_1.normalizePath)(p));
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
            const hasModuleTable = await (0, database_1.databaseHasModuleTable)(db.id);
            if (!hasModuleTable) {
                installs = ['base'];
                if (!baseInstallNotifiedDbs.has(db.id)) {
                    baseInstallNotifiedDbs.add(db.id);
                    (0, utils_1.showAutoInfo)('Added "base" during initialization so the new database can install core tables.', 3000);
                }
            }
        }
        catch (error) {
            logger_1.logger.warn('Failed to verify module table state:', error);
        }
    }
    const args = [];
    if (isShell) {
        args.push('shell', '-p', settings.shellPortNumber.toString());
    }
    else {
        args.push('-p', settings.portNumber.toString());
    }
    args.push('--addons-path', addonsPaths.join(','), '-d', db.id);
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
    args.push('--limit-time-real', settings.limitTimeReal.toString(), '--limit-time-cpu', settings.limitTimeCpu.toString(), '--max-cron-threads', settings.maxCronThreads.toString());
    // Use new testing system from project configuration
    if (project.testingConfig?.isEnabled) {
        args.push('--test-enable');
        // Ensure testingConfig is a proper TestingConfigModel instance
        const testingConfig = (0, testing_1.ensureTestingConfigModel)(project.testingConfig);
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
async function buildOdooCommandLine(isShell = false) {
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        return undefined;
    }
    const { project } = result;
    const versionsService = versionsService_1.VersionsService.getInstance();
    const workspaceSettings = await versionsService.getActiveVersionSettings();
    const normalizedOdooPath = (0, utils_1.normalizePath)(workspaceSettings.odooPath);
    const normalizedPythonPath = (0, utils_1.normalizePath)(workspaceSettings.pythonPath);
    let args;
    try {
        args = await prepareArgs(project, workspaceSettings, {
            isShell,
            versionId: versionsService.getActiveVersion()?.id
        });
    }
    catch (error) {
        if (error instanceof Error) {
            if (error.message === 'Select a database before running this action.') {
                void (0, utils_1.showInfo)('Select a database first.');
            }
            else {
                void (0, utils_1.showError)(error.message);
            }
        }
        else {
            void (0, utils_1.showError)('Could not prepare the Odoo command.');
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
async function startDebugShell() {
    const workspacePath = (0, utils_1.getWorkspacePath)();
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
function quoteShellArg(value) {
    if (/^[\w@%+=:,./-]+$/.test(value)) {
        return value;
    }
    const escapedValue = value.replaceAll("'", String.raw `'\''`);
    return `'${escapedValue}'`;
}
/** Stops one of the extension's running sessions, asking only when ambiguous. */
async function stopDebugServer() {
    const settings = await versionsService_1.VersionsService.getInstance().getActiveVersionSettings();
    const target = (0, debugSessions_1.resolveStopTarget)((0, debugSessions_1.runningDebuggerNames)(), settings.debuggerName);
    if (target.kind === 'none') {
        void (0, utils_1.showInfo)('No Odoo debug session is currently running.');
        return;
    }
    let name;
    if (target.kind === 'single') {
        name = target.name;
    }
    else {
        const picked = await vscode.window.showQuickPick(target.names, {
            title: 'Stop which Odoo server?',
            placeHolder: 'Several versions are running'
        });
        if (!picked) {
            return;
        }
        name = picked;
    }
    const session = (0, debugSessions_1.getSessionByName)(name);
    if (!session) {
        void (0, utils_1.showInfo)('No Odoo debug session is currently running.');
        return;
    }
    await vscode.debug.stopDebugging(session);
}
async function startDebugServer(options = {}) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        void (0, utils_1.showError)("Open a workspace to use this command.");
        return undefined;
    }
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    // Get settings from active version instead of legacy settings
    const versionsService = versionsService_1.VersionsService.getInstance();
    const workspaceSettings = await versionsService.getActiveVersionSettings();
    // Restarting this version stops only this version's session; other
    // versions running side by side must survive.
    const existingSession = (0, debugSessions_1.getSessionByName)(workspaceSettings.debuggerName);
    if (existingSession) {
        await vscode.debug.stopDebugging(existingSession);
    }
    void vscode.debug.startDebugging(workspaceFolders[0], workspaceSettings.debuggerName, { noDebug: options.noDebug === true });
}


/***/ }),
/* 68 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.updateManagedLaunchConfig = updateManagedLaunchConfig;
const fs = __importStar(__webpack_require__(23));
const path = __importStar(__webpack_require__(4));
const jsonc_parser_1 = __webpack_require__(17);
/**
 * Manages the extension's entry in .vscode/launch.json. Only the managed
 * configuration (matched by name) is rewritten - user comments, formatting
 * and other configurations in the file are preserved via jsonc edits.
 */
const EMPTY_LAUNCH_CONTENT = `{
    // For more information, visit: https://go.microsoft.com/fwlink/?linkid=830387
    "version": "0.2.0",

    // The "<debugger name>" entry is managed by the Odoo DevTools extension;
    // it is rewritten whenever the active version, database or modules change.
    "configurations": []
}
`;
/**
 * Updates (or inserts at the top) the launch configuration named
 * `managedConfig.name`, keeping any extra user-added keys on that entry and
 * leaving the rest of launch.json untouched.
 */
async function updateManagedLaunchConfig(workspacePath, managedConfig) {
    const vscodeDir = path.join(workspacePath, '.vscode');
    const launchPath = path.join(vscodeDir, 'launch.json');
    await fs.mkdir(vscodeDir, { recursive: true });
    let raw = await fs.readFile(launchPath, 'utf8').catch(() => EMPTY_LAUNCH_CONTENT);
    let parsed = (0, jsonc_parser_1.parse)(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.configurations)) {
        // Unreadable/malformed file: fall back to a fresh skeleton rather
        // than guessing at edits inside broken JSON.
        raw = EMPTY_LAUNCH_CONTENT;
        parsed = (0, jsonc_parser_1.parse)(raw);
    }
    const configurations = parsed.configurations;
    const existingIndex = configurations.findIndex(conf => conf?.name === managedConfig.name);
    const existing = existingIndex >= 0 ? configurations[existingIndex] : undefined;
    const merged = { ...existing, ...managedConfig };
    const options = { formattingOptions: { tabSize: 4, insertSpaces: true } };
    const edits = existingIndex >= 0
        ? (0, jsonc_parser_1.modify)(raw, ['configurations', existingIndex], merged, options)
        : (0, jsonc_parser_1.modify)(raw, ['configurations', 0], merged, { ...options, isArrayInsertion: true });
    await fs.writeFile(launchPath, (0, jsonc_parser_1.applyEdits)(raw, edits), 'utf8');
    return merged;
}


/***/ }),
/* 69 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.slugifyBranch = slugifyBranch;
exports.resolveProvisionPaths = resolveProvisionPaths;
exports.buildPlan = buildPlan;
exports.isFullySatisfied = isFullySatisfied;
exports.isVersionProvisioned = isVersionProvisioned;
exports.probeProvision = probeProvision;
exports.executeProvision = executeProvision;
/**
 * Provisioning orchestrator. Probes what already exists on disk, plans only
 * the missing steps, and executes those - so a failed run resumes where it
 * stopped and an environment built by hand is adopted rather than rebuilt.
 */
const fs = __importStar(__webpack_require__(2));
const path = __importStar(__webpack_require__(4));
const odooRequirements_1 = __webpack_require__(70);
const worktree_1 = __webpack_require__(35);
const pythonToolchain_1 = __webpack_require__(71);
const systemDeps_1 = __webpack_require__(72);
const logger_1 = __webpack_require__(12);
function samePath(a, b) {
    return path.resolve(a) === path.resolve(b);
}
function slugifyBranch(branch) {
    return branch.replace(/[^A-Za-z0-9._-]+/g, '-');
}
function resolveProvisionPaths(spec) {
    const slug = slugifyBranch(spec.branch);
    return {
        odooPath: path.join(spec.root, `odoo-${slug}`),
        enterprisePath: spec.enterpriseRepoPath ? path.join(spec.root, `enterprise-${slug}`) : undefined,
        designThemesPath: spec.designThemesRepoPath ? path.join(spec.root, `design-themes-${slug}`) : undefined,
        venvPath: path.join(spec.root, `venv-${slug}`)
    };
}
function buildPlan(spec, probe) {
    const mark = (satisfied) => (satisfied ? 'satisfied' : 'needed');
    const steps = [
        { id: 'worktree:odoo', label: `Worktree for odoo (${spec.branch})`, status: mark(probe.odooWorktree) }
    ];
    if (spec.enterpriseRepoPath) {
        steps.push({
            id: 'worktree:enterprise',
            label: `Worktree for enterprise (${spec.branch})`,
            status: mark(probe.enterpriseWorktree)
        });
    }
    if (spec.designThemesRepoPath) {
        steps.push({
            id: 'worktree:design-themes',
            label: `Worktree for design-themes (${spec.branch})`,
            status: mark(probe.designThemesWorktree)
        });
    }
    steps.push({ id: 'venv', label: 'Virtualenv', status: mark(probe.venv) });
    steps.push({ id: 'requirements', label: 'Python requirements', status: mark(probe.requirements) });
    return steps;
}
function isFullySatisfied(plan) {
    return plan.every(step => step.status === 'satisfied');
}
/**
 * A version is provisioned when the interpreter its pythonPath points at
 * actually exists - a fact about the filesystem, never stored state.
 *
 * Callers must pass an unset path through as undefined rather than running it
 * through normalizePath first: `normalizePath('')` yields the workspace root,
 * which exists, and would report an unconfigured version as provisioned.
 */
function isVersionProvisioned(pythonPath) {
    const trimmed = pythonPath?.trim();
    if (!trimmed) {
        return false;
    }
    return fs.existsSync(trimmed);
}
async function probeProvision(spec) {
    const paths = resolveProvisionPaths(spec);
    const venvExists = fs.existsSync((0, pythonToolchain_1.venvPythonPath)(paths.venvPath));
    // Requirements count as installed when the venv can import the packages
    // Odoo cannot start without.
    let requirements = false;
    if (venvExists) {
        const deps = await (0, systemDeps_1.checkSystemDeps)(paths.venvPath);
        requirements = deps.find(entry => entry.id === 'buildDeps')?.present ?? false;
    }
    return {
        odooWorktree: fs.existsSync(path.join(paths.odooPath, 'odoo-bin')),
        enterpriseWorktree: !paths.enterprisePath || fs.existsSync(paths.enterprisePath),
        designThemesWorktree: !paths.designThemesPath || fs.existsSync(paths.designThemesPath),
        venv: venvExists,
        requirements
    };
}
async function executeProvision(spec, progress, token) {
    const paths = resolveProvisionPaths(spec);
    const managedPaths = [];
    const warnings = [];
    fs.mkdirSync(spec.root, { recursive: true });
    progress.report({ message: `Worktree for odoo (${spec.branch})` });
    const odooTree = await (0, worktree_1.ensureWorktree)(spec.sourceRepoPath, spec.branch, paths.odooPath, token);
    if (!samePath(odooTree.path, paths.odooPath)) {
        // An existing worktree for this branch was adopted from elsewhere -
        // usually one built under a previous provisioning root. Say so rather
        // than silently pointing the version at an unexpected directory.
        warnings.push(`This branch already had a worktree at ${odooTree.path}; reused it instead of creating one under ${spec.root}.`);
    }
    paths.odooPath = odooTree.path;
    if (odooTree.created) {
        managedPaths.push(odooTree.path);
    }
    if (spec.enterpriseRepoPath && paths.enterprisePath) {
        progress.report({ message: `Worktree for enterprise (${spec.branch})` });
        try {
            const tree = await (0, worktree_1.ensureWorktree)(spec.enterpriseRepoPath, spec.branch, paths.enterprisePath, token);
            paths.enterprisePath = tree.path;
            if (tree.created) {
                managedPaths.push(tree.path);
            }
        }
        catch (error) {
            warnings.push(`enterprise: ${error instanceof Error ? error.message : String(error)}`);
            paths.enterprisePath = undefined;
        }
    }
    if (spec.designThemesRepoPath && paths.designThemesPath) {
        progress.report({ message: `Worktree for design-themes (${spec.branch})` });
        try {
            const tree = await (0, worktree_1.ensureWorktree)(spec.designThemesRepoPath, spec.branch, paths.designThemesPath, token);
            paths.designThemesPath = tree.path;
            if (tree.created) {
                managedPaths.push(tree.path);
            }
        }
        catch (error) {
            warnings.push(`design-themes: ${error instanceof Error ? error.message : String(error)}`);
            paths.designThemesPath = undefined;
        }
    }
    progress.report({ message: 'Resolving Python interpreter' });
    const window = await (0, odooRequirements_1.readOdooPythonWindow)(paths.odooPath);
    if (window.source === 'fallback') {
        warnings.push(`Could not read this branch's Python requirement; assuming ${window.minPython.join('.')}.`);
    }
    const interpreter = await (0, pythonToolchain_1.ensureInterpreter)(window, token);
    if (interpreter.warning) {
        warnings.push(interpreter.warning);
    }
    const uv = await (0, pythonToolchain_1.resolveUv)();
    if (!uv) {
        warnings.push('uv is not available; using the standard library venv and pip.');
    }
    progress.report({ message: 'Creating virtualenv' });
    await (0, pythonToolchain_1.ensureVenv)(interpreter.path, paths.venvPath, uv, token);
    if (!managedPaths.includes(paths.venvPath)) {
        managedPaths.push(paths.venvPath);
    }
    const requirementsPath = path.join(paths.odooPath, 'requirements.txt');
    const reportLine = (line) => {
        const trimmed = line.trim();
        if (trimmed) {
            progress.report({ message: trimmed.slice(0, 120) });
        }
    };
    progress.report({ message: 'Installing requirements (this takes a few minutes)' });
    let pythonVersion = interpreter.version;
    try {
        await (0, pythonToolchain_1.installRequirements)(paths.venvPath, requirementsPath, uv, reportLine, token);
    }
    catch (error) {
        // Some pins exist only to mirror a distribution package and have no
        // Linux wheel - Odoo 17.0's `gevent==21.8.0` on Python 3.10 is the
        // canonical case, and it cannot be built from source either, because
        // the Cython alpha its build requires is no longer on PyPI. Stepping
        // up one interpreter moves onto pins that do ship wheels.
        const stepUp = (0, pythonToolchain_1.nextInterpreterAbove)(await (0, pythonToolchain_1.discoverInterpreters)(), window, interpreter.version);
        if (!stepUp || token?.isCancellationRequested) {
            throw error;
        }
        logger_1.logger.warn(`[provisioning] requirements failed on Python ${interpreter.version.join('.')}, retrying on ${stepUp.version.join('.')}:`, error);
        warnings.push(`Python ${interpreter.version.join('.')} could not install this branch's requirements ` +
            `(some pins for it ship only as distribution packages, with no Linux wheel). ` +
            `Used Python ${stepUp.version.join('.')} instead.`);
        progress.report({ message: `Retrying on Python ${stepUp.version.join('.')}` });
        fs.rmSync(paths.venvPath, { recursive: true, force: true });
        await (0, pythonToolchain_1.ensureVenv)(stepUp.path, paths.venvPath, uv, token);
        await (0, pythonToolchain_1.installRequirements)(paths.venvPath, requirementsPath, uv, reportLine, token);
        pythonVersion = stepUp.version;
    }
    progress.report({ message: 'Checking system dependencies' });
    const deps = await (0, systemDeps_1.checkSystemDeps)(paths.venvPath);
    logger_1.logger.info(`[provisioning] ${spec.branch} provisioned at ${paths.odooPath}`);
    return {
        paths,
        managedPaths,
        pythonVersion: pythonVersion.join('.'),
        warnings,
        deps
    };
}


/***/ }),
/* 70 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.FALLBACK_MIN_PYTHON = void 0;
exports.parseMinPythonFromSetupPy = parseMinPythonFromSetupPy;
exports.parseMinPythonFromReleasePy = parseMinPythonFromReleasePy;
exports.parseSeriesFromReleasePy = parseSeriesFromReleasePy;
exports.parsePreferredPythonFromRequirements = parsePreferredPythonFromRequirements;
exports.readOdooPythonWindow = readOdooPythonWindow;
/**
 * Reads what Python an Odoo checkout needs, straight from the files the
 * branch itself ships. The floor comes from setup.py's literal
 * `python_requires` (present in 17.0/18.0) or release.py's MIN_PY_VERSION
 * (present in 19.0). The preferred interpreter comes from the distributions
 * named in requirements.txt's header comment.
 */
const fs = __importStar(__webpack_require__(23));
const path = __importStar(__webpack_require__(4));
exports.FALLBACK_MIN_PYTHON = [3, 10];
/**
 * Default `python3` of each distribution Odoo names in its requirements
 * header. Describes distributions, not Odoo, so it only changes when a new
 * release ships.
 */
const DISTRIBUTION_PYTHON = [
    { match: 'ubuntu 20.04', python: [3, 8] },
    { match: 'ubuntu 22.04', python: [3, 10] },
    { match: 'ubuntu 24.04', python: [3, 12] },
    { match: 'debian 11', python: [3, 9] },
    { match: 'debian 12', python: [3, 11] },
    { match: 'debian 13', python: [3, 13] }
];
function parseMinPythonFromSetupPy(content) {
    const match = /python_requires\s*=\s*['"]>=\s*(\d+)\.(\d+)/.exec(content);
    return match ? [Number(match[1]), Number(match[2])] : undefined;
}
function parseMinPythonFromReleasePy(content) {
    const match = /^MIN_PY_VERSION\s*=\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/m.exec(content);
    return match ? [Number(match[1]), Number(match[2])] : undefined;
}
function parseSeriesFromReleasePy(content) {
    const match = /^version_info\s*=\s*\(\s*(\d+)\s*,\s*(\d+)/m.exec(content);
    return match ? `${match[1]}.${match[2]}` : undefined;
}
/** Leading comment block only - later comments are not the header. */
function readHeaderComment(content) {
    const header = [];
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') {
            continue;
        }
        if (!trimmed.startsWith('#')) {
            break;
        }
        header.push(trimmed);
    }
    return header.join(' ').toLowerCase();
}
function parsePreferredPythonFromRequirements(content) {
    const header = readHeaderComment(content);
    let best;
    for (const entry of DISTRIBUTION_PYTHON) {
        if (!header.includes(entry.match)) {
            continue;
        }
        if (!best || entry.python[0] > best[0] || (entry.python[0] === best[0] && entry.python[1] > best[1])) {
            best = entry.python;
        }
    }
    return best;
}
async function readIfPresent(filePath) {
    return fs.readFile(filePath, 'utf-8').catch(() => undefined);
}
async function readOdooPythonWindow(odooPath) {
    const [setupPy, releasePy, requirements] = await Promise.all([
        readIfPresent(path.join(odooPath, 'setup.py')),
        readIfPresent(path.join(odooPath, 'odoo', 'release.py')),
        readIfPresent(path.join(odooPath, 'requirements.txt'))
    ]);
    const fromSetup = setupPy ? parseMinPythonFromSetupPy(setupPy) : undefined;
    const fromRelease = releasePy ? parseMinPythonFromReleasePy(releasePy) : undefined;
    let minPython = exports.FALLBACK_MIN_PYTHON;
    let source = 'fallback';
    if (fromSetup) {
        minPython = fromSetup;
        source = 'setup.py';
    }
    else if (fromRelease) {
        minPython = fromRelease;
        source = 'release.py';
    }
    return {
        series: releasePy ? parseSeriesFromReleasePy(releasePy) : undefined,
        minPython,
        preferredPython: requirements ? parsePreferredPythonFromRequirements(requirements) : undefined,
        source
    };
}


/***/ }),
/* 71 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parsePythonVersion = parsePythonVersion;
exports.isAbovePreferred = isAbovePreferred;
exports.rankInterpreters = rankInterpreters;
exports.nextInterpreterAbove = nextInterpreterAbove;
exports.venvPythonPath = venvPythonPath;
exports.discoverInterpreters = discoverInterpreters;
exports.resolveUv = resolveUv;
exports.ensureInterpreter = ensureInterpreter;
exports.ensureVenv = ensureVenv;
exports.installRequirements = installRequirements;
/**
 * Locating and ranking Python interpreters for a version, and building that
 * version's virtualenv. Ranking is the part with judgement in it, so it is
 * pure and tested; discovery and venv creation shell out through runCommand.
 */
const fs = __importStar(__webpack_require__(2));
const os = __importStar(__webpack_require__(37));
const path = __importStar(__webpack_require__(4));
const vscode = __importStar(__webpack_require__(1));
const process_1 = __webpack_require__(13);
const logger_1 = __webpack_require__(12);
/** Minor versions probed on PATH as `python3.<minor>`. */
const PROBED_MINORS = [8, 9, 10, 11, 12, 13, 14];
function parsePythonVersion(output) {
    const match = /Python\s+(\d+)\.(\d+)/.exec(output);
    return match ? [Number(match[1]), Number(match[2])] : undefined;
}
function compare(a, b) {
    return a[0] - b[0] || a[1] - b[1];
}
function isAbovePreferred(interpreter, window) {
    return !!window.preferredPython && compare(interpreter.version, window.preferredPython) > 0;
}
/**
 * Orders interpreters best-first for the given window. Anything below the
 * floor is unusable and is excluded entirely, so the first entry is always
 * safe to use - or the list is empty and one must be installed.
 *
 * Above the branch's target, *closest* wins rather than newest: running a
 * branch on a much newer Python than it was written for causes failures at
 * server initialization, and the further above the target you go the more
 * likely that is. Odoo 17.0 with 3.12 and 3.14 present should pick 3.12.
 */
function rankInterpreters(found, window) {
    const usable = found.filter(entry => compare(entry.version, window.minPython) >= 0);
    const tier = (entry) => {
        if (!window.preferredPython) {
            return 0;
        }
        const delta = compare(entry.version, window.preferredPython);
        if (delta === 0) {
            return 0;
        }
        return delta < 0 ? 1 : 2;
    };
    return [...usable].sort((a, b) => {
        const tierA = tier(a);
        const tierB = tier(b);
        if (tierA !== tierB) {
            return tierA - tierB;
        }
        // Above the target, the closest one wins; otherwise newest.
        return tierA === 2 ? compare(a.version, b.version) : compare(b.version, a.version);
    });
}
/**
 * The next usable interpreter above `current`, for stepping up after a
 * requirements install fails. Some pins only exist to mirror a distribution
 * package and have no Linux wheel - Odoo 17.0's `gevent==21.8.0` on Python
 * 3.10 is the canonical case, and it cannot be built from source either, since
 * the Cython alpha its build requires is gone from PyPI.
 */
function nextInterpreterAbove(found, window, current) {
    return rankInterpreters(found, window)
        .filter(entry => compare(entry.version, current) > 0)
        .sort((a, b) => compare(a.version, b.version))[0];
}
function venvPythonPath(venvPath) {
    return process.platform === 'win32'
        ? path.join(venvPath, 'Scripts', 'python.exe')
        : path.join(venvPath, 'bin', 'python');
}
async function probeInterpreter(candidate) {
    // tryRunCommand yields trimmed stdout, which is where Python 3 prints its
    // version; an empty string means it ran but said nothing useful.
    const output = await (0, process_1.tryRunCommand)(candidate, ['--version']);
    if (output === undefined) {
        return undefined;
    }
    const version = parsePythonVersion(output);
    return version ? { path: candidate, version } : undefined;
}
/** Candidate interpreters: PATH entries plus any pyenv-managed builds. */
function candidatePaths() {
    const candidates = PROBED_MINORS.map(minor => `python3.${minor}`);
    candidates.push('python3');
    const pyenvVersions = path.join(os.homedir(), '.pyenv', 'versions');
    if (fs.existsSync(pyenvVersions)) {
        for (const entry of fs.readdirSync(pyenvVersions)) {
            candidates.push(path.join(pyenvVersions, entry, 'bin', 'python'));
        }
    }
    return candidates;
}
async function discoverInterpreters() {
    const probed = await Promise.all(candidatePaths().map(probeInterpreter));
    const seen = new Set();
    const found = [];
    for (const entry of probed) {
        if (!entry) {
            continue;
        }
        const key = `${entry.version[0]}.${entry.version[1]}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        found.push(entry);
    }
    return found;
}
/**
 * Locates uv: the configured path, then PATH. When uv is absent the caller
 * falls back to the standard library venv and pip, so a missing uv degrades
 * rather than failing.
 */
async function resolveUv() {
    const configured = vscode.workspace
        .getConfiguration('odooDebugger.provisioning')
        .get('uvPath', '')
        .trim();
    const candidates = configured ? [configured, 'uv'] : ['uv'];
    for (const candidate of candidates) {
        if (await (0, process_1.tryRunCommand)(candidate, ['--version']) !== undefined) {
            return candidate;
        }
    }
    return undefined;
}
/**
 * Returns an interpreter satisfying the version's window, installing one via
 * uv when nothing on the machine qualifies. The warning names a mismatch when
 * the best available interpreter is newer than what the branch targets.
 */
async function ensureInterpreter(window, token) {
    const ranked = rankInterpreters(await discoverInterpreters(), window);
    if (ranked.length > 0) {
        const best = ranked[0];
        const warning = isAbovePreferred(best, window) && window.preferredPython
            ? `This branch targets Python ${window.preferredPython.join('.')}; using ${best.version.join('.')}.`
            : undefined;
        return { path: best.path, version: best.version, warning };
    }
    const wanted = window.preferredPython ?? window.minPython;
    const uv = await resolveUv();
    if (!uv) {
        throw new Error(`No installed Python satisfies this branch (needs ${window.minPython.join('.')} or newer). ` +
            `Install Python ${wanted.join('.')}, or install uv so it can be provisioned automatically.`);
    }
    const target = wanted.join('.');
    logger_1.logger.info(`[provisioning] installing Python ${target} via uv`);
    await (0, process_1.runCommand)(uv, ['python', 'install', target], { token });
    const rankedAfter = rankInterpreters(await discoverInterpreters(), window);
    if (rankedAfter.length > 0) {
        return { path: rankedAfter[0].path, version: rankedAfter[0].version };
    }
    // uv-managed builds are not always on PATH; ask uv where it put it.
    const found = await (0, process_1.tryRunCommand)(uv, ['python', 'find', target], { token });
    if (!found) {
        throw new Error(`uv installed Python ${target} but the interpreter could not be located.`);
    }
    return { path: found, version: wanted };
}
async function ensureVenv(pythonPath, venvPath, uvPath, token) {
    const interpreter = venvPythonPath(venvPath);
    if (fs.existsSync(interpreter)) {
        return interpreter;
    }
    if (uvPath) {
        await (0, process_1.runCommand)(uvPath, ['venv', '--python', pythonPath, venvPath], { token });
    }
    else {
        await (0, process_1.runCommand)(pythonPath, ['-m', 'venv', venvPath], { token });
    }
    return interpreter;
}
async function installRequirements(venvPath, requirementsPath, uvPath, onLine, token) {
    const interpreter = venvPythonPath(venvPath);
    if (uvPath) {
        await (0, process_1.runCommand)(uvPath, ['pip', 'install', '--python', interpreter, '-r', requirementsPath], {
            token,
            onStdoutLine: onLine,
            onStderrLine: onLine
        });
        return;
    }
    await (0, process_1.runCommand)(interpreter, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'], {
        token,
        onStdoutLine: onLine,
        onStderrLine: onLine
    });
    await (0, process_1.runCommand)(interpreter, ['-m', 'pip', 'install', '-r', requirementsPath], {
        token,
        onStdoutLine: onLine,
        onStderrLine: onLine
    });
}


/***/ }),
/* 72 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.detectPlatform = detectPlatform;
exports.installHintFor = installHintFor;
exports.summarizeMissing = summarizeMissing;
exports.checkSystemDeps = checkSystemDeps;
/**
 * Detects the non-Python dependencies an Odoo server needs and reports what
 * breaks without each. Reports and suggests only: nothing here executes an
 * installer or escalates privileges.
 */
const fs = __importStar(__webpack_require__(2));
const process_1 = __webpack_require__(13);
const pythonToolchain_1 = __webpack_require__(71);
const INSTALL_HINTS = {
    wkhtmltopdf: {
        apt: 'sudo apt install wkhtmltopdf',
        dnf: 'sudo dnf install wkhtmltopdf',
        brew: 'brew install --cask wkhtmltopdf'
    },
    psql: {
        apt: 'sudo apt install postgresql-client',
        dnf: 'sudo dnf install postgresql',
        brew: 'brew install libpq'
    },
    rtlcss: {
        apt: 'sudo npm install -g rtlcss',
        dnf: 'sudo npm install -g rtlcss',
        brew: 'npm install -g rtlcss'
    },
    buildDeps: {
        apt: 'sudo apt install libxml2-dev libxslt1-dev libldap2-dev libsasl2-dev libssl-dev python3-dev',
        dnf: 'sudo dnf install libxml2-devel libxslt-devel openldap-devel cyrus-sasl-devel openssl-devel python3-devel',
        brew: 'brew install libxmlsec1 openldap'
    }
};
function detectPlatform() {
    if (process.platform === 'win32') {
        return 'windows';
    }
    if (process.platform === 'darwin') {
        return 'brew';
    }
    if (fs.existsSync('/usr/bin/apt') || fs.existsSync('/usr/bin/apt-get')) {
        return 'apt';
    }
    if (fs.existsSync('/usr/bin/dnf')) {
        return 'dnf';
    }
    return 'unknown';
}
function installHintFor(id, platform) {
    return INSTALL_HINTS[id]?.[platform];
}
function summarizeMissing(reports) {
    const missing = reports.filter(entry => !entry.present);
    if (missing.length === 0) {
        return undefined;
    }
    return missing.map(entry => `${entry.label}: ${entry.impact}`).join('; ');
}
async function onPath(command, args = ['--version']) {
    return (await (0, process_1.tryRunCommand)(command, args)) !== undefined;
}
async function canImport(venvPath, moduleName) {
    const interpreter = (0, pythonToolchain_1.venvPythonPath)(venvPath);
    if (!fs.existsSync(interpreter)) {
        return false;
    }
    return (await (0, process_1.tryRunCommand)(interpreter, ['-c', `import ${moduleName}`])) !== undefined;
}
async function checkSystemDeps(venvPath) {
    const platform = detectPlatform();
    const reports = [];
    const add = (id, label, present, impact) => {
        reports.push({ id, label, present, impact, installHint: present ? undefined : installHintFor(id, platform) });
    };
    add('wkhtmltopdf', 'wkhtmltopdf', await onPath('wkhtmltopdf'), 'PDF reports will fail; everything else works');
    add('psql', 'PostgreSQL client tools', await onPath('psql'), 'Database features are unavailable');
    add('rtlcss', 'rtlcss', await onPath('rtlcss'), 'Right-to-left stylesheets are not generated');
    if (venvPath) {
        const missingModules = [];
        for (const moduleName of ['lxml', 'psycopg2', 'ldap']) {
            if (!(await canImport(venvPath, moduleName))) {
                missingModules.push(moduleName);
            }
        }
        add('buildDeps', `Python modules (${missingModules.join(', ') || 'all present'})`, missingModules.length === 0, 'The server will not start; build headers are probably missing');
    }
    return reports;
}


/***/ }),
/* 73 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ensureCustomWorktrees = ensureCustomWorktrees;
/**
 * Creates the worktrees a set of resolved repositories needs, resolving the
 * "source checkout holds this branch" conflict with the user rather than
 * around them. Never detaches silently and never stashes.
 */
const vscode = __importStar(__webpack_require__(1));
const process_1 = __webpack_require__(13);
const logger_1 = __webpack_require__(12);
const notifications_1 = __webpack_require__(16);
const branches_1 = __webpack_require__(32);
const worktree_1 = __webpack_require__(35);
const gitService_1 = __webpack_require__(11);
const sourceConflict_1 = __webpack_require__(74);
async function dirtyFiles(repoPath) {
    const stdout = await (0, process_1.tryRunCommand)('git', ['status', '--porcelain'], { cwd: repoPath });
    return stdout === undefined ? [] : (0, sourceConflict_1.parsePorcelainStatus)(stdout);
}
/** Branches the source could move to, excluding the one being freed. */
async function pickOtherBranch(sourcePath, exclude) {
    const names = (await (0, gitService_1.listAllBranches)(sourcePath)).filter(name => name !== exclude);
    if (names.length === 0) {
        void (0, notifications_1.showWarning)(`"${sourcePath}" has no other branch to move to. Detach it instead, or create a branch first.`);
        return undefined;
    }
    return vscode.window.showQuickPick(names, {
        title: `Move this checkout off "${exclude}"`,
        placeHolder: 'Pick the branch the source checkout should sit on',
        ignoreFocusOut: true
    });
}
/**
 * Frees `branch` from the source checkout, asking first. Returns true when the
 * branch is available afterwards.
 */
async function freeBranch(sourcePath, repoName, branch) {
    const conflict = (0, sourceConflict_1.classifySourceConflict)(await (0, branches_1.getRepoBranch)(sourcePath), branch, await dirtyFiles(sourcePath));
    if (conflict.kind === 'none') {
        return true;
    }
    const message = (0, sourceConflict_1.describeSourceConflict)(conflict, repoName);
    if (conflict.kind === 'dirty') {
        void (0, notifications_1.showWarning)(message);
        return false;
    }
    // Moving is offered first: it leaves the checkout on a branch, so pull
    // works and tooling that rejects a detached HEAD keeps working.
    const choice = await (0, notifications_1.showModalWarning)(message, 'Move to Another Branch', 'Detach It');
    if (choice === 'Move to Another Branch') {
        const target = await pickOtherBranch(sourcePath, branch);
        if (!target) {
            return false;
        }
        await (0, process_1.runCommand)('git', ['switch', target], { cwd: sourcePath });
        logger_1.logger.info(`[worktree] moved ${sourcePath} to ${target} to free ${branch}`);
        return true;
    }
    if (choice !== 'Detach It') {
        return false;
    }
    await (0, process_1.runCommand)('git', ['checkout', '--detach'], { cwd: sourcePath });
    logger_1.logger.info(`[worktree] detached ${sourcePath} to free ${branch}`);
    return true;
}
/**
 * Ensures every worktree-mode entry has its directory. Entries that cannot be
 * satisfied are reported and fall back to their source checkout, so one
 * problem repo never blocks the rest of the project.
 */
async function ensureCustomWorktrees(resolved, token) {
    const ready = [];
    const problems = [];
    for (const entry of resolved) {
        if (!entry.isWorktree || !entry.branch) {
            ready.push(entry);
            continue;
        }
        const sourcePath = entry.repo.path;
        try {
            if (!(await freeBranch(sourcePath, entry.repo.name, entry.branch))) {
                problems.push(`${entry.repo.name}: could not free "${entry.branch}" from its source checkout`);
                ready.push({ ...entry, path: sourcePath, isWorktree: false });
                continue;
            }
            const result = await (0, worktree_1.ensureRealBranchWorktree)(sourcePath, entry.branch, entry.path, token);
            ready.push({ ...entry, path: result.path });
        }
        catch (error) {
            logger_1.logger.error(`[worktree] ${entry.repo.name}:`, error);
            problems.push(`${entry.repo.name}: ${(0, logger_1.errorMessage)(error)}`);
            ready.push({ ...entry, path: sourcePath, isWorktree: false });
        }
    }
    return { ready, problems };
}


/***/ }),
/* 74 */
/***/ ((__unused_webpack_module, exports) => {


/**
 * git will not check one branch out in two places. Odoo core worktrees dodge
 * this with a managed `odt/<branch>` alias, but custom code is committed and
 * pushed, so its worktrees must hold the real branch - which means the source
 * checkout has to let go of it first.
 *
 * Deciding that is pure and lives here; doing it is the caller's job, and only
 * ever with the user's explicit confirmation.
 */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.classifySourceConflict = classifySourceConflict;
exports.describeSourceConflict = describeSourceConflict;
exports.parsePorcelainStatus = parsePorcelainStatus;
function classifySourceConflict(sourceBranch, targetBranch, dirtyFiles) {
    if (!sourceBranch || sourceBranch !== targetBranch) {
        return { kind: 'none' };
    }
    return dirtyFiles.length > 0
        ? { kind: 'dirty', branch: targetBranch, files: dirtyFiles }
        : { kind: 'movable', branch: targetBranch };
}
function describeSourceConflict(conflict, repoName) {
    if (conflict.kind === 'none') {
        return '';
    }
    const why = `git can only check a branch out in one place, and this version needs "${conflict.branch}" in its own worktree.`;
    if (conflict.kind === 'movable') {
        // Both consequences below were verified by experiment. The first
        // contradicts an earlier draft of the design, which claimed detaching
        // was reversible with one `git switch`; it is not.
        return `Your checkout of "${repoName}" is on "${conflict.branch}". ${why}\n\n`
            + `Moving it to another branch is recommended: it keeps working normally.\n\n`
            + `Detaching it instead keeps the same commit and files, but the checkout cannot return `
            + `to "${conflict.branch}" until the worktree is removed, and any commit you make there `
            + `would belong to no branch — only the reflog would find it.`;
    }
    const shown = conflict.files.slice(0, 5).join(', ');
    const more = conflict.files.length > 5 ? `, and ${conflict.files.length - 5} more` : '';
    return `Your checkout of "${repoName}" is on "${conflict.branch}" with uncommitted changes (${shown}${more}). `
        + `${why} Commit or stash them first - which of the two is your call, not the extension's.`;
}
/** Changed paths from `git status --porcelain`, staged and unstaged alike. */
function parsePorcelainStatus(stdout) {
    const paths = [];
    for (const rawLine of stdout.split('\n')) {
        // Status codes occupy the first two columns; the path follows a space.
        const line = rawLine.slice(3).trim();
        if (!line) {
            continue;
        }
        // Renames and copies report "old -> new"; the new path is the live one.
        const arrow = line.indexOf(' -> ');
        paths.push(arrow >= 0 ? line.slice(arrow + 4).trim() : line);
    }
    return paths;
}


/***/ }),
/* 75 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.VersionsTreeProvider = exports.VersionSettingTreeItem = exports.VersionTreeItem = void 0;
/**
 * Versions view: version profiles with their settings as editable children.
 */
const vscode = __importStar(__webpack_require__(1));
const versionsService_1 = __webpack_require__(24);
const utils_1 = __webpack_require__(8);
const provisioning_1 = __webpack_require__(69);
const runningState_1 = __webpack_require__(50);
const icons_1 = __webpack_require__(30);
const sortOptions_1 = __webpack_require__(29);
const logger_1 = __webpack_require__(12);
const baseTreeProvider_1 = __webpack_require__(5);
const versionIdentity_1 = __webpack_require__(27);
/** Provisioned state for the tree description, from the shared predicate. */
function provisioningLabel(version) {
    return (0, provisioning_1.isVersionProvisioned)((0, utils_1.resolveOptionalPath)(version.settings.pythonPath))
        ? 'provisioned'
        : 'not provisioned';
}
class VersionTreeItem extends vscode.TreeItem {
    version;
    collapsibleState;
    running;
    constructor(version, collapsibleState, running) {
        super(version.name, collapsibleState);
        this.version = version;
        this.collapsibleState = collapsibleState;
        this.running = running;
        this.id = version.id;
        this.tooltip = VersionTreeItem.buildTooltip(version, running);
        // The port is always visible: with several versions runnable at once,
        // knowing which localhost to open is the first thing you need.
        const parts = [version.odooVersion];
        if (version.settings.portNumber) {
            parts.push(`:${version.settings.portNumber}`);
        }
        parts.push(running ? 'running' : provisioningLabel(version));
        this.description = parts.join(' \u2022 ');
        this.contextValue = version.isActive ? 'activeVersion' : 'version';
        this.iconPath = version.isActive ? icons_1.activeIcon : new vscode.ThemeIcon('versions');
        // Add command to switch to this version when clicked
        this.command = {
            command: 'odoo.setActiveVersion',
            title: '',
            arguments: [version.id]
        };
    }
    static buildTooltip(version, running) {
        const lines = [
            `**${version.name}**${version.isActive ? ' (active)' : ''}`,
            `**Odoo Version:** ${version.odooVersion}`
        ];
        const settings = version.settings ?? {};
        if (running) {
            lines.push(`**Status:** running${running.dbName ? ` on \`${running.dbName}\`` : ''}`);
        }
        if (settings.portNumber) {
            lines.push(`**Port:** ${settings.portNumber} \u2014 http://localhost:${settings.portNumber}`);
        }
        if (settings.shellPortNumber) {
            lines.push(`**Shell Port:** ${settings.shellPortNumber}`);
        }
        if (settings.odooPath) {
            lines.push(`**Odoo Path:** ${settings.odooPath}`);
        }
        if (settings.pythonPath) {
            lines.push(`**Python:** ${settings.pythonPath}`);
        }
        if (settings.customAddonsPath) {
            lines.push(`**Custom Addons:** ${settings.customAddonsPath}`);
        }
        return new vscode.MarkdownString(lines.join('\n\n'));
    }
}
exports.VersionTreeItem = VersionTreeItem;
class VersionSettingTreeItem extends vscode.TreeItem {
    key;
    value;
    versionId;
    constructor(key, value, versionId) {
        const displayName = (0, utils_1.getSettingDisplayName)(key);
        const displayValue = (0, utils_1.getSettingDisplayValue)(key, value);
        super(`${displayName}: ${displayValue}`, vscode.TreeItemCollapsibleState.None);
        this.key = key;
        this.value = value;
        this.versionId = versionId;
        this.id = `${versionId}:${key}`;
        this.tooltip = `${displayName}: ${displayValue}`;
        this.contextValue = 'versionSetting';
        // Set appropriate icon based on setting type
        if (key === 'portNumber' || key === 'shellPortNumber') {
            this.iconPath = new vscode.ThemeIcon('plug');
        }
        else if (key === 'debuggerName' || key === 'debuggerVersion') {
            this.iconPath = new vscode.ThemeIcon('debug');
        }
        else if (key === 'devMode') {
            this.iconPath = new vscode.ThemeIcon('tools');
        }
        else if (key === 'limitTimeReal' || key === 'limitTimeCpu') {
            this.iconPath = new vscode.ThemeIcon('clock');
        }
        else if (key === 'maxCronThreads') {
            this.iconPath = new vscode.ThemeIcon('server-process');
        }
        else if (key === 'pythonPath') {
            this.iconPath = new vscode.ThemeIcon('terminal');
        }
        else if (key === 'extraParams') {
            this.iconPath = new vscode.ThemeIcon('settings-gear');
        }
        else if (key === 'installApps' || key === 'upgradeApps') {
            this.iconPath = new vscode.ThemeIcon('package');
        }
        else if (key.includes('Path') || key.includes('Dir') || key === 'dumpsFolder') {
            this.iconPath = new vscode.ThemeIcon('folder');
        }
        else {
            this.iconPath = new vscode.ThemeIcon('gear');
        }
        // Derived identity is shown but never editable: it is a function of
        // the version's branch, and editing it would let two versions collide.
        if ((0, versionIdentity_1.isDerivedSetting)(key)) {
            this.contextValue = 'versionSettingDerived';
            this.description = 'derived from branch';
            this.tooltip = `${displayName}: ${displayValue}\n\nDerived from the version's branch (${key}). Not editable.`;
            return;
        }
        this.command = {
            command: 'odoo.editVersionSetting',
            title: 'Edit Setting',
            arguments: [versionId, key, value]
        };
    }
}
exports.VersionSettingTreeItem = VersionSettingTreeItem;
class VersionsTreeProvider extends baseTreeProvider_1.BaseTreeProvider {
    sortPreferences;
    versionsService;
    constructor(sortPreferences) {
        super();
        this.sortPreferences = sortPreferences;
        this.versionsService = versionsService_1.VersionsService.getInstance();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (!element) {
            // Root level - show versions
            return this.versionsService.initialize().then(async () => {
                const sortId = this.sortPreferences.get('versionsManager', (0, sortOptions_1.getDefaultSortOption)('versionsManager'));
                const versions = this.versionsService.getVersions().slice().sort((a, b) => this.compareVersions(a, b, sortId));
                // Probed once per refresh, not once per row.
                const running = new Map((await (0, runningState_1.getRunningInstances)())
                    .filter(instance => !!instance.versionId)
                    .map(instance => [instance.versionId, instance]));
                return versions.map(version => new VersionTreeItem(version, vscode.TreeItemCollapsibleState.Collapsed, running.get(version.id)));
            }).catch(error => {
                logger_1.logger.error('Failed to load versions for tree view:', error);
                return [];
            });
        }
        else if (element instanceof VersionTreeItem) {
            // Show settings for this version
            const settings = element.version.settings;
            const settingItems = [];
            Object.entries(settings).forEach(([key, value]) => {
                settingItems.push(new VersionSettingTreeItem(key, value, element.version.id));
            });
            return Promise.resolve(settingItems);
        }
        return Promise.resolve([]);
    }
    getParent(element) {
        if (element instanceof VersionSettingTreeItem) {
            // Find the parent version
            const versions = this.versionsService.getVersions();
            const parentVersion = versions.find(v => v.id === element.versionId);
            if (parentVersion) {
                return new VersionTreeItem(parentVersion, vscode.TreeItemCollapsibleState.Collapsed);
            }
        }
        return undefined;
    }
    compareVersions(a, b, sortId) {
        const activeDelta = Number(b.isActive) - Number(a.isActive);
        if (activeDelta !== 0) {
            return activeDelta;
        }
        switch (sortId) {
            case 'version:name:asc':
                return a.name.localeCompare(b.name);
            case 'version:name:desc':
                return b.name.localeCompare(a.name);
            case 'version:created:newest':
                return this.getTimestamp(b.createdAt) - this.getTimestamp(a.createdAt);
            case 'version:created:oldest':
                return this.getTimestamp(a.createdAt) - this.getTimestamp(b.createdAt);
            case 'version:odoo:asc':
                return a.odooVersion.localeCompare(b.odooVersion);
            case 'version:odoo:desc':
                return b.odooVersion.localeCompare(a.odooVersion);
            default:
                return a.name.localeCompare(b.name);
        }
    }
    getTimestamp(value) {
        return value instanceof Date ? value.getTime() : new Date(value).getTime();
    }
}
exports.VersionsTreeProvider = VersionsTreeProvider;


/***/ }),
/* 76 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.getActiveServerPort = getActiveServerPort;
exports.pickPortForDatabase = pickPortForDatabase;
exports.buildServerUrl = buildServerUrl;
exports.waitForPort = waitForPort;
exports.resolvePortForDatabase = resolvePortForDatabase;
exports.openServerInBrowser = openServerInBrowser;
exports.registerServerLifecycle = registerServerLifecycle;
/**
 * Server URL helpers: resolves the local Odoo URL from the active
 * version's port setting and opens databases in the browser, optionally
 * waiting for the HTTP port to accept connections first.
 */
const vscode = __importStar(__webpack_require__(1));
const net = __importStar(__webpack_require__(28));
const versionsService_1 = __webpack_require__(24);
const logger_1 = __webpack_require__(12);
const notifications_1 = __webpack_require__(16);
const runningState_1 = __webpack_require__(50);
const debugSessions_1 = __webpack_require__(51);
const DEFAULT_ODOO_PORT = 8069;
/** Port the Odoo server listens on, from the active version's settings. */
async function getActiveServerPort() {
    try {
        const settings = await versionsService_1.VersionsService.getInstance().getActiveVersionSettings();
        const port = Number(settings.portNumber);
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
            return port;
        }
    }
    catch (error) {
        logger_1.logger.debug('Could not read active version port, using default:', error);
    }
    return DEFAULT_ODOO_PORT;
}
/**
 * Which port serves `dbId`. With several versions running, the active
 * version's port is usually the wrong answer: a database belongs to the
 * version that is actually serving it.
 */
function pickPortForDatabase(dbId, running, versions, dbVersionId, activePort) {
    const byId = (id) => versions.find(version => version.id === id);
    if (dbId) {
        const live = running.find(instance => instance.dbName === dbId && !!instance.port);
        if (live?.port) {
            return { port: live.port, source: 'running', versionName: byId(live.versionId)?.name };
        }
    }
    const owner = byId(dbVersionId);
    if (owner?.portNumber) {
        return { port: owner.portNumber, source: 'version', versionName: owner.name };
    }
    return { port: activePort, source: 'active' };
}
/** Local server URL, optionally routed straight into a database. */
function buildServerUrl(port, dbName) {
    const base = `http://localhost:${port}`;
    if (!dbName) {
        return vscode.Uri.parse(base);
    }
    return vscode.Uri.parse(`${base}/web?db=${encodeURIComponent(dbName)}`);
}
/** Resolves true once the port accepts a TCP connection, false on timeout. */
function waitForPort(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const tryOnce = () => new Promise(resolve => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        const finish = (result) => {
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(1000, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
    return (async () => {
        while (Date.now() < deadline) {
            if (await tryOnce()) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        return false;
    })();
}
/** Resolves the port serving `dbId`, consulting live sessions first. */
async function resolvePortForDatabase(dbId, dbVersionId) {
    try {
        const service = versionsService_1.VersionsService.getInstance();
        await service.initialize();
        const versions = service.getVersions().map(version => ({
            id: version.id,
            name: version.name,
            portNumber: Number(version.settings.portNumber) || undefined
        }));
        return pickPortForDatabase(dbId, await (0, runningState_1.getRunningInstances)(), versions, dbVersionId, await getActiveServerPort());
    }
    catch (error) {
        logger_1.logger.debug('Could not resolve the port for a database, using the active version:', error);
        return { port: await getActiveServerPort(), source: 'active' };
    }
}
/**
 * Opens the Odoo web client for the given (or server-selected) database, on
 * the port actually serving it. A dead port is reported rather than opened:
 * a browser tab showing a connection error is worse than being told why.
 */
async function openServerInBrowser(dbName, dbVersionId) {
    const resolved = await resolvePortForDatabase(dbName, dbVersionId);
    const url = buildServerUrl(resolved.port, dbName);
    if (await waitForPort(resolved.port, 400)) {
        await vscode.env.openExternal(url);
        return;
    }
    const target = resolved.versionName
        ? `${resolved.versionName} (port ${resolved.port})`
        : `port ${resolved.port}`;
    const choice = await (0, notifications_1.showWarning)(`No Odoo server is answering on ${target}.`, 'Open Anyway');
    if (choice === 'Open Anyway') {
        await vscode.env.openExternal(url);
    }
}
/** The version whose launch configuration this session was started from. */
async function versionForSession(session) {
    const name = session.configuration?.name;
    if (typeof name !== 'string' || name.length === 0) {
        return undefined;
    }
    try {
        const service = versionsService_1.VersionsService.getInstance();
        await service.initialize();
        const version = service.getVersions().find(entry => entry.settings?.debuggerName === name);
        if (!version) {
            return undefined;
        }
        const port = Number(version.settings.portNumber);
        return { portNumber: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_ODOO_PORT };
    }
    catch {
        return undefined;
    }
}
/**
 * Tracks the extension's own debug session: maintains the
 * 'odoo-debugger.server_running' context key and, when
 * odooDebugger.server.openBrowserOnStart is enabled, opens the web
 * client once the server port starts accepting connections.
 */
function registerServerLifecycle(context, hooks) {
    context.subscriptions.push(vscode.debug.onDidStartDebugSession(async (session) => {
        const version = await versionForSession(session);
        if (!version) {
            return;
        }
        (0, debugSessions_1.trackSession)(session);
        hooks.onRunningChanged((0, debugSessions_1.anySessionRunning)());
        const openBrowser = vscode.workspace
            .getConfiguration('odooDebugger')
            .get('server.openBrowserOnStart', false);
        if (!openBrowser) {
            return;
        }
        // The session's own port, not the active version's: another version
        // may have been activated since this one was launched.
        if (await waitForPort(version.portNumber, 60000)) {
            const dbName = await hooks.getSelectedDbName();
            await vscode.env.openExternal(buildServerUrl(version.portNumber, dbName));
        }
        else {
            logger_1.logger.debug(`Server port ${version.portNumber} did not open within 60s; not opening browser.`);
        }
    }));
    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
        (0, debugSessions_1.untrackSession)(session);
        hooks.onRunningChanged((0, debugSessions_1.anySessionRunning)());
    }));
}


/***/ }),
/* 77 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.SortPreferences = void 0;
class SortPreferences {
    workspaceState;
    prefix = 'odooDebugger.sort.';
    constructor(workspaceState) {
        this.workspaceState = workspaceState;
    }
    get(viewId, fallback) {
        return this.workspaceState.get(`${this.prefix}${viewId}`, fallback) ?? fallback;
    }
    async set(viewId, optionId) {
        await this.workspaceState.update(`${this.prefix}${viewId}`, optionId);
    }
}
exports.SortPreferences = SortPreferences;


/***/ }),
/* 78 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ProjectReposExplorerProvider = void 0;
exports.createNewFile = createNewFile;
exports.createNewFolder = createNewFolder;
exports.renameEntry = renameEntry;
exports.selectProjectForExplorer = selectProjectForExplorer;
/**
 * Project Repos view (Explorer sidebar): a project-scoped file tree with
 * file operations, file watchers, branch display and missing-path detection.
 */
const vscode = __importStar(__webpack_require__(1));
const path = __importStar(__webpack_require__(4));
const settingsStore_1 = __webpack_require__(6);
const utils_1 = __webpack_require__(8);
const runtimeCache_1 = __webpack_require__(15);
const filesExclude_1 = __webpack_require__(79);
const baseTreeProvider_1 = __webpack_require__(5);
const sortOptions_1 = __webpack_require__(29);
const branches_1 = __webpack_require__(32);
const repoPaths_1 = __webpack_require__(60);
const environment_1 = __webpack_require__(31);
const setupState_1 = __webpack_require__(64);
const dumpImport_1 = __webpack_require__(45);
class ProjectReposExplorerProvider extends baseTreeProvider_1.BaseTreeProvider {
    sortPreferences;
    watchers = [];
    watcherKey = '';
    refreshDebounceTimer;
    constructor(sortPreferences) {
        super();
        this.sortPreferences = sortPreferences;
    }
    scheduleRefresh() {
        if (this.refreshDebounceTimer) {
            clearTimeout(this.refreshDebounceTimer);
        }
        this.refreshDebounceTimer = setTimeout(() => {
            this.refreshDebounceTimer = undefined;
            this.refresh();
        }, 200);
    }
    shouldIgnoreWatcherPath(fsPath) {
        const normalized = fsPath.replace(/\\/g, '/');
        const ignoredFragments = ['/.git/', '/node_modules/', '/.venv/', '/__pycache__/'];
        if (ignoredFragments.some(fragment => normalized.includes(fragment))) {
            return true;
        }
        return normalized.endsWith('/.git') || normalized.endsWith('/node_modules') || normalized.endsWith('/.venv') || normalized.endsWith('/__pycache__');
    }
    onWatcherEvent(uri) {
        if (this.shouldIgnoreWatcherPath(uri.fsPath)) {
            return;
        }
        (0, runtimeCache_1.invalidateModuleDiscoveryCache)();
        (0, runtimeCache_1.invalidateRepositoryDiscoveryCache)();
        this.scheduleRefresh();
    }
    disposeWatchers() {
        this.watchers.forEach(w => w.dispose());
        this.watchers = [];
        this.watcherKey = '';
        if (this.refreshDebounceTimer) {
            clearTimeout(this.refreshDebounceTimer);
            this.refreshDebounceTimer = undefined;
        }
    }
    dispose() {
        this.disposeWatchers();
        super.dispose();
    }
    getTreeItem(element) {
        switch (element.kind) {
            case 'repo': {
                if (element.missing) {
                    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
                    item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
                    item.description = 'path missing';
                    item.tooltip = `${element.repo.path} does not exist.\nThe folder may have been moved or deleted - use "Relocate Repository" to fix the path.`;
                    item.contextValue = 'projectRepoRootMissing';
                    return item;
                }
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
                item.resourceUri = element.uri;
                item.description = element.branch ?? undefined;
                item.tooltip = element.branch ? `${element.repo.path}\nBranch: ${element.branch}` : element.repo.path;
                item.contextValue = 'projectRepoRoot';
                return item;
            }
            case 'folder': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
                item.resourceUri = element.uri;
                item.contextValue = 'projectRepoFolder';
                return item;
            }
            case 'file': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
                item.resourceUri = element.uri;
                item.contextValue = 'projectRepoFile';
                item.command = {
                    command: 'vscode.open',
                    title: 'Open File',
                    arguments: [element.uri]
                };
                return item;
            }
        }
    }
    async getChildren(element) {
        if (!element) {
            // Empty lists fall through to the view's welcome content, which
            // offers the select-project / select-repos actions.
            const selection = await settingsStore_1.SettingsStore.getSelectedProject();
            if (!selection) {
                return [];
            }
            const { project } = selection;
            const repos = (project.repos ?? []);
            if (!repos.length) {
                return [];
            }
            // Resolved once per refresh: the explorer must show the active
            // version's worktrees, so a file opened from it - and every command
            // that acts on the row's uri - belongs to the version being run.
            const resolved = this.resolveRepos(project);
            const resolvedByRepo = new Map(resolved.map(entry => [entry.repo, entry]));
            this.resetWatchers(resolved.map(entry => entry.path));
            const sortId = this.sortPreferences.get('projectRepos', (0, sortOptions_1.getDefaultSortOption)('projectRepos'));
            const sortedRepos = [...repos].sort((a, b) => this.compareRepos(a, b, sortId));
            return Promise.all(sortedRepos.map(async (repo) => {
                const entry = resolvedByRepo.get(repo);
                const repoPath = entry?.path ?? (0, utils_1.normalizePath)(repo.path);
                const missing = !(await (0, dumpImport_1.pathExists)(repoPath));
                return {
                    kind: 'repo',
                    label: entry?.isWorktree && entry.branch ? `${repo.name} (${entry.branch})` : repo.name,
                    repo,
                    uri: vscode.Uri.file(repoPath),
                    branch: missing ? null : await (0, branches_1.getRepoBranch)(repoPath),
                    missing
                };
            }));
        }
        if (element.kind === 'repo' || element.kind === 'folder') {
            return this.readDirectory(element.uri);
        }
        return [];
    }
    compareRepos(a, b, sortId) {
        switch (sortId) {
            case 'projectRepos:name:asc':
                return a.name.localeCompare(b.name);
            case 'projectRepos:name:desc':
                return b.name.localeCompare(a.name);
            case 'projectRepos:added:newest':
                return this.getAddedTimestamp(b) - this.getAddedTimestamp(a);
            case 'projectRepos:added:oldest':
                return this.getAddedTimestamp(a) - this.getAddedTimestamp(b);
            default:
                return a.name.localeCompare(b.name);
        }
    }
    getAddedTimestamp(repo) {
        if (repo.addedAt) {
            const value = new Date(repo.addedAt).getTime();
            if (!isNaN(value)) {
                return value;
            }
        }
        return 0;
    }
    /** The active version's directory for each project repo. */
    resolveRepos(project) {
        const db = project.dbs?.find(entry => entry.isSelected);
        return (0, repoPaths_1.resolveProjectRepos)(project.repos ?? [], db ? (0, environment_1.resolveProjectRepoBranchAssignments)(db, project.repos ?? []) : [], (0, setupState_1.readSetupState)().provisioningRoot);
    }
    resetWatchers(repoPaths) {
        const nextKey = [...repoPaths].sort((a, b) => a.localeCompare(b)).join('|');
        if (nextKey === this.watcherKey) {
            return;
        }
        this.disposeWatchers();
        this.watcherKey = nextKey;
        for (const repoPath of repoPaths) {
            const pattern = new vscode.RelativePattern(repoPath, '**/*');
            const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
            watcher.onDidCreate(uri => this.onWatcherEvent(uri));
            watcher.onDidChange(uri => this.onWatcherEvent(uri));
            watcher.onDidDelete(uri => this.onWatcherEvent(uri));
            this.watchers.push(watcher);
        }
    }
    async readDirectory(dir) {
        try {
            const filesExcludeMatcher = (0, filesExclude_1.createFilesExcludeMatcher)(dir);
            const entries = await vscode.workspace.fs.readDirectory(dir);
            const nodes = [];
            for (const [name, type] of entries) {
                const childUri = vscode.Uri.file(path.join(dir.fsPath, name));
                if (filesExcludeMatcher.isExcluded(childUri.fsPath, name)) {
                    continue;
                }
                if (type === vscode.FileType.Directory) {
                    nodes.push({ kind: 'folder', label: name, uri: childUri });
                    continue;
                }
                nodes.push({ kind: 'file', label: name, uri: childUri });
            }
            nodes.sort((a, b) => {
                if (a.kind === b.kind) {
                    return a.label.localeCompare(b.label);
                }
                if (a.kind === 'folder' && b.kind === 'file') {
                    return -1;
                }
                if (a.kind === 'file' && b.kind === 'folder') {
                    return 1;
                }
                return 0;
            });
            return nodes;
        }
        catch (error) {
            void (0, utils_1.showError)(`Unable to read ${dir.fsPath}: ${error?.message ?? error}`);
            return [];
        }
    }
}
exports.ProjectReposExplorerProvider = ProjectReposExplorerProvider;
async function promptName(prompt, options) {
    const name = await vscode.window.showInputBox({
        prompt,
        value: options?.value,
        placeHolder: options?.placeHolder,
        ignoreFocusOut: true,
        validateInput: input => {
            const trimmed = input.trim();
            if (!trimmed) {
                return 'Name cannot be empty';
            }
            if (trimmed === '.' || trimmed === '..' || /[/\\]/.test(trimmed)) {
                return 'Name cannot contain path separators';
            }
            return undefined;
        }
    });
    return name?.trim();
}
async function entryExists(uri) {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    }
    catch {
        return false;
    }
}
async function createNewFile(folderUri) {
    if (!folderUri) {
        void (0, utils_1.showInfo)('Select a folder to create a file.');
        return;
    }
    const name = await promptName('New file name', { placeHolder: 'my_file.py' });
    if (!name) {
        return;
    }
    const target = vscode.Uri.file(path.join(folderUri.fsPath, name));
    if (await entryExists(target)) {
        void (0, utils_1.showError)(`"${name}" already exists in this folder.`);
        return;
    }
    await vscode.workspace.fs.writeFile(target, new Uint8Array());
    await vscode.window.showTextDocument(target, { preview: false });
}
async function createNewFolder(folderUri) {
    if (!folderUri) {
        void (0, utils_1.showInfo)('Select a folder to create a new folder.');
        return;
    }
    const name = await promptName('New folder name', { placeHolder: 'my_folder' });
    if (!name) {
        return;
    }
    const target = vscode.Uri.file(path.join(folderUri.fsPath, name));
    if (await entryExists(target)) {
        void (0, utils_1.showError)(`"${name}" already exists in this folder.`);
        return;
    }
    await vscode.workspace.fs.createDirectory(target);
}
async function renameEntry(uri) {
    if (!uri) {
        void (0, utils_1.showInfo)('Select a file or folder to rename.');
        return;
    }
    const currentName = path.basename(uri.fsPath);
    const newName = await promptName('Rename to', { value: currentName });
    if (!newName || newName === currentName) {
        return;
    }
    const target = vscode.Uri.file(path.join(path.dirname(uri.fsPath), newName));
    if (await entryExists(target)) {
        void (0, utils_1.showError)(`"${newName}" already exists in this folder.`);
        return;
    }
    await vscode.workspace.fs.rename(uri, target, { overwrite: false });
}
async function selectProjectForExplorer() {
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    if (!data?.projects || data.projects.length === 0) {
        void (0, utils_1.showInfo)('No projects found. Create a project first.');
        return;
    }
    const pick = await vscode.window.showQuickPick(data.projects.map((p, idx) => ({
        label: p.name,
        description: `${p.repos?.length ?? 0} repos`,
        index: idx
    })), { placeHolder: 'Select a project' });
    if (!pick) {
        return;
    }
    data.projects.forEach((p, idx) => (p.isSelected = idx === pick.index));
    await settingsStore_1.SettingsStore.saveWithoutComments(data);
}


/***/ }),
/* 79 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.createFilesExcludeMatcher = createFilesExcludeMatcher;
/**
 * files.exclude-compatible matcher used by the Project Repos tree.
 */
const fs = __importStar(__webpack_require__(2));
const path = __importStar(__webpack_require__(4));
const vscode = __importStar(__webpack_require__(1));
function globToRegExp(pattern) {
    const normalizedPattern = pattern.split(path.sep).join('/');
    const placeholders = {
        doubleStar: '__GLOB_DOUBLE_STAR__',
        singleStar: '__GLOB_SINGLE_STAR__',
        question: '__GLOB_QUESTION__'
    };
    let working = normalizedPattern
        .replaceAll('**', placeholders.doubleStar)
        .replaceAll('*', placeholders.singleStar)
        .replaceAll('?', placeholders.question);
    working = working.replaceAll(/[.+^${}()|[\]\\]/g, String.raw `\$&`);
    working = working
        .replaceAll(new RegExp(placeholders.doubleStar, 'g'), '.*')
        .replaceAll(new RegExp(placeholders.singleStar, 'g'), '[^/]*')
        .replaceAll(new RegExp(placeholders.question, 'g'), '[^/]');
    return new RegExp(`^${working}$`, 'i');
}
function normalizeForMatch(value) {
    return value.replace(/\\/g, '/').replace(/^\.?\//, '');
}
function resolveWorkspaceRoot(scopeUri) {
    if (scopeUri) {
        const folder = vscode.workspace.getWorkspaceFolder(scopeUri);
        if (folder) {
            return folder.uri.fsPath;
        }
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
function resolveFilesExcludeRules(scopeUri) {
    const config = vscode.workspace.getConfiguration('files', scopeUri);
    const excludes = config.get('exclude', {});
    if (!excludes || typeof excludes !== 'object') {
        return [];
    }
    const rules = [];
    for (const [pattern, rawValue] of Object.entries(excludes)) {
        if (rawValue === false) {
            continue;
        }
        if (rawValue === true) {
            rules.push({ regex: globToRegExp(pattern) });
            continue;
        }
        if (!rawValue || typeof rawValue !== 'object') {
            continue;
        }
        rules.push({
            regex: globToRegExp(pattern),
            when: typeof rawValue.when === 'string' ? rawValue.when : undefined
        });
    }
    return rules;
}
function ruleMatchesPath(rule, relativePath, absolutePath, entryName) {
    return rule.regex.test(relativePath)
        || rule.regex.test(`/${relativePath}`)
        || rule.regex.test(entryName)
        || rule.regex.test(absolutePath);
}
function whenClauseMatches(whenClause, fsPath, entryName) {
    if (!whenClause || whenClause.trim() === '') {
        return true;
    }
    const basename = path.parse(entryName).name;
    const siblingName = whenClause.replaceAll('$(basename)', basename);
    const siblingPath = path.join(path.dirname(fsPath), siblingName);
    return fs.existsSync(siblingPath);
}
function createFilesExcludeMatcher(scopeUri) {
    const rules = resolveFilesExcludeRules(scopeUri);
    const workspaceRoot = resolveWorkspaceRoot(scopeUri);
    return {
        isExcluded(fsPath, entryName) {
            if (rules.length === 0) {
                return false;
            }
            const normalizedAbsolute = normalizeForMatch(fsPath);
            const relativeCandidate = workspaceRoot
                ? normalizeForMatch(path.relative(workspaceRoot, fsPath))
                : normalizedAbsolute;
            const relative = relativeCandidate && relativeCandidate !== '.'
                ? relativeCandidate
                : normalizedAbsolute;
            for (const rule of rules) {
                if (!ruleMatchesPath(rule, relative, normalizedAbsolute, entryName)) {
                    continue;
                }
                if (!whenClauseMatches(rule.when, fsPath, entryName)) {
                    continue;
                }
                return true;
            }
            return false;
        }
    };
}


/***/ }),
/* 80 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseWorktreeDirName = parseWorktreeDirName;
exports.registerWrongCopyGuard = registerWrongCopyGuard;
/**
 * Warns when a file being opened belongs to a version other than the active
 * one. Scoping the views (see repoPaths.ts consumers) removes the wrong copy
 * from the UI, but not from search history, bookmarks or external tools - and
 * two directories with identical file trees is the hazard this design
 * introduces, so it gets a second line of defence.
 */
const path = __importStar(__webpack_require__(4));
const vscode = __importStar(__webpack_require__(1));
const settingsStore_1 = __webpack_require__(6);
const logger_1 = __webpack_require__(12);
const notifications_1 = __webpack_require__(16);
const setupState_1 = __webpack_require__(64);
const repoPaths_1 = __webpack_require__(60);
const environment_1 = __webpack_require__(31);
const SUPPRESSED_KEY = 'odooDevtools.wrongCopyWarningSuppressed';
/**
 * The repo and branch a path under the provisioning root belongs to, derived
 * from the `<repo>@<branch>` directory name rather than from configuration -
 * the file may belong to a version that is not currently resolvable.
 */
function parseWorktreeDirName(dirName) {
    const at = dirName.lastIndexOf('@');
    if (at <= 0 || at === dirName.length - 1) {
        return undefined;
    }
    return { repo: dirName.slice(0, at), branch: dirName.slice(at + 1) };
}
function registerWrongCopyGuard(context) {
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(async (document) => {
        if (document.uri.scheme !== 'file') {
            return;
        }
        if (context.globalState.get(SUPPRESSED_KEY)) {
            return;
        }
        try {
            const root = (0, setupState_1.readSetupState)().provisioningRoot;
            const relative = path.relative(root, document.uri.fsPath);
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
                return;
            }
            const owner = parseWorktreeDirName(relative.split(path.sep)[0]);
            if (!owner) {
                return;
            }
            const result = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json').catch(() => undefined);
            const project = result?.projects?.find(entry => entry.isSelected);
            if (!project) {
                return;
            }
            const db = project.dbs?.find(entry => entry.isSelected);
            const active = (0, repoPaths_1.resolveProjectRepos)(project.repos ?? [], db ? (0, environment_1.resolveProjectRepoBranchAssignments)(db, project.repos ?? []) : [], root);
            const activeEntry = active.find(entry => entry.repo.name === owner.repo && entry.isWorktree);
            if (!activeEntry || !activeEntry.branch || activeEntry.branch === owner.branch) {
                return;
            }
            const choice = await (0, notifications_1.showWarning)(`${path.basename(document.uri.fsPath)} belongs to "${owner.branch}", but "${activeEntry.branch}" is active.`, `Open the ${activeEntry.branch} copy`, 'Stay here', "Don't warn again");
            if (choice === `Open the ${activeEntry.branch} copy`) {
                const withinWorktree = path.relative(path.join(root, (0, repoPaths_1.worktreeDirName)(owner.repo, owner.branch)), document.uri.fsPath);
                const target = vscode.Uri.file(path.join(activeEntry.path, withinWorktree));
                await vscode.window.showTextDocument(target, { preview: false });
            }
            else if (choice === "Don't warn again") {
                // A developer deliberately comparing two versions must not be nagged.
                await context.globalState.update(SUPPRESSED_KEY, true);
            }
        }
        catch (error) {
            logger_1.logger.debug('Wrong-copy guard failed:', error);
        }
    }));
}


/***/ }),
/* 81 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.StatusBarIndicators = void 0;
const vscode = __importStar(__webpack_require__(1));
const settingsStore_1 = __webpack_require__(6);
const versionsService_1 = __webpack_require__(24);
const utils_1 = __webpack_require__(8);
const logger_1 = __webpack_require__(12);
const runningState_1 = __webpack_require__(50);
/**
 * Status bar indicators for the active project, database and version.
 * Clicking each opens the corresponding quick-switch picker, so the current
 * context is visible (and switchable) without opening the side bar.
 */
class StatusBarIndicators {
    projectItem;
    dbItem;
    versionItem;
    constructor() {
        this.projectItem = vscode.window.createStatusBarItem('odooDevtools.project', vscode.StatusBarAlignment.Left, 100);
        this.projectItem.name = 'Odoo DevTools: Project';
        this.projectItem.command = 'odoo-debugger.quickProjectSearch';
        this.dbItem = vscode.window.createStatusBarItem('odooDevtools.database', vscode.StatusBarAlignment.Left, 99);
        this.dbItem.name = 'Odoo DevTools: Database';
        this.dbItem.command = 'dbSelector.quickSearch';
        this.versionItem = vscode.window.createStatusBarItem('odooDevtools.version', vscode.StatusBarAlignment.Left, 98);
        this.versionItem.name = 'Odoo DevTools: Version';
        this.versionItem.command = 'odoo.setActiveVersion';
    }
    /** Re-reads the active project/db/version and updates the items. */
    async update() {
        const enabled = vscode.workspace.getConfiguration('odooDebugger').get('statusBar.enabled', true);
        if (!enabled || !vscode.workspace.workspaceFolders?.length) {
            this.hideAll();
            return;
        }
        try {
            // Read without getSelectedProject(): no project selected must not toast.
            const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
            const project = data.projects?.find(p => p.isSelected);
            const db = project?.dbs?.find(candidate => candidate.isSelected);
            const version = versionsService_1.VersionsService.getInstance().getActiveVersion();
            if (project) {
                this.projectItem.text = `$(folder-library) ${project.name}`;
                this.projectItem.tooltip = `Odoo project: ${project.name} - click to switch`;
                this.projectItem.show();
            }
            else {
                this.projectItem.hide();
            }
            if (db) {
                this.dbItem.text = `$(database) ${(0, utils_1.getDatabaseLabel)(db)}`;
                this.dbItem.tooltip = `Selected database: ${db.id} - click to switch`;
                this.dbItem.show();
            }
            else {
                this.dbItem.hide();
            }
            if (version) {
                // The port belongs on the indicator: with several versions
                // runnable at once, "which localhost" is the question this
                // item is most often consulted for.
                const port = Number(version.settings?.portNumber) || undefined;
                const running = (await (0, runningState_1.getRunningInstances)()).some(instance => instance.versionId === version.id);
                const marker = running ? '$(debug-alt)' : '$(versions)';
                this.versionItem.text = port
                    ? `${marker} ${version.odooVersion} :${port}`
                    : `${marker} ${version.odooVersion}`;
                this.versionItem.tooltip = [
                    `Active version: ${version.name} (${version.odooVersion})`,
                    port ? `Server: http://localhost:${port}` : undefined,
                    running ? 'Currently running' : 'Not running',
                    'Click to switch'
                ].filter(Boolean).join('\n');
                this.versionItem.show();
            }
            else {
                this.versionItem.hide();
            }
        }
        catch (error) {
            logger_1.logger.debug('Status bar update failed:', error);
            this.hideAll();
        }
    }
    hideAll() {
        this.projectItem.hide();
        this.dbItem.hide();
        this.versionItem.hide();
    }
    dispose() {
        this.projectItem.dispose();
        this.dbItem.dispose();
        this.versionItem.dispose();
    }
}
exports.StatusBarIndicators = StatusBarIndicators;


/***/ }),
/* 82 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.registerAllCommands = registerAllCommands;
const viewCommands_1 = __webpack_require__(83);
const projectCommands_1 = __webpack_require__(85);
const repoCommands_1 = __webpack_require__(91);
const dbCommands_1 = __webpack_require__(92);
const moduleCommands_1 = __webpack_require__(93);
const testingCommands_1 = __webpack_require__(94);
const versionCommands_1 = __webpack_require__(95);
const debugCommands_1 = __webpack_require__(98);
const reposExplorerCommands_1 = __webpack_require__(99);
const editorCommands_1 = __webpack_require__(100);
const helpCommands_1 = __webpack_require__(101);
/** Registers every command the extension contributes. */
function registerAllCommands(deps) {
    (0, viewCommands_1.registerViewCommands)(deps);
    (0, projectCommands_1.registerProjectCommands)(deps);
    (0, repoCommands_1.registerRepoCommands)(deps);
    (0, dbCommands_1.registerDbCommands)(deps);
    (0, moduleCommands_1.registerModuleCommands)(deps);
    (0, testingCommands_1.registerTestingCommands)(deps);
    (0, versionCommands_1.registerVersionCommands)(deps);
    (0, debugCommands_1.registerDebugCommands)(deps);
    (0, reposExplorerCommands_1.registerReposExplorerCommands)(deps);
    (0, editorCommands_1.registerEditorCommands)(deps);
    (0, helpCommands_1.registerHelpCommands)(deps);
}


/***/ }),
/* 83 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.registerViewCommands = registerViewCommands;
const vscode = __importStar(__webpack_require__(1));
const quickSearch_1 = __webpack_require__(84);
const sortOptions_1 = __webpack_require__(29);
const notifications_1 = __webpack_require__(16);
const module_1 = __webpack_require__(62);
/**
 * Generic per-view plumbing: refresh, sort, and quick-search commands.
 */
function registerViewCommands(deps) {
    const { context, providers, sortPreferences, refreshAll } = deps;
    const registerViewSortCommand = (viewId, provider) => {
        const options = (0, sortOptions_1.getSortOptions)(viewId);
        context.subscriptions.push(vscode.commands.registerCommand(`${viewId}.sort`, async () => {
            const current = sortPreferences.get(viewId, (0, sortOptions_1.getDefaultSortOption)(viewId));
            const picks = options.map(option => ({
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
    registerViewSortCommand('projectSelector', providers.project);
    registerViewSortCommand('repoSelector', providers.repo);
    registerViewSortCommand('dbSelector', providers.db);
    registerViewSortCommand('moduleSelector', providers.module);
    registerViewSortCommand('versionsManager', providers.versions);
    // The explorer view keeps the historical 'projectRepos' sort ids so stored preferences survive.
    registerViewSortCommand('projectRepos', providers.projectReposExplorer);
    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.refresh', async () => refreshAll({ reason: 'ui' })));
    context.subscriptions.push(vscode.commands.registerCommand('repoSelector.refresh', async () => refreshAll({ reason: 'ui' })));
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.refresh', async () => refreshAll({ reason: 'ui' })));
    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.refresh', async () => refreshAll({ reason: 'ui' })));
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.refresh', async () => refreshAll({ reason: 'ui' })));
    context.subscriptions.push(vscode.commands.registerCommand('repoSelector.quickSearch', async () => {
        const items = ((await providers.repo.getChildren()) ?? [])
            .filter(item => !!item.command && (0, quickSearch_1.getTreeItemLabel)(item).trim().length > 0);
        await (0, quickSearch_1.quickSearchTreeItems)(items, {
            placeHolder: 'Search repositories...',
            title: 'Repository Search',
            emptyMessage: 'No repositories available to search.'
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.quickSearch', async () => {
        const items = ((await providers.db.getChildren()) ?? [])
            .filter(item => item.contextValue === 'database' && !!item.command);
        await (0, quickSearch_1.quickSearchTreeItems)(items, {
            placeHolder: 'Search databases...',
            title: 'Database Search',
            emptyMessage: 'No databases available to search.'
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.quickSearch', async () => {
        // Include modules nested under psae-internal groups in the search.
        const rootItems = ((await providers.module.getChildren()) ?? []);
        const nestedItems = rootItems.flatMap(item => item.psaeChildren ?? []);
        const items = [...rootItems, ...nestedItems]
            .filter(item => item.contextValue === 'module' && !!item.command);
        await (0, quickSearch_1.quickSearchTreeItems)(items, {
            placeHolder: 'Search modules...',
            title: 'Module Search',
            emptyMessage: 'No searchable modules found for the selected database.',
            onPick: async (item) => {
                const moduleData = item.moduleData
                    ?? item.command?.arguments?.[0];
                if (!moduleData?.name) {
                    void (0, notifications_1.showInfo)('Unable to read module details for this selection.');
                    return;
                }
                const stateSelection = await vscode.window.showQuickPick([
                    { label: 'Set to Install', description: moduleData.name, action: 'install' },
                    { label: 'Set to Upgrade', description: moduleData.name, action: 'upgrade' },
                    { label: 'Clear State', description: moduleData.name, action: 'none' }
                ], {
                    placeHolder: `Set state for module "${moduleData.name}"`,
                    ignoreFocusOut: true
                });
                if (!stateSelection) {
                    return;
                }
                if (stateSelection.action === 'install') {
                    await (0, module_1.setModuleToInstall)(moduleData);
                }
                else if (stateSelection.action === 'upgrade') {
                    await (0, module_1.setModuleToUpgrade)(moduleData);
                }
                else {
                    await (0, module_1.clearModuleState)(moduleData);
                }
                await refreshAll({ reason: 'ui' });
            }
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('versionsManager.quickSearch', async () => {
        const items = ((await providers.versions.getChildren()) ?? [])
            .filter(item => {
            const contextValue = item.contextValue;
            return (contextValue === 'version' || contextValue === 'activeVersion') && !!item.command;
        })
            .map(item => providers.versions.getTreeItem(item));
        await (0, quickSearch_1.quickSearchTreeItems)(items, {
            placeHolder: 'Search versions...',
            title: 'Version Search',
            emptyMessage: 'No versions available to search.'
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('projectRepos.quickSearch', async () => {
        const rootNodes = ((await providers.projectReposExplorer.getChildren()) ?? [])
            .filter(node => node.kind === 'repo');
        const items = rootNodes.map(node => providers.projectReposExplorer.getTreeItem(node));
        await (0, quickSearch_1.quickSearchTreeItems)(items, {
            placeHolder: 'Search project repositories...',
            title: 'Project Repo Search',
            emptyMessage: 'No project repositories available to search.',
            onPick: async (item) => {
                if (item.resourceUri) {
                    await vscode.commands.executeCommand('revealInExplorer', item.resourceUri);
                }
            }
        });
    }));
}


/***/ }),
/* 84 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.getTreeItemLabel = getTreeItemLabel;
exports.quickSearchTreeItems = quickSearchTreeItems;
const vscode = __importStar(__webpack_require__(1));
const notifications_1 = __webpack_require__(16);
/**
 * Shared quick-pick search over tree items, used by every view's
 * "search" title-bar action.
 */
function getTreeItemLabel(item) {
    if (typeof item.label === 'string') {
        return item.label;
    }
    if (item.label && typeof item.label === 'object' && 'label' in item.label) {
        return item.label.label;
    }
    return '';
}
function getTreeItemDescription(item) {
    return typeof item.description === 'string' ? item.description : undefined;
}
function stripMarkdownForQuickPick(value) {
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
function getTreeItemDetail(item) {
    if (typeof item.tooltip === 'string') {
        return stripMarkdownForQuickPick(item.tooltip);
    }
    if (item.tooltip instanceof vscode.MarkdownString) {
        return stripMarkdownForQuickPick(item.tooltip.value);
    }
    return undefined;
}
async function quickSearchTreeItems(items, options) {
    if (!items.length) {
        void (0, notifications_1.showInfo)(options.emptyMessage);
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
        void (0, notifications_1.showInfo)('No action is available for the selected item.');
        return;
    }
    await vscode.commands.executeCommand(selected.item.command.command, ...(selected.item.command.arguments ?? []));
}


/***/ }),
/* 85 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.registerProjectCommands = registerProjectCommands;
/**
 * Command handlers for the Projects view and project workspaces.
 */
const vscode = __importStar(__webpack_require__(1));
const path = __importStar(__webpack_require__(4));
const utils_1 = __webpack_require__(8);
const notifications_1 = __webpack_require__(16);
const logger_1 = __webpack_require__(12);
const project_1 = __webpack_require__(53);
const dbs_1 = __webpack_require__(36);
const odooInstaller_1 = __webpack_require__(86);
const projectWorkspace_1 = __webpack_require__(87);
const setupFlow_1 = __webpack_require__(89);
const setupState_1 = __webpack_require__(64);
const context_1 = __webpack_require__(66);
function registerProjectCommands(deps) {
    const { context, versionsService, refreshAll } = deps;
    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.create', async () => {
        try {
            // Get settings from active version
            const settings = await versionsService.getActiveVersionSettings();
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                throw new Error('Open a workspace to use this command.');
            }
            const name = await (0, project_1.getProjectName)(workspaceFolder);
            const customAddonsPath = (0, utils_1.normalizePath)(settings.customAddonsPath);
            const repos = await (0, project_1.getRepo)(customAddonsPath, name); // Pass project name as search filter
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
            let db;
            if (databaseChoice.value === 'create') {
                db = await (0, dbs_1.createDb)(name, repos, settings.dumpsFolder, settings, { allowExistingOption: false });
            }
            else if (databaseChoice.value === 'connect') {
                db = await (0, dbs_1.createDb)(name, repos, settings.dumpsFolder, settings, { initialMethod: 'existing' });
            }
            if (databaseChoice.value !== 'skip' && !db) {
                // User cancelled within DB creation flow.
                return;
            }
            await (0, project_1.createProject)(name, repos, db);
            if (db) {
                // Ensure project creation follows the same version/branch switch path as manual DB selection.
                await (0, dbs_1.selectDatabase)(db);
            }
            await refreshAll();
        }
        catch (err) {
            void (0, notifications_1.showError)((0, logger_1.errorMessage)(err));
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.selectProject', async (event) => {
        await (0, project_1.selectProject)(event);
        await refreshAll();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.delete', async (event) => {
        await (0, project_1.deleteProject)(event);
        await refreshAll();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.editSettings', async (event) => {
        await (0, project_1.editProjectSettings)(event);
        await refreshAll({ reason: 'ui' });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.manageTickets', async (event) => {
        await (0, project_1.manageProjectTickets)(event);
        await refreshAll({ reason: 'ui' });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.openTicket', async (event) => {
        await (0, project_1.openProjectTicket)(event);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.duplicateProject', async (event) => {
        await (0, project_1.duplicateProject)(event);
        await refreshAll();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.exportProject', async (event) => {
        await (0, project_1.exportProject)(event);
        await refreshAll({ reason: 'ui' });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.importProject', async () => {
        await (0, project_1.importProject)();
        await refreshAll({ reason: 'ui' });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo.setup', async () => {
        // Detection first: the clone wizard is the fallback, not the entry point.
        const configured = await (0, setupFlow_1.runSetup)({
            cloneFallback: () => (0, odooInstaller_1.cloneOdooRepositories)(path.dirname((0, setupState_1.readSetupState)().provisioningRoot))
        });
        (0, context_1.updateConfiguredContext)((0, setupState_1.readSetupState)().isConfigured);
        await refreshAll({ reason: 'ui' });
        if (!configured) {
            return;
        }
        const next = await (0, notifications_1.showInfo)('Odoo DevTools is set up.', 'Create a Version');
        if (next === 'Create a Version') {
            await vscode.commands.executeCommand('odoo.createVersion');
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo-debugger.quickProjectSearch', async () => {
        await (0, project_1.quickProjectSearch)();
        await refreshAll({ reason: 'ui' });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('proj.openProjectWorkspace', async () => {
        await (0, projectWorkspace_1.openProjectWorkspace)(context);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('proj.rebuildProjectWorkspace', async () => {
        await (0, projectWorkspace_1.rebuildProjectWorkspace)(context);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('proj.quickSwitchProject', async () => {
        await (0, projectWorkspace_1.quickSwitchProjectWorkspace)(context);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.detectTickets', async () => {
        await (0, project_1.detectProjectTickets)();
        await refreshAll({ reason: 'ui' });
    }));
}


/***/ }),
/* 86 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.provisionAndCreateVersion = provisionAndCreateVersion;
exports.cloneOdooRepositories = cloneOdooRepositories;
/**
 * Setup Odoo flow: clones the Odoo repositories for a chosen branch
 * (shallow single-branch or full history), optionally continues with a
 * Python virtualenv + requirements, and offers to create a matching
 * version profile.
 */
const vscode = __importStar(__webpack_require__(1));
const path = __importStar(__webpack_require__(4));
const fs = __importStar(__webpack_require__(2));
const utils_1 = __webpack_require__(8);
const process_1 = __webpack_require__(13);
const logger_1 = __webpack_require__(12);
const notifications_1 = __webpack_require__(16);
const versionsService_1 = __webpack_require__(24);
const provisioning_1 = __webpack_require__(69);
const systemDeps_1 = __webpack_require__(72);
const pythonToolchain_1 = __webpack_require__(71);
const setupState_1 = __webpack_require__(64);
const CLONE_TARGETS = {
    odoo: {
        dirName: 'odoo',
        urls: ['https://github.com/odoo/odoo.git'],
        label: 'Community (odoo)'
    },
    enterprise: {
        dirName: 'enterprise',
        urls: ['git@github.com:odoo/enterprise.git', 'https://github.com/odoo/enterprise.git'],
        label: 'Enterprise'
    },
    designThemes: {
        dirName: 'design-themes',
        urls: ['https://github.com/odoo/design-themes.git'],
        label: 'Design Themes'
    }
};
const BRANCH_OPTIONS = [
    { label: '19.0', description: 'Latest stable version' },
    { label: '18.0', description: 'Stable version' },
    { label: '17.0', description: 'Previous stable version' },
    { label: 'master', description: 'Development branch (unstable)' },
    { label: 'saas-19.2', description: 'SaaS version' },
    { label: 'saas-19.1', description: 'SaaS version' },
    { label: 'saas-18.4', description: 'SaaS version' },
    { label: 'Custom', description: 'Enter a custom branch name' }
];
async function pickBranch() {
    const selected = await vscode.window.showQuickPick(BRANCH_OPTIONS, {
        placeHolder: 'Select an Odoo branch to clone',
        ignoreFocusOut: true
    });
    if (!selected) {
        return undefined;
    }
    if (selected.label !== 'Custom') {
        return selected.label;
    }
    const custom = await vscode.window.showInputBox({
        prompt: 'Enter the branch name',
        placeHolder: 'e.g., 19.0, master, saas-19.2',
        ignoreFocusOut: true
    });
    return custom?.trim() || undefined;
}
/** Where to clone: the workspace folder by default, or any picked folder. */
async function pickDestination(workspaceDir) {
    const choice = await vscode.window.showQuickPick([
        {
            label: 'Workspace folder',
            description: workspaceDir,
            custom: false
        },
        {
            label: 'Choose a different folder…',
            description: 'The repositories are cloned inside the selected folder',
            custom: true
        }
    ], { placeHolder: 'Where should the repositories be cloned?', ignoreFocusOut: true });
    if (!choice) {
        return undefined;
    }
    if (!choice.custom) {
        return workspaceDir;
    }
    const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(workspaceDir),
        openLabel: 'Clone Here',
        title: 'Select the folder to clone the repositories into'
    });
    return picked?.[0]?.fsPath;
}
async function pickCloneDepth() {
    const choice = await vscode.window.showQuickPick([
        {
            label: 'Shallow copy (recommended)',
            description: 'Single branch, no history — fast and small (--depth 1)',
            shallow: true
        },
        {
            label: 'Full clone',
            description: 'All branches and full history — several GB for odoo',
            shallow: false
        }
    ], { placeHolder: 'How should the repositories be cloned?', ignoreFocusOut: true });
    return choice?.shallow;
}
async function pickCloneTargets() {
    const picks = await vscode.window.showQuickPick([
        { label: CLONE_TARGETS.odoo.label, target: CLONE_TARGETS.odoo, picked: true },
        { label: CLONE_TARGETS.enterprise.label, target: CLONE_TARGETS.enterprise, picked: true },
        { label: CLONE_TARGETS.designThemes.label, target: CLONE_TARGETS.designThemes, picked: false }
    ], {
        placeHolder: 'Select the repositories to clone',
        canPickMany: true,
        ignoreFocusOut: true
    });
    if (!picks) {
        return undefined;
    }
    if (picks.length === 0) {
        void (0, utils_1.showInfo)('Select at least one repository to clone.');
        return undefined;
    }
    return picks.map(pick => pick.target);
}
async function confirmExistingDirectories(baseDir, dirNames) {
    const existing = dirNames.filter(name => fs.existsSync(path.join(baseDir, name)));
    if (existing.length === 0) {
        return true;
    }
    const confirm = await (0, notifications_1.showModalWarning)(`The following directories already exist: ${existing.join(', ')}\n\ngit clone will fail on non-empty directories. Continue anyway?`, 'Continue Anyway');
    return confirm === 'Continue Anyway';
}
/** Clones one repository, trying each URL in order; reports git progress. */
async function cloneRepository(target, options, progress, token) {
    const args = ['clone', '--progress', '--branch', options.branch];
    if (options.shallow) {
        args.push('--depth', '1', '--single-branch');
    }
    let lastError;
    for (const url of target.urls) {
        if (token.isCancellationRequested) {
            throw new Error('Cancelled');
        }
        try {
            await (0, process_1.runCommand)('git', [...args, url, target.dirName], {
                cwd: options.baseDir,
                token,
                onStderrLine: line => {
                    const trimmed = line.trim();
                    if (trimmed) {
                        progress.report({ message: `${target.dirName}: ${trimmed}` });
                    }
                }
            });
            return;
        }
        catch (error) {
            lastError = error;
            logger_1.logger.warn(`Clone of ${url} failed:`, error);
        }
    }
    throw lastError instanceof Error ? lastError : new Error(`Failed to clone ${target.dirName}`);
}
/**
 * Provisions the environment for `branch` - worktree, interpreter, virtualenv,
 * requirements - and creates the matching version profile pointing at it.
 * Returns undefined when the user cancels or provisioning fails.
 */
async function provisionAndCreateVersion(branch, name) {
    const setup = (0, setupState_1.readSetupState)();
    if (!setup.isConfigured || !setup.sourceRepo) {
        // Offer the fix rather than instructing the user to find it.
        const choice = await (0, utils_1.showWarning)('Odoo DevTools is not set up yet.', 'Set Up');
        if (choice === 'Set Up') {
            await vscode.commands.executeCommand('odoo.setup');
        }
        return undefined;
    }
    const spec = {
        branch,
        sourceRepoPath: setup.sourceRepo,
        enterpriseRepoPath: setup.enterpriseRepo,
        designThemesRepoPath: setup.designThemesRepo,
        root: setup.provisioningRoot
    };
    const plan = (0, provisioning_1.buildPlan)(spec, await (0, provisioning_1.probeProvision)(spec));
    const detail = plan
        .map(step => `${step.status === 'satisfied' ? '$(check)' : '$(add)'} ${step.label}`)
        .join('  ');
    const choice = await vscode.window.showQuickPick([
        {
            label: (0, provisioning_1.isFullySatisfied)(plan) ? 'Create profile (already provisioned)' : 'Provision',
            detail,
            provision: true
        },
        {
            label: 'Profile only',
            detail: 'Create the version without building an environment',
            provision: false
        }
    ], { title: `Provision Odoo ${branch}?`, placeHolder: 'Choose how to create this version', ignoreFocusOut: true });
    if (!choice) {
        return undefined;
    }
    if (!choice.provision) {
        return versionsService_1.VersionsService.getInstance().createVersion(name, branch);
    }
    const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Provisioning Odoo ${branch}`,
        cancellable: true
    }, async (progress, token) => {
        try {
            return await (0, provisioning_1.executeProvision)(spec, progress, token);
        }
        catch (error) {
            if (token.isCancellationRequested) {
                void (0, utils_1.showInfo)('Provisioning cancelled. Run it again to resume where it stopped.');
            }
            else {
                logger_1.logger.error('Provisioning failed:', error);
                void (0, utils_1.showError)(`Provisioning failed: ${(0, logger_1.errorMessage)(error)}`);
            }
            return undefined;
        }
    });
    if (!result) {
        return undefined;
    }
    const version = await versionsService_1.VersionsService.getInstance().createVersion(name, branch, {
        odooPath: result.paths.odooPath,
        enterprisePath: result.paths.enterprisePath ?? '',
        designThemesPath: result.paths.designThemesPath ?? '',
        pythonPath: (0, pythonToolchain_1.venvPythonPath)(result.paths.venvPath),
        managedPaths: result.managedPaths
    });
    const notes = [...result.warnings];
    const missing = (0, systemDeps_1.summarizeMissing)(result.deps);
    if (missing) {
        notes.push(`Missing: ${missing}`);
    }
    if (notes.length > 0) {
        void (0, utils_1.showWarning)(`Provisioned ${branch} on Python ${result.pythonVersion}. ${notes.join(' ')}`);
    }
    else {
        void (0, utils_1.showInfo)(`Provisioned ${branch} on Python ${result.pythonVersion}.`);
    }
    return version;
}
/**
 * Clones the Odoo repositories and returns the path of the odoo checkout, so
 * the caller can record it. The previous version of this function cloned and
 * returned nothing, leaving configuration pointing at `./odoo` regardless of
 * where the user actually put the repositories.
 */
async function cloneOdooRepositories(defaultBaseDir) {
    const baseDir = await pickDestination(defaultBaseDir);
    if (!baseDir) {
        return undefined;
    }
    const targets = await pickCloneTargets();
    if (!targets) {
        return undefined;
    }
    const branch = await pickBranch();
    if (!branch) {
        return undefined;
    }
    const shallow = await pickCloneDepth();
    if (shallow === undefined) {
        return undefined;
    }
    if (!(await confirmExistingDirectories(baseDir, targets.map(target => target.dirName)))) {
        return undefined;
    }
    const cloned = [];
    const succeeded = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Cloning Odoo ${branch}${shallow ? ' (shallow)' : ''}\u2026`,
        cancellable: true
    }, async (progress, token) => {
        try {
            for (const target of targets) {
                progress.report({ message: `Cloning ${target.dirName}\u2026` });
                await cloneRepository(target, { baseDir, branch, shallow }, progress, token);
                cloned.push(target.dirName);
            }
            return true;
        }
        catch (error) {
            if (token.isCancellationRequested) {
                void (0, utils_1.showInfo)(`Clone cancelled.${cloned.length ? ` Completed: ${cloned.join(', ')}.` : ''}`);
            }
            else {
                logger_1.logger.error('Setup clone failed:', error);
                void (0, utils_1.showError)(`Clone failed: ${(0, logger_1.errorMessage)(error)}`);
            }
            return false;
        }
    });
    if (!succeeded) {
        return undefined;
    }
    // The odoo repo is the one that matters; enterprise and design-themes are
    // found beside it by detection.
    const odooTarget = targets.find(target => fs.existsSync(path.join(baseDir, target.dirName, 'odoo-bin')));
    return odooTarget ? path.join(baseDir, odooTarget.dirName) : undefined;
}


/***/ }),
/* 87 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.rebuildProjectWorkspace = rebuildProjectWorkspace;
exports.openProjectWorkspace = openProjectWorkspace;
exports.quickSwitchProjectWorkspace = quickSwitchProjectWorkspace;
/**
 * Multi-root workspace files built from a project's repositories
 * (open/rebuild/quick-switch).
 */
const vscode = __importStar(__webpack_require__(1));
const settingsStore_1 = __webpack_require__(6);
const utils_1 = __webpack_require__(8);
const versionsService_1 = __webpack_require__(24);
const workspaceFolders_1 = __webpack_require__(88);
const repoPaths_1 = __webpack_require__(60);
const environment_1 = __webpack_require__(31);
const setupState_1 = __webpack_require__(64);
async function getActiveProjectOrPrompt() {
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    if (!data?.projects || data.projects.length === 0) {
        void (0, utils_1.showInfo)('No projects found. Create a project first.');
        return undefined;
    }
    let projectIndex = data.projects.findIndex((p) => p.isSelected);
    if (projectIndex === -1) {
        const pick = await vscode.window.showQuickPick(data.projects.map((p, idx) => ({
            label: p.name,
            description: `${p.repos?.length ?? 0} repos`,
            index: idx
        })), { placeHolder: 'Select a project' });
        if (!pick) {
            return undefined;
        }
        projectIndex = pick.index;
        data.projects.forEach((p, idx) => (p.isSelected = idx === projectIndex));
        await settingsStore_1.SettingsStore.saveWithoutComments(data);
    }
    return { project: data.projects[projectIndex], projectIndex, data };
}
async function buildWorkspaceFile(context, project) {
    if (!project.repos || project.repos.length === 0) {
        void (0, utils_1.showInfo)(`Project "${project.name}" has no repositories. Add repos first.`);
        return undefined;
    }
    const workspacesDir = vscode.Uri.joinPath(context.globalStorageUri, 'workspaces');
    await vscode.workspace.fs.createDirectory(workspacesDir);
    const workspaceFile = vscode.Uri.joinPath(workspacesDir, `${project.uid || project.name}.code-workspace`);
    const folders = [];
    for (const repo of project.repos) {
        const repoPath = (0, utils_1.normalizePath)(repo.path);
        const folderEntry = { path: repoPath };
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(repoPath));
        }
        catch {
            folderEntry.name = `${repo.name} (missing)`;
        }
        folders.push(folderEntry);
    }
    // The active version's own checkouts, so files opened from this workspace
    // belong to the version being run.
    const versionsService = versionsService_1.VersionsService.getInstance();
    await versionsService.initialize();
    folders.push(...(0, workspaceFolders_1.versionFolderEntries)(versionsService.getActiveVersion(), folders.map(folder => folder.path)));
    // Project repos resolved to the active version's worktrees, so opening a
    // file from this workspace cannot land in another version's copy.
    const selectedDb = project.dbs?.find(entry => entry.isSelected);
    folders.push(...(0, workspaceFolders_1.repoFolderEntries)((0, repoPaths_1.resolveProjectRepos)(project.repos ?? [], selectedDb ? (0, environment_1.resolveProjectRepoBranchAssignments)(selectedDb, project.repos ?? []) : [], (0, setupState_1.readSetupState)().provisioningRoot), folders.map(folder => folder.path)));
    const workspaceData = {
        folders,
        settings: {}
    };
    const content = Buffer.from(JSON.stringify(workspaceData, null, 2), 'utf8');
    await vscode.workspace.fs.writeFile(workspaceFile, content);
    return workspaceFile;
}
async function rebuildProjectWorkspace(context) {
    const selection = await getActiveProjectOrPrompt();
    if (!selection) {
        return undefined;
    }
    return buildWorkspaceFile(context, selection.project);
}
async function openProjectWorkspace(context) {
    const workspaceFile = await rebuildProjectWorkspace(context);
    if (!workspaceFile) {
        return;
    }
    const choice = await (0, utils_1.showInfo)('Open project workspace?', 'This window', 'New window');
    if (!choice) {
        return;
    }
    const forceNewWindow = choice === 'New window';
    await vscode.commands.executeCommand('vscode.openFolder', workspaceFile, forceNewWindow);
}
async function quickSwitchProjectWorkspace(context) {
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    if (!data?.projects || data.projects.length === 0) {
        void (0, utils_1.showInfo)('No projects found. Create a project first.');
        return;
    }
    const pick = await vscode.window.showQuickPick(data.projects.map((p, idx) => ({
        label: p.name,
        description: `${p.repos?.length ?? 0} repos`,
        index: idx
    })), { placeHolder: 'Select a project to open its workspace' });
    if (!pick) {
        return;
    }
    data.projects.forEach((p, idx) => (p.isSelected = idx === pick.index));
    await settingsStore_1.SettingsStore.saveWithoutComments(data);
    await openProjectWorkspace(context);
}


/***/ }),
/* 88 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.versionFolderEntries = versionFolderEntries;
exports.repoFolderEntries = repoFolderEntries;
/**
 * The active version's core checkouts, as multi-root workspace folders. Each
 * version owns its own worktree, so a project workspace that lists only the
 * project repos opens the custom addons without the Odoo source being run -
 * and breakpoints set in a stale checkout bind to the wrong files.
 */
const utils_1 = __webpack_require__(8);
function versionFolderEntries(version, existingPaths) {
    if (!version) {
        return [];
    }
    const seen = new Set(existingPaths.map(entry => (0, utils_1.normalizePath)(entry)));
    const entries = [];
    const add = (rawPath, label) => {
        const trimmed = rawPath?.trim();
        if (!trimmed) {
            return;
        }
        const resolved = (0, utils_1.normalizePath)(trimmed);
        if (seen.has(resolved)) {
            return;
        }
        seen.add(resolved);
        entries.push({ path: resolved, name: `${label} (${version.name})` });
    };
    add(version.settings.odooPath, 'odoo');
    add(version.settings.enterprisePath, 'enterprise');
    add(version.settings.designThemesPath, 'design-themes');
    return entries;
}
/**
 * Project repositories as workspace folders, resolved to the active version's
 * worktrees. A worktree is labelled with its branch so two open copies of the
 * same repository are told apart at a glance.
 */
function repoFolderEntries(resolved, existingPaths) {
    const seen = new Set(existingPaths.map(entry => (0, utils_1.normalizePath)(entry)));
    const entries = [];
    for (const entry of resolved) {
        const resolvedPath = (0, utils_1.normalizePath)(entry.path);
        if (seen.has(resolvedPath)) {
            continue;
        }
        seen.add(resolvedPath);
        entries.push(entry.isWorktree && entry.branch
            ? { path: resolvedPath, name: `${entry.repo.name} (${entry.branch})` }
            : { path: resolvedPath });
    }
    return entries;
}


/***/ }),
/* 89 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.buildProposal = buildProposal;
exports.runSetup = runSetup;
/**
 * The setup flow: detect what is already on the machine, propose it in one
 * confirmation, write the result, and hand off to provisioning. Replaces a
 * five-question wizard that asked everything up front and - the bug this
 * exists to fix - never recorded where it put anything.
 */
const fs = __importStar(__webpack_require__(2));
const path = __importStar(__webpack_require__(4));
const vscode = __importStar(__webpack_require__(1));
const notifications_1 = __webpack_require__(16);
const logger_1 = __webpack_require__(12);
const branches_1 = __webpack_require__(32);
const setupDetection_1 = __webpack_require__(90);
const setupState_1 = __webpack_require__(64);
function workspaceFolderPaths() {
    return (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
}
/** Builds the proposal shown for confirmation: current settings, then detection. */
async function buildProposal() {
    const raw = (0, setupState_1.readRawSetupSettings)();
    const roots = (0, setupDetection_1.searchRoots)([raw.sourceRepo, raw.enterpriseRepo, raw.designThemesRepo], workspaceFolderPaths());
    const best = (0, setupDetection_1.pickBest)((0, setupDetection_1.detectRepos)(roots));
    const pick = (kind, configured) => configured?.trim() || best[kind]?.path;
    const sourceRepo = pick('odoo', raw.sourceRepo);
    return {
        sourceRepo,
        enterpriseRepo: pick('enterprise', raw.enterpriseRepo),
        designThemesRepo: pick('design-themes', raw.designThemesRepo),
        provisioningRoot: raw.provisioningRoot?.trim() || (0, setupState_1.defaultProvisioningRoot)(),
        sourceBranch: sourceRepo ? (await (0, branches_1.getRepoBranch)(sourceRepo)) ?? undefined : undefined
    };
}
function describe(proposal) {
    const rows = [
        `Source: ${proposal.sourceRepo ?? 'not found'}${proposal.sourceBranch ? ` (${proposal.sourceBranch})` : ''}`,
        proposal.enterpriseRepo ? `Enterprise: ${proposal.enterpriseRepo}` : undefined,
        proposal.designThemesRepo ? `Design themes: ${proposal.designThemesRepo}` : undefined,
        `Environments: ${proposal.provisioningRoot}${fs.existsSync(proposal.provisioningRoot) ? '' : ' (will be created)'}`
    ];
    return rows.filter(Boolean).join('  •  ');
}
async function browseForFolder(title, defaultPath) {
    const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        title,
        openLabel: 'Select',
        defaultUri: defaultPath && fs.existsSync(defaultPath) ? vscode.Uri.file(defaultPath) : undefined
    });
    return picked?.[0]?.fsPath;
}
/** The "Change…" path: only reached when detection got something wrong. */
async function editProposal(proposal) {
    const source = await browseForFolder('Select the Odoo source repository', proposal.sourceRepo);
    if (!source) {
        return undefined;
    }
    if (!fs.existsSync(path.join(source, 'odoo-bin'))) {
        void (0, notifications_1.showError)(`${source} does not look like an Odoo repository (no odoo-bin).`);
        return undefined;
    }
    const root = await browseForFolder('Select where environments should be built', proposal.provisioningRoot);
    if (!root) {
        return undefined;
    }
    // Optional repos are looked for beside the source repo rather than asked
    // about: they are almost always siblings, and a wrong guess is harmless.
    const parent = path.dirname(source);
    const sibling = (name) => {
        const candidate = path.join(parent, name);
        return fs.existsSync(candidate) ? candidate : undefined;
    };
    return {
        sourceRepo: source,
        enterpriseRepo: proposal.enterpriseRepo ?? sibling('enterprise'),
        designThemesRepo: proposal.designThemesRepo ?? sibling('design-themes'),
        provisioningRoot: root,
        sourceBranch: (await (0, branches_1.getRepoBranch)(source)) ?? undefined
    };
}
async function persist(proposal) {
    const values = {
        sourceRepo: proposal.sourceRepo,
        enterpriseRepo: proposal.enterpriseRepo ?? '',
        designThemesRepo: proposal.designThemesRepo ?? '',
        provisioningRoot: proposal.provisioningRoot
    };
    await (0, setupState_1.writeSetupSettings)(values);
    fs.mkdirSync(proposal.provisioningRoot, { recursive: true });
}
/**
 * Runs setup. Returns true when the machine ends up configured, so callers can
 * chain straight into creating a version.
 */
async function runSetup(options) {
    let proposal = await buildProposal();
    if (!proposal.sourceRepo) {
        const choice = await (0, notifications_1.showInfo)('No Odoo repository found on this machine.', 'Clone One', 'Choose Folder…');
        if (choice === 'Clone One') {
            const cloned = await options.cloneFallback();
            if (!cloned) {
                return false;
            }
            proposal = await buildProposal();
        }
        else if (choice === 'Choose Folder…') {
            const edited = await editProposal(proposal);
            if (!edited) {
                return false;
            }
            proposal = edited;
        }
        else {
            return false;
        }
    }
    if (!proposal.sourceRepo) {
        return false;
    }
    const confirmed = await vscode.window.showQuickPick([
        { label: '$(check) Use these', detail: describe(proposal), edit: false },
        { label: '$(edit) Change…', detail: 'Pick the source repository and environment directory yourself', edit: true }
    ], { title: 'Set up Odoo DevTools', placeHolder: 'Confirm where Odoo lives', ignoreFocusOut: true });
    if (!confirmed) {
        return false;
    }
    if (confirmed.edit) {
        const edited = await editProposal(proposal);
        if (!edited) {
            return false;
        }
        proposal = edited;
    }
    try {
        await persist(proposal);
    }
    catch (error) {
        logger_1.logger.error('Failed to save setup:', error);
        void (0, notifications_1.showError)(`Could not save the setup: ${(0, logger_1.errorMessage)(error)}`);
        return false;
    }
    return (0, setupState_1.readSetupState)().isConfigured;
}


/***/ }),
/* 90 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.classifyByName = classifyByName;
exports.searchRoots = searchRoots;
exports.pickBest = pickBest;
exports.detectRepos = detectRepos;
/**
 * Finds Odoo checkouts already on the machine so setup can propose them
 * instead of interrogating the user. Classification and ranking are pure;
 * only the scan touches the filesystem, and it is bounded to a fixed root
 * list one level deep so it can never wander a large home directory.
 */
const fs = __importStar(__webpack_require__(2));
const os = __importStar(__webpack_require__(37));
const path = __importStar(__webpack_require__(4));
const logger_1 = __webpack_require__(12);
/** Directory names that identify the two optional repos. */
const ENTERPRISE_NAMES = new Set(['enterprise', 'odoo-enterprise']);
const DESIGN_THEMES_NAMES = new Set(['design-themes', 'odoo-design-themes', 'themes']);
/**
 * What a directory is, from its name alone. `odoo` is deliberately absent:
 * an Odoo source repo is identified by containing `odoo-bin`, not by being
 * called "odoo", because the fork is often named after the client.
 */
function classifyByName(dirName) {
    const name = dirName.trim().toLowerCase();
    if (ENTERPRISE_NAMES.has(name)) {
        return 'enterprise';
    }
    if (DESIGN_THEMES_NAMES.has(name)) {
        return 'design-themes';
    }
    return undefined;
}
/** The directories scanned, most-trusted first. */
function searchRoots(configured, workspaceFolders, home = os.homedir()) {
    const roots = [];
    const seen = new Set();
    const push = (dir) => {
        const trimmed = dir?.trim();
        if (!trimmed || seen.has(trimmed)) {
            return;
        }
        seen.add(trimmed);
        roots.push(trimmed);
    };
    // A configured path is a statement of intent; its parent is where the
    // sibling repos almost always live.
    for (const dir of configured) {
        push(dir);
        if (dir?.trim()) {
            push(path.dirname(dir.trim()));
        }
    }
    workspaceFolders.forEach(push);
    for (const name of ['src', 'Dev', 'dev', 'Projects', 'odoo', DEFAULT_HOME_DIRNAME]) {
        push(path.join(home, name));
    }
    push(home);
    return roots;
}
const DEFAULT_HOME_DIRNAME = 'odoo-dev';
/**
 * Best candidate per kind: the earliest search root wins, since roots are
 * ordered by how much the location is trusted.
 */
function pickBest(candidates) {
    const best = {};
    for (const candidate of [...candidates].sort((a, b) => a.rank - b.rank)) {
        if (!best[candidate.kind]) {
            best[candidate.kind] = candidate;
        }
    }
    return best;
}
function isGitRepo(dir) {
    // A worktree carries a .git file rather than a directory, so test presence.
    return fs.existsSync(path.join(dir, '.git'));
}
function inspect(dir, rank) {
    try {
        if (!fs.statSync(dir).isDirectory() || !isGitRepo(dir)) {
            return undefined;
        }
    }
    catch {
        return undefined;
    }
    if (fs.existsSync(path.join(dir, 'odoo-bin'))) {
        return { path: dir, kind: 'odoo', rank };
    }
    const byName = classifyByName(path.basename(dir));
    return byName ? { path: dir, kind: byName, rank } : undefined;
}
/**
 * Scans the search roots one level deep. Each root is also tested directly,
 * so a configured path that *is* the repo is found without listing its parent.
 */
function detectRepos(roots) {
    const found = [];
    const seen = new Set();
    roots.forEach((root, index) => {
        const rank = index * 100;
        const direct = inspect(root, rank);
        if (direct && !seen.has(direct.path)) {
            seen.add(direct.path);
            found.push(direct);
        }
        let entries;
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) {
                continue;
            }
            const child = path.join(root, entry.name);
            if (seen.has(child)) {
                continue;
            }
            const candidate = inspect(child, rank + 1);
            if (candidate) {
                seen.add(child);
                found.push(candidate);
            }
        }
    });
    logger_1.logger.debug(`[setup] detected ${found.length} candidate repositories`);
    return found;
}


/***/ }),
/* 91 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.registerRepoCommands = registerRepoCommands;
/**
 * Command handlers for the Repos view.
 */
const vscode = __importStar(__webpack_require__(1));
const repos_1 = __webpack_require__(61);
const projectWorkspace_1 = __webpack_require__(87);
function registerRepoCommands(deps) {
    const { context, refreshAll } = deps;
    context.subscriptions.push(vscode.commands.registerCommand('repoSelector.selectRepo', async (event) => {
        await (0, repos_1.selectRepo)(event);
        await (0, projectWorkspace_1.rebuildProjectWorkspace)(context);
        await refreshAll();
    }));
}


/***/ }),
/* 92 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.registerDbCommands = registerDbCommands;
/**
 * Command handlers for the Databases view.
 */
const vscode = __importStar(__webpack_require__(1));
const settingsStore_1 = __webpack_require__(6);
const notifications_1 = __webpack_require__(16);
const logger_1 = __webpack_require__(12);
const dbs_1 = __webpack_require__(36);
const notifications_2 = __webpack_require__(16);
const server_1 = __webpack_require__(76);
const utils_1 = __webpack_require__(8);
function registerDbCommands(deps) {
    const { context, versionsService, refreshAll } = deps;
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.create', async () => {
        try {
            // Get settings from active version
            const settings = await versionsService.getActiveVersionSettings();
            const projects = await settingsStore_1.SettingsStore.getProjects();
            const project = projects?.find((p) => p.isSelected);
            if (!project) {
                throw new Error('Select a project before running this action.');
            }
            const db = await (0, dbs_1.createDb)(project.name, project.repos, settings.dumpsFolder, settings);
            if (db) {
                project.dbs.push(db);
                // Only save projects, not settings - settings are managed via versions
                const data = await settingsStore_1.SettingsStore.load();
                await settingsStore_1.SettingsStore.saveWithoutComments({
                    projects,
                    versions: data.versions,
                    activeVersion: data.activeVersion,
                    dbTemplates: data.dbTemplates
                });
                await (0, dbs_1.selectDatabase)(db);
            }
            await refreshAll();
        }
        catch (err) {
            void (0, notifications_1.showError)((0, logger_1.errorMessage)(err));
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.selectDb', async (event) => {
        try {
            await (0, dbs_1.selectDatabase)(event);
            await refreshAll();
        }
        catch (err) {
            void (0, notifications_1.showError)(`Failed to select database: ${(0, logger_1.errorMessage)(err)}`);
            logger_1.logger.error('Error in database selection:', err);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.delete', async (event) => {
        try {
            await (0, dbs_1.deleteDb)(event);
            await refreshAll();
        }
        catch (err) {
            void (0, notifications_1.showError)(`Failed to delete database: ${(0, logger_1.errorMessage)(err)}`);
            logger_1.logger.error('Error in database deletion:', err);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.restore', async (event) => {
        try {
            // restoreDb shows its own success notification.
            await (0, dbs_1.restoreDb)(event);
            await refreshAll();
        }
        catch (err) {
            void (0, notifications_1.showError)(`Failed to restore database: ${(0, logger_1.errorMessage)(err)}`);
            logger_1.logger.error('Error in database restoration:', err);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.changeVersion', async (event) => {
        try {
            await (0, dbs_1.changeDatabaseVersion)(event);
            await refreshAll();
        }
        catch (err) {
            void (0, notifications_1.showError)(`Failed to change database version: ${(0, logger_1.errorMessage)(err)}`);
            logger_1.logger.error('Error in database version change:', err);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.configureRepoBranches', async (event) => {
        try {
            await (0, dbs_1.changeDatabaseProjectRepoBranches)(event);
            await refreshAll({ reason: 'ui' });
        }
        catch (err) {
            void (0, notifications_1.showError)(`Failed to update project repo branch mapping: ${(0, logger_1.errorMessage)(err)}`);
            logger_1.logger.error('Error in database project repo branch mapping update:', err);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.manageTemplates', async () => {
        try {
            await (0, dbs_1.manageDatabaseTemplates)();
            await refreshAll({ reason: 'ui' });
        }
        catch (err) {
            void (0, notifications_1.showError)(`Failed to manage database templates: ${(0, logger_1.errorMessage)(err)}`);
            logger_1.logger.error('Error in database template management:', err);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.openInBrowser', async (event) => {
        const db = (0, dbs_1.extractDatabaseFromEvent)(event);
        if (!db) {
            void (0, notifications_1.showError)('Could not identify the database to open in the browser.');
            return;
        }
        // Pass the database's own version so the port comes from the server
        // serving it, not from whichever version happens to be active.
        await (0, server_1.openServerInBrowser)(db.id, db.versionId);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.openPsqlShell', async (event) => {
        const db = (0, dbs_1.extractDatabaseFromEvent)(event);
        if (!db) {
            void (0, notifications_1.showError)('Could not identify the database to open in psql.');
            return;
        }
        const terminal = vscode.window.createTerminal({ name: `psql: ${db.id}` });
        terminal.show();
        // db names are validated on creation, but quote defensively anyway
        terminal.sendText(`psql ${JSON.stringify(db.id)}`);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.rename', async (event) => {
        const db = (0, dbs_1.extractDatabaseFromEvent)(event);
        if (!db) {
            void (0, notifications_1.showError)('Could not identify the database to rename.');
            return;
        }
        const current = (0, utils_1.getDatabaseLabel)(db);
        const entered = await vscode.window.showInputBox({
            prompt: `New display name for "${db.id}" (the PostgreSQL database is not renamed)`,
            value: current,
            ignoreFocusOut: true,
            validateInput: value => (value.trim() ? undefined : 'Display name cannot be empty')
        });
        const newName = entered?.trim();
        if (!newName || newName === current) {
            return;
        }
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            return;
        }
        const { data, project } = result;
        const target = project.dbs?.find(entry => entry.id === db.id);
        if (!target) {
            void (0, notifications_1.showError)('The database could not be found in the current project.');
            return;
        }
        target.displayName = newName;
        target.name = newName;
        await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
        await refreshAll({ reason: 'ui' });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.copyName', async (event) => {
        const db = (0, dbs_1.extractDatabaseFromEvent)(event);
        if (!db) {
            void (0, notifications_1.showError)('Could not identify the database whose name to copy.');
            return;
        }
        await vscode.env.clipboard.writeText(db.id);
        (0, notifications_2.showBriefStatus)(`Copied database name: ${db.id}`);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.clone', async (event) => {
        try {
            await (0, dbs_1.cloneDatabaseFlow)(event);
            await refreshAll({ reason: 'ui' });
        }
        catch (err) {
            void (0, notifications_1.showError)(`Failed to clone database: ${(0, logger_1.errorMessage)(err)}`);
            logger_1.logger.error('Error in database clone:', err);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.reconcile', async () => {
        try {
            await (0, dbs_1.reconcileDatabasesFlow)();
            await refreshAll({ reason: 'ui' });
        }
        catch (err) {
            void (0, notifications_1.showError)(`Failed to reconcile databases: ${(0, logger_1.errorMessage)(err)}`);
            logger_1.logger.error('Error in database reconciliation:', err);
        }
    }));
}


/***/ }),
/* 93 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.registerModuleCommands = registerModuleCommands;
/**
 * Command handlers for the Modules view.
 */
const vscode = __importStar(__webpack_require__(1));
const notifications_1 = __webpack_require__(16);
const module_1 = __webpack_require__(62);
/**
 * Tree context menus pass (clickedItem, selectedItems); with canSelectMany
 * enabled a bulk action applies to the whole selection when the clicked
 * item is part of it.
 */
function targetsOf(event, selection) {
    if (selection && selection.length > 1 && selection.includes(event)) {
        return selection;
    }
    return [event];
}
function registerModuleCommands(deps) {
    const { context, refreshAll } = deps;
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.select', async (event) => {
        await (0, module_1.selectModule)(event);
        await refreshAll();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.togglePsaeInternalModule', async (event) => {
        await (0, module_1.togglePsaeInternalModule)(event);
        await refreshAll();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.create', async () => {
        await (0, module_1.createModuleFromScaffold)();
        await refreshAll({ reason: 'ui' });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.setToInstall', async (event, selection) => {
        for (const target of targetsOf(event, selection)) {
            await (0, module_1.setModuleToInstall)(target);
        }
        await refreshAll();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.setToUpgrade', async (event, selection) => {
        for (const target of targetsOf(event, selection)) {
            await (0, module_1.setModuleToUpgrade)(target);
        }
        await refreshAll();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.clearState', async (event, selection) => {
        for (const target of targetsOf(event, selection)) {
            await (0, module_1.clearModuleState)(target);
        }
        await refreshAll();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.updateAll', async () => {
        await (0, module_1.updateAllModules)();
        await refreshAll();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.updateInstalled', async () => {
        await (0, module_1.updateInstalledModules)();
        await refreshAll();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.installAll', async () => {
        await (0, module_1.installAllModules)();
        await refreshAll();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.clearAll', async () => {
        await (0, module_1.clearAllModuleSelections)();
        await refreshAll();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.viewInstalled', async () => {
        await (0, module_1.viewInstalledModules)();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.quickConfigure', async () => {
        await (0, module_1.quickConfigureModules)();
        // One refresh when the picker closes, however many states changed.
        await refreshAll();
    }));
    // Same reveal behavior as the Project Repos view, triggered from a
    // module item (module nodes carry moduleData.path, not a resourceUri).
    const modulePathOf = (event) => event?.moduleData?.path;
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.revealInExplorer', async (event) => {
        const modulePath = modulePathOf(event);
        if (!modulePath) {
            void (0, notifications_1.showInfo)('Could not identify the module to reveal.');
            return;
        }
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(modulePath));
    }));
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.revealInOS', async (event) => {
        const modulePath = modulePathOf(event);
        if (!modulePath) {
            void (0, notifications_1.showInfo)('Could not identify the module to reveal.');
            return;
        }
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(modulePath));
    }));
}


/***/ }),
/* 94 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.registerTestingCommands = registerTestingCommands;
/**
 * Command handlers for the Testing view.
 */
const vscode = __importStar(__webpack_require__(1));
const settingsStore_1 = __webpack_require__(6);
const testing_1 = __webpack_require__(65);
function registerTestingCommands(deps) {
    const { context, providers, refreshAll } = deps;
    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.toggleTesting', async (event) => {
        await (0, testing_1.toggleTesting)(event);
        await refreshAll({ reason: 'ui' });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.toggleStopAfterInit', async () => {
        await (0, testing_1.toggleStopAfterInit)();
        await refreshAll({ reason: 'ui' });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.setTestFile', async () => {
        await (0, testing_1.setTestFile)();
        await refreshAll({ reason: 'ui' });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.addTestTag', async () => {
        await (0, testing_1.addTestTag)();
        providers.testing.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.removeTestTag', async (event) => {
        await (0, testing_1.removeTestTag)(event);
        providers.testing.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.cycleTestTagState', async (event) => {
        await (0, testing_1.cycleTestTagState)(event);
        providers.testing.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.toggleLogLevel', async () => {
        await (0, testing_1.toggleLogLevel)();
        providers.testing.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.setSpecificLogLevel', async () => {
        await (0, testing_1.setSpecificLogLevel)();
        providers.testing.refresh();
    }));
    // No-argument wrapper (keybinding / palette): reads the current state
    // instead of requiring the tree item's payload.
    context.subscriptions.push(vscode.commands.registerCommand('odoo.toggleTestingMode', async () => {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            return;
        }
        await (0, testing_1.toggleTesting)({ isEnabled: !!result.project.testingConfig?.isEnabled });
        await refreshAll({ reason: 'ui' });
    }));
}


/***/ }),
/* 95 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.registerVersionCommands = registerVersionCommands;
/**
 * Command handlers for the Versions view and version settings.
 */
const vscode = __importStar(__webpack_require__(1));
const fs = __importStar(__webpack_require__(2));
const args_1 = __webpack_require__(96);
const utils_1 = __webpack_require__(8);
const versionIdentity_1 = __webpack_require__(27);
const notifications_1 = __webpack_require__(16);
const logger_1 = __webpack_require__(12);
const branchPick_1 = __webpack_require__(97);
const runtimeCache_1 = __webpack_require__(15);
const environment_1 = __webpack_require__(31);
const odooInstaller_1 = __webpack_require__(86);
const worktree_1 = __webpack_require__(35);
const server_1 = __webpack_require__(76);
const dbResolution_1 = __webpack_require__(40);
const settingsStore_1 = __webpack_require__(6);
function registerVersionCommands(deps) {
    const { context, versionsService, refreshAll } = deps;
    context.subscriptions.push(vscode.commands.registerCommand('odoo.openVersionInBrowser', async (versionIdOrTreeItem) => {
        try {
            let versionId = (0, args_1.extractVersionId)(versionIdOrTreeItem);
            if (!versionId) {
                const picked = await vscode.window.showQuickPick(versionsService.getVersions().map(version => ({
                    label: version.name,
                    description: version.settings.portNumber ? `:${version.settings.portNumber}` : version.odooVersion,
                    versionId: version.id
                })), { title: 'Open which version in the browser?', placeHolder: 'Select a version' });
                if (!picked) {
                    return;
                }
                versionId = picked.versionId;
            }
            const version = versionsService.getVersion(versionId);
            if (!version) {
                void (0, notifications_1.showError)('The selected version could not be found.');
                return;
            }
            const port = Number(version.settings.portNumber);
            if (!Number.isInteger(port) || port <= 0) {
                void (0, notifications_1.showError)(`"${version.name}" has no server port.`);
                return;
            }
            // The database this version runs, not the project's selection:
            // with several versions up they are usually different.
            const result = await settingsStore_1.SettingsStore.getSelectedProject();
            const db = result
                ? (0, dbResolution_1.resolveDbForVersion)(result.project.dbs, result.project.selectedDbByVersion, version.id)
                : undefined;
            const url = (0, server_1.buildServerUrl)(port, db?.id);
            if (await (0, server_1.waitForPort)(port, 400)) {
                await vscode.env.openExternal(url);
                return;
            }
            const choice = await (0, notifications_1.showWarning)(`No Odoo server is answering on port ${port} for "${version.name}".`, 'Open Anyway');
            if (choice === 'Open Anyway') {
                await vscode.env.openExternal(url);
            }
        }
        catch (error) {
            void (0, notifications_1.showError)(`Failed to open the server in the browser: ${(0, logger_1.errorMessage)(error)}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo.createVersion', async () => {
        try {
            // Two prompts: branch, then name. Paths and ports come from the
            // odooDebugger.defaultVersion.* settings and stay editable in the
            // Versions tree after creation.
            const activeSettings = await versionsService.getActiveVersionSettings();
            const odooPath = activeSettings?.odooPath ? (0, utils_1.normalizePath)(activeSettings.odooPath) : undefined;
            const odooVersion = await (0, branchPick_1.pickOdooBranch)(odooPath, 'Create Version');
            if (!odooVersion) {
                return;
            }
            const name = (await vscode.window.showInputBox({
                title: 'Create Version',
                prompt: 'Version name',
                value: `Odoo ${odooVersion}`,
                ignoreFocusOut: true,
                validateInput: value => value.trim() ? undefined : 'Name is required.'
            }))?.trim();
            if (!name) {
                return;
            }
            // Provisioning gives the version its own worktree, interpreter and
            // virtualenv; the flow offers a profile-only path for anyone who
            // already has an environment set up by hand.
            const version = await (0, odooInstaller_1.provisionAndCreateVersion)(odooVersion, name);
            if (!version) {
                return;
            }
            await refreshAll({ reason: 'ui' });
            const action = await (0, notifications_1.showInfo)(`Version "${name}" created on branch "${odooVersion}".`, 'Activate Now');
            if (action === 'Activate Now') {
                await vscode.commands.executeCommand('odoo.setActiveVersion', version.id);
            }
        }
        catch (error) {
            void (0, notifications_1.showError)(`Failed to create version: ${(0, logger_1.errorMessage)(error)}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo.openVersionDefaults', async () => {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:AhmadMansour.odoo-devtools-vscode odooDebugger.defaultVersion');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo.changeBranch', async (versionIdOrTreeItem) => {
        try {
            const versionId = (0, args_1.extractVersionId)(versionIdOrTreeItem);
            if (!versionId) {
                void (0, notifications_1.showError)('Select a version before continuing.');
                return;
            }
            const version = versionsService.getVersion(versionId);
            if (!version) {
                void (0, notifications_1.showError)('The selected version could not be found.');
                return;
            }
            // Get Odoo path from the specific version being edited
            const odooPath = version.settings.odooPath;
            let newBranch;
            if (odooPath) {
                newBranch = await (0, branchPick_1.pickOdooBranch)(odooPath, `Change branch for "${version.name}" (current: ${version.odooVersion})`);
            }
            else {
                // No Odoo path configured: manual entry is the only option.
                const result = await (0, notifications_1.showWarning)('Odoo path is not configured. Please set the Odoo path in settings first, or enter the branch manually.', 'Enter Manually', 'Cancel');
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
            void (0, notifications_1.showInfo)(`Branch changed from "${version.odooVersion}" to "${newBranch}" for version "${version.name}"`);
        }
        catch (error) {
            void (0, notifications_1.showError)(`Failed to change branch: ${(0, logger_1.errorMessage)(error)}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo.setActiveVersion', async (versionIdOrTreeItem) => {
        try {
            let versionId = (0, args_1.extractVersionId)(versionIdOrTreeItem);
            if (!versionId) {
                // No version provided - show version picker
                const versions = versionsService.getVersions();
                const items = versions.map(v => ({
                    label: v.name,
                    description: v.odooVersion,
                    detail: v.isActive ? '$(check) Currently active' : '',
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
                void (0, notifications_1.showInfo)(`Activated version: ${version?.name}`);
                if (version) {
                    // Align the core repos to the version's branch through the
                    // shared switch pipeline (honors databaseSwitchBehavior).
                    await (0, environment_1.alignEnvironment)({ versionId: version.id }, { label: `Version "${version.name}"` });
                }
                await refreshAll(); // Refresh all views to reflect new active version
            }
            else {
                void (0, notifications_1.showError)('Unable to activate the selected version.');
            }
        }
        catch (error) {
            void (0, notifications_1.showError)(`Unable to activate the selected version: ${(0, logger_1.errorMessage)(error)}`);
        }
    }));
    // Helper functions for setting editing
    const editNumberSetting = async (settingKey, currentValue) => {
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
    const editPathSetting = async (settingKey, currentValue) => {
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
        }
        else if (pathAction?.value === 'browse') {
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
    const editDevModeSetting = async (currentValue) => {
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
        }
        else if (devModeOption.label === 'None') {
            return '';
        }
        else {
            return `--dev=${devModeOption.label}`;
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand('odoo.editVersionSetting', async (versionIdOrTreeItem, settingKey, currentValue) => {
        try {
            const ref = (0, args_1.extractVersionSettingRef)(versionIdOrTreeItem, settingKey, currentValue);
            if (!ref) {
                void (0, notifications_1.showError)('This command was invoked with invalid parameters.');
                return;
            }
            const { versionId, key, value } = ref;
            if ((0, versionIdentity_1.isDerivedSetting)(key)) {
                void (0, notifications_1.showInfo)(`"${(0, utils_1.getSettingDisplayName)(key)}" is derived from this version's branch so two versions can run at once. ` +
                    `Change the version's branch to change it.`);
                return;
            }
            let newValue = undefined;
            // Handle different types of settings
            if (['portNumber', 'shellPortNumber', 'limitTimeReal', 'limitTimeCpu', 'maxCronThreads'].includes(key)) {
                newValue = await editNumberSetting(key, value);
            }
            else if (['odooPath', 'enterprisePath', 'designThemesPath', 'customAddonsPath', 'pythonPath', 'dumpsFolder'].includes(key)) {
                newValue = await editPathSetting(key, value);
            }
            else if (key === 'devMode') {
                newValue = await editDevModeSetting(value);
            }
            else {
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
            });
            if (['customAddonsPath'].includes(key)) {
                (0, runtimeCache_1.invalidateRepositoryDiscoveryCache)();
                (0, runtimeCache_1.invalidateModuleDiscoveryCache)();
            }
            else if (['odooPath', 'enterprisePath', 'designThemesPath', 'subModulesPaths'].includes(key)) {
                (0, runtimeCache_1.invalidateModuleDiscoveryCache)();
            }
            void (0, notifications_1.showInfo)(`Updated ${key} successfully`);
            await refreshAll();
        }
        catch (error) {
            void (0, notifications_1.showError)(`Failed to edit setting: ${(0, logger_1.errorMessage)(error)}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo.cloneVersion', async (versionIdOrTreeItem) => {
        try {
            let versionId = (0, args_1.extractVersionId)(versionIdOrTreeItem);
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
                void (0, notifications_1.showInfo)(`Version "${name}" cloned successfully`);
            }
            else {
                void (0, notifications_1.showError)('Failed to clone the selected version.');
            }
        }
        catch (error) {
            void (0, notifications_1.showError)(`Failed to clone the selected version: ${(0, logger_1.errorMessage)(error)}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo.deleteVersion', async (versionIdOrTreeItem) => {
        try {
            let versionId = (0, args_1.extractVersionId)(versionIdOrTreeItem);
            if (!versionId) {
                // No version provided - show version picker
                const versions = versionsService.getVersions();
                const items = versions.filter(v => !v.isActive).map(v => ({
                    label: v.name,
                    description: v.odooVersion,
                    versionId: v.id
                }));
                if (items.length === 0) {
                    void (0, notifications_1.showInfo)('There are no versions available to delete (the active version cannot be removed).');
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
                void (0, notifications_1.showError)('The selected version could not be found.');
                return;
            }
            const confirm = await (0, notifications_1.showModalWarning)(`Are you sure you want to delete version "${version.name}"?`, 'Delete');
            if (confirm !== 'Delete') {
                return;
            }
            const managedPaths = version.settings.managedPaths ?? [];
            if (managedPaths.length > 0) {
                const removeChoice = await (0, notifications_1.showModalWarning)(`Also delete the ${managedPaths.length} folder(s) this extension created for "${version.name}"?\n\n${managedPaths.join('\n')}`, 'Delete Folders', 'Keep Folders');
                if (removeChoice === 'Delete Folders') {
                    const sourceRepos = new Set();
                    for (const managedPath of managedPaths) {
                        // Worktrees must go through git so the parent repo's
                        // administrative entry goes with them; anything git
                        // refuses (a venv, a stale directory) is a plain delete.
                        // The source repo has to be resolved before removal,
                        // because afterwards there is nothing left to ask.
                        const sourceRepo = await (0, worktree_1.resolveSourceRepo)(managedPath);
                        let removed = false;
                        if (sourceRepo) {
                            removed = await (0, worktree_1.removeWorktree)(sourceRepo, managedPath)
                                .then(() => true)
                                .catch(() => false);
                            if (removed) {
                                sourceRepos.add(sourceRepo);
                            }
                        }
                        if (!removed) {
                            try {
                                await fs.promises.rm(managedPath, { recursive: true, force: true });
                            }
                            catch (error) {
                                logger_1.logger.warn(`Failed to remove ${managedPath}:`, error);
                            }
                        }
                    }
                    // git worktree remove leaves the managed branch behind.
                    for (const sourceRepo of sourceRepos) {
                        await (0, worktree_1.removeManagedBranch)(sourceRepo, version.odooVersion);
                    }
                }
            }
            const success = await versionsService.deleteVersion(versionId);
            if (success) {
                void (0, notifications_1.showInfo)(`Version "${version.name}" deleted successfully`);
            }
            else {
                void (0, notifications_1.showError)('Failed to delete the selected version.');
            }
        }
        catch (error) {
            void (0, notifications_1.showError)(`Failed to delete the selected version: ${(0, logger_1.errorMessage)(error)}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo.setSettingToDefault', async (settingTreeItem) => {
        try {
            const ref = (0, args_1.extractVersionSettingRef)(settingTreeItem);
            if (!ref) {
                void (0, notifications_1.showError)('Select a setting before continuing.');
                return;
            }
            const success = await versionsService.setSettingToDefault(ref.versionId, ref.key);
            if (!success) {
                void (0, notifications_1.showError)('Unable to reset this setting to its default value.');
            }
        }
        catch (error) {
            void (0, notifications_1.showError)(`Failed to reset setting to default: ${(0, logger_1.errorMessage)(error)}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo.setSettingAsDefault', async (settingTreeItem) => {
        try {
            const ref = (0, args_1.extractVersionSettingRef)(settingTreeItem);
            if (!ref) {
                void (0, notifications_1.showError)('Select a setting before continuing.');
                return;
            }
            const success = await versionsService.setSettingAsDefault(ref.versionId, ref.key);
            if (!success) {
                void (0, notifications_1.showError)('Unable to save this setting as the default.');
            }
        }
        catch (error) {
            void (0, notifications_1.showError)(`Unable to save this setting as the default: ${(0, logger_1.errorMessage)(error)}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo.setAllSettingsToDefault', async (versionTreeItem) => {
        try {
            const versionId = (0, args_1.extractVersionId)(versionTreeItem);
            if (!versionId) {
                void (0, notifications_1.showError)('Select a version before continuing.');
                return;
            }
            const version = versionsService.getVersion(versionId);
            if (!version) {
                void (0, notifications_1.showError)('The selected version could not be found.');
                return;
            }
            const confirm = await (0, notifications_1.showWarning)(`Are you sure you want to reset ALL settings for version "${version.name}" to their default values?`, 'Reset All', 'Cancel');
            if (confirm !== 'Reset All') {
                return;
            }
            const success = await versionsService.setAllSettingsToDefault(versionId);
            if (!success) {
                void (0, notifications_1.showError)('Unable to reset all settings to their default values.');
            }
        }
        catch (error) {
            void (0, notifications_1.showError)(`Failed to reset all settings to default: ${(0, logger_1.errorMessage)(error)}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo.setAllSettingsAsDefault', async (versionTreeItem) => {
        try {
            const versionId = (0, args_1.extractVersionId)(versionTreeItem);
            if (!versionId) {
                void (0, notifications_1.showError)('Select a version before continuing.');
                return;
            }
            const version = versionsService.getVersion(versionId);
            if (!version) {
                void (0, notifications_1.showError)('The selected version could not be found.');
                return;
            }
            const confirm = await (0, notifications_1.showWarning)(`Are you sure you want to save ALL settings from version "${version.name}" as new default values?`, 'Save All as Default', 'Cancel');
            if (confirm !== 'Save All as Default') {
                return;
            }
            const success = await versionsService.setAllSettingsAsDefault(versionId);
            if (!success) {
                void (0, notifications_1.showError)('Unable to save these settings as the new defaults.');
            }
        }
        catch (error) {
            void (0, notifications_1.showError)(`Unable to save these settings as the new defaults: ${(0, logger_1.errorMessage)(error)}`);
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
}


/***/ }),
/* 96 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.extractVersionId = extractVersionId;
exports.extractVersionSettingRef = extractVersionSettingRef;
exports.extractUri = extractUri;
const vscode = __importStar(__webpack_require__(1));
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
/** A version id passed directly, or a version tree item. */
function extractVersionId(arg) {
    if (typeof arg === 'string') {
        return arg;
    }
    if (isObject(arg)) {
        const id = arg.version?.id;
        if (typeof id === 'string') {
            return id;
        }
    }
    return undefined;
}
/** A version-setting tree item, or explicit (versionId, key, value) params. */
function extractVersionSettingRef(arg, settingKey, currentValue) {
    if (typeof arg === 'string' && typeof settingKey === 'string') {
        return { versionId: arg, key: settingKey, value: currentValue };
    }
    if (isObject(arg)) {
        const carrier = arg;
        if (typeof carrier.versionId === 'string' && typeof carrier.key === 'string') {
            return { versionId: carrier.versionId, key: carrier.key, value: carrier.value };
        }
    }
    return undefined;
}
/** A Uri passed directly, or a tree item carrying resourceUri/uri. */
function extractUri(arg) {
    if (!arg) {
        return undefined;
    }
    if (arg instanceof vscode.Uri) {
        return arg;
    }
    if (isObject(arg)) {
        const carrier = arg;
        if (carrier.resourceUri instanceof vscode.Uri) {
            return carrier.resourceUri;
        }
        if (carrier.uri instanceof vscode.Uri) {
            return carrier.uri;
        }
    }
    return undefined;
}


/***/ }),
/* 97 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.pickOdooBranch = pickOdooBranch;
/**
 * Shared Odoo branch picker.
 *
 * The picker is shown before the branch list is known, then filled in - the
 * previous flow awaited the full remote branch list first, which on the odoo
 * repository is ~68,700 refs and left the button looking dead for seconds.
 * Only release branches are listed up front; everything else stays reachable
 * behind an explicit "search all" row that pays the cost on demand.
 */
const vscode = __importStar(__webpack_require__(1));
const fs = __importStar(__webpack_require__(2));
const gitService_1 = __webpack_require__(11);
const MANUAL_ITEM = {
    label: '$(pencil) Enter branch manually…',
    description: 'e.g. "19.0", "saas-18.4", "master"',
    action: 'manual'
};
const SEARCH_ALL_ITEM = {
    label: '$(search) Search all branches…',
    description: 'Includes PR and development branches — slower on large repositories',
    action: 'all'
};
function toItems(branches, includeSearchAll) {
    const items = branches.map(branch => ({
        label: branch,
        action: 'branch',
        branch
    }));
    if (includeSearchAll) {
        items.push(SEARCH_ALL_ITEM);
    }
    items.push(MANUAL_ITEM);
    return items;
}
async function promptManualBranch(title) {
    const entered = await vscode.window.showInputBox({
        title,
        placeHolder: 'Enter Odoo version/branch (e.g. "19.0", "saas-18.4", "master")',
        ignoreFocusOut: true,
        validateInput: value => value.trim() ? undefined : 'Branch is required.'
    });
    return entered?.trim() || undefined;
}
/**
 * Asks for an Odoo branch. Resolves to undefined when the user cancels.
 */
async function pickOdooBranch(odooPath, title) {
    const repoPath = odooPath && fs.existsSync(odooPath) ? odooPath : undefined;
    if (!repoPath) {
        return promptManualBranch(title);
    }
    const picker = vscode.window.createQuickPick();
    picker.title = title;
    picker.placeholder = 'Select the Odoo branch for this version';
    picker.busy = true;
    picker.items = [MANUAL_ITEM];
    try {
        const selection = await new Promise(resolve => {
            let settled = false;
            const settle = (value) => {
                if (!settled) {
                    settled = true;
                    resolve(value);
                }
            };
            picker.onDidAccept(() => {
                const picked = picker.selectedItems[0];
                if (picked?.action === 'all') {
                    // Explicitly requested: pay the full enumeration now, with
                    // the picker still on screen showing progress.
                    picker.busy = true;
                    void (0, gitService_1.listAllBranches)(repoPath).then(all => {
                        picker.items = toItems(all, false);
                        picker.busy = false;
                    });
                    return;
                }
                settle(picked);
                picker.hide();
            });
            picker.onDidHide(() => settle(undefined));
            picker.show();
            void (0, gitService_1.listSeriesBranches)(repoPath).then(branches => {
                picker.items = toItems(branches, true);
                picker.busy = false;
            });
        });
        if (!selection) {
            return undefined;
        }
        if (selection.action === 'manual') {
            return promptManualBranch(title);
        }
        return selection.branch;
    }
    finally {
        picker.dispose();
    }
}


/***/ }),
/* 98 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.registerDebugCommands = registerDebugCommands;
/**
 * Start/stop/restart server (with and without debugging) and shell commands.
 */
const vscode = __importStar(__webpack_require__(1));
const debugger_1 = __webpack_require__(67);
const server_1 = __webpack_require__(76);
const notifications_1 = __webpack_require__(16);
const settingsStore_1 = __webpack_require__(6);
function registerDebugCommands(deps) {
    const { context } = deps;
    context.subscriptions.push(vscode.commands.registerCommand('odoo.startServer', async () => {
        await (0, debugger_1.startDebugServer)();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo.startServerNoDebug', async () => {
        await (0, debugger_1.startDebugServer)({ noDebug: true });
    }));
    // startDebugServer already stops the extension's own session first, so a
    // restart is a plain start; the separate command exists for
    // discoverability (palette + keybinding).
    context.subscriptions.push(vscode.commands.registerCommand('odoo.restartServer', async () => {
        await (0, debugger_1.startDebugServer)();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo.startShell', async () => {
        await (0, debugger_1.startDebugShell)();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo.stopServer', async () => {
        await (0, debugger_1.stopDebugServer)();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo.openInBrowser', async () => {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        const selectedDb = result?.project.dbs?.find(db => db.isSelected);
        await (0, server_1.openServerInBrowser)(selectedDb?.id, selectedDb?.versionId);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo.copyCommand', async () => {
        const command = await (0, debugger_1.buildOdooCommandLine)(false);
        if (!command) {
            return;
        }
        await vscode.env.clipboard.writeText(command);
        (0, notifications_1.showBriefStatus)('Copied the Odoo command to the clipboard');
    }));
}


/***/ }),
/* 99 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.registerReposExplorerCommands = registerReposExplorerCommands;
/**
 * Command handlers for the Project Repos (Explorer) view: file operations,
 * path utilities and repository relocation.
 */
const vscode = __importStar(__webpack_require__(1));
const fs = __importStar(__webpack_require__(2));
const path = __importStar(__webpack_require__(4));
const args_1 = __webpack_require__(96);
const notifications_1 = __webpack_require__(16);
const notifications_2 = __webpack_require__(16);
const settingsStore_1 = __webpack_require__(6);
const utils_1 = __webpack_require__(8);
const runtimeCache_1 = __webpack_require__(15);
const projectReposExplorer_1 = __webpack_require__(78);
async function copyPathToClipboard(uri, relative) {
    if (!uri) {
        void (0, notifications_1.showInfo)('Select a file or folder first.');
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
async function openUriInIntegratedTerminal(uri) {
    if (!uri) {
        void (0, notifications_1.showInfo)('Select a folder to open in terminal.');
        return;
    }
    const cwd = fs.existsSync(uri.fsPath) && fs.lstatSync(uri.fsPath).isDirectory()
        ? uri.fsPath
        : path.dirname(uri.fsPath);
    const terminal = vscode.window.createTerminal({ cwd });
    terminal.show();
}
function registerReposExplorerCommands(deps) {
    const { context, providers } = deps;
    // Tree context menus pass the tree node (which carries `.uri`), while
    // programmatic calls may pass a Uri directly — extractUri handles both.
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.newFile', async (arg) => {
        await (0, projectReposExplorer_1.createNewFile)((0, args_1.extractUri)(arg));
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.newFolder', async (arg) => {
        await (0, projectReposExplorer_1.createNewFolder)((0, args_1.extractUri)(arg));
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.rename', async (arg) => {
        await (0, projectReposExplorer_1.renameEntry)((0, args_1.extractUri)(arg));
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odt.projectReposExplorer.selectProject', async () => {
        await (0, projectReposExplorer_1.selectProjectForExplorer)();
        providers.projectReposExplorer.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.copyFilePath', async (arg) => {
        await copyPathToClipboard((0, args_1.extractUri)(arg), false);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.copyRelativePath', async (arg) => {
        await copyPathToClipboard((0, args_1.extractUri)(arg), true);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.openInIntegratedTerminal', async (arg) => {
        await openUriInIntegratedTerminal((0, args_1.extractUri)(arg));
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.revealInExplorer', async (arg) => {
        const uri = (0, args_1.extractUri)(arg);
        if (!uri) {
            void (0, notifications_1.showInfo)('Select a file or folder first.');
            return;
        }
        await vscode.commands.executeCommand('revealInExplorer', uri);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.revealFileInOS', async (arg) => {
        const uri = (0, args_1.extractUri)(arg);
        if (!uri) {
            void (0, notifications_1.showInfo)('Select a file or folder first.');
            return;
        }
        await vscode.commands.executeCommand('revealFileInOS', uri);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odooDebugger.relocateRepo', async (arg) => {
        const repo = arg?.repo;
        if (!repo?.path) {
            void (0, notifications_1.showInfo)('Select a repository to relocate.');
            return;
        }
        const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            title: `Select the new location of "${repo.name ?? repo.path}"`,
            openLabel: 'Use This Folder'
        });
        if (!picked || picked.length === 0) {
            return;
        }
        const newPath = picked[0].fsPath;
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            return;
        }
        const { data, project } = result;
        const target = (project.repos ?? []).find(r => r.path === repo.path || r.name === repo.name);
        if (!target) {
            void (0, notifications_1.showError)('The repository could not be found in the current project.');
            return;
        }
        target.path = newPath;
        await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
        (0, runtimeCache_1.invalidateModuleDiscoveryCache)();
        (0, runtimeCache_1.invalidateRepositoryDiscoveryCache)();
        (0, runtimeCache_1.invalidateGitBranchCache)();
        (0, notifications_2.showAutoInfo)(`Repository "${target.name}" now points to ${newPath}`, 3000);
        await deps.refreshAll();
    }));
}


/***/ }),
/* 100 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.registerEditorCommands = registerEditorCommands;
/**
 * Editor-context commands acting on the active file's Odoo module.
 * Menu visibility is gated by odooDebugger.editorActions.enabled; the
 * commands themselves stay callable from the palette.
 */
const vscode = __importStar(__webpack_require__(1));
const manifest_1 = __webpack_require__(58);
const module_1 = __webpack_require__(62);
const testing_1 = __webpack_require__(65);
const debugger_1 = __webpack_require__(67);
const notifications_1 = __webpack_require__(16);
async function moduleForActiveEditor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
        void (0, notifications_1.showInfo)('Open a file inside an Odoo module first.');
        return undefined;
    }
    const fileFsPath = editor.document.uri.fsPath;
    const module = await (0, manifest_1.findModuleForFile)(fileFsPath);
    if (!module) {
        void (0, notifications_1.showInfo)('The active file does not belong to an Odoo module (no __manifest__.py found).');
        return undefined;
    }
    return { ...module, fileFsPath };
}
function registerEditorCommands(deps) {
    const { context, providers, moduleTreeView, refreshAll } = deps;
    context.subscriptions.push(vscode.commands.registerCommand('odoo.upgradeCurrentModule', async () => {
        const module = await moduleForActiveEditor();
        if (!module) {
            return;
        }
        if (!(await (0, module_1.setModuleToUpgrade)({ name: module.name }))) {
            return;
        }
        await refreshAll();
        const choice = await (0, notifications_1.showInfo)(`Module "${module.name}" marked for upgrade.`, 'Restart Server');
        if (choice === 'Restart Server') {
            await (0, debugger_1.startDebugServer)();
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo.runTestsForCurrentFile', async () => {
        const module = await moduleForActiveEditor();
        if (!module) {
            return;
        }
        if (!(await (0, testing_1.prepareTestRunForFile)(module.fileFsPath, module.name))) {
            return;
        }
        await refreshAll();
        await (0, debugger_1.startDebugServer)();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('odoo.revealModuleInView', async () => {
        const module = await moduleForActiveEditor();
        if (!module) {
            return;
        }
        const node = await providers.module.findModuleNode(module.name);
        if (!node) {
            void (0, notifications_1.showInfo)(`Module "${module.name}" was not found in the Modules view - is its repository part of the active project?`);
            return;
        }
        await moduleTreeView.reveal(node, { select: true, focus: true });
    }));
}


/***/ }),
/* 101 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.registerHelpCommands = registerHelpCommands;
/**
 * Help commands: a keyboard-shortcut cheat sheet generated from the
 * extension's own package.json contributions, so it never goes stale.
 * Picking an entry runs the command; the last entry opens the Keyboard
 * Shortcuts editor for customization.
 */
const vscode = __importStar(__webpack_require__(1));
/** 'ctrl+alt+o s' → 'Ctrl+Alt+O S' */
function formatKey(key) {
    return key
        .split(' ')
        .map(chord => chord
        .split('+')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('+'))
        .join(' ');
}
function registerHelpCommands(deps) {
    const { context } = deps;
    context.subscriptions.push(vscode.commands.registerCommand('odoo.showKeyboardShortcuts', async () => {
        const contributes = vscode.extensions.getExtension('AhmadMansour.odoo-devtools-vscode')?.packageJSON?.contributes;
        const keybindings = contributes?.keybindings ?? [];
        const titles = new Map((contributes?.commands ?? []).map(entry => [entry.command, entry.title]));
        const isMac = process.platform === 'darwin';
        const picks = keybindings.map(binding => ({
            label: titles.get(binding.command) ?? binding.command,
            description: formatKey(isMac && binding.mac ? binding.mac : binding.key),
            command: binding.command
        }));
        picks.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(gear) Customize Keyboard Shortcuts…', description: 'Open the Keyboard Shortcuts editor filtered to Odoo' });
        const selected = await vscode.window.showQuickPick(picks, {
            title: 'Odoo DevTools Keyboard Shortcuts',
            placeHolder: 'Pick an entry to run its command',
            matchOnDescription: true
        });
        if (!selected) {
            return;
        }
        if (!selected.command) {
            await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'odoo');
            return;
        }
        await vscode.commands.executeCommand(selected.command);
    }));
}


/***/ })
/******/ 	]);
/************************************************************************/
/******/ 	// The module cache
/******/ 	const __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		const cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		const module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/define property getters */
/******/ 	(() => {
/******/ 		// define getter/value functions for harmony exports
/******/ 		__webpack_require__.d = (exports, definition) => {
/******/ 			if(Array.isArray(definition)) {
/******/ 				var i = 0;
/******/ 				while(i < definition.length) {
/******/ 					var key = definition[i++];
/******/ 					var binding = definition[i++];
/******/ 					if(!__webpack_require__.o(exports, key)) {
/******/ 						if(binding === 0) {
/******/ 							Object.defineProperty(exports, key, { enumerable: true, value: definition[i++] });
/******/ 						} else {
/******/ 							Object.defineProperty(exports, key, { enumerable: true, get: binding });
/******/ 						}
/******/ 					} else if(binding === 0) { i++; }
/******/ 				}
/******/ 			} else {
/******/ 				for(var key in definition) {
/******/ 					if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 						Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 					}
/******/ 				}
/******/ 			}
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__webpack_require__.r = (exports) => {
/******/ 			if(Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	let __webpack_exports__ = __webpack_require__(0);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;
//# sourceMappingURL=extension.js.map