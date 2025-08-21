import * as vscode from 'vscode';

import { normalizePath, showError, showInfo, showWarning, getGitBranches } from './utils';
import { ProjectModel } from './models/project';
import { DbsTreeProvider, createDb, selectDatabase, deleteDb, restoreDb, changeDatabaseVersion } from './dbs';
import { ProjectTreeProvider, createProject, selectProject, getRepo, getProjectName, deleteProject, editProjectSettings, duplicateProject, exportProject, importProject, quickProjectSearch} from './project';
import { RepoTreeProvider, selectRepo } from './repos';
import { ModuleTreeProvider, selectModule, setModuleToInstall, setModuleToUpgrade, clearModuleState, togglePsaeInternalModule, updateAllModules, installAllModules, clearAllModuleSelections, updateInstalledModules, viewInstalledModules } from './module';
import { TestingTreeProvider, toggleTesting, toggleStopAfterInit, setTestFile, addTestTag, removeTestTag, cycleTestTagState } from './testing';
import { setupDebugger, startDebugShell, startDebugServer } from './debugger';
import { setupOdooBranch } from './odooInstaller';
import { SettingsStore } from './settingsStore';
import { VersionsTreeProvider } from './versionsTreeProvider';
import { VersionsService } from './versionsService';

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
        console.warn('Error initializing testing context:', error);
        updateTestingContext(false);
    }
}

export async function activate(context: vscode.ExtensionContext) {
    // Clear any existing disposables
    extensionDisposables.forEach(d => d.dispose());
    extensionDisposables = [];

    // Initialize version management service
    const versionsService = VersionsService.getInstance();
    await versionsService.initialize();

    // Migrate existing settings to version management for backwards compatibility
    // Wait for migration to complete to ensure proper initialization order
    await versionsService.migrateFromLegacySettings().catch(error => {
        console.warn('Settings migration failed (this is non-critical):', error);
    });

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
        versions: new VersionsTreeProvider()
    };

    // Register tree data providers and store disposables
    extensionDisposables.push(vscode.window.registerTreeDataProvider('projectSelector', providers.project));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('repoSelector', providers.repo));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('dbSelector', providers.db));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('moduleSelector', providers.module));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('testingSelector', providers.testing));
    extensionDisposables.push(vscode.window.registerTreeDataProvider('versionsManager', providers.versions));

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
            // Get settings from active version
            const settings = await versionsService.getActiveVersionSettings();

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
            // Get settings from active version
            const settings = await versionsService.getActiveVersionSettings();

            const projects = await SettingsStore.getProjects();
            const project = projects?.find((p: ProjectModel) => p.isSelected);
            if (!project) {
                throw new Error('No project selected');
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
            refreshAll();
        } catch (err: any) {
            showError(err.message);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.selectDb', async (event) => {
        try {
            await selectDatabase(event);
            refreshAll();
        } catch (err: any) {
            showError(`Failed to select database: ${err.message}`);
            console.error('Error in database selection:', err);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.delete', async (event) => {
        try {
            await deleteDb(event);
            refreshAll();
        } catch (err: any) {
            showError(`Failed to delete database: ${err.message}`);
            console.error('Error in database deletion:', err);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.restore', async (event) => {
        try {
            await restoreDb(event);
            refreshAll();
            showInfo(`Database ${event.name || event.id} restored successfully!`);
        } catch (err: any) {
            showError(`Failed to restore database: ${err.message}`);
            console.error('Error in database restoration:', err);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('dbSelector.changeVersion', async (event) => {
        try {
            await changeDatabaseVersion(event);
            refreshAll();
        } catch (err: any) {
            showError(`Failed to change database version: ${err.message}`);
            console.error('Error in database version change:', err);
        }
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

    // Context menu commands for individual modules
    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.setToInstall', async (event) => {
        await setModuleToInstall(event);
        refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.setToUpgrade', async (event) => {
        await setModuleToUpgrade(event);
        refreshAll();
    }));

    extensionDisposables.push(vscode.commands.registerCommand('moduleSelector.clearState', async (event) => {
        await clearModuleState(event);
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

    // Version management commands

    extensionDisposables.push(vscode.commands.registerCommand('odoo.createVersion', async () => {
        try {
            const name = await vscode.window.showInputBox({
                placeHolder: 'Enter version name (e.g., "Odoo 17.0 Production")',
                prompt: 'Version name'
            });
            if (!name) return;

            // Get Odoo path from active version settings
            const settings = await versionsService.getActiveVersionSettings();
            const odooPath = settings.odooPath;

            let odooVersion: string | undefined;

            if (odooPath) {
                // Try to get Git branches from the Odoo path
                const branches = await getGitBranches(odooPath);

                if (branches.length > 0) {
                    // Show branch selection
                    odooVersion = await vscode.window.showQuickPick(branches, {
                        placeHolder: 'Select Odoo version/branch',
                        title: 'Choose from available Git branches'
                    });
                } else {
                    // Fallback to manual input if no branches found
                    const result = await showWarning(
                        `No Git branches found in Odoo path: ${odooPath}. Would you like to enter the version manually?`,
                        'Enter Manually', 'Cancel'
                    );

                    if (result === 'Enter Manually') {
                        odooVersion = await vscode.window.showInputBox({
                            placeHolder: 'Enter Odoo version/branch (e.g., "17.0", "saas-17.4", "master")',
                            prompt: 'Odoo version/branch'
                        });
                    }
                }
            } else {
                // No Odoo path configured, show warning and fallback to manual input
                const result = await showWarning(
                    'Odoo path is not configured. Please set the Odoo path in settings first, or enter the version manually.',
                    'Enter Manually', 'Cancel'
                );

                if (result === 'Enter Manually') {
                    odooVersion = await vscode.window.showInputBox({
                        placeHolder: 'Enter Odoo version/branch (e.g., "17.0", "saas-17.4", "master")',
                        prompt: 'Odoo version/branch'
                    });
                }
            }

            if (!odooVersion) return;

            await versionsService.createVersion(name, odooVersion);
            showInfo(`Version "${name}" created successfully`);
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
                showError('No version selected');
                return;
            }

            const version = versionsService.getVersion(versionId);
            if (!version) {
                showError('Version not found');
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
                if (!selected) return;

                versionId = selected.versionId;
            }

            const success = await versionsService.setActiveVersion(versionId);
            if (success) {
                const version = versionsService.getVersion(versionId);
                showInfo(`Activated version: ${version?.name}`);
                refreshAll(); // Refresh all views to reflect new active version
            } else {
                showError('Failed to set active version');
            }
        } catch (error: any) {
            showError(`Failed to set active version: ${error.message}`);
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

        if (!devModeOption) return undefined;

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
                showError('Invalid parameters for edit setting command');
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

            if (newValue === undefined) return; // User cancelled

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
                if (!selected) return;

                versionId = selected.versionId;
            }

            const name = await vscode.window.showInputBox({
                placeHolder: 'Enter name for the cloned version',
                prompt: 'Version name'
            });
            if (!name) return;

            const clonedVersion = await versionsService.cloneVersion(versionId, name);
            if (clonedVersion) {
                showInfo(`Version "${name}" cloned successfully`);
            } else {
                showError('Failed to clone version');
            }
        } catch (error: any) {
            showError(`Failed to clone version: ${error.message}`);
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
                    showInfo('No versions available to delete (cannot delete active version)');
                    return;
                }

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select version to delete'
                });
                if (!selected) return;

                versionId = selected.versionId;
            }

            const version = versionsService.getVersion(versionId);
            if (!version) {
                showError('Version not found');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to delete version "${version.name}"?`,
                { modal: true },
                'Delete'
            );
            if (confirm !== 'Delete') return;

            const success = await versionsService.deleteVersion(versionId);
            if (success) {
                showInfo(`Version "${version.name}" deleted successfully`);
            } else {
                showError('Failed to delete version');
            }
        } catch (error: any) {
            showError(`Failed to delete version: ${error.message}`);
        }
    }));

    // Version settings context menu commands
    extensionDisposables.push(vscode.commands.registerCommand('odoo.setSettingToDefault', async (settingTreeItem?: any) => {
        try {
            if (!settingTreeItem) {
                showError('No setting selected');
                return;
            }

            // Extract version ID and setting key from the tree item
            const versionId = settingTreeItem.versionId;
            const settingKey = settingTreeItem.key;

            if (!versionId || !settingKey) {
                showError('Invalid setting selection');
                return;
            }

            const success = await versionsService.setSettingToDefault(versionId, settingKey);
            if (!success) {
                showError('Failed to reset setting to default value');
            }
        } catch (error: any) {
            showError(`Failed to reset setting to default: ${error.message}`);
        }
    }));

    extensionDisposables.push(vscode.commands.registerCommand('odoo.setSettingAsDefault', async (settingTreeItem?: any) => {
        try {
            if (!settingTreeItem) {
                showError('No setting selected');
                return;
            }

            // Extract version ID and setting key from the tree item
            const versionId = settingTreeItem.versionId;
            const settingKey = settingTreeItem.key;

            if (!versionId || !settingKey) {
                showError('Invalid setting selection');
                return;
            }

            const success = await versionsService.setSettingAsDefault(versionId, settingKey);
            if (!success) {
                showError('Failed to set setting as default');
            }
        } catch (error: any) {
            showError(`Failed to set setting as default: ${error.message}`);
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
                showError('No version selected');
                return;
            }

            const version = versionsService.getVersion(versionId);
            if (!version) {
                showError('Version not found');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to reset ALL settings for version "${version.name}" to their default values?`,
                'Reset All',
                'Cancel'
            );
            if (confirm !== 'Reset All') return;

            const success = await versionsService.setAllSettingsToDefault(versionId);
            if (!success) {
                showError('Failed to reset all settings to default values');
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
                showError('No version selected');
                return;
            }

            const version = versionsService.getVersion(versionId);
            if (!version) {
                showError('Version not found');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to save ALL settings from version "${version.name}" as new default values?`,
                'Save All as Default',
                'Cancel'
            );
            if (confirm !== 'Save All as Default') return;

            const success = await versionsService.setAllSettingsAsDefault(versionId);
            if (!success) {
                showError('Failed to save all settings as defaults');
            }
        } catch (error: any) {
            showError(`Failed to save all settings as defaults: ${error.message}`);
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
