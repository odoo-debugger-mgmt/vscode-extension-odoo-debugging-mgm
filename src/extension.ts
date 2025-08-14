import * as vscode from 'vscode';

import { normalizePath, showError, showInfo } from './utils';
import { ProjectModel } from './models/project';
import { DbsTreeProvider, createDb, selectDatabase, deleteDb, restoreDb } from './dbs';
import { ProjectTreeProvider, createProject, selectProject, getRepo, getProjectName, deleteProject, editProjectSettings, duplicateProject, exportProject, importProject, quickProjectSearch} from './project';
import { RepoTreeProvider, selectRepo } from './repos';
import { ModuleTreeProvider, selectModule, togglePsaeInternalModule, updateAllModules, installAllModules, clearAllModuleSelections, updateInstalledModules, viewInstalledModules } from './module';
import { TestingTreeProvider, toggleTesting, toggleStopAfterInit, setTestFile, addTestTag, removeTestTag, cycleTestTagState } from './testing';
import { SettingsTreeProvider, editSetting } from './settings';
import { setupDebugger, startDebugShell, startDebugServer } from './debugger';
import { setupOdooBranch } from './odooInstaller';
import { SettingsStore } from './settingsStore';

// Store disposables for proper cleanup
let extensionDisposables: vscode.Disposable[] = [];

// Helper function to update testing context for UI elements
export function updateTestingContext(isTestingEnabled: boolean): void {
    vscode.commands.executeCommand("setContext", "odoo-debugger.testing_enabled", isTestingEnabled);
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
        updateTestingContext(false);
    }
}

export function activate(context: vscode.ExtensionContext) {
    // Clear any existing disposables
    extensionDisposables.forEach(d => d.dispose());
    extensionDisposables = [];
    const isWorkspaceOpen = !!vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
    vscode.commands.executeCommand("setContext", "odoo-debugger.is_active", isWorkspaceOpen ? "true" : "false");

    // Initialize testing context
    initializeTestingContext();

    const providers = {
        project: new ProjectTreeProvider(context),
        repo: new RepoTreeProvider(context),
        db: new DbsTreeProvider(context),
        module: new ModuleTreeProvider(context),
        testing: new TestingTreeProvider(context),
        settings: new SettingsTreeProvider(context)
    };

    // Register tree data providers and store disposables
    extensionDisposables.push(vscode.window.registerTreeDataProvider('projectSelector', providers.project));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('repoSelector', providers.repo));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('dbSelector', providers.db));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('moduleSelector', providers.module));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('testingSelector', providers.testing));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('workspaceSettings', providers.settings));

    const refreshAll = () => {
        setupDebugger();
        initializeTestingContext();
        Object.values(providers).forEach(provider => provider.refresh());
    };

    // Register all commands and store disposables
    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.refresh', refreshAll));
    extensionDisposables.push(vscode.commands.registerCommand('repoSelector.refresh', refreshAll));
    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.refresh', refreshAll));
    extensionDisposables.push(vscode.commands.registerCommand('testingSelector.refresh', refreshAll));
    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.refresh', refreshAll));

    // Projects
    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.create', async () => {
        try {
            const settings = await SettingsStore.getSettings();
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {throw new Error("No workspace open.");}
            const name = await getProjectName(workspaceFolder);
            const customAddonsPath = normalizePath(settings.customAddonsPath);
            const repos = await getRepo(customAddonsPath, name); // Pass project name as search filter
            const createADb = await vscode.window.showQuickPick(["Yes", "No"], { placeHolder: 'Create a database?' });
            const db = createADb === "Yes" ? await createDb(name, repos, settings.dumpsFolder, settings) : undefined;
            await createProject(name, repos, db);
            refreshAll();
        } catch (err: any) {
            showError(err.message);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.selectProject', async (event) => {
        await selectProject(event);
        refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.delete', async (event) => {
        await deleteProject(event);
        refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.editSettings', async (event) => {
        await editProjectSettings(event);
        refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.duplicateProject', async (event) => {
        await duplicateProject(event);
        refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.exportProject', async (event) => {
        await exportProject(event);
        refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.importProject', async () => {
        await importProject();
        refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('projectSelector.setup', async (event) => {
        await setupOdooBranch();
        refreshAll();
    }));

    // Quick Project Search
    extensionDisposables.push(vscode.commands.registerCommand('odoo-debugger.quickProjectSearch', async () => {
        await quickProjectSearch();
        refreshAll();
    }));

    // DBS
    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.create', async () => {
        try {
            const settings = await SettingsStore.getSettings();
            const projects = await SettingsStore.getProjects();
            const project = projects?.find((p: ProjectModel) => p.isSelected);
            if (!project) {
                throw new Error('No project selected');
            }
            const db = await createDb(project.name, project.repos, settings.dumpsFolder, settings);
            if (db) {
                project.dbs.push(db);
                await SettingsStore.saveWithoutComments({ settings, projects });
                await selectDatabase(db);
            }
            refreshAll();
        } catch (err: any) {
            showError(err.message);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.selectDb', async (event) => {
        await selectDatabase(event);
        refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.delete', async (event) => {
        await deleteDb(event);
        refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.restore', async (event) => {
        await restoreDb(event);
        refreshAll();
        showInfo(`Database ${event.name || event.id} restored successfully!`);
    }));

    // Repos
    extensionDisposables.push(vscode.commands.registerCommand('repoSelector.selectRepo', async (event) => {
        await selectRepo(event);
        refreshAll();
    }));

    // Modules
    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.select', async (event) => {
        await selectModule(event);
        refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.togglePsaeInternalModule', async (event) => {
        await togglePsaeInternalModule(event);
        refreshAll();
    }));

    // Module Quick Actions
    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.updateAll', async () => {
        await updateAllModules();
        refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.updateInstalled', async () => {
        await updateInstalledModules();
        refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.installAll', async () => {
        await installAllModules();
        refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.clearAll', async () => {
        await clearAllModuleSelections();
        refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.viewInstalled', async () => {
        await viewInstalledModules();
    }));

    // Testing
    extensionDisposables.push(vscode.commands.registerCommand('testingSelector.toggleTesting', async (event) => {
        await toggleTesting(event);
        refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('testingSelector.toggleStopAfterInit', async () => {
        await toggleStopAfterInit();
        refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('testingSelector.setTestFile', async () => {
        await setTestFile();
        refreshAll();
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

    // SETTINGS
    extensionDisposables.push(vscode.commands.registerCommand('workspaceSettings.editSetting', async (event) => {
        await editSetting(event);
        refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('workspaceSettings.startServer', startDebugServer));
    extensionDisposables.push(vscode.commands.registerCommand('workspaceSettings.startShell', startDebugShell));

    // Add all disposables to the context for automatic cleanup
    extensionDisposables.forEach(disposable => context.subscriptions.push(disposable));

    return {
        dispose() {
            // Clean up all disposables
            extensionDisposables.forEach(d => d.dispose());
            extensionDisposables = [];

            // Reset the context
            vscode.commands.executeCommand(
                "setContext",
                "odoo-debugger.is_active",
                "false"
            );
        }
    };
}

// Proper deactivate function
export function deactivate() {
    // Clean up all disposables
    extensionDisposables.forEach(d => d.dispose());
    extensionDisposables = [];

    // Reset the context
    vscode.commands.executeCommand(
        "setContext",
        "odoo-debugger.is_active",
        "false"
    );

    console.log('Odoo Debugger extension deactivated');
}
