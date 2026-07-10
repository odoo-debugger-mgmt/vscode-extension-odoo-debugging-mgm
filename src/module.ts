/**
 * Modules view and module workflows: discovery across project repos,
 * install/upgrade state management, psae-internal groups, manifest
 * dependencies, bulk actions and odoo-bin scaffolding.
 */
import { ModuleModel, InstalledModuleInfo } from "./models/module";
import { DatabaseModel } from "./models/db";
import { RepoModel } from "./models/repo";
import * as vscode from "vscode";
import { showError, showInfo, showAutoInfo, stripSettings, createInfoTreeItem, getDatabaseLabel, normalizePath } from './utils';
import { collectModuleDiscovery, resolvePsaeDirectories, setPsaeDirectoryIncluded, PSAE_INTERNAL_REGEX, PsaeDirectoryState } from './services/psaeInternal';

import * as fs from 'node:fs';
import * as path from 'node:path';

import { SettingsStore } from './settingsStore';
import { getInstalledModuleNames, getInstalledModules } from './services/database';
import { SortPreferences } from './sortPreferences';
import { getDefaultSortOption } from './sortOptions';
import { VersionsService } from './versionsService';
import { showModalWarning } from './services/notifications';
import { BaseTreeProvider } from './views/baseTreeProvider';
import { runCommand, tryRunCommand } from './services/process';
import { errorMessage } from './services/logger';
import { readModuleManifest } from './services/manifest';

interface ModuleData {
    name: string;
    path: string;
    state: string;
    repoName: string;
    isPsaeInternal: boolean;
    isInstalled: boolean;
}

type ModuleTreeNode = vscode.TreeItem & {
    moduleData?: ModuleData;
    psaeState?: PsaeDirectoryState;
    psaeChildren?: ModuleTreeNode[];
};

const CORE_HINT = 'Core/other module (not in this project\'s repos)';

export class ModuleTreeProvider extends BaseTreeProvider<vscode.TreeItem> {

    constructor(_context: vscode.ExtensionContext, private sortPreferences: SortPreferences) {
        super();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    /** Module names discovered in the project's repos (for dependency hints). */
    private knownModuleNames = new Set<string>();

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[] | undefined> {
        if (element) {
            const node = element as ModuleTreeNode;
            if (node.psaeChildren) {
                return node.psaeChildren;
            }
            if (node.moduleData) {
                return this.buildDependencyItems(node.moduleData);
            }
            return [];
        }

        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            return [createInfoTreeItem('Select a project to manage modules.')];
        }
        const { project } = result;
        const db: DatabaseModel | undefined = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
        if (!db) {
            return [createInfoTreeItem('Select a database to view modules.')];
        }
        const modules: ModuleModel[] = db.modules;
        if (!modules) {
            return [createInfoTreeItem('No modules configured for this database.')];
        }

        const isTestingEnabled = !!(project.testingConfig && project.testingConfig.isEnabled);

        const { modules: allModules, psaeDirectories } = collectModuleDiscovery(project);
        this.knownModuleNames = new Set(allModules.map(module => module.name));
        const installedModuleNames = await getInstalledModuleNames(db.id);
        const dbModulesByName = new Map(modules.map(module => [module.name, module]));
        const selectedDbModuleNames = new Set(
            modules
                .filter(module => module.state === 'install' || module.state === 'upgrade')
                .map(module => module.name)
        );

        const psaeStates = resolvePsaeDirectories({
            psaeDirectories,
            includedPsaeInternalPaths: project.includedPsaeInternalPaths,
            selectedModuleNames: selectedDbModuleNames,
            installedModuleNames
        });

        const buildModuleNode = (module: { name: string; path: string; repoName: string; isPsaeInternal: boolean; psInternalDirName?: string }): ModuleTreeNode => {
            const repoPath = module.isPsaeInternal ? `${module.repoName}/${module.psInternalDirName}` : module.repoName;
            const managed = dbModulesByName.get(module.name);
            const isInstalledInDb = installedModuleNames.has(module.name);
            if (managed) {
                managed.isInstalled = isInstalledInDb;
            }
            const state = managed?.state ?? 'none';

            // Collapsed: expanding a module lazily lists its manifest dependencies.
            const item: ModuleTreeNode = new vscode.TreeItem(module.name, vscode.TreeItemCollapsibleState.Collapsed);
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

            const moduleData: ModuleData = {
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

        const treeItems: ModuleTreeNode[] = [];

        if (isTestingEnabled) {
            const testingModeItem: ModuleTreeNode = new vscode.TreeItem(
                'Module management disabled (testing mode)',
                vscode.TreeItemCollapsibleState.None
            );
            testingModeItem.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
            testingModeItem.tooltip = 'Testing is enabled. Disable testing in the Testing view to manage modules again.';
            testingModeItem.contextValue = 'info';
            treeItems.push(testingModeItem);
        }

        // psae-internal directories become collapsible groups with their
        // modules as children; the toggle lives on the group.
        const modulesByPsaeDir = new Map<string, typeof allModules>();
        for (const module of allModules) {
            if (!module.isPsaeInternal || !module.psInternalDirPath) {
                continue;
            }
            const key = normalizePath(module.psInternalDirPath);
            const existing = modulesByPsaeDir.get(key) ?? [];
            existing.push(module);
            modulesByPsaeDir.set(key, existing);
        }

        for (const psaeState of psaeStates) {
            const members = (modulesByPsaeDir.get(psaeState.path) ?? [])
                .filter(m => !PSAE_INTERNAL_REGEX.test(m.name))
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

            const parent: ModuleTreeNode = new vscode.TreeItem(psaeState.dirName, vscode.TreeItemCollapsibleState.Collapsed);
            parent.id = psaeState.path;
            parent.iconPath = psaeState.isIncluded
                ? new vscode.ThemeIcon('package', new vscode.ThemeColor('charts.green'))
                : new vscode.ThemeIcon('package');
            parent.description = `${psaeState.repoName} • ${members.length} modules • ${psaeState.isIncluded ? 'in addons path' : 'excluded'}`;
            parent.contextValue = isTestingEnabled ? 'psaeDirectoryDisabled' : 'psaeDirectory';

            const reasons: string[] = [];
            if (psaeState.isManuallyIncluded) { reasons.push('manually included'); }
            if (psaeState.isManuallyExcluded) { reasons.push('manually excluded'); }
            if (psaeState.hasSelectedModules) { reasons.push('has selected modules'); }
            if (psaeState.hasDbModules) { reasons.push('has database modules'); }
            parent.tooltip = [
                `${psaeState.dirName}: ${psaeState.isIncluded ? 'Included in addons path' : 'Not included'}${reasons.length ? ` (${reasons.join(' + ')})` : ''}`,
                `Repo: ${psaeState.repoName}`,
                `Path: ${psaeState.path}`,
                isTestingEnabled ? 'Module management disabled while testing is enabled' : 'Use the toggle action to include/exclude it'
            ].join('\n');

            parent.psaeState = psaeState;
            parent.psaeChildren = members.map(buildModuleNode);
            treeItems.push(parent);
        }

        // Regular (non-psae) modules at the root.
        const regularModules = allModules
            .filter(m => !m.isPsaeInternal && !PSAE_INTERNAL_REGEX.test(m.name))
            .map(buildModuleNode);

        const sortId = this.sortPreferences.get('moduleSelector', getDefaultSortOption('moduleSelector'));
        regularModules.sort((a, b) => this.compareModules(a, b, sortId));

        treeItems.push(...regularModules);
        return treeItems;
    }

    /** Lazily lists a module's manifest dependencies (one level deep). */
    private async buildDependencyItems(moduleData: ModuleData): Promise<vscode.TreeItem[]> {
        const manifest = await readModuleManifest(moduleData.path);
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

    private getModuleIcon(state: string, isInstalled: boolean): vscode.ThemeIcon {
        switch (state) {
            case 'install':
                return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
            case 'upgrade':
                return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow'));
            default:
                return isInstalled
                    ? new vscode.ThemeIcon('circle-filled')
                    : new vscode.ThemeIcon('circle-outline');
        }
    }

    private compareModules(itemA: ModuleTreeNode, itemB: ModuleTreeNode, sortId: string): number {
        const dataA = itemA.moduleData;
        const dataB = itemB.moduleData;

        if (!dataA || !dataB) {
            return 0;
        }

        const nameCompare = dataA.name.localeCompare(dataB.name);
        const repoCompare = (dataA.repoName || '').localeCompare(dataB.repoName || '');
        const statePriority = (state: string) => {
            if (state === 'install') {return 0;}
            if (state === 'upgrade') {return 1;}
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

export async function selectModule(event: any) {
    const module = event;
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    const db: DatabaseModel | undefined = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        void showError('Select a database before running this action.');
        return;
    }

    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        void showError('Disable testing mode before changing module selections.');
        return;
    }
    const moduleExistsInDb = db.modules.find(mod => mod.name === module.name);
    if (!moduleExistsInDb) {
        db.modules.push(new ModuleModel(module.name, 'install'));
    } else {
        if (moduleExistsInDb.state === 'install') {
            moduleExistsInDb.state = 'upgrade';
        } else {
            db.modules = db.modules.filter(mod => mod.name !== module.name);
        }
    }
    await SettingsStore.saveWithoutComments(stripSettings(data));
}

async function runScaffoldCommand(
    pythonPath: string,
    odooBinPath: string,
    moduleName: string,
    targetPath: string
): Promise<void> {
    try {
        await runCommand(pythonPath, [odooBinPath, 'scaffold', moduleName, targetPath]);
    } catch (error) {
        throw new Error(`Scaffold command failed: ${errorMessage(error)}`);
    }
}

async function resolveRepositoryRoot(repoPath: string): Promise<string> {
    const resolved = await tryRunCommand('git', ['-C', repoPath, 'rev-parse', '--show-toplevel']);
    if (resolved && fs.existsSync(resolved)) {
        return resolved;
    }
    // Fall back to the selected path if git resolution is unavailable.
    return repoPath;
}


export async function createModuleFromScaffold(): Promise<void> {
    const projectResult = await SettingsStore.getSelectedProject();
    if (!projectResult) {
        return;
    }

    const targetProject = projectResult.project;

    const projectRepos = (targetProject.repos ?? []) as RepoModel[];
    if (projectRepos.length === 0) {
        void showError(`Project "${targetProject.name}" has no selected repositories.`);
        return;
    }

    let targetRepo: RepoModel | undefined;
    if (projectRepos.length === 1) {
        targetRepo = projectRepos[0];
    } else {
        const selectedRepo = await vscode.window.showQuickPick(
            projectRepos.map(repo => ({
                label: repo.name,
                description: repo.path,
                detail: 'Scaffold destination repository',
                repo
            })),
            {
                placeHolder: `Select destination repository for "${targetProject.name}"`,
                ignoreFocusOut: true
            }
        );
        if (!selectedRepo) {
            return;
        }
        targetRepo = selectedRepo.repo;
    }

    if (!targetRepo) {
        void showError('Select a destination repository.');
        return;
    }

    const versionsService = VersionsService.getInstance();
    const settings = await versionsService.getActiveVersionSettings();

    const normalizedPythonPath = normalizePath(settings.pythonPath);
    const normalizedOdooPath = normalizePath(settings.odooPath);
    const destinationPath = normalizePath(targetRepo.path);
    const repositoryRootPath = await resolveRepositoryRoot(destinationPath);
    const odooBinPath = path.join(normalizedOdooPath, 'odoo-bin');

    if (!normalizedPythonPath || !fs.existsSync(normalizedPythonPath)) {
        void showError(`Python executable not found: ${normalizedPythonPath}`);
        return;
    }

    if (!normalizedOdooPath || !fs.existsSync(normalizedOdooPath)) {
        void showError(`Odoo path not found: ${normalizedOdooPath}`);
        return;
    }

    if (!fs.existsSync(odooBinPath)) {
        void showError(`odoo-bin not found at: ${odooBinPath}`);
        return;
    }

    if (!repositoryRootPath || !fs.existsSync(repositoryRootPath)) {
        void showError(`Destination repository path not found: ${repositoryRootPath}`);
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
            await runScaffoldCommand(
                normalizedPythonPath,
                odooBinPath,
                sanitizedModuleName,
                repositoryRootPath
            );
        });

        showAutoInfo(
            `Module "${sanitizedModuleName}" created in ${repositoryRootPath}`,
            3500
        );
    } catch (error: any) {
        void showError(`Failed to scaffold module "${sanitizedModuleName}": ${error.message}`);
    }
}

/**
 * Set a module to 'install' state
 */
export async function setModuleToInstall(event: any): Promise<void> {
    const moduleData = event.moduleData || event;
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    const db: DatabaseModel | undefined = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        void showError('Select a database before running this action.');
        return;
    }

    // Check if testing is enabled
    if (project.testingConfig && project.testingConfig.isEnabled) {
        void showError('Disable testing mode before changing module selections.');
        return;
    }

    const moduleExistsInDb = db.modules.find(mod => mod.name === moduleData.name);
    if (!moduleExistsInDb) {
        db.modules.push(new ModuleModel(moduleData.name, 'install'));
        showAutoInfo(`Module "${moduleData.name}" set to install`, 2000);
    } else {
        moduleExistsInDb.state = 'install';
        showAutoInfo(`Module "${moduleData.name}" state changed to install`, 2000);
    }
    await SettingsStore.saveWithoutComments(stripSettings(data));
}

/**
 * Set a module to 'upgrade' state
 */
export async function setModuleToUpgrade(event: any): Promise<void> {
    const moduleData = event.moduleData || event;
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    const db: DatabaseModel | undefined = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        void showError('Select a database before running this action.');
        return;
    }

    // Check if testing is enabled
    if (project.testingConfig && project.testingConfig.isEnabled) {
        void showError('Disable testing mode before changing module selections.');
        return;
    }

    const moduleExistsInDb = db.modules.find(mod => mod.name === moduleData.name);
    if (!moduleExistsInDb) {
        db.modules.push(new ModuleModel(moduleData.name, 'upgrade'));
        showAutoInfo(`Module "${moduleData.name}" set to upgrade`, 2000);
    } else {
        moduleExistsInDb.state = 'upgrade';
        showAutoInfo(`Module "${moduleData.name}" state changed to upgrade`, 2000);
    }
    await SettingsStore.saveWithoutComments(stripSettings(data));
}

/**
 * Clear a module's state (remove from managed modules)
 */
export async function clearModuleState(event: any): Promise<void> {
    const moduleData = event.moduleData || event;
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    const db: DatabaseModel | undefined = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        void showError('Select a database before running this action.');
        return;
    }

    // Check if testing is enabled
    if (project.testingConfig && project.testingConfig.isEnabled) {
        void showError('Disable testing mode before changing module selections.');
        return;
    }

    const moduleExistsInDb = db.modules.find(mod => mod.name === moduleData.name);
    if (moduleExistsInDb) {
        db.modules = db.modules.filter(mod => mod.name !== moduleData.name);
        showAutoInfo(`Module "${moduleData.name}" state cleared`, 2000);
    } else {
        showAutoInfo(`Module "${moduleData.name}" was already not managed`, 1500);
    }
    await SettingsStore.saveWithoutComments(stripSettings(data));
}

export async function togglePsaeInternalModule(event: unknown): Promise<void> {
    const state = (event as { psaeState?: PsaeDirectoryState })?.psaeState;
    if (!state) {
        void showError('Could not identify the psae-internal directory to toggle.');
        return;
    }

    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }

    const { data, project } = result;
    const db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        void showError('Select a database before running this action.');
        return;
    }

    if (project.testingConfig && project.testingConfig.isEnabled) {
        void showError('Disable testing mode before changing module selections.');
        return;
    }

    const include = !state.isIncluded;
    const { removedModuleNames } = setPsaeDirectoryIncluded(project, state, include);
    if (removedModuleNames.length > 0) {
        db.modules = db.modules.filter(dbModule => !removedModuleNames.includes(dbModule.name));
    }

    await SettingsStore.saveWithoutComments(stripSettings(data));

    if (include) {
        showAutoInfo(`Included ${state.dirName} (${state.repoName}) in the addons path`, 2500);
    } else if (removedModuleNames.length > 0) {
        showAutoInfo(`Excluded ${state.dirName} (${state.repoName}) and cleared ${removedModuleNames.length} selected module(s)`, 3000);
    } else {
        showAutoInfo(`Excluded ${state.dirName} (${state.repoName}) from the addons path`, 2500);
    }
}

export async function updateAllModules(): Promise<void> {
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        void showError('Select a project before running this action.');
        return;
    }

    const { data, project } = result;
    const db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        void showError('Select a database before running this action.');
        return;
    }

    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        void showError('Disable testing mode before changing module selections.');
        return;
    }

    const { modules: allModules } = collectModuleDiscovery(project);

    const availableModules = allModules.filter(m => !PSAE_INTERNAL_REGEX.test(m.name));

    if (availableModules.length === 0) {
        void showInfo('No modules are available to update.');
        return;
    }

    // Confirm action
    const confirm = await showModalWarning(
        `Are you sure you want to set all ${availableModules.length} available modules to "upgrade" state regardless of their current state?`,
        'Update All'
    );

    if (confirm !== 'Update All') {
        return;
    }

    // Set all modules to upgrade state (add new ones or update existing ones)
    let addedCount = 0;
    let updatedCount = 0;

    for (const module of availableModules) {
        const existingModule = db.modules.find(mod => mod.name === module.name);
        if (!existingModule) {
            db.modules.push(new ModuleModel(module.name, 'upgrade'));
            addedCount++;
        } else if (existingModule.state !== 'upgrade') {
            existingModule.state = 'upgrade';
            updatedCount++;
        }
    }

    await SettingsStore.saveWithoutComments(stripSettings(data));
    const message = addedCount > 0 && updatedCount > 0
        ? `Added ${addedCount} new modules and updated ${updatedCount} existing modules to "upgrade" state (${db.modules.length} total)`
        : addedCount > 0
        ? `Added ${addedCount} modules for upgrade (${db.modules.length} total modules selected)`
        : updatedCount > 0
        ? `Updated ${updatedCount} modules to "upgrade" state`
        : `All ${availableModules.length} modules already set to "upgrade" state`;

    showAutoInfo(message, 4000);
}

export async function updateInstalledModules(): Promise<void> {
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        void showError('Select a project before running this action.');
        return;
    }

    const { data, project } = result;
    const db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        void showError('Select a database before running this action.');
        return;
    }

    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        void showError('Disable testing mode before changing module selections.');
        return;
    }

    if (!db.modules || db.modules.length === 0) {
        void showInfo('No modules are configured for this database to update');
        return;
    }

    const installedModules = db.modules.filter(module => module.state === 'install');
    if (installedModules.length === 0) {
        void showInfo('No modules are currently marked with the "install" state.');
        return;
    }

    // Confirm action
    const confirm = await showModalWarning(
        `Are you sure you want to set all ${installedModules.length} modules with "install" state to "upgrade" state?`,
        'Update Installed'
    );

    if (confirm !== 'Update Installed') {
        return;
    }

    // Set only installed modules to upgrade state
    installedModules.forEach(module => {
        module.state = 'upgrade';
    });

    await SettingsStore.saveWithoutComments(stripSettings(data));
    showAutoInfo(`${installedModules.length} installed modules set to upgrade state`, 3000);
}

export async function installAllModules(): Promise<void> {
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        void showError('Select a project before running this action.');
        return;
    }

    const { data, project } = result;
    const db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        void showError('Select a database before running this action.');
        return;
    }

    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        void showError('Disable testing mode before changing module selections.');
        return;
    }

    const { modules: allModules } = collectModuleDiscovery(project);

    const availableModules = allModules.filter(m => !PSAE_INTERNAL_REGEX.test(m.name));

    if (availableModules.length === 0) {
        void showInfo('No modules are available to install.');
        return;
    }

    // Confirm action
    const confirm = await showModalWarning(
        `Are you sure you want to set all ${availableModules.length} available modules to "install" state?`,
        'Install All'
    );

    if (confirm !== 'Install All') {
        return;
    }

    // Set all modules to install state (add new ones or update existing ones)
    let addedCount = 0;
    let updatedCount = 0;

    for (const module of availableModules) {
        const existingModule = db.modules.find(mod => mod.name === module.name);
        if (!existingModule) {
            db.modules.push(new ModuleModel(module.name, 'install'));
            addedCount++;
        } else if (existingModule.state !== 'install') {
            existingModule.state = 'install';
            updatedCount++;
        }
    }

    await SettingsStore.saveWithoutComments(stripSettings(data));
    const message = addedCount > 0 && updatedCount > 0
        ? `Added ${addedCount} new modules and updated ${updatedCount} existing modules to "install" state (${db.modules.length} total)`
        : addedCount > 0
        ? `Added ${addedCount} modules for installation (${db.modules.length} total modules selected)`
        : updatedCount > 0
        ? `Updated ${updatedCount} modules to "install" state`
        : `All ${availableModules.length} modules already set to "install" state`;

    showAutoInfo(message, 4000);
}

export async function clearAllModuleSelections(): Promise<void> {
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        void showError('Select a project before running this action.');
        return;
    }

    const { data, project } = result;
    const db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        void showError('Select a database before running this action.');
        return;
    }

    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        void showError('Disable testing mode before changing module selections.');
        return;
    }

    if (!db.modules || db.modules.length === 0) {
        return; // Silently return if no modules to clear
    }

    // Confirm action
    const confirm = await showModalWarning(
        `Are you sure you want to clear all ${db.modules.length} selected modules?`,
        'Clear All'
    );

    if (confirm !== 'Clear All') {
        return;
    }

    // Clear all module selections
    const clearedCount = db.modules.length;
    db.modules = [];

    await SettingsStore.saveWithoutComments(stripSettings(data));
    showAutoInfo(`Cleared ${clearedCount} module selections`, 3000);
}
export async function viewInstalledModules(): Promise<void> {
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        void showError('Select a project before running this action.');
        return;
    }

    const { project } = result;
    const db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        void showError('Select a database before running this action.');
        return;
    }

    try {
        // Get all installed modules from database
        const installedModules = await getInstalledModules(db.id);

        if (installedModules.length === 0) {
            void showInfo('No installed modules were found in the database');
            return;
        }

        // Create quick pick items with detailed information
        const quickPickItems = installedModules.map((module: InstalledModuleInfo) => ({
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
            title: `Installed Modules in ${getDatabaseLabel(db)}`
        });

    } catch (error) {
        void showError(`Failed to retrieve installed modules: ${error}`);
    }
}
