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
const path = __importStar(__webpack_require__(3));
const utils_1 = __webpack_require__(4);
const dbs_1 = __webpack_require__(16);
const project_1 = __webpack_require__(26);
const repos_1 = __webpack_require__(30);
const projectRepos_1 = __webpack_require__(31);
const module_1 = __webpack_require__(33);
const testing_1 = __webpack_require__(37);
const debugger_1 = __webpack_require__(39);
const odooInstaller_1 = __webpack_require__(40);
const settingsStore_1 = __webpack_require__(21);
const versionsTreeProvider_1 = __webpack_require__(41);
const versionsService_1 = __webpack_require__(18);
const context_1 = __webpack_require__(38);
const settings_1 = __webpack_require__(8);
const gitService_1 = __webpack_require__(9);
const sortPreferences_1 = __webpack_require__(42);
const sortOptions_1 = __webpack_require__(25);
const projectWorkspace_1 = __webpack_require__(43);
const projectReposExplorer_1 = __webpack_require__(44);
// Store disposables for proper cleanup
let extensionDisposables = [];
function extractUriFromContext(arg) {
    if (!arg) {
        return undefined;
    }
    if (arg instanceof vscode.Uri) {
        return arg;
    }
    if (typeof arg === 'object') {
        const maybeResourceUri = arg.resourceUri;
        if (maybeResourceUri instanceof vscode.Uri) {
            return maybeResourceUri;
        }
        const maybeUri = arg.uri;
        if (maybeUri instanceof vscode.Uri) {
            return maybeUri;
        }
    }
    return undefined;
}
async function copyPathToClipboard(uri, relative) {
    if (!uri) {
        (0, utils_1.showInfo)('Select a file or folder first.');
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
        (0, utils_1.showInfo)('Select a folder to open in terminal.');
        return;
    }
    const cwd = fs.existsSync(uri.fsPath) && fs.lstatSync(uri.fsPath).isDirectory()
        ? uri.fsPath
        : path.dirname(uri.fsPath);
    const terminal = vscode.window.createTerminal({ cwd });
    terminal.show();
}
// Initialize testing context based on current project state
async function initializeTestingContext() {
    try {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (result?.project?.testingConfig?.isEnabled) {
            (0, context_1.updateTestingContext)(true);
        }
        else {
            (0, context_1.updateTestingContext)(false);
        }
    }
    catch (error) {
        // If there's an error, default to testing disabled
        console.warn('Error initializing testing context:', error);
        (0, context_1.updateTestingContext)(false);
    }
}
async function maybeSwitchBranchForActivatedVersion(version) {
    if (!version) {
        return;
    }
    const targetBranch = version.odooVersion;
    if (!targetBranch) {
        return;
    }
    const switchBehavior = vscode.workspace.getConfiguration('odooDebugger').get('databaseSwitchBehavior', 'ask');
    if (switchBehavior === 'auto-version-only') {
        return;
    }
    const checkoutSettings = new settings_1.SettingsModel(version.settings);
    if (!checkoutSettings.odooPath || checkoutSettings.odooPath.trim() === '') {
        return;
    }
    let currentBranch = await (0, utils_1.getGitBranch)(checkoutSettings.odooPath);
    const performCheckout = async (branch, context) => {
        if (!branch || !branch.trim()) {
            return;
        }
        if (currentBranch === branch) {
            const message = context === 'auto'
                ? `Branch "${branch}" already active`
                : `Branch "${branch}" already active`;
            (0, utils_1.showAutoInfo)(message, 2000);
            return;
        }
        await (0, dbs_1.checkoutBranch)(checkoutSettings, branch);
        currentBranch = branch;
        const message = context === 'auto'
            ? `Auto-switched to branch "${branch}" for version "${version.name}".`
            : `Switched to branch "${branch}" for version "${version.name}".`;
        (0, utils_1.showAutoInfo)(message, 3000);
    };
    if (switchBehavior === 'auto-both' || switchBehavior === 'auto-branch-only') {
        await performCheckout(targetBranch, 'auto');
        return;
    }
    const metadata = await (0, gitService_1.getBranchesWithMetadata)(checkoutSettings.odooPath);
    const branchRecord = metadata.find(entry => entry.name === targetBranch);
    const branchTypeDescription = branchRecord
        ? (branchRecord.type === 'remote' ? 'Remote branch' : 'Local branch')
        : undefined;
    const options = [
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
async function activate(context) {
    // Clear any existing disposables
    extensionDisposables.forEach(d => d.dispose());
    extensionDisposables = [];
    const sortPreferences = new sortPreferences_1.SortPreferences(context.workspaceState);
    // Initialize version management service
    const versionsService = versionsService_1.VersionsService.getInstance();
    await versionsService.initialize();
    // Migrate existing settings to version management for backwards compatibility
    // Wait for migration to complete to ensure proper initialization order
    await versionsService.migrateFromLegacySettings().catch(error => {
        console.warn('Settings migration failed (this is non-critical):', error);
    });
    const isWorkspaceOpen = !!vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
    (0, context_1.updateActiveContext)(isWorkspaceOpen);
    // Initialize testing context
    await initializeTestingContext();
    const providers = {
        project: new project_1.ProjectTreeProvider(context, sortPreferences),
        repo: new repos_1.RepoTreeProvider(context, sortPreferences),
        db: new dbs_1.DbsTreeProvider(sortPreferences),
        module: new module_1.ModuleTreeProvider(context, sortPreferences),
        testing: new testing_1.TestingTreeProvider(context),
        versions: new versionsTreeProvider_1.VersionsTreeProvider(sortPreferences),
        projectRepos: new projectRepos_1.ProjectReposProvider(sortPreferences),
        projectReposExplorer: new projectReposExplorer_1.ProjectReposExplorerProvider()
    };
    const registerViewSortCommand = (viewId, provider) => {
        const options = (0, sortOptions_1.getSortOptions)(viewId);
        extensionDisposables.push(vscode.commands.registerCommand(`${viewId}.sort`, async () => {
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
    // Register tree data providers and store disposables
    extensionDisposables.push(vscode.window.registerTreeDataProvider('projectSelector', providers.project));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('repoSelector', providers.repo));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('dbSelector', providers.db));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('moduleSelector', providers.module));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('testingSelector', providers.testing));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('versionsManager', providers.versions));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('projectRepos', providers.projectRepos));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('odt.projectReposExplorer', providers.projectReposExplorer));
    const refreshAll = async (options = {}) => {
        const { syncDebugger = true } = options;
        if (syncDebugger) {
            try {
                await (0, debugger_1.setupDebugger)();
            }
            catch (error) {
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
    extensionDisposables.push(vscode.commands.registerCommand('projectRepos.reveal', async (arg) => {
        const repo = arg?.metadata?.kind === 'repo' ? arg?.metadata?.repo : undefined;
        if (repo?.path) {
            await (0, projectRepos_1.revealProjectRepo)(repo);
            return;
        }
        const uri = extractUriFromContext(arg);
        if (!uri) {
            (0, utils_1.showInfo)('Select a repository to reveal.');
            return;
        }
        await vscode.commands.executeCommand('revealInExplorer', uri);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('proj.openProjectWorkspace', async () => {
        await (0, projectWorkspace_1.openProjectWorkspace)(context);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('proj.rebuildProjectWorkspace', async () => {
        await (0, projectWorkspace_1.rebuildProjectWorkspace)(context);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('proj.quickSwitchProject', async () => {
        await (0, projectWorkspace_1.quickSwitchProjectWorkspace)(context);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odt.projectReposExplorer.newFile', async (uri) => {
        await (0, projectReposExplorer_1.createNewFile)(uri);
        providers.projectReposExplorer.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odt.projectReposExplorer.newFolder', async (uri) => {
        await (0, projectReposExplorer_1.createNewFolder)(uri);
        providers.projectReposExplorer.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odt.projectReposExplorer.rename', async (uri) => {
        await (0, projectReposExplorer_1.renameEntry)(uri);
        providers.projectReposExplorer.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odt.projectReposExplorer.delete', async (uri) => {
        await (0, projectReposExplorer_1.deleteEntry)(uri);
        providers.projectReposExplorer.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odt.projectReposExplorer.openTerminalHere', async (uri) => {
        await (0, projectReposExplorer_1.openTerminalHere)(uri);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odt.projectReposExplorer.selectProject', async () => {
        await (0, projectReposExplorer_1.selectProjectForExplorer)();
        providers.projectReposExplorer.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odt.projectReposExplorer.copy', async (uri, uris) => {
        const list = uris && uris.length ? uris : uri ? [uri] : [];
        if (!list.length) {
            return;
        }
        (0, projectReposExplorer_1.copyEntries)(list, false);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odt.projectReposExplorer.cut', async (uri, uris) => {
        const list = uris && uris.length ? uris : uri ? [uri] : [];
        if (!list.length) {
            return;
        }
        (0, projectReposExplorer_1.copyEntries)(list, true);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odt.projectReposExplorer.paste', async (uri) => {
        await (0, projectReposExplorer_1.pasteEntries)(uri);
        providers.projectReposExplorer.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.copyFilePath', async (arg) => {
        await copyPathToClipboard(extractUriFromContext(arg), false);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.copyRelativePath', async (arg) => {
        await copyPathToClipboard(extractUriFromContext(arg), true);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.openInIntegratedTerminal', async (arg) => {
        await openUriInIntegratedTerminal(extractUriFromContext(arg));
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.revealInExplorer', async (arg) => {
        const uri = extractUriFromContext(arg);
        if (!uri) {
            (0, utils_1.showInfo)('Select a file or folder first.');
            return;
        }
        await vscode.commands.executeCommand('revealInExplorer', uri);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.revealFileInOS', async (arg) => {
        const uri = extractUriFromContext(arg);
        if (!uri) {
            (0, utils_1.showInfo)('Select a file or folder first.');
            return;
        }
        await vscode.commands.executeCommand('revealFileInOS', uri);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.renameEntry', async (arg) => {
        await (0, projectReposExplorer_1.renameEntry)(extractUriFromContext(arg));
        providers.projectRepos.refresh();
        providers.projectReposExplorer.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.deleteEntry', async (arg) => {
        await (0, projectReposExplorer_1.deleteEntry)(extractUriFromContext(arg));
        providers.projectRepos.refresh();
        providers.projectReposExplorer.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.copyEntry', async (arg) => {
        const uri = extractUriFromContext(arg);
        if (!uri) {
            (0, utils_1.showInfo)('Select a file or folder first.');
            return;
        }
        (0, projectReposExplorer_1.copyEntries)([uri], false);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.cutEntry', async (arg) => {
        const uri = extractUriFromContext(arg);
        if (!uri) {
            (0, utils_1.showInfo)('Select a file or folder first.');
            return;
        }
        (0, projectReposExplorer_1.copyEntries)([uri], true);
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odooDebugger.pasteEntry', async (arg) => {
        const uri = extractUriFromContext(arg);
        if (!uri) {
            (0, utils_1.showInfo)('Select a folder to paste into.');
            return;
        }
        let target = uri;
        try {
            if (fs.existsSync(uri.fsPath) && fs.lstatSync(uri.fsPath).isFile()) {
                target = vscode.Uri.file(path.dirname(uri.fsPath));
            }
        }
        catch {
            // Best effort: fall back to the provided uri
        }
        await (0, projectReposExplorer_1.pasteEntries)(target);
        providers.projectRepos.refresh();
        providers.projectReposExplorer.refresh();
    }));
    // Projects
    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.create', async () => {
        try {
            // Get settings from active version
            const settings = await versionsService.getActiveVersionSettings();
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                throw new Error("Open a workspace to use this command.");
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
            let db;
            if (databaseChoice?.value === 'create') {
                db = await (0, dbs_1.createDb)(name, repos, settings.dumpsFolder, settings, { allowExistingOption: false });
            }
            else if (databaseChoice?.value === 'connect') {
                db = await (0, dbs_1.createDb)(name, repos, settings.dumpsFolder, settings, { initialMethod: 'existing' });
            }
            await (0, project_1.createProject)(name, repos, db);
            await refreshAll();
        }
        catch (err) {
            (0, utils_1.showError)(err.message);
        }
    }));
    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.selectProject', async (event) => {
        await (0, project_1.selectProject)(event);
        await refreshAll();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.delete', async (event) => {
        await (0, project_1.deleteProject)(event);
        await refreshAll();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.editSettings', async (event) => {
        await (0, project_1.editProjectSettings)(event);
        await refreshAll();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.duplicateProject', async (event) => {
        await (0, project_1.duplicateProject)(event);
        await refreshAll();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.exportProject', async (event) => {
        await (0, project_1.exportProject)(event);
        await refreshAll();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.importProject', async () => {
        await (0, project_1.importProject)();
        await refreshAll();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.setup', async () => {
        await (0, odooInstaller_1.setupOdooBranch)();
        await refreshAll();
    }));
    // Quick Project Search
    extensionDisposables.push(vscode.commands.registerCommand('odoo-debugger.quickProjectSearch', async () => {
        await (0, project_1.quickProjectSearch)();
        await refreshAll();
    }));
    // DBS
    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.create', async () => {
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
                    activeVersion: data.activeVersion
                });
                await (0, dbs_1.selectDatabase)(db);
            }
            await refreshAll();
        }
        catch (err) {
            (0, utils_1.showError)(err.message);
        }
    }));
    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.selectDb', async (event) => {
        try {
            await (0, dbs_1.selectDatabase)(event);
            await refreshAll();
        }
        catch (err) {
            (0, utils_1.showError)(`Failed to select database: ${err.message}`);
            console.error('Error in database selection:', err);
        }
    }));
    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.delete', async (event) => {
        try {
            await (0, dbs_1.deleteDb)(event);
            await refreshAll();
        }
        catch (err) {
            (0, utils_1.showError)(`Failed to delete database: ${err.message}`);
            console.error('Error in database deletion:', err);
        }
    }));
    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.restore', async (event) => {
        try {
            await (0, dbs_1.restoreDb)(event);
            await refreshAll();
            (0, utils_1.showInfo)(`Database ${event.name || event.id} restored successfully!`);
        }
        catch (err) {
            (0, utils_1.showError)(`Failed to restore database: ${err.message}`);
            console.error('Error in database restoration:', err);
        }
    }));
    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.changeVersion', async (event) => {
        try {
            await (0, dbs_1.changeDatabaseVersion)(event);
            await refreshAll();
        }
        catch (err) {
            (0, utils_1.showError)(`Failed to change database version: ${err.message}`);
            console.error('Error in database version change:', err);
        }
    }));
    // Repos
    extensionDisposables.push(vscode.commands.registerCommand('repoSelector.selectRepo', async (event) => {
        await (0, repos_1.selectRepo)(event);
        await (0, projectWorkspace_1.rebuildProjectWorkspace)(context);
        await refreshAll();
    }));
    // Modules
    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.select', async (event) => {
        await (0, module_1.selectModule)(event);
        await refreshAll();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.togglePsaeInternalModule', async (event) => {
        await (0, module_1.togglePsaeInternalModule)(event);
        await refreshAll();
    }));
    // Context menu commands for individual modules
    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.setToInstall', async (event) => {
        await (0, module_1.setModuleToInstall)(event);
        await refreshAll();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.setToUpgrade', async (event) => {
        await (0, module_1.setModuleToUpgrade)(event);
        await refreshAll();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.clearState', async (event) => {
        await (0, module_1.clearModuleState)(event);
        await refreshAll();
    }));
    // Module Quick Actions
    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.updateAll', async () => {
        await (0, module_1.updateAllModules)();
        await refreshAll();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.updateInstalled', async () => {
        await (0, module_1.updateInstalledModules)();
        await refreshAll();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.installAll', async () => {
        await (0, module_1.installAllModules)();
        await refreshAll();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.clearAll', async () => {
        await (0, module_1.clearAllModuleSelections)();
        await refreshAll();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.viewInstalled', async () => {
        await (0, module_1.viewInstalledModules)();
    }));
    // Testing
    extensionDisposables.push(vscode.commands.registerCommand('testingSelector.toggleTesting', async (event) => {
        await (0, testing_1.toggleTesting)(event);
        await refreshAll({ syncDebugger: false });
    }));
    extensionDisposables.push(vscode.commands.registerCommand('testingSelector.toggleStopAfterInit', async () => {
        await (0, testing_1.toggleStopAfterInit)();
        await refreshAll({ syncDebugger: false });
    }));
    extensionDisposables.push(vscode.commands.registerCommand('testingSelector.setTestFile', async () => {
        await (0, testing_1.setTestFile)();
        await refreshAll({ syncDebugger: false });
    }));
    extensionDisposables.push(vscode.commands.registerCommand('testingSelector.addTestTag', async () => {
        await (0, testing_1.addTestTag)();
        providers.testing.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('testingSelector.removeTestTag', async (event) => {
        await (0, testing_1.removeTestTag)(event);
        providers.testing.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('testingSelector.cycleTestTagState', async (event) => {
        await (0, testing_1.cycleTestTagState)(event);
        providers.testing.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('testingSelector.toggleLogLevel', async () => {
        await (0, testing_1.toggleLogLevel)();
        providers.testing.refresh();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('testingSelector.setSpecificLogLevel', async () => {
        await (0, testing_1.setSpecificLogLevel)();
        providers.testing.refresh();
    }));
    // Version management commands
    extensionDisposables.push(vscode.commands.registerCommand('odoo.createVersion', async () => {
        try {
            const name = await vscode.window.showInputBox({
                placeHolder: 'Enter version name (e.g., "Odoo 19.0")',
                prompt: 'Version name'
            });
            if (!name) {
                return;
            }
            const activeSettings = await versionsService.getActiveVersionSettings();
            const promptRepoPath = async (label, currentValue, required) => {
                let current = currentValue?.trim();
                while (true) {
                    const items = [];
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
                            const defaultUriCandidates = [];
                            if (current) {
                                try {
                                    const normalized = (0, utils_1.normalizePath)(current);
                                    if (fs.existsSync(normalized)) {
                                        defaultUriCandidates.push(vscode.Uri.file(normalized));
                                    }
                                }
                                catch { /* ignore */ }
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
            if (odooPathInput === undefined) {
                return;
            }
            const odooPath = odooPathInput.trim();
            const normalizedOdooPath = (0, utils_1.normalizePath)(odooPath);
            const enterprisePathInput = await promptRepoPath('Enterprise repository (optional)', activeSettings?.enterprisePath, false);
            if (enterprisePathInput === undefined) {
                return;
            }
            const enterprisePath = enterprisePathInput.trim();
            const designThemesPathInput = await promptRepoPath('Design Themes repository (optional)', activeSettings?.designThemesPath, false);
            if (designThemesPathInput === undefined) {
                return;
            }
            const designThemesPath = designThemesPathInput.trim();
            let odooVersion;
            let branches = [];
            const branchMetadata = await (0, gitService_1.getBranchesWithMetadata)(normalizedOdooPath);
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
            }
            else {
                branches = await (0, utils_1.getGitBranches)(odooPath);
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
                const fallbackAction = await (0, utils_1.showWarning)(noBranchMessage, 'Enter Manually', 'Cancel');
                if (fallbackAction !== 'Enter Manually') {
                    return;
                }
                odooVersion = await vscode.window.showInputBox({
                    placeHolder: 'Enter Odoo version/branch (e.g., "19.0", "saas-18.4", "master")',
                    prompt: 'Odoo version/branch',
                    value: branches[0] ?? ''
                }) ?? undefined;
                if (!odooVersion) {
                    return;
                }
            }
            const settingsOverrides = { odooPath };
            if (enterprisePath) {
                settingsOverrides.enterprisePath = enterprisePath;
            }
            if (designThemesPath) {
                settingsOverrides.designThemesPath = designThemesPath;
            }
            const version = await versionsService.createVersion(name, odooVersion, settingsOverrides);
            await refreshAll({ syncDebugger: false });
            const action = await vscode.window.showInformationMessage(`Version "${name}" created on branch "${odooVersion}".`, 'Activate Now');
            if (action === 'Activate Now') {
                await vscode.commands.executeCommand('odoo.setActiveVersion', version.id);
            }
        }
        catch (error) {
            (0, utils_1.showError)(`Failed to create version: ${error.message}`);
        }
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odoo.openVersionDefaults', async () => {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:odoo-ps.odoo-debugging-mgm-tool odooDebugger.defaultVersion');
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odoo.changeBranch', async (versionIdOrTreeItem) => {
        try {
            let versionId;
            // Handle both direct calls and context menu calls
            if (typeof versionIdOrTreeItem === 'string') {
                // Direct command call with version ID
                versionId = versionIdOrTreeItem;
            }
            else if (versionIdOrTreeItem?.version?.id) {
                // Context menu call - extract ID from tree item
                versionId = versionIdOrTreeItem.version.id;
            }
            else {
                (0, utils_1.showError)('Select a version before continuing.');
                return;
            }
            const version = versionsService.getVersion(versionId);
            if (!version) {
                (0, utils_1.showError)('The selected version could not be found.');
                return;
            }
            // Get Odoo path from the specific version being edited
            const odooPath = version.settings.odooPath;
            let newBranch;
            if (odooPath) {
                // Try to get Git branches from the Odoo path
                const branches = await (0, utils_1.getGitBranches)(odooPath);
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
                }
                else {
                    // Fallback to manual input if no branches found
                    const result = await (0, utils_1.showWarning)(`No Git branches found in Odoo path: ${odooPath}. Would you like to enter the branch manually?`, 'Enter Manually', 'Cancel');
                    if (result === 'Enter Manually') {
                        newBranch = await vscode.window.showInputBox({
                            placeHolder: version.odooVersion,
                            prompt: 'Enter new Odoo version/branch',
                            value: version.odooVersion
                        });
                    }
                }
            }
            else {
                // No Odoo path configured, show warning and fallback to manual input
                const result = await (0, utils_1.showWarning)('Odoo path is not configured. Please set the Odoo path in settings first, or enter the branch manually.', 'Enter Manually', 'Cancel');
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
            (0, utils_1.showInfo)(`Branch changed from "${version.odooVersion}" to "${newBranch}" for version "${version.name}"`);
        }
        catch (error) {
            (0, utils_1.showError)(`Failed to change branch: ${error.message}`);
        }
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odoo.setActiveVersion', async (versionIdOrTreeItem) => {
        try {
            let versionId;
            // Handle both direct calls and context menu calls
            if (typeof versionIdOrTreeItem === 'string') {
                // Direct command call with version ID
                versionId = versionIdOrTreeItem;
            }
            else if (versionIdOrTreeItem?.version?.id) {
                // Context menu call - extract ID from tree item
                versionId = versionIdOrTreeItem.version.id;
            }
            else {
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
                (0, utils_1.showInfo)(`Activated version: ${version?.name}`);
                await maybeSwitchBranchForActivatedVersion(version);
                await refreshAll(); // Refresh all views to reflect new active version
            }
            else {
                (0, utils_1.showError)('Unable to activate the selected version.');
            }
        }
        catch (error) {
            (0, utils_1.showError)(`Unable to activate the selected version: ${error.message}`);
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
    extensionDisposables.push(vscode.commands.registerCommand('odoo.editVersionSetting', async (versionIdOrTreeItem, settingKey, currentValue) => {
        try {
            let versionId;
            let key;
            let value;
            // Handle both direct command calls and context menu calls
            if (typeof versionIdOrTreeItem === 'string') {
                // Direct command call with parameters
                versionId = versionIdOrTreeItem;
                key = settingKey;
                value = currentValue;
            }
            else if (versionIdOrTreeItem?.versionId) {
                // Context menu call - extract from tree item
                versionId = versionIdOrTreeItem.versionId;
                key = versionIdOrTreeItem.key;
                value = versionIdOrTreeItem.value;
            }
            else {
                (0, utils_1.showError)('This command was invoked with invalid parameters.');
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
            (0, utils_1.showInfo)(`Updated ${key} successfully`);
        }
        catch (error) {
            (0, utils_1.showError)(`Failed to edit setting: ${error.message}`);
        }
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odoo.cloneVersion', async (versionIdOrTreeItem) => {
        try {
            let versionId;
            // Handle both direct calls and context menu calls
            if (typeof versionIdOrTreeItem === 'string') {
                // Direct command call with version ID
                versionId = versionIdOrTreeItem;
            }
            else if (versionIdOrTreeItem?.version?.id) {
                // Context menu call - extract ID from tree item
                versionId = versionIdOrTreeItem.version.id;
            }
            else {
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
                (0, utils_1.showInfo)(`Version "${name}" cloned successfully`);
            }
            else {
                (0, utils_1.showError)('Failed to clone the selected version.');
            }
        }
        catch (error) {
            (0, utils_1.showError)(`Failed to clone the selected version: ${error.message}`);
        }
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odoo.deleteVersion', async (versionIdOrTreeItem) => {
        try {
            let versionId;
            // Handle both direct calls and context menu calls
            if (typeof versionIdOrTreeItem === 'string') {
                // Direct command call with version ID
                versionId = versionIdOrTreeItem;
            }
            else if (versionIdOrTreeItem?.version?.id) {
                // Context menu call - extract ID from tree item
                versionId = versionIdOrTreeItem.version.id;
            }
            else {
                // No version provided - show version picker
                const versions = versionsService.getVersions();
                const items = versions.filter(v => !v.isActive).map(v => ({
                    label: v.name,
                    description: v.odooVersion,
                    versionId: v.id
                }));
                if (items.length === 0) {
                    (0, utils_1.showInfo)('There are no versions available to delete (the active version cannot be removed).');
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
                (0, utils_1.showError)('The selected version could not be found.');
                return;
            }
            const confirm = await vscode.window.showWarningMessage(`Are you sure you want to delete version "${version.name}"?`, { modal: true }, 'Delete');
            if (confirm !== 'Delete') {
                return;
            }
            const success = await versionsService.deleteVersion(versionId);
            if (success) {
                (0, utils_1.showInfo)(`Version "${version.name}" deleted successfully`);
            }
            else {
                (0, utils_1.showError)('Failed to delete the selected version.');
            }
        }
        catch (error) {
            (0, utils_1.showError)(`Failed to delete the selected version.: ${error.message}`);
        }
    }));
    // Version settings context menu commands
    extensionDisposables.push(vscode.commands.registerCommand('odoo.setSettingToDefault', async (settingTreeItem) => {
        try {
            if (!settingTreeItem) {
                (0, utils_1.showError)('Select a setting before continuing.');
                return;
            }
            // Extract version ID and setting key from the tree item
            const versionId = settingTreeItem.versionId;
            const settingKey = settingTreeItem.key;
            if (!versionId || !settingKey) {
                (0, utils_1.showError)('Could not identify the selected setting.');
                return;
            }
            const success = await versionsService.setSettingToDefault(versionId, settingKey);
            if (!success) {
                (0, utils_1.showError)('Unable to reset this setting to its default value.');
            }
        }
        catch (error) {
            (0, utils_1.showError)(`Failed to reset setting to default: ${error.message}`);
        }
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odoo.setSettingAsDefault', async (settingTreeItem) => {
        try {
            if (!settingTreeItem) {
                (0, utils_1.showError)('Select a setting before continuing.');
                return;
            }
            // Extract version ID and setting key from the tree item
            const versionId = settingTreeItem.versionId;
            const settingKey = settingTreeItem.key;
            if (!versionId || !settingKey) {
                (0, utils_1.showError)('Could not identify the selected setting.');
                return;
            }
            const success = await versionsService.setSettingAsDefault(versionId, settingKey);
            if (!success) {
                (0, utils_1.showError)('Unable to save this setting as the default.');
            }
        }
        catch (error) {
            (0, utils_1.showError)(`Unable to save this setting as the default: ${error.message}`);
        }
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odoo.setAllSettingsToDefault', async (versionTreeItem) => {
        try {
            let versionId;
            // Handle both direct calls and context menu calls
            if (typeof versionTreeItem === 'string') {
                // Direct command call with version ID
                versionId = versionTreeItem;
            }
            else if (versionTreeItem?.version?.id) {
                // Context menu call - extract ID from tree item
                versionId = versionTreeItem.version.id;
            }
            else {
                (0, utils_1.showError)('Select a version before continuing.');
                return;
            }
            const version = versionsService.getVersion(versionId);
            if (!version) {
                (0, utils_1.showError)('The selected version could not be found.');
                return;
            }
            const confirm = await vscode.window.showWarningMessage(`Are you sure you want to reset ALL settings for version "${version.name}" to their default values?`, 'Reset All', 'Cancel');
            if (confirm !== 'Reset All') {
                return;
            }
            const success = await versionsService.setAllSettingsToDefault(versionId);
            if (!success) {
                (0, utils_1.showError)('Unable to reset all settings to their default values.');
            }
        }
        catch (error) {
            (0, utils_1.showError)(`Failed to reset all settings to default: ${error.message}`);
        }
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odoo.setAllSettingsAsDefault', async (versionTreeItem) => {
        try {
            let versionId;
            // Handle both direct calls and context menu calls
            if (typeof versionTreeItem === 'string') {
                // Direct command call with version ID
                versionId = versionTreeItem;
            }
            else if (versionTreeItem?.version?.id) {
                // Context menu call - extract ID from tree item
                versionId = versionTreeItem.version.id;
            }
            else {
                (0, utils_1.showError)('Select a version before continuing.');
                return;
            }
            const version = versionsService.getVersion(versionId);
            if (!version) {
                (0, utils_1.showError)('The selected version could not be found.');
                return;
            }
            const confirm = await vscode.window.showWarningMessage(`Are you sure you want to save ALL settings from version "${version.name}" as new default values?`, 'Save All as Default', 'Cancel');
            if (confirm !== 'Save All as Default') {
                return;
            }
            const success = await versionsService.setAllSettingsAsDefault(versionId);
            if (!success) {
                (0, utils_1.showError)('Unable to save these settings as the new defaults.');
            }
        }
        catch (error) {
            (0, utils_1.showError)(`Unable to save these settings as the new defaults.: ${error.message}`);
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
        await (0, debugger_1.startDebugServer)();
    }));
    extensionDisposables.push(vscode.commands.registerCommand('odoo.startShell', async () => {
        await (0, debugger_1.startDebugShell)();
    }));
    // Add all disposables to the context for automatic cleanup
    extensionDisposables.forEach(disposable => context.subscriptions.push(disposable));
    return {
        dispose() {
            // Clean up all disposables
            extensionDisposables.forEach(d => d.dispose());
            extensionDisposables = [];
            // Reset the context
            (0, context_1.updateActiveContext)(false);
        }
    };
}
// Proper deactivate function
function deactivate() {
    // Clean up all disposables
    extensionDisposables.forEach(d => d.dispose());
    extensionDisposables = [];
    // Reset the context
    (0, context_1.updateActiveContext)(false);
    console.log('Odoo Debugger extension deactivated');
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
/***/ ((module) => {

module.exports = require("node:path");

/***/ }),
/* 4 */
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
exports.MessageType = exports.CONFIG = void 0;
exports.stripSettings = stripSettings;
exports.addActiveIndicator = addActiveIndicator;
exports.getDatabaseLabel = getDatabaseLabel;
exports.getWorkspacePath = getWorkspacePath;
exports.normalizePath = normalizePath;
exports.findModules = findModules;
exports.findRepositories = findRepositories;
exports.discoverModulesInRepos = discoverModulesInRepos;
exports.createInfoTreeItem = createInfoTreeItem;
exports.readFromFile = readFromFile;
exports.showMessage = showMessage;
exports.showError = showError;
exports.showInfo = showInfo;
exports.showWarning = showWarning;
exports.showAutoInfo = showAutoInfo;
exports.showBriefStatus = showBriefStatus;
exports.camelCaseToTitleCase = camelCaseToTitleCase;
exports.getSettingDisplayName = getSettingDisplayName;
exports.getSettingDisplayValue = getSettingDisplayValue;
exports.getGitBranch = getGitBranch;
exports.getGitBranches = getGitBranches;
exports.getDefaultVersionSettings = getDefaultVersionSettings;
const vscode = __importStar(__webpack_require__(1));
const fs = __importStar(__webpack_require__(5));
const path = __importStar(__webpack_require__(6));
const childProcess = __importStar(__webpack_require__(7));
const settings_1 = __webpack_require__(8);
const gitService_1 = __webpack_require__(9);
const jsonc_parser_1 = __webpack_require__(10);
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
    "projects": []
}`;
/**
 * Strip settings from DebuggerData to ensure settings are managed exclusively by versions
 */
function stripSettings(data) {
    return {
        projects: data.projects,
        versions: data.versions,
        activeVersion: data.activeVersion
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
 * Adds the pointing hand emoji (👉) to the beginning of a string if the condition is true
 * Used consistently across the extension for indicating active/selected items
 * @param text The text to potentially prefix
 * @param isActive Whether to add the pointing hand emoji
 * @returns The text with or without the pointing hand prefix
 */
function addActiveIndicator(text, isActive) {
    return `${isActive ? '👉' : ''} ${text}`;
}
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
        showError("Open a workspace to use this command.");
        return null;
    }
    return workspaceFolders[0].uri.fsPath;
}
/**
 * Normalizes a path to be absolute, relative to workspace if needed
 */
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
    const config = vscode.workspace.getConfiguration('odooDebugger.search');
    const maxDepth = Math.max(0, overrides.maxDepth ?? config.get('maxDepth', 4));
    const maxEntries = Math.max(1, overrides.maxEntries ?? config.get('maxEntries', 100000));
    const patternKey = kind === 'modules' ? 'excludePatterns.modules' : 'excludePatterns.repositories';
    const defaults = kind === 'modules' ? DEFAULT_MODULE_EXCLUDES : DEFAULT_REPOSITORY_EXCLUDES;
    const patterns = overrides.excludePatterns ?? config.get(patternKey, defaults);
    return {
        maxDepth,
        maxEntries,
        excludeRegexes: compilePatterns(patterns),
        token: overrides.token
    };
}
function discoverDirectories(targetPath, kind, options) {
    if (!targetPath) {
        showError('Enter a target path to continue.');
        return [];
    }
    const normalizedRoot = normalizePath(targetPath);
    if (!fs.existsSync(normalizedRoot)) {
        showError(`Path does not exist: ${normalizedRoot}`);
        return [];
    }
    const stack = [{ dir: normalizedRoot, depth: 0 }];
    const visited = new Set();
    const results = [];
    let processed = 0;
    let limitWarningShown = false;
    const rootNormalized = normalizedRoot.split(path.sep).join('/');
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
            console.warn(`Failed to read directory ${resolved}:`, error);
            continue;
        }
        processed++;
        if (processed > options.maxEntries) {
            if (!limitWarningShown) {
                showWarning(`Search limit reached while scanning ${targetPath}. Some folders may be skipped. Adjust "odooDebugger.search.maxEntries" to increase the limit.`);
                limitWarningShown = true;
            }
            break;
        }
        const hasManifest = entries.some(entry => entry.isFile() && entry.name === '__manifest__.py');
        const hasGitDir = entries.some(entry => entry.isDirectory() && entry.name === '.git');
        if (kind === 'modules' && hasManifest) {
            results.push({ path: resolved, name: path.basename(resolved) });
            continue;
        }
        if (kind === 'repositories' && hasGitDir) {
            results.push({ path: resolved, name: path.basename(resolved) });
            // Do not recurse into repository contents.
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
    const options = getSearchOptions('repositories', overrides);
    return discoverDirectories(targetPath, 'repositories', options);
}
const PSAE_INTERNAL_REGEX = /^ps[a-z]*-internal$/i;
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
    const modulesByPath = new Map();
    const psaeDirectories = new Map();
    const searchOverrides = options.search ?? {};
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
                settings: new settings_1.SettingsModel(),
                projects: []
            };
            content = debuggerDataFileContent;
        }
        fs.writeFileSync(filePath, content, 'utf-8');
        return data;
    }
    catch (error) {
        showError(`Failed to create ${fileName}: ${error}`);
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
            showInfo(`Creating ${fileName} file...`);
            return await createOdooDebuggerFile(filePath, workspacePath, fileName);
        }
        const data = fs.readFileSync(filePath, 'utf-8');
        return (0, jsonc_parser_1.parse)(data);
    }
    catch (error) {
        showError(`Failed to read ${fileName}: ${error}`);
        return null;
    }
}
// ============================================================================
// UI & MESSAGING UTILITIES
// ============================================================================
/**
 * Output channel for logging messages
 */
let outputChannel = null;
/**
 * Gets or creates the output channel for logging
 */
function getOutputChannel() {
    outputChannel ??= vscode.window.createOutputChannel('Odoo Debugger');
    return outputChannel;
}
/**
 * Message types for the show message function
 */
var MessageType;
(function (MessageType) {
    MessageType["Error"] = "error";
    MessageType["Warning"] = "warning";
    MessageType["Info"] = "info";
})(MessageType || (exports.MessageType = MessageType = {}));
/**
 * Shows a message with logging to output channel and console
 * @param message - the message to display
 * @param type - the type of message (error, warning, info)
 * @param actions - optional action buttons
 * @returns the selected action or undefined
 */
async function showMessage(message, type = MessageType.Error, ...actions) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${type.toUpperCase()}: ${message}`;
    // Log to output channel
    const channel = getOutputChannel();
    channel.appendLine(logMessage);
    // Log to console for debugging
    switch (type) {
        case MessageType.Error:
            console.error(`[Odoo Debugger] ${logMessage}`);
            break;
        case MessageType.Warning:
            console.warn(`[Odoo Debugger] ${logMessage}`);
            break;
        case MessageType.Info:
            console.info(`[Odoo Debugger] ${logMessage}`);
            break;
    }
    // Show the appropriate message type
    let result;
    switch (type) {
        case MessageType.Error:
            if (actions.length > 0) {
                result = await vscode.window.showErrorMessage(message, ...actions);
            }
            else {
                vscode.window.showErrorMessage(message);
            }
            break;
        case MessageType.Warning:
            if (actions.length > 0) {
                result = await vscode.window.showWarningMessage(message, ...actions);
            }
            else {
                vscode.window.showWarningMessage(message);
            }
            break;
        case MessageType.Info:
            if (actions.length > 0) {
                result = await vscode.window.showInformationMessage(message, ...actions);
            }
            else {
                vscode.window.showInformationMessage(message);
            }
            break;
    }
    return result;
}
/**
 * Shows an error message with optional actions (backward compatibility)
 * @param message - the error message to display
 * @param actions - optional action buttons
 * @returns the selected action or undefined
 */
async function showError(message, ...actions) {
    return showMessage(message, MessageType.Error, ...actions);
}
/**
 * Shows an info message with optional actions
 * @param message - the info message to display
 * @param actions - optional action buttons
 * @returns the selected action or undefined
 */
async function showInfo(message, ...actions) {
    return showMessage(message, MessageType.Info, ...actions);
}
/**
 * Shows a warning message with optional actions
 * @param message - the warning message to display
 * @param actions - optional action buttons
 * @returns the selected action or undefined
 */
async function showWarning(message, ...actions) {
    return showMessage(message, MessageType.Warning, ...actions);
}
/**
 * Shows an auto-dismissing information message that disappears after a specified time
 * @param message - the info message to display
 * @param timeoutMs - time in milliseconds before auto-dismiss (default: 3000ms = 3 seconds)
 * @returns void
 */
function showAutoInfo(message, timeoutMs = 3000) {
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: message,
        cancellable: false
    }, async (progress) => {
        // Show progress for visual feedback
        progress.report({ increment: 0 });
        // Auto-dismiss after timeout
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve();
            }, timeoutMs);
        });
    });
    // Also log to output channel and console
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] INFO (AUTO): ${message}`;
    const channel = getOutputChannel();
    channel.appendLine(logMessage);
    console.info(`[Odoo Debugger] ${logMessage}`);
}
/**
 * Shows a brief status bar message that disappears automatically
 * @param message - the message to display in status bar
 * @param timeoutMs - time in milliseconds before auto-dismiss (default: 2000ms = 2 seconds)
 */
function showBriefStatus(message, timeoutMs = 2000) {
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = `$(info) ${message}`;
    statusBarItem.show();
    // Auto-dismiss after timeout
    setTimeout(() => {
        statusBarItem.dispose();
    }, timeoutMs);
    // Also log to output channel and console
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] STATUS: ${message}`;
    const channel = getOutputChannel();
    channel.appendLine(logMessage);
    console.info(`[Odoo Debugger] ${logMessage}`);
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
 * Gets the current git branch for a given repository path.
 * @param repoPath - The path to the git repository.
 * @returns The current branch name, or null if not found or error occurs.
 */
async function getGitBranch(repoPath) {
    if (!repoPath) {
        return null;
    }
    const gitHeadPath = path.join(repoPath, '.git', 'HEAD');
    try {
        if (fs.existsSync(gitHeadPath)) {
            const headContent = fs.readFileSync(gitHeadPath, 'utf-8').trim();
            const match = /^ref: refs\/heads\/(.+)$/.exec(headContent);
            return match ? match[1] : headContent;
        }
    }
    catch (err) {
        console.warn(`Failed to read branch for ${repoPath}: ${err}`);
    }
    return null;
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
            console.warn(`Not a git repository: ${normalizedPath}`);
            return [];
        }
        return new Promise((resolve) => {
            childProcess.exec('git branch -a --format="%(refname:short)"', { cwd: normalizedPath }, (error, stdout, stderr) => {
                if (error) {
                    console.warn(`Failed to get branches for ${normalizedPath}: ${error.message}`);
                    resolve([]);
                    return;
                }
                if (stderr) {
                    console.warn(`Git branch warning for ${normalizedPath}: ${stderr}`);
                }
                const branches = stdout
                    .split('\n')
                    .map(branch => branch.trim())
                    .filter(branch => {
                    // Filter out empty lines and HEAD reference
                    if (!branch || branch === 'HEAD') {
                        return false;
                    }
                    // Remove remote prefix for remote branches
                    return true;
                })
                    .map(branch => {
                    // Clean up branch names
                    if (branch.startsWith('origin/')) {
                        return branch.replace('origin/', '');
                    }
                    if (branch.startsWith('remotes/origin/')) {
                        return branch.replace('remotes/origin/', '');
                    }
                    return branch;
                })
                    .filter((branch, index, array) => {
                    // Remove duplicates (local and remote of same branch)
                    return array.indexOf(branch) === index;
                })
                    .sort((a, b) => a.localeCompare(b)); // Sort alphabetically
                resolve(branches);
            });
        });
    }
    catch (err) {
        console.warn(`Failed to get branches for ${normalizedPath}: ${err}`);
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
        debuggerName: config.get('debuggerName', 'odoo:18.0'),
        debuggerVersion: config.get('debuggerVersion', '1.0.0'),
        portNumber: config.get('portNumber', 8018),
        shellPortNumber: config.get('shellPortNumber', 5018),
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
        preCheckoutCommands: config.get('preCheckoutCommands', []),
        postCheckoutCommands: config.get('postCheckoutCommands', [])
    };
}


/***/ }),
/* 5 */
/***/ ((module) => {

module.exports = require("fs");

/***/ }),
/* 6 */
/***/ ((module) => {

module.exports = require("path");

/***/ }),
/* 7 */
/***/ ((module) => {

module.exports = require("child_process");

/***/ }),
/* 8 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.SettingsModel = void 0;
class SettingsModel {
    debuggerName = "odoo:18.0";
    debuggerVersion = "1.0.0";
    portNumber = 8018;
    shellPortNumber = 5018;
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
    preCheckoutCommands = [];
    postCheckoutCommands = [];
    constructor(data) {
        if (data) {
            Object.assign(this, data);
        }
        this.preCheckoutCommands = Array.isArray(this.preCheckoutCommands) ? this.preCheckoutCommands : [];
        this.postCheckoutCommands = Array.isArray(this.postCheckoutCommands) ? this.postCheckoutCommands : [];
    }
}
exports.SettingsModel = SettingsModel;


/***/ }),
/* 9 */
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
exports.getBranchesWithMetadata = getBranchesWithMetadata;
exports.getBranchesViaSourceControl = getBranchesViaSourceControl;
const vscode = __importStar(__webpack_require__(1));
const path = __importStar(__webpack_require__(3));
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
        console.warn(`Git API checkout failed for ${repoPath}:`, error);
        return false;
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
        console.warn(`Git API branch listing failed for ${repoPath}:`, error);
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


/***/ }),
/* 10 */
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
/* harmony import */ var _impl_format__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(11);
/* harmony import */ var _impl_edit__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(14);
/* harmony import */ var _impl_scanner__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(12);
/* harmony import */ var _impl_parser__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(15);
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
/* 11 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   format: () => (/* binding */ format),
/* harmony export */   isEOL: () => (/* binding */ isEOL)
/* harmony export */ });
/* harmony import */ var _scanner__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(12);
/* harmony import */ var _string_intern__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(13);
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
/* 12 */
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
/* 13 */
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
/* 14 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   applyEdit: () => (/* binding */ applyEdit),
/* harmony export */   isWS: () => (/* binding */ isWS),
/* harmony export */   removeProperty: () => (/* binding */ removeProperty),
/* harmony export */   setProperty: () => (/* binding */ setProperty)
/* harmony export */ });
/* harmony import */ var _format__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(11);
/* harmony import */ var _parser__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(15);
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
/* 15 */
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
/* harmony import */ var _scanner__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(12);
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
exports.DbsTreeProvider = void 0;
exports.showBranchSelector = showBranchSelector;
exports.checkoutBranch = checkoutBranch;
exports.getDbDumpFolder = getDbDumpFolder;
exports.createDb = createDb;
exports.restoreDb = restoreDb;
exports.setupDatabase = setupDatabase;
exports.selectDatabase = selectDatabase;
exports.deleteDb = deleteDb;
exports.changeDatabaseVersion = changeDatabaseVersion;
const vscode = __importStar(__webpack_require__(1));
const db_1 = __webpack_require__(17);
const module_1 = __webpack_require__(22);
const utils_1 = __webpack_require__(4);
const settingsStore_1 = __webpack_require__(21);
const versionsService_1 = __webpack_require__(18);
const child_process_1 = __webpack_require__(7);
const fs = __importStar(__webpack_require__(5));
const path = __importStar(__webpack_require__(6));
const crypto_1 = __webpack_require__(20);
const gitService_1 = __webpack_require__(9);
const dbNaming_1 = __webpack_require__(23);
const os = __importStar(__webpack_require__(24));
const sortOptions_1 = __webpack_require__(25);
const checkoutHooksOutput = vscode.window.createOutputChannel('Odoo Debugger: Branch Hooks');
/**
 * Gets the effective Odoo version for a database object.
 * Works with both DatabaseModel instances and plain database objects.
 */
function getEffectiveOdooVersion(db) {
    // If it's a DatabaseModel instance, use its method
    if (db && typeof db.getEffectiveOdooVersion === 'function') {
        return db.getEffectiveOdooVersion();
    }
    // For plain objects, implement the same logic
    if (db && db.versionId) {
        try {
            const versionsService = versionsService_1.VersionsService.getInstance();
            const version = versionsService.getVersion(db.versionId);
            if (version) {
                return version.odooVersion;
            }
        }
        catch (error) {
            console.warn(`Failed to get version for database ${(0, utils_1.getDatabaseLabel)(db)}:`, error);
        }
    }
    // Fall back to legacy odooVersion property
    return db?.odooVersion || undefined;
}
/**
 * Gets the version name for a database object if it has a version assigned.
 * Works with both DatabaseModel instances and plain database objects.
 */
function getVersionName(db) {
    // If it's a DatabaseModel instance, use its method
    if (db && typeof db.getVersionName === 'function') {
        return db.getVersionName();
    }
    // For plain objects, implement the same logic
    if (db && db.versionId) {
        try {
            const versionsService = versionsService_1.VersionsService.getInstance();
            const version = versionsService.getVersion(db.versionId);
            return version?.name;
        }
        catch (error) {
            console.warn(`Failed to get version name for database ${(0, utils_1.getDatabaseLabel)(db)}:`, error);
            return undefined;
        }
    }
    return undefined;
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
function buildDumpDeterministicSeed(sqlDumpPath, projectName, repoSignature) {
    try {
        const stats = fs.statSync(sqlDumpPath);
        return [
            path.resolve(sqlDumpPath),
            projectName,
            repoSignature,
            stats.size,
            Math.floor(stats.mtimeMs)
        ].join('|');
    }
    catch (error) {
        console.warn(`Failed to read dump metadata from ${sqlDumpPath}:`, error);
        return [path.resolve(sqlDumpPath), projectName, repoSignature].join('|');
    }
}
function buildStandardDeterministicSeed(projectName, kind, timestamp, branchName, versionId, repoSignature) {
    return [
        projectName,
        kind,
        branchName ?? '',
        versionId ?? '',
        repoSignature,
        timestamp.toISOString()
    ].join('|');
}
function buildRepoSignature(repos) {
    return repos
        .map(repo => (0, utils_1.normalizePath)(repo.path))
        .sort((a, b) => a.localeCompare(b))
        .join('|');
}
async function promptBranchSwitch(targetVersion, currentBranches) {
    const mismatchedRepos = [];
    if (currentBranches.odoo !== targetVersion) {
        mismatchedRepos.push(`Odoo (currently: ${currentBranches.odoo || 'unknown'})`);
    }
    if (currentBranches.enterprise !== targetVersion) {
        mismatchedRepos.push(`Enterprise (currently: ${currentBranches.enterprise || 'unknown'})`);
    }
    if (currentBranches.designThemes !== targetVersion) {
        mismatchedRepos.push(`Design Themes (currently: ${currentBranches.designThemes || 'unknown'})`);
    }
    if (mismatchedRepos.length === 0) {
        return false; // No switch needed
    }
    const message = `Database requires Odoo version ${targetVersion}, but the following repositories are on different branches:\n\n${mismatchedRepos.join('\n')}\n\nWould you like to switch all repositories to version ${targetVersion}?`;
    const choice = await vscode.window.showWarningMessage(message, { modal: false }, 'Switch Branches', 'Keep Current Branches');
    return choice === 'Switch Branches';
}
/**
 * Helper function to extract DatabaseModel from various event sources
 * (direct database object, VS Code TreeItem, or command arguments)
 */
function extractDatabaseFromEvent(event) {
    if (!event) {
        return null;
    }
    // Check if we received a VS Code TreeItem (context menu call)
    // TreeItems have properties like collapsibleState, label, id, and our custom database property
    if (typeof event === 'object' &&
        'collapsibleState' in event &&
        'label' in event &&
        'database' in event &&
        event.database) {
        return event.database;
    }
    // Check if it's a direct database object (has required DatabaseModel properties)
    if (typeof event === 'object' &&
        event.name &&
        event.id &&
        typeof event.name === 'string' &&
        typeof event.id === 'string') {
        return event;
    }
    return null;
}
class DbsTreeProvider {
    sortPreferences;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    constructor(sortPreferences) {
        this.sortPreferences = sortPreferences;
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(item) {
        return item;
    }
    async getChildren(_element) {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            return [];
        }
        const { project } = result;
        const dbs = project.dbs;
        if (!dbs) {
            (0, utils_1.showError)('No databases are configured for this project.');
            return [];
        }
        const sortId = this.sortPreferences.get('dbSelector', (0, sortOptions_1.getDefaultSortOption)('dbSelector'));
        const sortedDbs = [...dbs].sort((a, b) => this.compareDatabases(a, b, sortId));
        return sortedDbs.map(db => {
            // Handle date parsing defensively
            let editedDate;
            try {
                editedDate = new Date(db.createdAt);
                if (isNaN(editedDate.getTime())) {
                    // If date is invalid, use current date
                    editedDate = new Date();
                }
            }
            catch {
                // If date parsing fails, use current date
                editedDate = new Date();
            }
            const formattedDate = `${editedDate.toISOString().split('T')[0]} ${editedDate.toTimeString().split(' ')[0]}`;
            const dbLabel = (0, utils_1.getDatabaseLabel)(db);
            const badges = `${db.isItABackup ? ' ☁️' : ''}${db.isExisting ? ' 📂' : ''}`;
            const mainLabel = (0, utils_1.addActiveIndicator)(dbLabel, db.isSelected) + badges;
            // Description shows branch and version info as subtext
            let description = '';
            if (db.versionId) {
                // Try to get version name from versions service
                try {
                    const versionsService = versionsService_1.VersionsService.getInstance();
                    const version = versionsService.getVersion(db.versionId);
                    if (version) {
                        // Show branch first if different from version's odoo version, then version
                        if (db.branchName && db.branchName !== version.odooVersion) {
                            description = `🌿 ${db.branchName} • 📦 ${version.name}`;
                        }
                        else {
                            description = `📦 ${version.name}`;
                        }
                    }
                    else {
                        // Fallback to version ID if version not found
                        if (db.branchName) {
                            description = `🌿 ${db.branchName} • 📦 ${db.versionId.substring(0, 8)}...`;
                        }
                        else {
                            description = `📦 ${db.versionId.substring(0, 8)}...`;
                        }
                    }
                }
                catch (error) {
                    // Fallback to version ID if versions service fails
                    if (db.branchName) {
                        description = `🌿 ${db.branchName} • 📦 ${db.versionId.substring(0, 8)}...`;
                    }
                    else {
                        description = `📦 ${db.versionId.substring(0, 8)}...`;
                    }
                }
            }
            else if (db.branchName && db.branchName.trim() !== '') {
                // Show branch when no version is selected
                description = `🌿 ${db.branchName}`;
                const effectiveOdooVersion = getEffectiveOdooVersion(db);
                if (effectiveOdooVersion && effectiveOdooVersion !== db.branchName) {
                    description += ` • 🛠️ ${effectiveOdooVersion}`;
                }
            }
            else {
                const effectiveOdooVersion = getEffectiveOdooVersion(db);
                if (effectiveOdooVersion && effectiveOdooVersion.trim() !== '') {
                    description = `🛠️ ${effectiveOdooVersion}`;
                }
                else {
                    description = '';
                }
            }
            const treeItem = new vscode.TreeItem(mainLabel, vscode.TreeItemCollapsibleState.None);
            treeItem.id = `${db.id}-${formattedDate}`;
            treeItem.description = description;
            // Create tooltip - push each detail into array, join with \n\n at the end
            const tooltipDetails = [];
            // Database name header
            tooltipDetails.push(`**${dbLabel}**`);
            tooltipDetails.push(`**Internal name:** ${db.id}`);
            // Version information
            if (db.versionId) {
                try {
                    const versionsService = versionsService_1.VersionsService.getInstance();
                    const version = versionsService.getVersion(db.versionId);
                    if (version) {
                        tooltipDetails.push(`**Version:** ${version.name}`);
                        tooltipDetails.push(`**Odoo Version:** ${version.odooVersion}`);
                    }
                    else {
                        tooltipDetails.push(`**Version ID:** ${db.versionId}`);
                    }
                }
                catch (error) {
                    tooltipDetails.push(`**Version ID:** ${db.versionId}`);
                }
            }
            else {
                tooltipDetails.push(`**Version:** None`);
                // Get Odoo version from effective lookup (legacy odooVersion property)
                const effectiveOdooVersion = getEffectiveOdooVersion(db);
                if (effectiveOdooVersion) {
                    tooltipDetails.push(`**Odoo Version:** ${effectiveOdooVersion}`);
                }
            }
            // Branch information
            if (db.branchName) {
                tooltipDetails.push(`**Branch:** ${db.branchName}`);
            }
            // Database details
            tooltipDetails.push(`**Created:** ${formattedDate}`);
            // Database type
            if (db.isItABackup) {
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
            // Status
            if (db.isSelected) {
                tooltipDetails.push(`**Status:** Currently selected`);
            }
            // Module information
            if (db.modules && db.modules.length > 0) {
                tooltipDetails.push(`**Modules:** ${db.modules.length} installed`);
            }
            // Join all details with double newlines
            const tooltip = tooltipDetails.join('\n\n');
            treeItem.tooltip = new vscode.MarkdownString(tooltip);
            // Set contextValue to enable right-click context menu
            treeItem.contextValue = 'database';
            // Store the database object for commands that need it
            treeItem.database = db;
            treeItem.command = {
                command: 'dbSelector.selectDb',
                title: 'Select DB',
                arguments: [db]
            };
            return treeItem;
        });
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
        const effective = getEffectiveOdooVersion(db);
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
async function showBranchSelector(repoPath) {
    repoPath = (0, utils_1.normalizePath)(repoPath);
    if (!repoPath || !fs.existsSync(repoPath)) {
        (0, utils_1.showError)(`Repository path does not exist: ${repoPath}`);
        return undefined;
    }
    try {
        const { stdout } = await new Promise((resolve, reject) => {
            (0, child_process_1.exec)('git branch --all --format="%(refname:short)"', { cwd: repoPath }, (err, stdout, stderr) => {
                if (err || stderr) {
                    reject(new Error(`Failed to fetch branches in ${repoPath}: ${stderr || (err?.message || 'Unknown error')}`));
                }
                else {
                    resolve({ stdout });
                }
            });
        });
        const branches = stdout
            .split('\n')
            .map((b) => b.trim())
            .filter((b) => b.length && !b.includes('->'));
        const result = await vscode.window.showQuickPick(branches, {
            placeHolder: 'Select a branch to switch to',
            canPickMany: false,
            ignoreFocusOut: true
        });
        return result;
    }
    catch (error) {
        (0, utils_1.showError)(error.message);
        return undefined;
    }
}
async function checkoutBranch(settings, branch) {
    const runCheckoutHookCommands = async (commands, phase, cwd, contextLabel, progress) => {
        if (!Array.isArray(commands) || commands.length === 0) {
            return true;
        }
        const normalizedCommands = commands.map(cmd => cmd.trim()).filter(Boolean);
        if (normalizedCommands.length === 0) {
            return true;
        }
        checkoutHooksOutput.show(true);
        checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: running ${normalizedCommands.length} command(s) in: ${cwd}`);
        for (const [index, command] of normalizedCommands.entries()) {
            progress?.report({ message: `${contextLabel}: ${phase} (${index + 1}/${normalizedCommands.length}): ${command}` });
            checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: $ ${command}`);
            const taskName = `Odoo Debugger: ${phase} (${index + 1}/${normalizedCommands.length})`;
            const task = new vscode.Task({ type: 'odooDebugger.branchHooks', phase, index }, vscode.TaskScope.Workspace, taskName, 'odooDebugger', new vscode.ShellExecution(command, { cwd }), []);
            task.presentationOptions = {
                reveal: vscode.TaskRevealKind.Always,
                focus: false,
                panel: vscode.TaskPanelKind.Shared,
                clear: false
            };
            const execution = await vscode.tasks.executeTask(task);
            const exitCode = await new Promise((resolve) => {
                const disposable = vscode.tasks.onDidEndTaskProcess(event => {
                    if (event.execution === execution) {
                        disposable.dispose();
                        resolve(event.exitCode);
                    }
                });
            });
            if (exitCode !== 0 && exitCode !== undefined) {
                (0, utils_1.showError)(`${contextLabel}: failed during ${phase} command "${command}" (exit code ${exitCode})`);
                checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: FAILED (exit ${exitCode})`);
                return false;
            }
            if (exitCode === undefined) {
                (0, utils_1.showError)(`${contextLabel}: failed during ${phase} command "${command}" (no exit code)`);
                checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: FAILED (no exit code)`);
                return false;
            }
            checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: OK`);
        }
        return true;
    };
    const repos = [
        { name: 'Odoo', path: (0, utils_1.normalizePath)(settings.odooPath) },
        { name: 'Enterprise', path: (0, utils_1.normalizePath)(settings.enterprisePath) },
        { name: 'Design Themes', path: (0, utils_1.normalizePath)(settings.designThemesPath) }
    ];
    // Pull hook commands directly from VS Code settings (not per-version settings)
    const config = vscode.workspace.getConfiguration('odooDebugger.defaultVersion');
    const preCheckoutCommands = config.get('preCheckoutCommands', []);
    const postCheckoutCommands = config.get('postCheckoutCommands', []);
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Switching to branch: ${branch}`,
        cancellable: false
    }, async (progress) => {
        const results = [];
        const totalRepos = repos.length;
        // Process each repository
        for (const repo of repos) {
            progress.report({
                message: `Processing ${repo.name}...`,
                increment: totalRepos > 0 ? (100 / totalRepos) : 0
            });
            if (!repo.path || repo.path.trim() === '') {
                results.push({
                    name: repo.name,
                    success: false,
                    message: 'Path not configured'
                });
                continue;
            }
            if (!fs.existsSync(repo.path)) {
                results.push({
                    name: repo.name,
                    success: false,
                    message: `Repository path does not exist: ${repo.path}`
                });
                continue;
            }
            const preOk = await runCheckoutHookCommands(preCheckoutCommands, 'pre-checkout', repo.path, repo.name, progress);
            if (!preOk) {
                results.push({
                    name: repo.name,
                    success: false,
                    message: `Pre-checkout hook(s) failed`
                });
                continue;
            }
            const apiCheckoutSucceeded = await (0, gitService_1.checkoutBranchViaSourceControl)(repo.path, branch);
            let checkoutSucceededForRepo = false;
            let checkoutMessage = '';
            if (!apiCheckoutSucceeded) {
                try {
                    await new Promise((resolve, reject) => {
                        (0, child_process_1.exec)(`git checkout ${branch}`, { cwd: repo.path }, (err, _stdout, stderr) => {
                            if (stderr && stderr.includes(`Already on '${branch}'`)) {
                                checkoutSucceededForRepo = true;
                                checkoutMessage = `Already on branch: ${branch}`;
                                resolve();
                                return;
                            }
                            if (err || (stderr && !stderr.includes('Switched to branch'))) {
                                checkoutSucceededForRepo = false;
                                checkoutMessage = stderr || err?.message || 'Unknown error';
                                reject(new Error(`Failed to checkout branch ${branch} in ${repo.name}`));
                                return;
                            }
                            checkoutSucceededForRepo = true;
                            checkoutMessage = `Switched to branch: ${branch}`;
                            resolve();
                        });
                    });
                }
                catch (error) {
                    results.push({
                        name: repo.name,
                        success: false,
                        message: checkoutMessage || 'Failed to checkout branch'
                    });
                    continue;
                }
            }
            else {
                checkoutSucceededForRepo = true;
                checkoutMessage = `Switched to branch ${branch}`;
            }
            if (checkoutSucceededForRepo) {
                const postOk = await runCheckoutHookCommands(postCheckoutCommands, 'post-checkout', repo.path, repo.name, progress);
                results.push({
                    name: repo.name,
                    success: postOk,
                    message: postOk ? checkoutMessage : `${checkoutMessage} (but post-checkout hook(s) failed)`
                });
            }
            else {
                results.push({
                    name: repo.name,
                    success: false,
                    message: checkoutMessage || 'Failed to checkout branch'
                });
            }
        }
        // Check results and provide feedback
        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);
        if (failed.length === 0) {
            (0, utils_1.showInfo)(`All repositories switched to branch: ${branch}`);
        }
        else if (successful.length > 0) {
            (0, utils_1.showWarning)(`Partially switched to branch ${branch}. Failed: ${failed.map(f => f.name).join(', ')}`);
            // Show details of failures
            failed.forEach(f => {
                console.error(`${f.name}: ${f.message}`);
            });
        }
        else {
            (0, utils_1.showError)(`Failed to switch any repository to branch: ${branch}`);
            // Show details of all failures
            failed.forEach(f => {
                console.error(`${f.name}: ${f.message}`);
            });
        }
        // Log successful switches
        successful.forEach(s => {
            console.log(`${s.name}: ${s.message}`);
        });
    });
}
function collectDumpSources(root, maxDepth = 2) {
    const results = [];
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length > 0) {
        const { dir, depth } = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch (error) {
            console.warn(`Failed to read dumps directory ${dir}:`, error);
            continue;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativeLabel = path.relative(root, fullPath) || entry.name;
            if (entry.isDirectory()) {
                const dumpSqlPath = path.join(fullPath, 'dump.sql');
                if (fs.existsSync(dumpSqlPath)) {
                    results.push({
                        label: relativeLabel,
                        kind: 'folder',
                        path: fullPath
                    });
                }
                if (depth < maxDepth) {
                    stack.push({ dir: fullPath, depth: depth + 1 });
                }
            }
            else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
                results.push({
                    label: relativeLabel,
                    kind: 'zip',
                    path: fullPath
                });
            }
        }
    }
    return results;
}
async function getDbDumpFolder(dumpsFolder, searchFilter) {
    dumpsFolder = (0, utils_1.normalizePath)(dumpsFolder);
    if (!fs.existsSync(dumpsFolder)) {
        (0, utils_1.showError)(`Dumps folder not found: ${dumpsFolder}`);
        return undefined;
    }
    const matches = collectDumpSources(dumpsFolder);
    if (matches.length === 0) {
        (0, utils_1.showInfo)(`No dump directories or zip archives found in ${path.basename(dumpsFolder)}.`);
        return undefined;
    }
    let foldersToShow = matches.map(item => ({
        label: item.label,
        description: item.path,
        detail: item.kind === 'zip' ? 'Zip archive' : 'Folder',
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
    }
};
async function createDb(projectName, repos, dumpFolderPath, _settings, options = {}) {
    const discovery = (0, utils_1.discoverModulesInRepos)(repos);
    const allModules = discovery.modules.map(module => ({
        path: module.path,
        name: module.name,
        source: module.isPsaeInternal && module.psInternalDirName
            ? `${module.repoName}/${module.psInternalDirName}`
            : module.repoName
    }));
    let selectedModules = [];
    let db;
    let modules = [];
    // Step 1: Choose database creation method
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
            return undefined; // User cancelled
        }
        creationMethod = selection.method;
    }
    let existingDbName;
    let isExistingDb = false;
    let sqlDumpPath;
    // Step 2: Handle the specific creation method
    switch (creationMethod) {
        case 'fresh':
            // Select modules to install
            const moduleChoices = allModules.map(entry => ({
                label: entry.name,
                description: entry.source,
                detail: entry.path
            }));
            const selectedModuleObjects = await vscode.window.showQuickPick(moduleChoices, {
                placeHolder: 'Select modules to install (optional)',
                canPickMany: true,
                ignoreFocusOut: true
            }) || [];
            selectedModules = selectedModuleObjects.map(choice => choice.label);
            break;
        case 'dump': {
            const selection = await getDbDumpFolder(dumpFolderPath, projectName);
            if (!selection) {
                (0, utils_1.showError)('Select a dump folder or archive to continue.');
                return undefined;
            }
            if (selection.kind === 'folder') {
                const candidate = path.join(selection.path, 'dump.sql');
                if (!fs.existsSync(candidate)) {
                    (0, utils_1.showError)(`dump.sql not found inside ${selection.path}`);
                    return undefined;
                }
                sqlDumpPath = candidate;
            }
            else {
                sqlDumpPath = selection.path;
            }
            break;
        }
        case 'existing':
            // Get existing database name
            existingDbName = await vscode.window.showInputBox({
                placeHolder: 'Enter the name of the existing PostgreSQL database',
                prompt: 'Make sure the database exists in your PostgreSQL instance',
                ignoreFocusOut: true
            });
            if (!existingDbName) {
                (0, utils_1.showError)('Enter a database name to continue.');
                return undefined;
            }
            isExistingDb = true;
            break;
    }
    // Step 3: Get database branch name (optional)
    let branchName = await vscode.window.showInputBox({
        placeHolder: 'Enter a branch/tag name for this database (optional)',
        prompt: 'This helps identify which version/branch this database represents',
        ignoreFocusOut: true
    });
    // Step 4: Select the Odoo version from available versions
    const versionsService = versionsService_1.VersionsService.getInstance();
    await versionsService.initialize();
    const availableVersions = versionsService.getVersions();
    let selectedVersion;
    let selectedVersionId;
    if (availableVersions.length > 0) {
        const versionChoices = [
            {
                label: "$(close) No Version",
                description: "Use current branch settings",
                detail: "Database will use the current repository branches",
                versionId: undefined
            },
            ...availableVersions.map(version => ({
                label: `$(versions) ${version.name}`,
                description: `Odoo ${version.odooVersion}`,
                detail: `Use settings and configuration from ${version.name}`,
                versionId: version.id
            }))
        ];
        const selectedChoice = await vscode.window.showQuickPick(versionChoices, {
            placeHolder: 'Select a version for this database (optional)',
            ignoreFocusOut: true
        });
        if (selectedChoice) {
            selectedVersionId = selectedChoice.versionId;
            if (selectedVersionId) {
                selectedVersion = versionsService.getVersion(selectedVersionId);
            }
        }
    }
    // Step 5: Create the database model
    for (const module of selectedModules) {
        modules.push(new module_1.ModuleModel(module, 'install'));
    }
    const creationTimestamp = new Date();
    const existingIdentifiers = await collectExistingDatabaseIdentifiers();
    const repoSignature = buildRepoSignature(repos);
    let dbKind = creationMethod === 'dump' ? 'dump' : 'fresh';
    let internalDbName;
    let displayDbName;
    if (isExistingDb) {
        if (!existingDbName) {
            throw new Error('Enter a database name to continue.');
        }
        internalDbName = existingDbName;
        displayDbName = existingDbName;
        dbKind = 'existing';
    }
    else {
        const deterministicSeed = creationMethod === 'dump' && sqlDumpPath
            ? buildDumpDeterministicSeed(sqlDumpPath, projectName, repoSignature)
            : buildStandardDeterministicSeed(projectName, dbKind, creationTimestamp, branchName, selectedVersionId, repoSignature);
        const identifiers = (0, dbNaming_1.generateDatabaseIdentifiers)({
            projectName,
            kind: dbKind,
            timestamp: creationTimestamp,
            deterministicSeed,
            existingInternalNames: existingIdentifiers
        });
        internalDbName = identifiers.internalName;
        displayDbName = identifiers.displayName;
        existingIdentifiers.add(internalDbName.toLowerCase());
    }
    db = new db_1.DatabaseModel(displayDbName, creationTimestamp, {
        modules,
        isItABackup: false, // isSelected (will be set when added to project)
        isSelected: true, // isActive
        sqlFilePath: sqlDumpPath,
        isExisting: isExistingDb,
        branchName,
        // Only set odooVersion if no version is selected (legacy compatibility)
        odooVersion: selectedVersionId ? undefined : (selectedVersion?.odooVersion || ''),
        versionId: selectedVersionId,
        displayName: displayDbName,
        internalName: internalDbName,
        kind: dbKind
    });
    // Step 6: Set up the database if needed
    if (sqlDumpPath) {
        db.isItABackup = true;
        await setupDatabase(db.id, sqlDumpPath);
    }
    else if (!isExistingDb) {
        // Create fresh database
        await setupDatabase(db.id, undefined);
    }
    // Note: Version switching will be handled when the database is selected or activated,
    // not during creation, to avoid redundant prompts
    return db;
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
    const confirm = await vscode.window.showWarningMessage(`Are you sure you want to restore the database "${databaseLabel}"? This will overwrite the existing database.`, { modal: true }, 'Restore');
    if (confirm !== 'Restore') {
        return; // User cancelled
    }
    await setupDatabase(database.id, database.sqlFilePath);
    (0, utils_1.showAutoInfo)(`Database "${databaseLabel}" restored successfully`, 3000);
}
async function setupDatabase(dbName, dumpPath, remove = false) {
    if (dumpPath && !fs.existsSync(dumpPath)) {
        console.error(`❌ Dump file not found at: ${dumpPath}`);
        return;
    }
    let preparedDump;
    try {
        preparedDump = dumpPath ? prepareDumpIfNeeded(dumpPath) : undefined;
    }
    catch (error) {
        (0, utils_1.showError)(`Unable to read dump file: ${error.message ?? error}`);
        return;
    }
    const finalDumpPath = preparedDump?.sqlPath;
    const operation = remove ? 'Removing' : finalDumpPath ? 'Setting up' : 'Creating';
    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `${operation} database ${dbName}`,
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ message: 'Checking database existence...', increment: 10 });
                const checkCommand = `psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`;
                const result = (0, child_process_1.execSync)(checkCommand).toString().trim();
                if (result === '1') {
                    progress.report({ message: 'Dropping existing database...', increment: 20 });
                    console.log(`🗑️ Dropping existing database: ${dbName}`);
                    (0, child_process_1.execSync)(`dropdb ${dbName}`, { stdio: 'inherit' });
                }
                if (!remove) {
                    progress.report({ message: 'Creating database...', increment: 40 });
                    console.log(`🚀 Creating database: ${dbName}`);
                    (0, child_process_1.execSync)(`createdb ${dbName}`, { stdio: 'inherit' });
                    if (finalDumpPath) {
                        progress.report({ message: 'Importing dump file...', increment: 50 });
                        console.log(`📥 Importing SQL dump into ${dbName}`);
                        (0, child_process_1.execSync)(`psql ${dbName} < "${finalDumpPath}"`, { stdio: 'inherit', shell: '/bin/sh' });
                        progress.report({ message: 'Configuring database...', increment: 70 });
                        console.log(`� Configuring database for development use`);
                        const newUuid = (0, crypto_1.randomUUID)();
                        console.log(`⏸️ Disabling cron jobs`);
                        (0, child_process_1.execSync)(`psql ${dbName} -c "UPDATE ir_cron SET active='f';"`, { stdio: 'inherit', shell: '/bin/sh' });
                        console.log(`📧 Disabling mail servers`);
                        (0, child_process_1.execSync)(`psql ${dbName} -c "UPDATE ir_mail_server SET active=false;"`, { stdio: 'inherit', shell: '/bin/sh' });
                        console.log(`⏰ Extending database expiry`);
                        (0, child_process_1.execSync)(`psql ${dbName} -c "UPDATE ir_config_parameter SET value = '2090-09-21 00:00:00' WHERE key = 'database.expiration_date';"`, { stdio: 'inherit', shell: '/bin/sh' });
                        console.log(`🔑 Updating database UUID`);
                        (0, child_process_1.execSync)(`psql ${dbName} -c "UPDATE ir_config_parameter SET value = '${newUuid}' WHERE key = 'database.uuid';"`, { stdio: 'inherit', shell: '/bin/sh' });
                        console.log(`📨 Adding mailcatcher server`);
                        try {
                            (0, child_process_1.execSync)(`psql ${dbName} -c "INSERT INTO ir_mail_server(active,name,smtp_host,smtp_port,smtp_encryption) VALUES (true,'mailcatcher','localhost',1025,false);"`, { stdio: 'inherit', shell: '/bin/sh' });
                        }
                        catch (error) {
                            console.warn(`⚠️ Failed to add mailcatcher server (continuing setup): ${error}`);
                        }
                        console.log(`👤 Resetting user passwords to login names`);
                        (0, child_process_1.execSync)(`psql ${dbName} -c "UPDATE res_users SET password=login;"`, { stdio: 'inherit', shell: '/bin/sh' });
                        console.log(`🔐 Configuring admin user`);
                        (0, child_process_1.execSync)(`psql ${dbName} -c "UPDATE res_users SET password='admin' WHERE id=2;"`, { stdio: 'inherit', shell: '/bin/sh' });
                        (0, child_process_1.execSync)(`psql ${dbName} -c "UPDATE res_users SET login='admin' WHERE id=2;"`, { stdio: 'inherit', shell: '/bin/sh' });
                        (0, child_process_1.execSync)(`psql ${dbName} -c "UPDATE res_users SET totp_secret='' WHERE id=2;"`, { stdio: 'inherit', shell: '/bin/sh' });
                        (0, child_process_1.execSync)(`psql ${dbName} -c "UPDATE res_users SET active=true WHERE id=2;"`, { stdio: 'inherit', shell: '/bin/sh' });
                        console.log(`🏢 Clearing employee PINs`);
                        (0, child_process_1.execSync)(`psql ${dbName} -c "UPDATE hr_employee SET pin = '';"`, { stdio: 'inherit', shell: '/bin/sh' });
                        progress.report({ message: 'Database configured for development', increment: 90 });
                    }
                    else {
                        progress.report({ message: 'Database created (empty)...', increment: 90 });
                        console.log(`📝 Empty database created: ${dbName}`);
                    }
                }
                progress.report({ message: 'Complete!', increment: 100 });
                console.log(`✅ Database "${dbName}" is ready.`);
            }
            catch (error) {
                console.error(`❌ Error: ${error.message}`);
                (0, utils_1.showError)(`Failed to setup database: ${error.message}`);
            }
        });
    }
    finally {
        if (preparedDump?.cleanup) {
            try {
                preparedDump.cleanup();
            }
            catch (cleanupError) {
                console.warn('Failed to cleanup temporary dump files:', cleanupError);
            }
        }
    }
}
async function selectDatabase(event) {
    const database = extractDatabaseFromEvent(event);
    if (!database) {
        (0, utils_1.showError)('Could not identify the database to select.');
        return;
    }
    const databaseLabel = (0, utils_1.getDatabaseLabel)(database);
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    // Find the project index in the projects array
    const projectIndex = data.projects.findIndex((p) => p.uid === project.uid);
    if (projectIndex === -1) {
        (0, utils_1.showError)('The selected project could not be found.');
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
    // Save the updated databases array without settings
    const updatedData = (0, utils_1.stripSettings)(data);
    await settingsStore_1.SettingsStore.saveWithoutComments(updatedData);
    // Handle version and branch switching with enhanced options
    try {
        await handleDatabaseVersionSwitch(database);
    }
    catch (error) {
        console.error('Error in database version switching:', error);
        (0, utils_1.showWarning)(`Database selected, but version switching failed: ${error.message}`);
    }
    (0, utils_1.showBriefStatus)(`Database switched to: ${databaseLabel}`, 2000);
}
async function handleDatabaseVersionSwitch(database) {
    const versionsService = versionsService_1.VersionsService.getInstance();
    await versionsService.initialize();
    const settings = await versionsService.getActiveVersionSettings();
    const databaseLabel = (0, utils_1.getDatabaseLabel)(database);
    // Get the database switch behavior setting
    const switchBehavior = vscode.workspace.getConfiguration('odooDebugger').get('databaseSwitchBehavior', 'ask');
    // Check if database has a version associated with it
    if (database.versionId) {
        const dbVersion = versionsService.getVersion(database.versionId);
        if (dbVersion) {
            // Handle automatic behaviors first
            if (switchBehavior !== 'ask') {
                switch (switchBehavior) {
                    case 'auto-both':
                        // Automatically switch both version and branch
                        await versionsService.setActiveVersion(dbVersion.id);
                        const currentOdooBranch = await (0, utils_1.getGitBranch)(settings.odooPath);
                        if (currentOdooBranch !== dbVersion.odooVersion) {
                            await checkoutBranch(settings, dbVersion.odooVersion);
                            (0, utils_1.showAutoInfo)(`Auto-switched to version "${dbVersion.name}" and branch "${dbVersion.odooVersion}"`, 3000);
                        }
                        else {
                            (0, utils_1.showAutoInfo)(`Auto-switched to version "${dbVersion.name}" (branch already correct)`, 3000);
                        }
                        return;
                    case 'auto-version-only':
                        // Automatically switch version settings only
                        await versionsService.setActiveVersion(dbVersion.id);
                        (0, utils_1.showAutoInfo)(`Auto-switched to version "${dbVersion.name}" settings`, 3000);
                        return;
                    case 'auto-branch-only':
                        // Automatically switch branches only (no version change)
                        const currentOdooBranchOnly = await (0, utils_1.getGitBranch)(settings.odooPath);
                        if (currentOdooBranchOnly !== dbVersion.odooVersion) {
                            await checkoutBranch(settings, dbVersion.odooVersion);
                            (0, utils_1.showAutoInfo)(`Auto-switched to branch "${dbVersion.odooVersion}"`, 3000);
                        }
                        else {
                            (0, utils_1.showAutoInfo)(`Branch "${dbVersion.odooVersion}" already active`, 2000);
                        }
                        return;
                }
            }
            // Show enhanced switching options (when switchBehavior is 'ask')
            const switchOptions = [
                {
                    label: "$(rocket) Switch to Version Settings Only",
                    description: "Use version settings without changing branches",
                    detail: `Apply settings from ${dbVersion.name} but keep current branches`,
                    action: 'version-only'
                },
                {
                    label: "$(git-branch) Switch Version + Branch",
                    description: "Use version settings and switch to matching branch",
                    detail: `Apply settings from ${dbVersion.name} and switch to ${dbVersion.odooVersion} branch`,
                    action: 'version-and-branch'
                },
                {
                    label: "$(close) Do Nothing",
                    description: "Keep current settings and branches",
                    detail: "No changes will be made",
                    action: 'nothing'
                }
            ];
            const selectedOption = await vscode.window.showQuickPick(switchOptions, {
                placeHolder: `Database "${databaseLabel}" uses version "${dbVersion.name}". What would you like to do?`,
                ignoreFocusOut: true
            });
            if (selectedOption) {
                switch (selectedOption.action) {
                    case 'version-only':
                        // Activate the version (which applies its settings)
                        await versionsService.setActiveVersion(dbVersion.id);
                        (0, utils_1.showAutoInfo)(`Switched to version "${dbVersion.name}" settings`, 3000);
                        break;
                    case 'version-and-branch': {
                        // Activate the version and switch branches
                        await versionsService.setActiveVersion(dbVersion.id);
                        const currentOdooBranch = await (0, utils_1.getGitBranch)(settings.odooPath);
                        // Check if branch switching is needed
                        if (currentOdooBranch !== dbVersion.odooVersion) {
                            await checkoutBranch(settings, dbVersion.odooVersion);
                            (0, utils_1.showAutoInfo)(`Switched to version "${dbVersion.name}" and branch "${dbVersion.odooVersion}"`, 3000);
                        }
                        else {
                            (0, utils_1.showAutoInfo)(`Switched to version "${dbVersion.name}" (branch already correct)`, 3000);
                        }
                        break;
                    }
                    case 'nothing':
                        // Do nothing
                        break;
                }
            }
            return;
        }
    }
    // Fallback to old behavior for databases without version (only branch switching available)
    const effectiveOdooVersion = getEffectiveOdooVersion(database);
    if (effectiveOdooVersion && effectiveOdooVersion !== '') {
        const currentOdooBranch = await (0, utils_1.getGitBranch)(settings.odooPath);
        const currentEnterpriseBranch = await (0, utils_1.getGitBranch)(settings.enterprisePath);
        const currentDesignThemesBranch = await (0, utils_1.getGitBranch)(settings.designThemesPath);
        // Handle automatic branch switching for databases without version
        if (switchBehavior === 'auto-both' || switchBehavior === 'auto-branch-only') {
            // For databases without version, we can only do branch switching
            if (currentOdooBranch !== effectiveOdooVersion) {
                await checkoutBranch(settings, effectiveOdooVersion);
                (0, utils_1.showAutoInfo)(`Auto-switched to branch "${effectiveOdooVersion}"`, 3000);
            }
            else {
                (0, utils_1.showAutoInfo)(`Branch "${effectiveOdooVersion}" already active`, 2000);
            }
        }
        else if (switchBehavior === 'auto-version-only') {
            // Can't switch version for databases without version - do nothing
            (0, utils_1.showAutoInfo)(`No version settings to switch to for database "${databaseLabel}"`, 2000);
        }
        else {
            // Ask user (default behavior)
            const shouldSwitch = await promptBranchSwitch(effectiveOdooVersion, {
                odoo: currentOdooBranch,
                enterprise: currentEnterpriseBranch,
                designThemes: currentDesignThemesBranch
            });
            if (shouldSwitch) {
                await checkoutBranch(settings, effectiveOdooVersion);
            }
        }
    }
}
async function deleteDb(event) {
    const db = extractDatabaseFromEvent(event);
    if (!db) {
        (0, utils_1.showError)('Could not identify the database to delete.');
        return;
    }
    const dbLabel = (0, utils_1.getDatabaseLabel)(db);
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    // Find the project index in the projects array
    const projectIndex = data.projects.findIndex((p) => p.uid === project.uid);
    if (projectIndex === -1) {
        (0, utils_1.showError)('The selected project could not be found.');
        return;
    }
    // Ask for confirmation
    const confirm = await vscode.window.showWarningMessage(`Are you sure you want to delete the database "${dbLabel}"?`, { modal: true }, 'Delete');
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
    (0, utils_1.showAutoInfo)(`Database "${dbLabel}" deleted successfully`, 2500);
    if (db.isSelected && project.dbs.length > 0) {
        (0, utils_1.showBriefStatus)(`Switched to database: ${(0, utils_1.getDatabaseLabel)(project.dbs[0])}`, 2000);
    }
}
async function changeDatabaseVersion(event) {
    try {
        const db = extractDatabaseFromEvent(event);
        if (!db) {
            (0, utils_1.showError)('Could not identify the database whose version should change.');
            return;
        }
        const dbLabel = (0, utils_1.getDatabaseLabel)(db);
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            return;
        }
        const { data, project } = result;
        // Find the project index in the projects array
        const projectIndex = data.projects.findIndex((p) => p.uid === project.uid);
        if (projectIndex === -1) {
            (0, utils_1.showError)('The selected project could not be found.');
            return;
        }
        // Find the database index
        const dbIndex = project.dbs.findIndex((database) => database.id === db.id);
        if (dbIndex === -1) {
            (0, utils_1.showError)('The selected database could not be found.');
            return;
        }
        // Get available versions
        const versionsService = versionsService_1.VersionsService.getInstance();
        await versionsService.initialize();
        const availableVersions = versionsService.getVersions();
        // Create version choices including "No Version" option
        const versionChoices = [
            {
                label: "$(close) No Version",
                description: "Remove version association",
                detail: "Database will use current branch settings without version",
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
        let currentVersionText = "No version";
        if (db.versionId) {
            const currentVersion = versionsService.getVersion(db.versionId);
            currentVersionText = currentVersion ? currentVersion.name : "Unknown version";
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
            : "no version";
        (0, utils_1.showAutoInfo)(`Database "${dbNameForMessage}" updated to use ${newVersionText}`, 3000);
        // If this is the currently selected database, offer to switch to the new version
        if (db.isSelected && selectedChoice.versionId) {
            const switchChoice = await vscode.window.showInformationMessage(`Would you like to immediately switch to the new version settings?`, { modal: false }, 'Switch Now', 'Not Now');
            if (switchChoice === 'Switch Now') {
                // Use the same switching logic as database selection
                await handleDatabaseVersionSwitch(project.dbs[dbIndex]);
            }
        }
    }
    catch (error) {
        (0, utils_1.showError)(`Failed to change database version: ${error.message}`);
        console.error('Error in changeDatabaseVersion:', error);
    }
}
function prepareDumpIfNeeded(dumpPath) {
    if (dumpPath.endsWith('.zip')) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-dump-'));
        const tempSqlPath = path.join(tempDir, 'dump.sql');
        try {
            const listOutput = (0, child_process_1.execSync)(`unzip -Z1 "${dumpPath}"`, { encoding: 'utf8', shell: '/bin/sh' });
            const entries = listOutput.split('\n').map(line => line.trim()).filter(Boolean);
            if (entries.length === 0) {
                throw new Error('Archive is empty.');
            }
            const sqlEntry = entries.find(entry => entry.toLowerCase().endsWith('.sql'));
            const gzEntry = entries.find(entry => entry.toLowerCase().endsWith('.sql.gz'));
            if (sqlEntry) {
                (0, child_process_1.execSync)(`unzip -p "${dumpPath}" "${sqlEntry}" > "${tempSqlPath}"`, { stdio: 'inherit', shell: '/bin/sh' });
            }
            else if (gzEntry) {
                (0, child_process_1.execSync)(`unzip -p "${dumpPath}" "${gzEntry}" | gunzip -c > "${tempSqlPath}"`, { stdio: 'inherit', shell: '/bin/sh' });
            }
            else {
                (0, child_process_1.execSync)(`unzip -p "${dumpPath}" > "${tempSqlPath}"`, { stdio: 'inherit', shell: '/bin/sh' });
            }
            return {
                sqlPath: tempSqlPath,
                cleanup: () => {
                    try {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    }
                    catch (cleanupError) {
                        console.warn('Failed to cleanup temporary unzip folder:', cleanupError);
                    }
                }
            };
        }
        catch (error) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
            catch {
                // ignore
            }
            throw error;
        }
    }
    if (dumpPath.endsWith('.gz')) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-dump-'));
        const tempSqlPath = path.join(tempDir, 'dump.sql');
        try {
            (0, child_process_1.execSync)(`gunzip -c "${dumpPath}" > "${tempSqlPath}"`, { stdio: 'inherit', shell: '/bin/sh' });
            return {
                sqlPath: tempSqlPath,
                cleanup: () => {
                    try {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    }
                    catch (cleanupError) {
                        console.warn('Failed to cleanup temporary gunzip folder:', cleanupError);
                    }
                }
            };
        }
        catch (error) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
            catch {
                // ignore
            }
            throw error;
        }
    }
    return { sqlPath: dumpPath };
}


/***/ }),
/* 17 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.DatabaseModel = void 0;
const versionsService_1 = __webpack_require__(18);
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
                console.warn(`Failed to get version for database ${this.name}:`, error);
                // Fall through to legacy property
            }
        }
        // Fall back to legacy odooVersion property for backward compatibility
        return this.odooVersion || undefined;
    }
    /**
     * Gets the version name if this database has a version assigned.
     */
    getVersionName() {
        if (this.versionId) {
            try {
                const versionsService = versionsService_1.VersionsService.getInstance();
                const version = versionsService.getVersion(this.versionId);
                return version?.name;
            }
            catch (error) {
                console.warn(`Failed to get version name for database ${this.name}:`, error);
                return undefined;
            }
        }
        return undefined;
    }
    // Legacy constructor for backward compatibility
    static createLegacy(name, createdAt, options) {
        return new DatabaseModel(name, createdAt, options);
    }
}
exports.DatabaseModel = DatabaseModel;


/***/ }),
/* 18 */
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
const vscode = __importStar(__webpack_require__(1));
const fs = __importStar(__webpack_require__(5));
const path = __importStar(__webpack_require__(6));
const version_1 = __webpack_require__(19);
const settingsStore_1 = __webpack_require__(21);
const settings_1 = __webpack_require__(8);
const utils_1 = __webpack_require__(4);
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
            const hasLegacySettings = this.hasLegacySettings();
            // Create default version if none exist
            if (this.versions.size === 0) {
                const defaultVersion = new version_1.VersionModel('Default Version', '17.0' // Odoo version
                );
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
            console.error('Failed to load versions:', error);
            // Create default version on error
            const defaultVersion = new version_1.VersionModel('Default Version', '17.0');
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
            console.log(`Saved ${this.versions.size} versions successfully`);
        }
        catch (error) {
            console.error('Failed to save versions:', error);
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
            console.log(`Saved ${this.versions.size} versions during migration`);
        }
        catch (error) {
            console.error('Failed to save versions during migration:', error);
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
            console.log(`Using settings from active version: ${activeVersion.name}`);
            return activeVersion.settings;
        }
        // Fallback: if no active version or no settings, create a temporary default
        console.warn('No active version or settings found, creating temporary default settings');
        // Create a version with default settings if none exists
        if (this.versions.size === 0) {
            const defaultVersion = new version_1.VersionModel('Default Version', '17.0');
            defaultVersion.isActive = true;
            this.versions.set(defaultVersion.id, defaultVersion);
            this.activeVersionId = defaultVersion.id;
            await this.saveVersions();
            return defaultVersion.settings;
        }
        // Return default settings structure as fallback
        return new settings_1.SettingsModel();
    }
    /**
     * Set active version
     */
    async setActiveVersion(id) {
        await this.initialize(); // Ensure initialization
        if (!this.versions.has(id)) {
            console.error(`Version with id ${id} not found`);
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
            console.log(`Successfully set active version from ${oldActiveVersionId} to ${id}`);
            return true;
        }
        catch (error) {
            console.error('Error saving active version:', error);
            // Revert on error
            this.activeVersionId = oldActiveVersionId;
            this.versions.forEach((version, versionId) => {
                version.isActive = (versionId === oldActiveVersionId);
            });
            return false;
        }
    }
    /**
     * Create a new version
     */
    async createVersion(name, odooVersion, settingsOverrides = {}) {
        await this.initialize(); // Ensure initialization
        // Get default settings from VS Code configuration
        const defaultSettings = (0, utils_1.getDefaultVersionSettings)();
        const mergedSettings = { ...defaultSettings, ...settingsOverrides };
        delete mergedSettings.debuggerName;
        const version = new version_1.VersionModel(name, odooVersion, mergedSettings);
        version.settings.debuggerName = `odoo:${odooVersion}`;
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
        if (updatesCopy.odooVersion) {
            const defaultDebuggerForCurrent = `odoo:${version.odooVersion}`;
            const hasCustomDebugger = version.settings.debuggerName && version.settings.debuggerName !== defaultDebuggerForCurrent;
            const overrideDebuggerName = !hasCustomDebugger && !(settingsPatch && Object.hasOwn(settingsPatch, 'debuggerName'));
            if (overrideDebuggerName) {
                settingsPatch = {
                    ...(settingsPatch),
                    debuggerName: `odoo:${updatesCopy.odooVersion}`
                };
            }
        }
        if (settingsPatch) {
            Object.assign(version.settings, settingsPatch);
        }
        const { settings, ...otherUpdates } = updatesCopy;
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
            vscode.window.showWarningMessage('Cannot delete the last version. At least one version must exist.');
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
                                console.log(`Clearing version reference from database "${(0, utils_1.getDatabaseLabel)(db)}" (was using deleted version)`);
                                db.versionId = undefined;
                                // Don't touch odooVersion - let it remain as is for backward compatibility
                                needsSave = true;
                            }
                        }
                    }
                }
            }
            if (needsSave) {
                console.log('Saving cleaned database references after version deletion');
                await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
            }
        }
        catch (error) {
            console.warn('Failed to clean up database version references:', error);
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
            console.error(`Source version with id ${sourceId} not found`);
            return undefined;
        }
        try {
            const clonedVersion = sourceVersion.clone(newName);
            this.versions.set(clonedVersion.id, clonedVersion);
            await this.saveVersions();
            vscode.commands.executeCommand('odoo.versionsChanged');
            console.log(`Successfully cloned version ${sourceVersion.name} to ${newName}`);
            return clonedVersion;
        }
        catch (error) {
            console.error('Error cloning version:', error);
            return undefined;
        }
    }
    /**
     * Get settings for active version
     */
    async getActiveSettings() {
        await this.initialize(); // Ensure initialization
        const activeVersion = this.getActiveVersion();
        return activeVersion ? activeVersion.settings : {};
    }
    /**
     * Update settings for active version
     */
    async updateActiveSettings(settings) {
        await this.initialize(); // Ensure initialization
        const activeVersion = this.getActiveVersion();
        if (!activeVersion) {
            console.warn('No active version is configured, cannot update settings');
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
            console.warn('Settings migration during refresh failed (this is non-critical):', error);
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
            console.log('No versions found, creating default version');
            const defaultVersion = new version_1.VersionModel('Default Version', '17.0');
            defaultVersion.isActive = true;
            this.versions.set(defaultVersion.id, defaultVersion);
            this.activeVersionId = defaultVersion.id;
            needsRepair = true;
        }
        // Ensure we have an active version
        if (!this.activeVersionId || !this.versions.has(this.activeVersionId)) {
            console.log('Invalid active version, selecting first available version');
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
        // Save if repairs were needed
        if (needsRepair) {
            console.log('Version data repaired, saving...');
            await this.saveVersions();
        }
    }
    /**
 * Migrate existing settings from SettingsStore to a new version for backwards compatibility
 */
    async migrateFromLegacySettings() {
        try {
            console.log('Starting migration check...');
            // Check if legacy settings actually exist in the file
            if (!this.hasLegacySettings()) {
                console.log('No legacy settings found, migration not needed');
                return;
            }
            console.log('Legacy settings found, proceeding with migration...');
            // Try to get existing settings
            const existingSettings = await settingsStore_1.SettingsStore.getSettings();
            if (!existingSettings) {
                console.log('Legacy settings exist but are empty, clearing them');
                await this.clearLegacySettings();
                return;
            }
            console.log('Retrieved legacy settings:', existingSettings);
            // Check if we already have a migrated version (avoid duplicate migration)
            if (this.getVersion('migrated-version')) {
                console.log('Migration already completed, clearing legacy settings');
                await this.clearLegacySettings();
                return;
            }
            console.log('Migrating legacy settings to version management...');
            // Convert SettingsModel to VersionSettings format
            const versionSettings = {
                debuggerName: existingSettings.debuggerName || 'odoo:17.0',
                debuggerVersion: existingSettings.debuggerVersion || '1.0.0',
                portNumber: existingSettings.portNumber || 8017,
                shellPortNumber: existingSettings.shellPortNumber || 5017,
                limitTimeReal: existingSettings.limitTimeReal || 0,
                limitTimeCpu: existingSettings.limitTimeCpu || 0,
                maxCronThreads: existingSettings.maxCronThreads || 0,
                extraParams: existingSettings.extraParams || '--log-handler,odoo.addons.base.models.ir_attachment:WARNING',
                devMode: existingSettings.devMode || '--dev=all',
                dumpsFolder: existingSettings.dumpsFolder || '/dumps',
                odooPath: existingSettings.odooPath || './odoo',
                enterprisePath: existingSettings.enterprisePath || './enterprise',
                designThemesPath: existingSettings.designThemesPath || './design-themes',
                customAddonsPath: existingSettings.customAddonsPath || './custom-addons',
                pythonPath: existingSettings.pythonPath || './venv/bin/python',
                subModulesPaths: existingSettings.subModulesPaths || '',
                installApps: existingSettings.installApps || '',
                upgradeApps: existingSettings.upgradeApps || ''
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
            console.log('Saving migrated version to versions system...');
            await this.saveVersionsDuringMigration();
            console.log('Clearing legacy settings after successful version save...');
            // Clear the legacy settings to prevent repeated migration
            await this.clearLegacySettings();
            // Now that legacy settings are cleared, save versions normally to ensure proper state
            console.log('Final save of versions with settings properly cleared...');
            await this.saveVersions();
            console.log('Successfully migrated legacy settings to version management');
        }
        catch (error) {
            console.warn('Failed to migrate legacy settings:', error);
            // Don't throw - migration failure shouldn't break the extension
        }
    }
    /**
     * Clear legacy settings from odoo-debugger-data.json after successful migration
     */
    async clearLegacySettings() {
        try {
            const workspacePath = (0, utils_1.getWorkspacePath)();
            if (!workspacePath) {
                return;
            }
            const filePath = path.join(workspacePath, '.vscode', 'odoo-debugger-data.json');
            if (!fs.existsSync(filePath)) {
                return;
            }
            // Read current data
            const content = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(content);
            // Remove the settings property but keep projects
            if (data.settings) {
                delete data.settings;
                // Write back the cleaned data
                const cleanedContent = JSON.stringify(data, null, 4);
                fs.writeFileSync(filePath, cleanedContent, 'utf-8');
                console.log('Legacy settings cleared after successful migration');
            }
        }
        catch (error) {
            console.warn('Failed to clear legacy settings:', error);
            // Don't throw - clearing failure shouldn't break anything
        }
    }
    /**
     * Check if legacy settings exist in the odoo-debugger-data.json file
     */
    hasLegacySettings() {
        try {
            const workspacePath = (0, utils_1.getWorkspacePath)();
            if (!workspacePath) {
                return false;
            }
            const filePath = path.join(workspacePath, '.vscode', 'odoo-debugger-data.json');
            if (!fs.existsSync(filePath)) {
                return false;
            }
            // Read current data
            const content = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(content);
            // Check if settings property exists and has meaningful content
            return data.settings && Object.keys(data.settings).length > 0;
        }
        catch (error) {
            console.warn('Failed to check for legacy settings:', error);
            return false;
        }
    }
    /**
     * Set a specific setting to its default value for a version
     */
    async setSettingToDefault(versionId, settingKey) {
        const version = this.versions.get(versionId);
        if (!version) {
            vscode.window.showErrorMessage('The selected version could not be found.');
            return false;
        }
        try {
            // Get the default value for this setting
            const defaultSettings = (0, utils_1.getDefaultVersionSettings)();
            const defaultValue = defaultSettings[settingKey];
            if (defaultValue === undefined) {
                vscode.window.showErrorMessage('Default value not found for this setting.');
                return false;
            }
            // Update the setting
            const updatedSettings = { ...version.settings, [settingKey]: defaultValue };
            version.updateSettings(updatedSettings);
            await this.saveVersions();
            vscode.commands.executeCommand('odoo.versionsChanged');
            vscode.window.showInformationMessage(`Setting "${settingKey}" reset to default value.`);
            return true;
        }
        catch (error) {
            console.error('Failed to set setting to default:', error);
            vscode.window.showErrorMessage('Failed to set setting to default value.');
            return false;
        }
    }
    /**
     * Set a specific setting's current value as the new default
     */
    async setSettingAsDefault(versionId, settingKey) {
        const version = this.versions.get(versionId);
        if (!version) {
            vscode.window.showErrorMessage('The selected version could not be found.');
            return false;
        }
        try {
            const currentValue = version.settings[settingKey];
            if (currentValue === undefined) {
                vscode.window.showErrorMessage('Setting value not found.');
                return false;
            }
            // Update the VS Code configuration
            const config = vscode.workspace.getConfiguration('odooDebugger.defaultVersion');
            await config.update(settingKey, currentValue, vscode.ConfigurationTarget.Workspace);
            vscode.window.showInformationMessage(`Setting "${settingKey}" value saved as new default.`);
            return true;
        }
        catch (error) {
            console.error('Unable to save this setting as the default:', error);
            vscode.window.showErrorMessage('Unable to save this setting as the default.');
            return false;
        }
    }
    /**
     * Set all settings to their default values for a version
     */
    async setAllSettingsToDefault(versionId) {
        const version = this.versions.get(versionId);
        if (!version) {
            vscode.window.showErrorMessage('The selected version could not be found.');
            return false;
        }
        try {
            // Get all default settings from VS Code configuration
            const defaultSettings = (0, utils_1.getDefaultVersionSettings)();
            // Only preserve version-specific settings that should be calculated
            // Port numbers should come from VS Code settings, not calculated
            defaultSettings.debuggerName = `odoo:${version.odooVersion}`;
            version.updateSettings(defaultSettings);
            await this.saveVersions();
            vscode.commands.executeCommand('odoo.versionsChanged');
            vscode.window.showInformationMessage(`All settings reset to default values for version "${version.name}".`);
            return true;
        }
        catch (error) {
            console.error('Failed to set all settings to default:', error);
            vscode.window.showErrorMessage('Unable to reset all settings to their default values.');
            return false;
        }
    }
    /**
     * Set all current settings as new defaults
     */
    async setAllSettingsAsDefault(versionId) {
        const version = this.versions.get(versionId);
        if (!version) {
            vscode.window.showErrorMessage('The selected version could not be found.');
            return false;
        }
        try {
            const config = vscode.workspace.getConfiguration('odooDebugger.defaultVersion');
            const settings = version.settings;
            // Update all settings in configuration
            for (const [key, value] of Object.entries(settings)) {
                await config.update(key, value, vscode.ConfigurationTarget.Workspace);
            }
            vscode.window.showInformationMessage(`All settings from version "${version.name}" saved as new defaults.`);
            return true;
        }
        catch (error) {
            console.error('Failed to set all settings as default:', error);
            vscode.window.showErrorMessage('Unable to save these settings as the new defaults.');
            return false;
        }
    }
}
exports.VersionsService = VersionsService;


/***/ }),
/* 19 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.VersionModel = void 0;
const crypto_1 = __webpack_require__(20);
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
        // Default settings with overrides
        this.settings = {
            debuggerName: `odoo:${odooVersion}`,
            debuggerVersion: "1.0.0",
            portNumber: this.getDefaultPort(odooVersion),
            shellPortNumber: this.getDefaultShellPort(odooVersion),
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
            preCheckoutCommands: [],
            postCheckoutCommands: [],
            ...settings
        };
    }
    getDefaultPort(odooVersion) {
        // Extract version number for port calculation
        const versionRegex = /(\d+)/;
        const versionMatch = versionRegex.exec(odooVersion);
        if (versionMatch) {
            const majorVersion = parseInt(versionMatch[1]);
            return 8000 + majorVersion; // e.g., 17.0 -> 8017, 16.0 -> 8016
        }
        return 8069; // Default Odoo port
    }
    getDefaultShellPort(odooVersion) {
        return this.getDefaultPort(odooVersion) - 3000; // e.g., 8017 -> 5017
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
/* 20 */
/***/ ((module) => {

module.exports = require("crypto");

/***/ }),
/* 21 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.SettingsStore = void 0;
const settings_1 = __webpack_require__(8);
const utils_1 = __webpack_require__(4);
const jsonc_parser_1 = __webpack_require__(10);
const fs_1 = __importDefault(__webpack_require__(5));
const path_1 = __importDefault(__webpack_require__(6));
class SettingsStore {
    /**
     * Helper function to read raw file content for JSON modification
     */
    static async readRawFileContent(fileName) {
        const workspacePath = (0, utils_1.getWorkspacePath)();
        if (!workspacePath) {
            return null;
        }
        try {
            const filePath = path_1.default.join(workspacePath, '.vscode', fileName);
            if (!fs_1.default.existsSync(filePath)) {
                return null;
            }
            return fs_1.default.readFileSync(filePath, 'utf-8');
        }
        catch (error) {
            (0, utils_1.showError)(`Failed to read raw content from ${fileName}: ${error}`);
            return null;
        }
    }
    static async get(fileName) {
        const data = await (0, utils_1.readFromFile)(fileName);
        if (!data) {
            throw new Error(`Error reading file: ${fileName}`);
        }
        return data;
    }
    static async saveWithComments(value, jsonPath, fileName, options = {}) {
        const workspacePath = (0, utils_1.getWorkspacePath)();
        if (!workspacePath) {
            return;
        }
        const rawData = await this.readRawFileContent(fileName);
        if (!rawData) {
            return;
        }
        const filePath = path_1.default.join(workspacePath, '.vscode', fileName);
        let edits = (0, jsonc_parser_1.modify)(rawData, jsonPath, value, options);
        const updatedJson = (0, jsonc_parser_1.applyEdits)(rawData, edits);
        fs_1.default.writeFileSync(filePath, updatedJson, 'utf8');
    }
    /**
     * Saves the entire data object to file
     */
    static async saveWithoutComments(data, fileName = 'odoo-debugger-data.json') {
        const workspacePath = (0, utils_1.getWorkspacePath)();
        if (!workspacePath) {
            return;
        }
        const filePath = path_1.default.join(workspacePath, '.vscode', fileName);
        const jsonString = JSON.stringify(data, null, 4);
        fs_1.default.writeFileSync(filePath, jsonString, 'utf8');
    }
    static async load() {
        const data = await (0, utils_1.readFromFile)('odoo-debugger-data.json') || {};
        return {
            settings: data.settings ? Object.assign(new settings_1.SettingsModel(), data.settings) : undefined,
            projects: data.projects || [],
            versions: data.versions || {},
            activeVersion: data.activeVersion || ''
        };
    }
    static async getSettings() {
        const data = await this.load();
        return data.settings || null;
    }
    /**
     * @deprecated Settings should only be managed through VersionsService now.
     * This method should not be used as it violates the versions-exclusive settings management.
     */
    static async updateSettings(partial) {
        const data = await this.load();
        const updated = Object.assign(new settings_1.SettingsModel(), data.settings, partial);
        data.settings = updated;
        // Even though this method sets settings, we must strip them to prevent persistence
        await this.saveWithoutComments((0, utils_1.stripSettings)(data));
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
            (0, utils_1.showError)('Unable to load projects, please create a project first');
            return null;
        }
        if (typeof projects !== 'object') {
            (0, utils_1.showError)('Unable to load projects.');
            return null;
        }
        const project = projects.find((p) => p.isSelected === true);
        if (!project) {
            (0, utils_1.showError)('Select a project before running this action.');
            return null;
        }
        return { data, project };
    }
}
exports.SettingsStore = SettingsStore;


/***/ }),
/* 22 */
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
/* 23 */
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
const crypto = __importStar(__webpack_require__(20));
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
    existing: 'Existing'
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
/* 24 */
/***/ ((module) => {

module.exports = require("os");

/***/ }),
/* 25 */
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
        { id: 'repo:created:oldest', label: 'Creation Date (Oldest first)', description: 'Uses filesystem creation time' }
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
/* 26 */
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
exports.createProject = createProject;
exports.selectProject = selectProject;
exports.getRepo = getRepo;
exports.getProjectName = getProjectName;
exports.deleteProject = deleteProject;
exports.duplicateProject = duplicateProject;
exports.editProjectSettings = editProjectSettings;
exports.exportProject = exportProject;
exports.importProject = importProject;
exports.quickProjectSearch = quickProjectSearch;
const vscode = __importStar(__webpack_require__(1));
const os = __importStar(__webpack_require__(24));
const project_1 = __webpack_require__(27);
const repo_1 = __webpack_require__(29);
const utils_1 = __webpack_require__(4);
const settingsStore_1 = __webpack_require__(21);
const versionsService_1 = __webpack_require__(18);
const crypto_1 = __webpack_require__(20);
const dbs_1 = __webpack_require__(16);
const sortOptions_1 = __webpack_require__(25);
class ProjectTreeProvider {
    context;
    sortPreferences;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    constructor(context, sortPreferences) {
        this.context = context;
        this.sortPreferences = sortPreferences;
        this.context = context;
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren(_element) {
        const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
        if (!data) {
            return [];
        }
        const projects = data.projects;
        if (!projects) {
            (0, utils_1.showError)('Unable to load projects, please create a project first');
            return [];
        }
        // Ensure all projects have UIDs (migration for existing data)
        const needsSave = await ensureProjectUIDs(data);
        if (needsSave) {
            await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
        }
        const sortId = this.sortPreferences.get('projectSelector', (0, sortOptions_1.getDefaultSortOption)('projectSelector'));
        const sortedProjects = [...projects].sort((a, b) => this.compareProjects(a, b, sortId));
        return sortedProjects.map(project => {
            const treeItem = new vscode.TreeItem((0, utils_1.addActiveIndicator)(project.name, project.isSelected));
            treeItem.id = project.uid; // Use UID instead of name for uniqueness
            let tooltip = `Project: ${project.name}`;
            treeItem.tooltip = tooltip;
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
    // If the project has a database with a version, check if branches need switching
    if (db && db.odooVersion && db.odooVersion !== '') {
        // Get settings from active version
        const versionsService = versionsService_1.VersionsService.getInstance();
        const settings = await versionsService.getActiveVersionSettings();
        const currentOdooBranch = await (0, utils_1.getGitBranch)(settings.odooPath);
        const currentEnterpriseBranch = await (0, utils_1.getGitBranch)(settings.enterprisePath);
        const currentDesignThemesBranch = await (0, utils_1.getGitBranch)(settings.designThemesPath || './design-themes');
        const shouldSwitch = await promptBranchSwitch(db.odooVersion, {
            odoo: currentOdooBranch,
            enterprise: currentEnterpriseBranch,
            designThemes: currentDesignThemesBranch
        });
        if (shouldSwitch) {
            await (0, dbs_1.checkoutBranch)(settings, db.odooVersion);
        }
    }
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
async function promptBranchSwitch(targetVersion, currentBranches) {
    const mismatchedRepos = [];
    if (currentBranches.odoo !== targetVersion) {
        mismatchedRepos.push(`Odoo (currently: ${currentBranches.odoo || 'unknown'})`);
    }
    if (currentBranches.enterprise !== targetVersion) {
        mismatchedRepos.push(`Enterprise (currently: ${currentBranches.enterprise || 'unknown'})`);
    }
    if (currentBranches.designThemes !== targetVersion) {
        mismatchedRepos.push(`Design Themes (currently: ${currentBranches.designThemes || 'unknown'})`);
    }
    if (mismatchedRepos.length === 0) {
        return false; // No switch needed
    }
    const message = `Database requires Odoo version ${targetVersion}, but the following repositories are on different branches:\n\n${mismatchedRepos.join('\n')}\n\nWould you like to switch all repositories to version ${targetVersion}?`;
    const choice = await vscode.window.showWarningMessage(message, { modal: false }, 'Switch Branches', 'Keep Current Branches');
    return choice === 'Switch Branches';
}
async function selectProject(projectUid) {
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    const projects = data.projects;
    if (!projects) {
        (0, utils_1.showError)('Unable to load projects.');
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
        // Check if the project has a selected database with a specific version
        const selectedDb = selectedProject.dbs?.find((db) => db.isSelected);
        if (selectedDb) {
            await handleDatabaseVersionSwitchForProject(selectedDb);
        }
        (0, utils_1.showInfo)(`Project switched to: ${selectedProject.name}`);
        // Force a small delay and refresh to ensure UI is updated
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    else {
        (0, utils_1.showError)('The selected project could not be found.');
    }
}
async function handleDatabaseVersionSwitchForProject(database) {
    const versionsService = versionsService_1.VersionsService.getInstance();
    await versionsService.initialize();
    const settings = await versionsService.getActiveVersionSettings();
    // Check if database has a version associated with it
    if (database.versionId) {
        const dbVersion = versionsService.getVersion(database.versionId);
        if (dbVersion) {
            // Silently activate the version for project switching (no user prompt)
            await versionsService.setActiveVersion(dbVersion.id);
            const currentOdooBranch = await (0, utils_1.getGitBranch)(settings.odooPath);
            // Check if branch switching is needed
            if (currentOdooBranch !== dbVersion.odooVersion) {
                const shouldSwitch = await promptBranchSwitch(dbVersion.odooVersion, {
                    odoo: currentOdooBranch,
                    enterprise: await (0, utils_1.getGitBranch)(settings.enterprisePath),
                    designThemes: await (0, utils_1.getGitBranch)(settings.designThemesPath || './design-themes')
                });
                if (shouldSwitch) {
                    await (0, dbs_1.checkoutBranch)(settings, dbVersion.odooVersion);
                }
            }
            return;
        }
    }
    // Fallback to old behavior for databases without version
    if (database.odooVersion && database.odooVersion !== '') {
        const currentOdooBranch = await (0, utils_1.getGitBranch)(settings.odooPath);
        const currentEnterpriseBranch = await (0, utils_1.getGitBranch)(settings.enterprisePath);
        const currentDesignThemesBranch = await (0, utils_1.getGitBranch)(settings.designThemesPath || './design-themes');
        const shouldSwitch = await promptBranchSwitch(database.odooVersion, {
            odoo: currentOdooBranch,
            enterprise: currentEnterpriseBranch,
            designThemes: currentDesignThemesBranch
        });
        if (shouldSwitch) {
            await (0, dbs_1.checkoutBranch)(settings, database.odooVersion);
        }
    }
}
async function getRepo(targetPath, searchFilter) {
    const devsRepos = (0, utils_1.findRepositories)(targetPath);
    if (devsRepos.length === 0) {
        (0, utils_1.showInfo)('No repositories found in the custom-addons path.');
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
        (0, utils_1.showError)("Select at least one folder to continue.");
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
        (0, utils_1.showError)('Enter a project name to continue.');
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
        (0, utils_1.showError)('The project data is invalid for deletion');
        return;
    }
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    const projects = data.projects;
    if (!projects) {
        (0, utils_1.showError)('Unable to load projects.');
        return;
    }
    // Find the project index in the array by UID
    const projectIndex = projects.findIndex((p) => p.uid === projectUid);
    if (projectIndex !== -1) {
        const projectToDelete = projects[projectIndex];
        // Ask for confirmation
        const confirm = await vscode.window.showWarningMessage(`Are you sure you want to delete the project "${projectToDelete.name}"?`, { modal: true }, 'Delete');
        if (confirm !== 'Delete') {
            return; // User cancelled
        }
        // Remove the project from the array and save the updated data
        data.projects.splice(projectIndex, 1);
        await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
        (0, utils_1.showInfo)(`Project "${projectToDelete.name}" deleted successfully`);
        // If the deleted project was selected and there are other projects, select the first one
        if (projectToDelete.isSelected && data.projects.length > 0) {
            // Use the command to properly select the first project
            await vscode.commands.executeCommand('projectSelector.selectProject', data.projects[0].uid);
        }
    }
    else {
        (0, utils_1.showError)('The selected project could not be found. It may have already been deleted.');
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
        (0, utils_1.showError)('The project data is invalid.');
        return;
    }
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    const projects = data.projects;
    if (!projects) {
        (0, utils_1.showError)('Unable to load projects.');
        return;
    }
    const projectIndex = projects.findIndex((p) => p.uid === projectUid);
    if (projectIndex === -1) {
        (0, utils_1.showError)('The selected project could not be found.');
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
        (0, utils_1.showError)('A project with this name already exists. Choose a different name.');
        return;
    }
    // Deselect all projects
    projects.forEach(p => p.isSelected = false);
    // Create duplicate project
    const duplicateProject = new project_1.ProjectModel(duplicateName, new Date(), [...sourceProject.dbs], // Copy databases array
    [...sourceProject.repos], // Copy repositories array
    true, // Set as selected
    (0, crypto_1.randomUUID)(), // New unique ID
    [...(sourceProject.includedPsaeInternalPaths || [])] // Copy included psae-internal paths
    );
    projects.push(duplicateProject);
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
    (0, utils_1.showInfo)(`Project "${duplicateName}" created as a duplicate of "${sourceProject.name}"`);
}
async function editProjectSettings(event) {
    // Get project UID from event
    let projectUid;
    console.log('editProjectSettings called with event:', event);
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
        console.error('The project data is invalid for editing settings:', event);
        (0, utils_1.showError)('The project data is invalid for editing settings. Please try clicking on the project first to select it, then try again.');
        return;
    }
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    const projects = data.projects;
    if (!projects) {
        (0, utils_1.showError)('Unable to load projects.');
        return;
    }
    const projectIndex = projects.findIndex((p) => p.uid === projectUid);
    if (projectIndex === -1) {
        (0, utils_1.showError)('The selected project could not be found.');
        return;
    }
    const project = projects[projectIndex];
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
        (0, utils_1.showInfo)(`Project renamed from "${oldName}" to "${project.name}"`);
    }
}
async function viewProjectInfo(project) {
    const dbCount = project.dbs?.length || 0;
    const selectedDb = project.dbs?.find((db) => db.isSelected);
    let infoMessage = `Project Information

Name: ${project.name}
Created: ${new Date(project.createdAt).toLocaleString()}

Repositories (${project.repos.length}):
${project.repos.map(r => `  • ${r.name}`).join('\n')}

Databases: ${dbCount}${selectedDb ? `
Active Database: ${selectedDb.name}` : `
No active database`}`;
    await vscode.window.showInformationMessage(infoMessage, { modal: true }, 'OK');
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
            (0, utils_1.showError)('The project data is invalid.');
            return;
        }
        const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
        const projects = data.projects;
        if (!projects) {
            (0, utils_1.showError)('No projects are configured.');
            return;
        }
        const project = projects.find(p => p.uid === projectUid);
        if (!project) {
            (0, utils_1.showError)('The selected project could not be found.');
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
            exportedAt: new Date().toISOString(),
            exportVersion: '1.0'
        };
        // Write to file
        const content = JSON.stringify(exportData, null, 2);
        await vscode.workspace.fs.writeFile(saveUri, Buffer.from(content, 'utf8'));
        const action = await vscode.window.showInformationMessage(`Project "${project.name}" exported successfully!`, 'Open Export Location', 'Import Instructions');
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
            await vscode.window.showInformationMessage(instructions, { modal: true });
        }
    }
    catch (error) {
        console.error('Error exporting project:', error);
        vscode.window.showErrorMessage(`Failed to export project: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
            (0, utils_1.showError)('The selected file is not a valid project export.');
            return;
        }
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
            const useNewName = await vscode.window.showWarningMessage(`A project named "${importData.name}" already exists. Import as "${projectName}"?`, 'Yes, Import with New Name', 'Cancel');
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
        (0, crypto_1.randomUUID)(), [] // No included psae-internal paths on import
        );
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
        await vscode.window.showInformationMessage(message, 'OK');
    }
    catch (error) {
        console.error('Error importing project:', error);
        if (error instanceof SyntaxError) {
            (0, utils_1.showError)('The selected file is not valid JSON.');
        }
        else {
            (0, utils_1.showError)(`Failed to import project: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
}
async function quickProjectSearch() {
    try {
        const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
        const projects = data.projects;
        if (!projects || projects.length === 0) {
            (0, utils_1.showError)('No projects are configured. Create a project first.');
            return;
        }
        // Create quick pick items with project information
        const quickPickItems = projects.map(project => {
            const selectedDb = project.dbs?.find((db) => db.isSelected);
            const repoCount = project.repos.length;
            const dbInfo = selectedDb ? ` | DB: ${selectedDb.name}` : ' | No DB';
            return {
                label: `${project.isSelected ? '$(arrow-right) ' : ''}${project.name}`,
                description: `${repoCount} repo${repoCount === 1 ? '' : 's'}${dbInfo}`,
                detail: `Created: ${new Date(project.createdAt).toLocaleDateString()} | Repositories: ${project.repos.map(r => r.name).join(', ')}`,
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
        console.error('Error in quick project search:', error);
        (0, utils_1.showError)('Unable to load projects for search.');
    }
}


/***/ }),
/* 27 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ProjectModel = void 0;
const testing_1 = __webpack_require__(28);
const crypto_1 = __webpack_require__(20);
class ProjectModel {
    name; // project sh name
    createdAt;
    dbs;
    repos = [];
    isSelected = false;
    uid; // unique identifier for the project
    includedPsaeInternalPaths = []; // Manually included psae-internal paths
    testingConfig; // Testing configuration
    constructor(name, createdAt, dbs = [], repos = [], isSelected = false, uid = (0, crypto_1.randomUUID)(), includedPsaeInternalPaths = [], testingConfig = new testing_1.TestingConfigModel()) {
        this.name = name;
        this.dbs = dbs;
        this.repos = repos;
        this.createdAt = createdAt;
        this.isSelected = isSelected;
        this.uid = uid;
        this.includedPsaeInternalPaths = includedPsaeInternalPaths;
        this.testingConfig = testingConfig;
    }
}
exports.ProjectModel = ProjectModel;


/***/ }),
/* 28 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.TestingConfigModel = void 0;
exports.ensureTestingConfigModel = ensureTestingConfigModel;
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
        console.warn('Error converting testing config, creating new instance:', error);
        return new TestingConfigModel();
    }
}


/***/ }),
/* 29 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.RepoModel = void 0;
class RepoModel {
    name;
    path;
    isSelected = false;
    addedAt;
    constructor(name, path, isSelected = false, addedAt) {
        this.name = name;
        this.path = path;
        this.isSelected = isSelected;
        this.addedAt = addedAt ?? new Date().toISOString();
    }
}
exports.RepoModel = RepoModel;


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
exports.RepoTreeProvider = void 0;
exports.selectRepo = selectRepo;
const repo_1 = __webpack_require__(29);
const vscode = __importStar(__webpack_require__(1));
const utils_1 = __webpack_require__(4);
const settingsStore_1 = __webpack_require__(21);
const versionsService_1 = __webpack_require__(18);
const path = __importStar(__webpack_require__(6));
const fs = __importStar(__webpack_require__(5));
const child_process_1 = __webpack_require__(7);
const sortOptions_1 = __webpack_require__(25);
class RepoTreeProvider {
    context;
    sortPreferences;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    constructor(context, sortPreferences) {
        this.context = context;
        this.sortPreferences = sortPreferences;
        this.context = context;
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren(_element) {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            return [];
        }
        const { data, project } = result;
        const workspacePath = (0, utils_1.getWorkspacePath)();
        if (!workspacePath) {
            return [];
        }
        const repos = project.repos;
        // Get settings from active version
        const versionsService = versionsService_1.VersionsService.getInstance();
        const settings = await versionsService.getActiveVersionSettings();
        const customAddonsPath = (0, utils_1.normalizePath)(settings.customAddonsPath);
        // Check if path exists first
        if (!fs.existsSync(customAddonsPath)) {
            (0, utils_1.showError)(`Path does not exist: ${customAddonsPath}`);
            return [];
        }
        const devsRepos = (0, utils_1.findRepositories)(customAddonsPath);
        if (devsRepos.length === 0) {
            (0, utils_1.showInfo)('No repositories found in the custom addons directory.');
            return [];
        }
        if (!repos) {
            (0, utils_1.showError)('No modules are configured for this database.');
            return [];
        }
        const repoEntries = devsRepos.map(repo => {
            const existingRepo = repos.find(r => r.name === repo.name);
            let branch = null;
            const gitPath = path.join(repo.path, '.git');
            if (fs.existsSync(gitPath)) {
                try {
                    branch = (0, child_process_1.execSync)('git rev-parse --abbrev-ref HEAD', { cwd: repo.path })
                        .toString()
                        .trim();
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
                repoModel: existingRepo,
                fsCreatedAt
            };
        });
        const sortId = this.sortPreferences.get('repoSelector', (0, sortOptions_1.getDefaultSortOption)('repoSelector'));
        repoEntries.sort((a, b) => this.compareRepos(a, b, sortId));
        return repoEntries.map(entry => {
            const repoIcon = entry.isSelected ? "☑️" : "⬜️";
            const treeItem = new vscode.TreeItem(`${repoIcon} ${entry.name}`);
            treeItem.tooltip = `Repo: ${entry.name}\nPath: ${entry.path}`;
            treeItem.id = entry.path;
            treeItem.description = entry.branch ?? '';
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
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
}


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
exports.ProjectReposProvider = void 0;
exports.revealProjectRepo = revealProjectRepo;
const vscode = __importStar(__webpack_require__(1));
const fs = __importStar(__webpack_require__(32));
const path = __importStar(__webpack_require__(3));
const settingsStore_1 = __webpack_require__(21);
const utils_1 = __webpack_require__(4);
const sortOptions_1 = __webpack_require__(25);
class ProjectRepoItem extends vscode.TreeItem {
    metadata;
    constructor(metadata) {
        super(ProjectRepoItem.getLabel(metadata), ProjectRepoItem.getCollapsibleState(metadata));
        this.metadata = metadata;
        this.contextValue = ProjectRepoItem.getContext(metadata);
        this.tooltip = ProjectRepoItem.getTooltip(metadata);
        this.resourceUri = ProjectRepoItem.getResource(metadata);
        this.command = ProjectRepoItem.getCommand(metadata);
        this.description = ProjectRepoItem.getDescription(metadata);
    }
    static getLabel(metadata) {
        switch (metadata.kind) {
            case 'info':
                return metadata.message;
            case 'repo':
                return metadata.repo.name;
            case 'folder':
            case 'file':
                return path.basename(metadata.fsPath);
            default:
                return '';
        }
    }
    static getDescription(metadata) {
        if (metadata.kind === 'repo') {
            return metadata.repo.path;
        }
        return undefined;
    }
    static getCollapsibleState(metadata) {
        if (metadata.kind === 'info' || metadata.kind === 'file') {
            return vscode.TreeItemCollapsibleState.None;
        }
        return vscode.TreeItemCollapsibleState.Collapsed;
    }
    static getTooltip(metadata) {
        if (metadata.kind === 'repo') {
            return metadata.repo.path;
        }
        if (metadata.kind === 'folder' || metadata.kind === 'file') {
            return metadata.fsPath;
        }
        return undefined;
    }
    static getResource(metadata) {
        if (metadata.kind === 'repo') {
            return vscode.Uri.file(metadata.repo.path);
        }
        if (metadata.kind === 'folder' || metadata.kind === 'file') {
            return vscode.Uri.file(metadata.fsPath);
        }
        return undefined;
    }
    static getCommand(metadata) {
        if (metadata.kind === 'file') {
            return {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [vscode.Uri.file(metadata.fsPath)]
            };
        }
        return undefined;
    }
    static getContext(metadata) {
        switch (metadata.kind) {
            case 'info':
                return 'projectReposInfo';
            case 'repo':
                return 'projectRepoRoot';
            case 'folder':
                return 'projectRepoFolder';
            case 'file':
                return 'projectRepoFile';
            default:
                return undefined;
        }
    }
}
class ProjectReposProvider {
    sortPreferences;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    constructor(sortPreferences) {
        this.sortPreferences = sortPreferences;
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren(element) {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            return [new ProjectRepoItem({ kind: 'info', message: 'Select a project to see its repositories.' })];
        }
        const repos = result.project.repos ?? [];
        if (!repos.length) {
            return [new ProjectRepoItem({ kind: 'info', message: 'No repositories selected for this project.' })];
        }
        if (!element) {
            const sortId = this.sortPreferences.get('projectRepos', (0, sortOptions_1.getDefaultSortOption)('projectRepos'));
            const sortedRepos = [...repos].sort((a, b) => this.compareRepos(a, b, sortId));
            return sortedRepos.map(repo => new ProjectRepoItem({ kind: 'repo', repo }));
        }
        if (element.metadata.kind === 'repo') {
            return this.getDirectoryEntries(element.metadata.repo.path, element.metadata.repo);
        }
        if (element.metadata.kind === 'folder') {
            return this.getDirectoryEntries(element.metadata.fsPath, element.metadata.repo);
        }
        return [];
    }
    async getDirectoryEntries(dirPath, repo) {
        try {
            const dirents = await fs.readdir(dirPath, { withFileTypes: true });
            const sorted = dirents.sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory()) {
                    return -1;
                }
                if (!a.isDirectory() && b.isDirectory()) {
                    return 1;
                }
                return a.name.localeCompare(b.name);
            });
            return sorted.map(dirent => {
                const childPath = path.join(dirPath, dirent.name);
                if (dirent.isDirectory()) {
                    return new ProjectRepoItem({ kind: 'folder', repo, fsPath: childPath });
                }
                return new ProjectRepoItem({ kind: 'file', repo, fsPath: childPath });
            });
        }
        catch (error) {
            return [
                new ProjectRepoItem({
                    kind: 'info',
                    message: `Unable to read folder: ${error?.message ?? error}`
                })
            ];
        }
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
}
exports.ProjectReposProvider = ProjectReposProvider;
async function revealProjectRepo(repo) {
    try {
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(repo.path));
    }
    catch (error) {
        (0, utils_1.showError)(`Unable to reveal repository: ${error?.message ?? error}`);
    }
}


/***/ }),
/* 32 */
/***/ ((module) => {

module.exports = require("node:fs/promises");

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
exports.ModuleTreeProvider = void 0;
exports.selectModule = selectModule;
exports.setModuleToInstall = setModuleToInstall;
exports.setModuleToUpgrade = setModuleToUpgrade;
exports.clearModuleState = clearModuleState;
exports.togglePsaeInternalModule = togglePsaeInternalModule;
exports.updateAllModules = updateAllModules;
exports.updateInstalledModules = updateInstalledModules;
exports.installAllModules = installAllModules;
exports.clearAllModuleSelections = clearAllModuleSelections;
exports.viewInstalledModules = viewInstalledModules;
const module_1 = __webpack_require__(22);
const vscode = __importStar(__webpack_require__(1));
const utils_1 = __webpack_require__(4);
function collectModuleDiscovery(project) {
    const manualIncludes = (project.includedPsaeInternalPaths ?? []).filter(entry => !entry.startsWith('!'));
    return (0, utils_1.discoverModulesInRepos)(project.repos, { manualIncludePaths: manualIncludes });
}
const settingsStore_1 = __webpack_require__(21);
const database_1 = __webpack_require__(34);
const sortOptions_1 = __webpack_require__(25);
class ModuleTreeProvider {
    context;
    sortPreferences;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    constructor(context, sortPreferences) {
        this.context = context;
        this.sortPreferences = sortPreferences;
        this.context = context;
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren(_element) {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            return [(0, utils_1.createInfoTreeItem)('Select a project to manage modules.')];
        }
        const { project } = result;
        const db = project.dbs.find((db) => db.isSelected === true);
        if (!db) {
            return [(0, utils_1.createInfoTreeItem)('Select a database to view modules.')];
        }
        const modules = db.modules;
        if (!modules) {
            return [(0, utils_1.createInfoTreeItem)('No modules configured for this database.')];
        }
        // Check if testing is enabled
        const isTestingEnabled = project.testingConfig && project.testingConfig.isEnabled;
        // Get modules that are installed or marked for upgrade in the database
        const installedModules = await (0, database_1.getInstalledModules)(db.id);
        const installedModuleNames = new Set(installedModules.map((m) => m.name));
        const { modules: allModules, psaeDirectories } = collectModuleDiscovery(project);
        let treeItems = [];
        // ALWAYS add testing mode notification first when testing is enabled
        if (isTestingEnabled) {
            const testingModeItem = new vscode.TreeItem('⚠️ Module Management Disabled (Testing Mode)', vscode.TreeItemCollapsibleState.None);
            testingModeItem.tooltip = 'Testing is enabled. Disable testing to manage modules again.';
            testingModeItem.description = 'Go to Testing tab to disable';
            treeItems.push(testingModeItem);
        }
        // Add psae-internal directories as special meta-modules
        for (const psaeDir of psaeDirectories) {
            const psaeInternalModules = allModules.filter(m => m.isPsaeInternal && m.psInternalDirPath === psaeDir.path);
            // Check if any modules from this ps*-internal are selected OR installed in DB
            const hasSelectedModules = psaeInternalModules.some(m => modules.some(dbModule => dbModule.name === m.name && (dbModule.state === 'install' || dbModule.state === 'upgrade')));
            // Check if any modules from this ps*-internal directory are installed/to upgrade in DB
            const hasDbModules = psaeInternalModules.some(m => installedModuleNames.has(m.name));
            const isManuallyIncluded = project.includedPsaeInternalPaths?.includes(psaeDir.path) || false;
            // Auto-include if has selected OR database modules
            // If not manually set: auto-include if has selected OR database modules
            const shouldBeIncluded = isManuallyIncluded || (!project.includedPsaeInternalPaths?.includes(`!${psaeDir.path}`) && (hasSelectedModules || hasDbModules));
            // Determine icon and tooltip based on status
            let psaeIcon;
            let psaeTooltip;
            if (shouldBeIncluded) {
                psaeIcon = '📦'; // Package icon when included in addons path
                const reasons = [];
                if (isManuallyIncluded) {
                    reasons.push('manually included');
                }
                if (hasSelectedModules) {
                    reasons.push('has selected modules');
                }
                if (hasDbModules) {
                    reasons.push('has database modules');
                }
                psaeTooltip = `${psaeDir.dirName}: Included (${reasons.join(' + ')})\nRepo: ${psaeDir.repoName}\nPath: ${psaeDir.path}\nClick to exclude from addons path`;
            }
            else {
                psaeIcon = '📋'; // Clipboard icon when not included
                const reason = project.includedPsaeInternalPaths?.includes(`!${psaeDir.path}`) ? 'manually excluded' : 'no modules';
                psaeTooltip = `${psaeDir.dirName}: Not included (${reason})\nRepo: ${psaeDir.repoName}\nPath: ${psaeDir.path}\nClick to include in addons path`;
            }
            treeItems.push({
                label: `${psaeIcon} ${psaeDir.dirName}`,
                tooltip: isTestingEnabled
                    ? `${psaeTooltip}\n⚠️ Module management disabled while testing is enabled`
                    : psaeTooltip,
                description: `${psaeDir.repoName} (${psaeInternalModules.length} modules)`,
                command: isTestingEnabled ? undefined : {
                    command: 'moduleSelector.togglePsaeInternalModule',
                    title: `Toggle ${psaeDir.dirName}`,
                    arguments: [{
                            path: psaeDir.path,
                            repoName: psaeDir.repoName,
                            dirName: psaeDir.dirName,
                            hasSelectedModules: hasSelectedModules,
                            hasDbModules: hasDbModules,
                            isManuallyIncluded: isManuallyIncluded,
                            shouldBeIncluded: shouldBeIncluded,
                            modules: psaeInternalModules
                        }]
                }
            });
        }
        // Add regular modules (excluding ps*-internal from the name display since we show them separately)
        for (const module of allModules.filter(m => !m.name.match(/^ps[a-z]*-internal$/i))) {
            const repoPath = module.isPsaeInternal ? `${module.repoName}/${module.psInternalDirName}` : module.repoName;
            const existingModule = modules.find(mod => mod.name === module.name);
            const isInstalledInDb = installedModuleNames.has(module.name);
            if (existingModule) {
                // Update the isInstalled flag based on database state
                existingModule.isInstalled = isInstalledInDb;
                let moduleIcon;
                switch (existingModule.state) {
                    case 'install':
                        moduleIcon = '🟢';
                        break;
                    case 'upgrade':
                        moduleIcon = '🟡';
                        break;
                    default:
                        moduleIcon = existingModule.isInstalled ? '⚫' : '⚪'; // Black circle for installed but not managed
                        break;
                }
                // Create module tooltip with consistent formatting
                const moduleTooltipDetails = [];
                moduleTooltipDetails.push(`**Module:** ${module.name}`);
                moduleTooltipDetails.push(`**State:** ${existingModule.state}`);
                moduleTooltipDetails.push(`**Source:** ${repoPath}`);
                moduleTooltipDetails.push(`**Path:** ${module.path}`);
                const managedModuleItem = {
                    label: `${moduleIcon} ${module.name}`,
                    tooltip: new vscode.MarkdownString(moduleTooltipDetails.join('\n\n')),
                    description: repoPath,
                    contextValue: 'module',
                    command: isTestingEnabled ? undefined : {
                        command: 'moduleSelector.select',
                        title: 'Select Module',
                        arguments: [{ name: module.name, path: module.path, state: existingModule.state, repoName: module.repoName, isPsaeInternal: module.isPsaeInternal, isInstalled: existingModule.isInstalled }]
                    }
                };
                // Store module data for context menu commands
                managedModuleItem.moduleData = {
                    name: module.name,
                    path: module.path,
                    state: existingModule.state,
                    repoName: module.repoName,
                    isPsaeInternal: module.isPsaeInternal,
                    isInstalled: existingModule.isInstalled
                };
                treeItems.push(managedModuleItem);
            }
            else {
                // Module not in our managed list
                const moduleIcon = isInstalledInDb ? '⚫' : '⚪'; // Black circle for installed, white for not installed
                const moduleState = isInstalledInDb ? 'Installed' : 'none';
                // Create module tooltip with consistent formatting
                const moduleTooltipDetails = [];
                moduleTooltipDetails.push(`**Module:** ${module.name}`);
                moduleTooltipDetails.push(`**State:** ${moduleState}`);
                moduleTooltipDetails.push(`**Source:** ${repoPath}`);
                moduleTooltipDetails.push(`**Path:** ${module.path}`);
                const unmanagedModuleItem = {
                    label: `${moduleIcon} ${module.name}`,
                    tooltip: new vscode.MarkdownString(moduleTooltipDetails.join('\n\n')),
                    description: repoPath,
                    contextValue: 'module',
                    command: isTestingEnabled ? undefined : {
                        command: 'moduleSelector.select',
                        title: 'Select Module',
                        arguments: [{ name: module.name, path: module.path, state: 'none', repoName: module.repoName, isPsaeInternal: module.isPsaeInternal, isInstalled: isInstalledInDb }]
                    }
                };
                // Store module data for context menu commands
                unmanagedModuleItem.moduleData = {
                    name: module.name,
                    path: module.path,
                    state: 'none',
                    repoName: module.repoName,
                    isPsaeInternal: module.isPsaeInternal,
                    isInstalled: isInstalledInDb
                };
                treeItems.push(unmanagedModuleItem);
            }
        }
        const sortId = this.sortPreferences.get('moduleSelector', (0, sortOptions_1.getDefaultSortOption)('moduleSelector'));
        return this.sortModuleItems(treeItems, sortId);
    }
    sortModuleItems(items, sortId) {
        const testingItems = [];
        const psaeItems = [];
        const moduleItems = [];
        const otherItems = [];
        for (const item of items) {
            if (typeof item.label === 'string' && item.label.includes('⚠️ Module Management Disabled (Testing Mode)')) {
                testingItems.push(item);
            }
            else if ((item.command?.command === 'moduleSelector.togglePsaeInternalModule') || (typeof item.label === 'string' && /ps[a-z]*-internal/i.test(item.label))) {
                psaeItems.push(item);
            }
            else if (item.moduleData) {
                moduleItems.push(item);
            }
            else {
                otherItems.push(item);
            }
        }
        moduleItems.sort((a, b) => this.compareModules(a, b, sortId));
        return [...testingItems, ...psaeItems, ...moduleItems, ...otherItems];
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
        (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        (0, utils_1.showError)('Disable testing mode before changing module selections.');
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
        (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    // Check if testing is enabled
    if (project.testingConfig && project.testingConfig.isEnabled) {
        (0, utils_1.showError)('Disable testing mode before changing module selections.');
        return;
    }
    const moduleExistsInDb = db.modules.find(mod => mod.name === moduleData.name);
    if (!moduleExistsInDb) {
        db.modules.push(new module_1.ModuleModel(moduleData.name, 'install'));
        (0, utils_1.showAutoInfo)(`Module "${moduleData.name}" set to install`, 2000);
    }
    else {
        moduleExistsInDb.state = 'install';
        (0, utils_1.showAutoInfo)(`Module "${moduleData.name}" state changed to install`, 2000);
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
        return;
    }
    const { data, project } = result;
    const db = project.dbs.find((db) => db.isSelected === true);
    if (!db) {
        (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    // Check if testing is enabled
    if (project.testingConfig && project.testingConfig.isEnabled) {
        (0, utils_1.showError)('Disable testing mode before changing module selections.');
        return;
    }
    const moduleExistsInDb = db.modules.find(mod => mod.name === moduleData.name);
    if (!moduleExistsInDb) {
        db.modules.push(new module_1.ModuleModel(moduleData.name, 'upgrade'));
        (0, utils_1.showAutoInfo)(`Module "${moduleData.name}" set to upgrade`, 2000);
    }
    else {
        moduleExistsInDb.state = 'upgrade';
        (0, utils_1.showAutoInfo)(`Module "${moduleData.name}" state changed to upgrade`, 2000);
    }
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
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
        (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    // Check if testing is enabled
    if (project.testingConfig && project.testingConfig.isEnabled) {
        (0, utils_1.showError)('Disable testing mode before changing module selections.');
        return;
    }
    const moduleExistsInDb = db.modules.find(mod => mod.name === moduleData.name);
    if (moduleExistsInDb) {
        db.modules = db.modules.filter(mod => mod.name !== moduleData.name);
        (0, utils_1.showAutoInfo)(`Module "${moduleData.name}" state cleared`, 2000);
    }
    else {
        (0, utils_1.showAutoInfo)(`Module "${moduleData.name}" was already not managed`, 1500);
    }
    await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
}
async function togglePsaeInternalModule(event) {
    const { path: psaeInternalPath, repoName, dirName, hasSelectedModules, hasInstalledModules, isManuallyIncluded, shouldBeIncluded, modules: psaeModules } = event;
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    const db = project.dbs.find((db) => db.isSelected === true);
    if (!db) {
        (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        (0, utils_1.showError)('Disable testing mode before changing module selections.');
        return;
    }
    // Initialize includedPsaeInternalPaths if it doesn't exist
    if (!project.includedPsaeInternalPaths) {
        project.includedPsaeInternalPaths = [];
    }
    const excludePath = `!${psaeInternalPath}`;
    const isManuallyExcluded = project.includedPsaeInternalPaths.includes(excludePath);
    if (shouldBeIncluded) {
        if (isManuallyIncluded) {
            // Currently manually included - remove manual inclusion (may still be auto-included)
            const pathIndex = project.includedPsaeInternalPaths.indexOf(psaeInternalPath);
            if (pathIndex > -1) {
                project.includedPsaeInternalPaths.splice(pathIndex, 1);
            }
            // If would still be auto-included, add manual exclusion and remove selected modules
            if (hasSelectedModules || hasInstalledModules) {
                project.includedPsaeInternalPaths.push(excludePath);
                // Remove selected modules from this psae-internal directory
                const moduleNamesToRemove = psaeModules.map((m) => m.name);
                db.modules = db.modules.filter(dbModule => !moduleNamesToRemove.includes(dbModule.name));
                await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
                (0, utils_1.showInfo)(`Manually excluded ${dirName} (${repoName}) and removed selected modules from addons path`);
            }
            else {
                await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
                (0, utils_1.showInfo)(`Removed manual inclusion of ${dirName} (${repoName})`);
            }
        }
        else {
            // Currently auto-included - add manual exclusion to override and remove selected modules
            project.includedPsaeInternalPaths.push(excludePath);
            // Remove selected modules from this psae-internal directory
            const moduleNamesToRemove = psaeModules.map((m) => m.name);
            db.modules = db.modules.filter(dbModule => !moduleNamesToRemove.includes(dbModule.name));
            await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
            (0, utils_1.showInfo)(`Manually excluded ${dirName} (${repoName}) and removed selected modules from addons path`);
        }
    }
    else {
        if (isManuallyExcluded) {
            // Currently manually excluded - remove exclusion (may auto-include)
            const pathIndex = project.includedPsaeInternalPaths.indexOf(excludePath);
            if (pathIndex > -1) {
                project.includedPsaeInternalPaths.splice(pathIndex, 1);
            }
            await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
            if (hasSelectedModules || hasInstalledModules) {
                (0, utils_1.showInfo)(`Removed manual exclusion of ${dirName} (${repoName}). Now auto-included due to modules.`);
            }
            else {
                (0, utils_1.showInfo)(`Removed manual exclusion of ${dirName} (${repoName})`);
            }
        }
        else {
            // Currently not included - add manual inclusion
            project.includedPsaeInternalPaths.push(psaeInternalPath);
            await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data));
            (0, utils_1.showInfo)(`Manually included ${dirName} (${repoName}) in addons path`);
        }
    }
}
async function updateAllModules() {
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        (0, utils_1.showError)('Select a project before running this action.');
        return;
    }
    const { data, project } = result;
    const db = project.dbs.find((db) => db.isSelected === true);
    if (!db) {
        (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        (0, utils_1.showError)('Disable testing mode before changing module selections.');
        return;
    }
    const { modules: allModules } = collectModuleDiscovery(project);
    const availableModules = allModules.filter(m => !m.name.match(/^ps[a-z]*-internal$/i));
    if (availableModules.length === 0) {
        (0, utils_1.showInfo)('No modules are available to update.');
        return;
    }
    // Confirm action
    const confirm = await vscode.window.showWarningMessage(`Are you sure you want to set all ${availableModules.length} available modules to "upgrade" state regardless of their current state?`, { modal: true }, 'Update All');
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
        (0, utils_1.showError)('Select a project before running this action.');
        return;
    }
    const { data, project } = result;
    const db = project.dbs.find((db) => db.isSelected === true);
    if (!db) {
        (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        (0, utils_1.showError)('Disable testing mode before changing module selections.');
        return;
    }
    if (!db.modules || db.modules.length === 0) {
        (0, utils_1.showInfo)('No modules are configured for this database to update');
        return;
    }
    const installedModules = db.modules.filter(module => module.state === 'install');
    if (installedModules.length === 0) {
        (0, utils_1.showInfo)('No modules are currently marked with the "install" state.');
        return;
    }
    // Confirm action
    const confirm = await vscode.window.showWarningMessage(`Are you sure you want to set all ${installedModules.length} modules with "install" state to "upgrade" state?`, { modal: true }, 'Update Installed');
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
        (0, utils_1.showError)('Select a project before running this action.');
        return;
    }
    const { data, project } = result;
    const db = project.dbs.find((db) => db.isSelected === true);
    if (!db) {
        (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        (0, utils_1.showError)('Disable testing mode before changing module selections.');
        return;
    }
    const { modules: allModules } = collectModuleDiscovery(project);
    const availableModules = allModules.filter(m => !m.name.match(/^ps[a-z]*-internal$/i));
    if (availableModules.length === 0) {
        (0, utils_1.showInfo)('No modules are available to install.');
        return;
    }
    // Confirm action
    const confirm = await vscode.window.showWarningMessage(`Are you sure you want to set all ${availableModules.length} available modules to "install" state?`, { modal: true }, 'Install All');
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
        (0, utils_1.showError)('Select a project before running this action.');
        return;
    }
    const { data, project } = result;
    const db = project.dbs.find((db) => db.isSelected === true);
    if (!db) {
        (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        (0, utils_1.showError)('Disable testing mode before changing module selections.');
        return;
    }
    if (!db.modules || db.modules.length === 0) {
        return; // Silently return if no modules to clear
    }
    // Confirm action
    const confirm = await vscode.window.showWarningMessage(`Are you sure you want to clear all ${db.modules.length} selected modules?`, { modal: true }, 'Clear All');
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
        (0, utils_1.showError)('Select a project before running this action.');
        return;
    }
    const { project } = result;
    const db = project.dbs.find((db) => db.isSelected === true);
    if (!db) {
        (0, utils_1.showError)('Select a database before running this action.');
        return;
    }
    try {
        // Get all installed modules from database
        const installedModules = await (0, database_1.getInstalledModules)(db.id);
        if (installedModules.length === 0) {
            (0, utils_1.showInfo)('No installed modules were found in the database');
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
        (0, utils_1.showError)(`Failed to retrieve installed modules: ${error}`);
    }
}


/***/ }),
/* 34 */
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
const node_child_process_1 = __webpack_require__(35);
const util = __importStar(__webpack_require__(36));
const execFileAsync = util.promisify(node_child_process_1.execFile);
const INSTALLED_MODULES_QUERY = `
    SELECT id, name, shortdesc, latest_version, state, application
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
        console.warn(`psql command failed for database "${dbName}":`, error);
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
    const modules = [];
    if (!(await databaseHasModuleTable(dbName))) {
        console.debug(`Database ${dbName} does not contain Odoo tables yet.`);
        return modules;
    }
    let output;
    try {
        output = await runPsqlQuery(dbName, INSTALLED_MODULES_QUERY);
    }
    catch (error) {
        console.warn(`Failed to fetch installed modules for database "${dbName}":`, error);
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
}


/***/ }),
/* 35 */
/***/ ((module) => {

module.exports = require("node:child_process");

/***/ }),
/* 36 */
/***/ ((module) => {

module.exports = require("node:util");

/***/ }),
/* 37 */
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
exports.toggleStopAfterInit = toggleStopAfterInit;
exports.setTestFile = setTestFile;
exports.addTestTag = addTestTag;
exports.cycleTestTagState = cycleTestTagState;
exports.removeTestTag = removeTestTag;
exports.toggleLogLevel = toggleLogLevel;
exports.setSpecificLogLevel = setSpecificLogLevel;
const vscode = __importStar(__webpack_require__(1));
const settingsStore_1 = __webpack_require__(21);
const testing_1 = __webpack_require__(28);
const module_1 = __webpack_require__(22);
const utils_1 = __webpack_require__(4);
const context_1 = __webpack_require__(38);
const debugger_1 = __webpack_require__(39);
const database_1 = __webpack_require__(34);
class TestingTreeProvider {
    context;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    constructor(context) {
        this.context = context;
        this.context = context;
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren(element) {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            return [(0, utils_1.createInfoTreeItem)('Select a project before running this action.')];
        }
        const { data, project } = result;
        const db = project.dbs.find(db => db.isSelected === true);
        if (!db) {
            return [(0, utils_1.createInfoTreeItem)('Select a database before running this action.')];
        }
        let testingConfig = (0, testing_1.ensureTestingConfigModel)(project.testingConfig);
        if (testingConfig !== project.testingConfig) {
            // Save the converted model back to persist the conversion
            project.testingConfig = testingConfig;
            await settingsStore_1.SettingsStore.saveWithoutComments((0, utils_1.stripSettings)(data)).catch(error => {
                console.warn('Failed to save converted testing config:', error);
            });
        }
        // Handle test tags section expansion
        if (element && element.contextValue === 'testTagsSection') {
            const tagItems = [];
            for (const tag of testingConfig.testTags) {
                let prefix = '';
                let stateText = '';
                switch (tag.state) {
                    case 'include':
                        prefix = '🟢';
                        stateText = 'included';
                        break;
                    case 'exclude':
                        prefix = '🔴';
                        stateText = 'excluded';
                        break;
                    case 'disabled':
                        prefix = '⚪';
                        stateText = 'disabled';
                        break;
                }
                const typeIcon = this.getTypeIcon(tag.type);
                const tagItem = new vscode.TreeItem(`${prefix} ${typeIcon} ${tag.value}`, vscode.TreeItemCollapsibleState.None);
                tagItem.id = tag.id; // Store the tag ID for context menu actions
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
        const enableToggle = new vscode.TreeItem(testingConfig.isEnabled ? '🟢 Testing Enabled' : '⚪ Testing Disabled', vscode.TreeItemCollapsibleState.None);
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
            const testTagsSection = new vscode.TreeItem(`📋 Test Targets (${testingConfig.testTags.length} total, ${activeTags.length} active)`, testingConfig.testTags.length > 0
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed);
            testTagsSection.contextValue = 'testTagsSection';
            testTagsSection.tooltip = 'Test targets - Click targets to cycle states: 🟢 Include → 🔴 Exclude → ⚪ Disabled. Right-click to remove.';
            treeItems.push(testTagsSection);
            // Test File section
            const testFileSection = new vscode.TreeItem(testingConfig.testFile ? `📄 Test File: ${testingConfig.testFile}` : '📄 No Test File Set', vscode.TreeItemCollapsibleState.None);
            testFileSection.command = {
                command: 'testingSelector.setTestFile',
                title: 'Set Test File'
            };
            testFileSection.tooltip = 'Click to set or change test file path';
            treeItems.push(testFileSection);
            // Stop After Init toggle
            const stopAfterInitToggle = new vscode.TreeItem(testingConfig.stopAfterInit ? '🟢 Stop After Init' : '⚪ Stop After Init', vscode.TreeItemCollapsibleState.None);
            stopAfterInitToggle.command = {
                command: 'testingSelector.toggleStopAfterInit',
                title: 'Toggle Stop After Init'
            };
            stopAfterInitToggle.tooltip = 'Toggle --stop-after-init option';
            treeItems.push(stopAfterInitToggle);
            // Log Level toggle
            const getLogLevelIcon = (level) => {
                switch (level) {
                    case 'disabled': return '⚪';
                    case 'critical': return '🔴';
                    case 'error': return '🟠';
                    case 'warn': return '🟡';
                    case 'debug': return '🔵';
                    default: return '⚪';
                }
            };
            const logLevelIcon = getLogLevelIcon(testingConfig.logLevel);
            const logLevelDisplay = testingConfig.logLevel === 'disabled' ? 'Log Level: Disabled' : `Log Level: ${testingConfig.logLevel.charAt(0).toUpperCase() + testingConfig.logLevel.slice(1)}`;
            const logLevelToggle = new vscode.TreeItem(`${logLevelIcon} ${logLevelDisplay}`, vscode.TreeItemCollapsibleState.None);
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
                const previewItem = new vscode.TreeItem(`⚡ Command: ${commandPreview}`, vscode.TreeItemCollapsibleState.None);
                previewItem.tooltip = `Full command: ${commandPreview}`;
                treeItems.push(previewItem);
            }
        }
        else if (testingConfig.savedModuleStates && testingConfig.savedModuleStates.length > 0) {
            // Show info about saved states when testing is disabled
            const savedStatesInfo = new vscode.TreeItem(`💾 ${testingConfig.savedModuleStates.length} module states saved`, vscode.TreeItemCollapsibleState.None);
            savedStatesInfo.tooltip = 'Module states from before enabling testing are saved and will be restored';
            treeItems.push(savedStatesInfo);
        }
        return treeItems;
    }
    getTypeIcon(type) {
        switch (type) {
            case 'module': return '📦';
            case 'class': return '🔧';
            case 'method': return '⚙️';
            case 'tag': return '🏷️';
            default:
                console.warn(`Unknown test tag type: "${type}"`);
                return '❓'; // Changed to question mark for debugging unknown types
        }
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
        return parts.join(' ');
    }
}
exports.TestingTreeProvider = TestingTreeProvider;
async function toggleTesting(event) {
    try {
        const { isEnabled } = event;
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            (0, utils_1.showError)('Select a project before running this action.');
            return;
        }
        const { data, project } = result;
        const db = project.dbs.find(db => db.isSelected === true);
        if (!db) {
            (0, utils_1.showError)('Select a database before running this action.');
            return;
        }
        // Ensure we have a proper TestingConfigModel instance
        project.testingConfig = (0, testing_1.ensureTestingConfigModel)(project.testingConfig);
        if (isEnabled) {
            // Disable testing - restore module states
            const confirm = await vscode.window.showWarningMessage('Are you sure you want to disable testing? This will restore the previous module states.', { modal: true }, 'Disable Testing');
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
            const confirm = await vscode.window.showWarningMessage('Enabling testing will clear all current module selections (install/upgrade). The current states will be saved and can be restored when testing is disabled. Continue?', { modal: true }, 'Enable Testing');
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
        console.error('Error in toggleTesting:', error);
        (0, utils_1.showError)(`Failed to toggle testing: ${error}`);
    }
}
async function toggleStopAfterInit() {
    try {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            (0, utils_1.showError)('Select a project before running this action.');
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
        console.error('Error in toggleStopAfterInit:', error);
        (0, utils_1.showError)(`Failed to toggle stop after init: ${error}`);
    }
}
async function setTestFile() {
    try {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            (0, utils_1.showError)('Select a project before running this action.');
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
        console.error('Error in setTestFile:', error);
        (0, utils_1.showError)(`Failed to set test file: ${error}`);
    }
}
async function addTestTag() {
    try {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            (0, utils_1.showError)('Select a project before running this action.');
            return;
        }
        const { data, project } = result;
        project.testingConfig = (0, testing_1.ensureTestingConfigModel)(project.testingConfig);
        if (!project.testingConfig.isEnabled) {
            (0, utils_1.showError)('Enable testing before running this command.');
            return;
        }
        const db = project.dbs.find(db => db.isSelected === true);
        if (!db) {
            (0, utils_1.showError)('Select a database before running this action.');
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
                    (0, utils_1.showInfo)('No installed modules were found.');
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
                (0, utils_1.showError)(`Failed to get installed modules: ${error}`);
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
                    // Basic validation based on type
                    switch (selectedType.value) {
                        case 'tag':
                            // Simple tags: alphanumeric and underscores
                            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
                                return 'Tag names should contain only letters, numbers, and underscores';
                            }
                            break;
                        case 'class':
                            // Class format: just the class name (no module: prefix needed)
                            // Non-blocking check for Test prefix - just log suggestion, don't block
                            if (!trimmed.startsWith('Test') && !trimmed.includes('Test')) {
                                console.log(`Class names typically start with "Test" (e.g., "TestSalesAccessRights")`);
                            }
                            break;
                        case 'method':
                            // Method format: just the method name (no module:Class. prefix needed)
                            // Non-blocking check for test_ prefix - just log suggestion, don't block
                            if (!trimmed.startsWith('test_')) {
                                console.log(`Method names typically start with "test_" (e.g., "test_workflow_invoice")`);
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
                    // Show naming convention suggestion if applicable
                    if (!userInput.trim().startsWith('Test') && !userInput.trim().includes('Test')) {
                        (0, utils_1.showWarning)(`Warning: Class names typically start with "Test" (e.g., "TestSalesAccessRights").`);
                    }
                }
                else if (selectedType.value === 'method') {
                    formatInfo = ` (will be formatted as .${userInput.trim()})`;
                    // Show naming convention suggestion if applicable
                    if (!userInput.trim().startsWith('test_')) {
                        (0, utils_1.showWarning)(`Warning: Method names typically start with "test_" (e.g., "test_workflow_invoice").`);
                    }
                }
                (0, utils_1.showAutoInfo)(`Added ${selectedType.value} "${userInput.trim()}"${formatInfo} as test target.`, 4000);
                // Update launch.json with new test configuration
                await (0, debugger_1.setupDebugger)();
            }
        }
    }
    catch (error) {
        console.error('Error in addTestTag:', error);
        (0, utils_1.showError)(`Failed to add test tag: ${error}`);
    }
}
async function cycleTestTagState(tag) {
    try {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            (0, utils_1.showError)('Select a project before running this action.');
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
            (0, utils_1.showError)('Could not find that test tag.');
        }
    }
    catch (error) {
        console.error('Error in cycleTestTagState:', error);
        (0, utils_1.showError)(`Failed to cycle test tag state: ${error}`);
    }
}
async function removeTestTag(tagOrTreeItem) {
    try {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            (0, utils_1.showError)('Select a project before running this action.');
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
            console.error('Could not find the referenced test tag:', tagOrTreeItem);
            (0, utils_1.showError)('Could not find the referenced test tag.');
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
            (0, utils_1.showError)('Could not find that test tag.');
        }
    }
    catch (error) {
        console.error('Error in removeTestTag:', error);
        (0, utils_1.showError)(`Failed to remove test tag: ${error}`);
    }
}
async function toggleLogLevel() {
    try {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            (0, utils_1.showError)('Select a project before running this action.');
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
        console.error('Error in toggleLogLevel:', error);
        (0, utils_1.showError)(`Failed to toggle log level: ${error}`);
    }
}
async function setSpecificLogLevel() {
    try {
        const result = await settingsStore_1.SettingsStore.getSelectedProject();
        if (!result) {
            (0, utils_1.showError)('Select a project before running this action.');
            return;
        }
        const { data, project } = result;
        project.testingConfig = (0, testing_1.ensureTestingConfigModel)(project.testingConfig);
        const logLevelOptions = [
            {
                label: '⚪ Disabled',
                detail: 'No --log-level argument (default Odoo logging)',
                value: 'disabled'
            },
            {
                label: '🔴 Critical',
                detail: 'Only critical errors',
                value: 'critical'
            },
            {
                label: '🟠 Error',
                detail: 'Critical and error messages',
                value: 'error'
            },
            {
                label: '🟡 Warn',
                detail: 'Critical, error, and warning messages',
                value: 'warn'
            },
            {
                label: '🔵 Debug',
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
        console.error('Error in setSpecificLogLevel:', error);
        (0, utils_1.showError)(`Failed to set log level: ${error}`);
    }
}


/***/ }),
/* 38 */
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


/***/ }),
/* 39 */
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
exports.startDebugShell = startDebugShell;
exports.startDebugServer = startDebugServer;
const vscode = __importStar(__webpack_require__(1));
const fs = __importStar(__webpack_require__(5));
const path = __importStar(__webpack_require__(3));
const utils_1 = __webpack_require__(4);
const settingsStore_1 = __webpack_require__(21);
const versionsService_1 = __webpack_require__(18);
const testing_1 = __webpack_require__(28);
const database_1 = __webpack_require__(34);
const jsonc_parser_1 = __webpack_require__(10);
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
        console.warn(`Failed to set Python interpreter to "${pythonPath}":`, error);
    }
}
function readLaunchData(workspacePath, debuggerName) {
    const vscodeDir = path.join(workspacePath, '.vscode');
    const launchPath = path.join(vscodeDir, 'launch.json');
    fs.mkdirSync(vscodeDir, { recursive: true });
    let content;
    if (fs.existsSync(launchPath)) {
        content = fs.readFileSync(launchPath, 'utf8');
    }
    else {
        content = JSON.stringify({ version: '0.2.0', configurations: [] }, null, 2) + '\n';
        fs.writeFileSync(launchPath, content, 'utf8');
    }
    let launchData = (0, jsonc_parser_1.parse)(content);
    if (!launchData || typeof launchData !== 'object') {
        launchData = { version: '0.2.0', configurations: [] };
    }
    const configurations = Array.isArray(launchData.configurations) ? [...launchData.configurations] : [];
    const existingIndex = configurations.findIndex(conf => conf?.name === debuggerName);
    return { launchPath, launchData, configurations, existingIndex };
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
    // Get settings from active version instead of legacy settings
    const versionsService = versionsService_1.VersionsService.getInstance();
    const settings = await versionsService.getActiveVersionSettings();
    // Normalize paths to handle absolute vs relative
    const normalizedOdooPath = (0, utils_1.normalizePath)(settings.odooPath);
    const normalizedPythonPath = (0, utils_1.normalizePath)(settings.pythonPath);
    let args;
    try {
        args = await prepareArgs(project, settings);
    }
    catch (error) {
        console.warn('Could not prepare debugger launch arguments:', error);
        if (error instanceof Error) {
            if (error.message === 'Select a database before running this action.') {
                (0, utils_1.showInfo)('Select a database before configuring the debugger.');
            }
            else {
                (0, utils_1.showError)(error.message);
            }
        }
        else {
            (0, utils_1.showError)('Could not prepare debugger launch arguments.');
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
    }
    catch (error) {
        (0, utils_1.showError)(`Unable to update launch.json: ${error}`);
    }
    await selectPythonInterpreter(settings.pythonPath);
    return newOdooConfig;
}
async function prepareArgs(project, settings, isShell = false) {
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
    const db = project.dbs.find(database => database.isSelected);
    if (!db) {
        throw new Error('Select a database before running this action.');
    }
    const projectModules = db.modules ?? [];
    // Auto-detect ps*-internal paths needed based on selected modules
    const psInternalPaths = new Set();
    const manualIncludes = new Set();
    const manualExcludes = new Set();
    for (const entry of project.includedPsaeInternalPaths ?? []) {
        if (entry.startsWith('!')) {
            manualExcludes.add((0, utils_1.normalizePath)(entry.substring(1)));
        }
        else {
            const normalized = (0, utils_1.normalizePath)(entry);
            manualIncludes.add(normalized);
            psInternalPaths.add(normalized);
        }
    }
    const manualPsaeIncludes = (project.includedPsaeInternalPaths ?? []).filter(entry => !entry.startsWith('!'));
    const discovery = (0, utils_1.discoverModulesInRepos)(project.repos, { manualIncludePaths: manualPsaeIncludes });
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
    const foundPsInternalDirs = new Map(); // path -> modules
    for (const dir of discovery.psaeDirectories) {
        foundPsInternalDirs.set((0, utils_1.normalizePath)(dir.path), dir.moduleNames);
    }
    const selectedModuleNames = new Set(projectModules
        .filter(module => module.state === 'install' || module.state === 'upgrade')
        .map(module => module.name));
    let installedModuleNames = new Set();
    try {
        const installedModules = await (0, database_1.getInstalledModules)(db.id);
        installedModuleNames = new Set(installedModules.map((m) => m.name));
    }
    catch (error) {
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
                (0, utils_1.showAutoInfo)('Added "base" during initialization so the new database can install core tables.', 3000);
            }
        }
        catch (error) {
            console.warn('Failed to verify module table state:', error);
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
async function startDebugShell() {
    const workspacePath = (0, utils_1.getWorkspacePath)();
    if (!workspacePath) {
        return undefined;
    }
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        return undefined;
    }
    const { project } = result;
    // Get settings from active version instead of legacy settings
    const versionsService = versionsService_1.VersionsService.getInstance();
    const workspaceSettings = await versionsService.getActiveVersionSettings();
    // Normalize paths for terminal commands
    const normalizedOdooPath = (0, utils_1.normalizePath)(workspaceSettings.odooPath);
    const normalizedPythonPath = (0, utils_1.normalizePath)(workspaceSettings.pythonPath);
    let args;
    try {
        args = await prepareArgs(project, workspaceSettings, true);
    }
    catch (error) {
        if (error instanceof Error) {
            if (error.message === 'Select a database before running this action.') {
                (0, utils_1.showInfo)('Select a database before opening the Odoo shell.');
            }
            else {
                (0, utils_1.showError)(error.message);
            }
        }
        else {
            (0, utils_1.showError)('Could not prepare shell arguments.');
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
function quoteShellArg(value) {
    if (/^[\w@%+=:,./-]+$/.test(value)) {
        return value;
    }
    const escapedValue = value.replaceAll("'", String.raw `'\''`);
    return `'${escapedValue}'`;
}
async function startDebugServer() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        (0, utils_1.showError)("Open a workspace to use this command.");
        return undefined;
    }
    const result = await settingsStore_1.SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    // Get settings from active version instead of legacy settings
    const versionsService = versionsService_1.VersionsService.getInstance();
    const workspaceSettings = await versionsService.getActiveVersionSettings();
    const existingSession = vscode.debug.activeDebugSession;
    if (existingSession) {
        await vscode.debug.stopDebugging(existingSession);
    }
    vscode.debug.startDebugging(workspaceFolders[0], workspaceSettings.debuggerName);
}


/***/ }),
/* 40 */
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
exports.setupOdooBranch = setupOdooBranch;
// VSCode Extension Utility: Clone Odoo & Enterprise for a selected branch and setup venv with progress
const vscode = __importStar(__webpack_require__(1));
const path = __importStar(__webpack_require__(6));
const fs = __importStar(__webpack_require__(5));
const utils_1 = __webpack_require__(4);
const child_process_1 = __webpack_require__(7);
async function setupOdooBranch() {
    // Show confirmation dialog with detailed information
    const confirmMessage = `This will:
• Clone Odoo and Enterprise repositories
• Create a Python virtual environment
• Allow you to select a specific branch

This may take several minutes depending on your internet connection.

Continue?`;
    const confirm = await vscode.window.showWarningMessage(confirmMessage, { modal: true }, 'Continue');
    if (confirm !== 'Continue') {
        return;
    }
    const baseDir = (0, utils_1.getWorkspacePath)();
    if (!baseDir) {
        (0, utils_1.showError)('Open a workspace folder before running this command.');
        return;
    }
    // Check if directories already exist
    const odooPath = path.join(baseDir, 'odoo');
    const enterprisePath = path.join(baseDir, 'enterprise');
    const venvPath = path.join(baseDir, 'venv');
    const existingPaths = [];
    if (fs.existsSync(odooPath)) {
        existingPaths.push('odoo');
    }
    if (fs.existsSync(enterprisePath)) {
        existingPaths.push('enterprise');
    }
    if (fs.existsSync(venvPath)) {
        existingPaths.push('venv');
    }
    if (existingPaths.length > 0) {
        const overwriteConfirm = await vscode.window.showWarningMessage(`The following directories already exist: ${existingPaths.join(', ')}\n\nDo you want to continue? This may overwrite existing files.`, { modal: true }, 'Continue Anyway', 'Cancel');
        if (overwriteConfirm !== 'Continue Anyway') {
            return;
        }
    }
    // Let user select branch
    const branchOptions = [
        { label: '17.0', description: 'Latest stable version' },
        { label: '16.0', description: 'Previous stable version' },
        { label: '15.0', description: 'Legacy stable version' },
        { label: '14.0', description: 'Legacy stable version' },
        { label: 'master', description: 'Development branch (unstable)' },
        { label: 'saas-17.4', description: 'SaaS version' },
        { label: 'saas-17.3', description: 'SaaS version' },
        { label: 'saas-17.2', description: 'SaaS version' },
        { label: 'Custom', description: 'Enter a custom branch name' }
    ];
    const selectedBranch = await vscode.window.showQuickPick(branchOptions, {
        placeHolder: 'Select an Odoo branch to clone',
        ignoreFocusOut: true
    });
    if (!selectedBranch) {
        return;
    }
    let branch = selectedBranch.label;
    if (branch === 'Custom') {
        const customBranch = await vscode.window.showInputBox({
            prompt: 'Enter the branch name',
            placeHolder: 'e.g., 17.0, master, saas-17.4',
            ignoreFocusOut: true
        });
        if (!customBranch) {
            return;
        }
        branch = customBranch.trim();
    }
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Setting up Odoo ${branch}…`,
        cancellable: false
    }, async (progress) => {
        try {
            progress.report({ message: 'Preparing setup…', increment: 5 });
            // Create terminal for operations
            const terminal = vscode.window.createTerminal({
                name: `Odoo Setup (${branch})`,
                cwd: baseDir
            });
            terminal.show();
            // Clone Odoo repository
            progress.report({ message: 'Cloning Odoo repository…', increment: 15 });
            console.log(`🔄 Cloning Odoo repository (branch: ${branch})`);
            terminal.sendText(`echo "🔄 Cloning Odoo repository (branch: ${branch})..."`);
            terminal.sendText(`git clone --depth 1 --branch ${branch} https://github.com/odoo/odoo.git`);
            // Wait a bit for the clone to start
            await new Promise(resolve => setTimeout(resolve, 2000));
            // Clone Enterprise repository
            progress.report({ message: 'Cloning Enterprise repository…', increment: 35 });
            console.log(`🔄 Cloning Enterprise repository (branch: ${branch})`);
            terminal.sendText(`echo "🔄 Cloning Enterprise repository (branch: ${branch})..."`);
            terminal.sendText(`git clone --depth 1 --branch ${branch} git@github.com:odoo/enterprise.git || git clone --depth 1 --branch ${branch} https://github.com/odoo/enterprise.git`);
            // Wait for enterprise clone
            await new Promise(resolve => setTimeout(resolve, 2000));
            // Check Python availability
            progress.report({ message: 'Checking Python installation…', increment: 55 });
            console.log('🐍 Checking Python installation');
            let pythonCmd = 'python3';
            try {
                (0, child_process_1.execSync)('python3 --version', { stdio: 'ignore' });
            }
            catch {
                try {
                    (0, child_process_1.execSync)('python --version', { stdio: 'ignore' });
                    pythonCmd = 'python';
                }
                catch {
                    throw new Error('Python not found. Please install Python 3.8+ first.');
                }
            }
            // Create virtual environment
            progress.report({ message: 'Creating Python virtual environment…', increment: 75 });
            console.log('🔧 Creating Python virtual environment');
            terminal.sendText(`echo "🔧 Creating Python virtual environment..."`);
            terminal.sendText(`${pythonCmd} -m venv venv`);
            // Wait for venv creation
            await new Promise(resolve => setTimeout(resolve, 3000));
            // Activate venv and install basic requirements
            progress.report({ message: 'Installing basic Python packages…', increment: 85 });
            console.log('📦 Installing basic Python packages');
            terminal.sendText(`echo "📦 Installing basic Python packages..."`);
            // Platform-specific activation
            const isWindows = process.platform === 'win32';
            const activateCmd = isWindows ? '.\\venv\\Scripts\\activate' : 'source venv/bin/activate';
            terminal.sendText(`${activateCmd} && pip install --upgrade pip setuptools wheel`);
            // Install Odoo requirements if they exist
            terminal.sendText(`${activateCmd} && if [ -f odoo/requirements.txt ]; then pip install -r odoo/requirements.txt; else echo "No requirements.txt found in odoo directory"; fi`);
            progress.report({ message: 'Setup complete!', increment: 100 });
            // Show completion message with next steps
            terminal.sendText(`echo ""`);
            terminal.sendText(`echo "✅ Odoo ${branch} setup complete!"`);
            terminal.sendText(`echo ""`);
            terminal.sendText(`echo "Next steps:"`);
            terminal.sendText(`echo "1. Configure your VS Code settings to point to these directories"`);
            terminal.sendText(`echo "2. Activate the virtual environment: ${activateCmd}"`);
            terminal.sendText(`echo "3. Install additional dependencies if needed"`);
            terminal.sendText(`echo "4. Create your custom addons directory"`);
            terminal.sendText(`echo ""`);
            (0, utils_1.showInfo)(`Odoo ${branch} setup completed successfully!\n\nCheck the terminal for next steps.`);
        }
        catch (error) {
            console.error('Setup failed:', error);
            (0, utils_1.showError)(`Setup failed: ${error.message}`);
        }
    });
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
exports.VersionsTreeProvider = exports.VersionSettingTreeItem = exports.VersionTreeItem = void 0;
const vscode = __importStar(__webpack_require__(1));
const versionsService_1 = __webpack_require__(18);
const utils_1 = __webpack_require__(4);
const sortOptions_1 = __webpack_require__(25);
class VersionTreeItem extends vscode.TreeItem {
    version;
    collapsibleState;
    constructor(version, collapsibleState) {
        // Use the same pattern as projects and databases - emoji in label
        super((0, utils_1.addActiveIndicator)(version.name, version.isActive), collapsibleState);
        this.version = version;
        this.collapsibleState = collapsibleState;
        this.tooltip = `${version.name} (${version.odooVersion})`;
        this.description = version.odooVersion;
        this.contextValue = version.isActive ? 'activeVersion' : 'version';
        // No icon needed - using emoji in label like other tabs
        // Add command to switch to this version when clicked
        this.command = {
            command: 'odoo.setActiveVersion',
            title: '',
            arguments: [version.id]
        };
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
        // Add command to edit this setting
        this.command = {
            command: 'odoo.editVersionSetting',
            title: 'Edit Setting',
            arguments: [versionId, key, value]
        };
    }
}
exports.VersionSettingTreeItem = VersionSettingTreeItem;
class VersionsTreeProvider {
    sortPreferences;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    versionsService;
    constructor(sortPreferences) {
        this.sortPreferences = sortPreferences;
        this.versionsService = versionsService_1.VersionsService.getInstance();
        // Listen for version changes
        vscode.commands.registerCommand('odoo.versionsChanged', () => {
            this.refresh();
        });
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (!element) {
            // Root level - show versions
            return this.versionsService.initialize().then(() => {
                const sortId = this.sortPreferences.get('versionsManager', (0, sortOptions_1.getDefaultSortOption)('versionsManager'));
                const versions = this.versionsService.getVersions().slice().sort((a, b) => this.compareVersions(a, b, sortId));
                return versions.map(version => new VersionTreeItem(version, vscode.TreeItemCollapsibleState.Collapsed));
            }).catch(error => {
                console.error('Failed to load versions for tree view:', error);
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
/* 42 */
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
/* 43 */
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
const vscode = __importStar(__webpack_require__(1));
const settingsStore_1 = __webpack_require__(21);
const utils_1 = __webpack_require__(4);
async function getActiveProjectOrPrompt() {
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    if (!data?.projects || data.projects.length === 0) {
        (0, utils_1.showInfo)('No projects found. Create a project first.');
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
        (0, utils_1.showInfo)(`Project "${project.name}" has no repositories. Add repos first.`);
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
    const choice = await vscode.window.showInformationMessage('Open project workspace?', { modal: false }, 'This window', 'New window');
    if (!choice) {
        return;
    }
    const forceNewWindow = choice === 'New window';
    await vscode.commands.executeCommand('vscode.openFolder', workspaceFile, forceNewWindow);
}
async function quickSwitchProjectWorkspace(context) {
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    if (!data?.projects || data.projects.length === 0) {
        (0, utils_1.showInfo)('No projects found. Create a project first.');
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
/* 44 */
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
exports.deleteEntry = deleteEntry;
exports.openTerminalHere = openTerminalHere;
exports.selectProjectForExplorer = selectProjectForExplorer;
exports.copyEntries = copyEntries;
exports.pasteEntries = pasteEntries;
const vscode = __importStar(__webpack_require__(1));
const path = __importStar(__webpack_require__(3));
const settingsStore_1 = __webpack_require__(21);
const utils_1 = __webpack_require__(4);
class ProjectReposExplorerProvider {
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    watchers = [];
    constructor() { }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    disposeWatchers() {
        this.watchers.forEach(w => w.dispose());
        this.watchers = [];
    }
    getTreeItem(element) {
        switch (element.kind) {
            case 'placeholder': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
                item.contextValue = 'projectReposExplorerInfo';
                item.command = element.command;
                return item;
            }
            case 'repo': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
                item.resourceUri = element.uri;
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
            const selection = await settingsStore_1.SettingsStore.getSelectedProject();
            if (!selection) {
                return [
                    {
                        kind: 'placeholder',
                        label: 'No active project. Select a project to view its repos.',
                        command: { command: 'odt.projectReposExplorer.selectProject', title: 'Select Project' }
                    }
                ];
            }
            const { project } = selection;
            const repos = (project.repos ?? []);
            if (!repos.length) {
                return [
                    {
                        kind: 'placeholder',
                        label: 'No repositories selected for this project.',
                        command: { command: 'repoSelector.selectRepo', title: 'Select Repo' }
                    }
                ];
            }
            this.resetWatchers(repos);
            return repos.map(repo => ({
                kind: 'repo',
                label: repo.name,
                repo,
                uri: vscode.Uri.file(repo.path)
            }));
        }
        if (element.kind === 'repo' || element.kind === 'folder') {
            return this.readDirectory(element.uri);
        }
        return [];
    }
    resetWatchers(repos) {
        this.disposeWatchers();
        for (const repo of repos) {
            const pattern = new vscode.RelativePattern(repo.path, '**/*');
            const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
            watcher.onDidCreate(() => this.refresh());
            watcher.onDidChange(() => this.refresh());
            watcher.onDidDelete(() => this.refresh());
            this.watchers.push(watcher);
        }
    }
    async readDirectory(dir) {
        try {
            const entries = await vscode.workspace.fs.readDirectory(dir);
            const nodes = entries.map(([name, type]) => {
                const childUri = vscode.Uri.file(path.join(dir.fsPath, name));
                if (type === vscode.FileType.Directory) {
                    return { kind: 'folder', label: name, uri: childUri };
                }
                return { kind: 'file', label: name, uri: childUri };
            });
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
            (0, utils_1.showError)(`Unable to read ${dir.fsPath}: ${error?.message ?? error}`);
            return [];
        }
    }
}
exports.ProjectReposExplorerProvider = ProjectReposExplorerProvider;
async function promptName(placeHolder, value) {
    return vscode.window.showInputBox({
        prompt: placeHolder,
        value,
        ignoreFocusOut: true
    });
}
async function createNewFile(folderUri) {
    const baseUri = folderUri ?? (vscode.window.activeTextEditor?.document.uri);
    if (!baseUri) {
        (0, utils_1.showInfo)('Select a folder to create a file.');
        return;
    }
    const folderPath = baseUri.fsPath;
    const name = await promptName('New file name', 'untitled.txt');
    if (!name) {
        return;
    }
    const target = vscode.Uri.file(path.join(folderPath, name));
    await vscode.workspace.fs.writeFile(target, new Uint8Array());
}
async function createNewFolder(folderUri) {
    if (!folderUri) {
        (0, utils_1.showInfo)('Select a folder to create a new folder.');
        return;
    }
    const name = await promptName('New folder name', 'new-folder');
    if (!name) {
        return;
    }
    const target = vscode.Uri.file(path.join(folderUri.fsPath, name));
    await vscode.workspace.fs.createDirectory(target);
}
async function renameEntry(uri) {
    if (!uri) {
        (0, utils_1.showInfo)('Select a file or folder to rename.');
        return;
    }
    const currentName = path.basename(uri.fsPath);
    const newName = await promptName('Rename to', currentName);
    if (!newName || newName === currentName) {
        return;
    }
    const target = vscode.Uri.file(path.join(path.dirname(uri.fsPath), newName));
    await vscode.workspace.fs.rename(uri, target, { overwrite: false });
}
async function deleteEntry(uri) {
    if (!uri) {
        (0, utils_1.showInfo)('Select a file or folder to delete.');
        return;
    }
    const choice = await vscode.window.showWarningMessage(`Delete "${path.basename(uri.fsPath)}"?`, { modal: true }, 'Delete');
    if (choice !== 'Delete') {
        return;
    }
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
}
async function openTerminalHere(uri) {
    if (!uri) {
        (0, utils_1.showInfo)('Select a folder to open in terminal.');
        return;
    }
    const terminal = vscode.window.createTerminal({ cwd: uri.fsPath });
    terminal.show();
}
async function selectProjectForExplorer() {
    const data = await settingsStore_1.SettingsStore.get('odoo-debugger-data.json');
    if (!data?.projects || data.projects.length === 0) {
        (0, utils_1.showInfo)('No projects found. Create a project first.');
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
// Clipboard for copy/cut
let clipboard = null;
function copyEntries(uris, cut = false) {
    clipboard = { uris, cut };
    const action = cut ? 'Cut' : 'Copied';
    vscode.window.setStatusBarMessage(`${action} ${uris.length} item(s)`, 2000);
}
function getTargetFolderUri(uri) {
    if (!uri) {
        return undefined;
    }
    return uri;
}
async function pathExists(uri) {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    }
    catch {
        return false;
    }
}
async function pasteEntries(targetUri) {
    if (!clipboard || clipboard.uris.length === 0) {
        (0, utils_1.showInfo)('Nothing to paste.');
        return;
    }
    const folderUri = getTargetFolderUri(targetUri);
    if (!folderUri) {
        (0, utils_1.showInfo)('Select a destination folder.');
        return;
    }
    for (const source of clipboard.uris) {
        const base = path.basename(source.fsPath);
        const destination = vscode.Uri.file(path.join(folderUri.fsPath, base));
        const exists = await pathExists(destination);
        if (exists) {
            const choice = await vscode.window.showWarningMessage(`"${base}" already exists. Overwrite?`, { modal: true }, 'Overwrite', 'Skip');
            if (choice !== 'Overwrite') {
                continue;
            }
        }
        try {
            if (clipboard.cut) {
                await vscode.workspace.fs.rename(source, destination, { overwrite: true });
            }
            else {
                await vscode.workspace.fs.copy(source, destination, { overwrite: true });
            }
        }
        catch (error) {
            (0, utils_1.showError)(`Failed to paste "${base}": ${error?.message ?? error}`);
        }
    }
    if (clipboard.cut) {
        clipboard = null;
    }
}


/***/ })
/******/ 	]);
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
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
/******/ 		// define getter functions for harmony exports
/******/ 		__webpack_require__.d = (exports, definition) => {
/******/ 			for(var key in definition) {
/******/ 				if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 					Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
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
/******/ 			if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
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
/******/ 	var __webpack_exports__ = __webpack_require__(0);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;
//# sourceMappingURL=extension.js.map