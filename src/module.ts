import { ModuleModel } from "./models/module";
import { DatabaseModel } from "./models/db";
import * as vscode from "vscode";
import * as fs from 'fs';
import { listSubdirectories, showError, showInfo, showAutoInfo, normalizePath } from './utils';
import { SettingsStore } from './settingsStore';

export class ModuleTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    constructor(private context: vscode.ExtensionContext) {
        this.context = context;
    }
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }
    async getChildren(element?: any): Promise<vscode.TreeItem[] | undefined> {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            return [];
        }
        const { project } = result;
        const db: DatabaseModel | undefined = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
        if (!db) {
            showError('No database selected');
            return [];
        }
        const modules: ModuleModel[] = db.modules;
        if (!modules) {
            showError('No modules found');
            return [];
        }

        let allModules: {"path": string, "name": string, "repoName": string, "isPsaeInternal": boolean}[] = [];
        let psaeInternalDirs: {"path": string, "repoName": string}[] = [];

        // Add modules from regular repositories
        for (const repo of project.repos) {
            const repoModules = listSubdirectories(repo.path);
            allModules = allModules.concat(repoModules.map(module => ({
                ...module,
                repoName: repo.name,
                isPsaeInternal: false
            })));

            // Check for psae-internal in this repo and collect both the directory info and modules
            const psaeInternalPath = `${repo.path}/psae-internal`;
            if (fs.existsSync(psaeInternalPath) && fs.statSync(psaeInternalPath).isDirectory()) {
                // Add psae-internal directory as a special entry
                psaeInternalDirs.push({
                    path: psaeInternalPath,
                    repoName: repo.name
                });

                try {
                    const psaeModules = listSubdirectories(psaeInternalPath);
                    allModules = allModules.concat(psaeModules.map(module => ({
                        ...module,
                        repoName: repo.name,
                        isPsaeInternal: true
                    })));
                } catch (error) {
                    console.warn(`Failed to read psae-internal modules from ${psaeInternalPath}:`, error);
                }
            }
        }

        let treeItems: vscode.TreeItem[] = [];

        // Add psae-internal directories as special meta-modules
        for (const psaeDir of psaeInternalDirs) {
            const psaeInternalModules = allModules.filter(m =>
                m.isPsaeInternal && m.repoName === psaeDir.repoName
            );

            // Check if any modules from this psae-internal are selected OR if it's manually included
            const hasSelectedModules = psaeInternalModules.some(m =>
                modules.some(dbModule =>
                    dbModule.name === m.name && (dbModule.state === 'install' || dbModule.state === 'upgrade')
                )
            );

            const isManuallyIncluded = project.includedPsaeInternalPaths?.includes(psaeDir.path) || false;

            // Determine icon based on status
            let psaeIcon: string;
            let psaeTooltip: string;

            if (hasSelectedModules || isManuallyIncluded) {
                psaeIcon = '📦'; // Package icon when included in addons path
                if (hasSelectedModules && isManuallyIncluded) {
                    psaeTooltip = `psae-internal: Included (has selected modules + manually included)\nRepo: ${psaeDir.repoName}\nPath: ${psaeDir.path}\nClick to exclude from addons path`;
                } else if (hasSelectedModules) {
                    psaeTooltip = `psae-internal: Included (has selected modules)\nRepo: ${psaeDir.repoName}\nPath: ${psaeDir.path}\nClick to exclude from addons path`;
                } else {
                    psaeTooltip = `psae-internal: Included (manually)\nRepo: ${psaeDir.repoName}\nPath: ${psaeDir.path}\nClick to exclude from addons path`;
                }
            } else {
                psaeIcon = '📋'; // Clipboard icon when not included
                psaeTooltip = `psae-internal: Not included\nRepo: ${psaeDir.repoName}\nPath: ${psaeDir.path}\nClick to include in addons path`;
            }

            treeItems.push({
                label: `${psaeIcon} psae-internal`,
                tooltip: psaeTooltip,
                description: `${psaeDir.repoName} (${psaeInternalModules.length} modules)`,
                command: {
                    command: 'moduleSelector.togglePsaeInternalModule',
                    title: 'Toggle psae-internal',
                    arguments: [{
                        path: psaeDir.path,
                        repoName: psaeDir.repoName,
                        hasSelectedModules: hasSelectedModules,
                        isManuallyIncluded: isManuallyIncluded,
                        modules: psaeInternalModules
                    }]
                }
            });
        }

        // Add regular modules (excluding psae-internal from the name display since we show them separately)
        for (const module of allModules.filter(m => m.name !== 'psae-internal')) {
            const repoPath = module.isPsaeInternal ? `${module.repoName}/psae-internal` : module.repoName;
            const existingModule = modules.find(mod => mod.name === module.name);
            if (existingModule) {
                let moduleIcon: string;
                switch (existingModule.state) {
                    case 'install':
                        moduleIcon = '🟢';
                        break;
                    case 'upgrade':
                        moduleIcon = '🟡';
                        break;
                    default:
                        moduleIcon = '⚪';
                        break;
                }
                treeItems.push({
                    label: `${moduleIcon} ${module.name}`,
                    tooltip: `Module: ${module.name}\nState: ${existingModule.state}\nSource: ${repoPath}\nPath: ${module.path}`,
                    description: repoPath,
                    command: {
                        command: 'moduleSelector.select',
                        title: 'Select Module',
                        arguments: [{ name: module.name, path: module.path, state: existingModule.state, repoName: module.repoName, isPsaeInternal: module.isPsaeInternal }]
                    }
                });
            } else {
                // If the module does not exist, treat it as a new module
                treeItems.push({
                    label: `⚪ ${module.name}`,
                    tooltip: `Module: ${module.name}\nState: none\nSource: ${repoPath}\nPath: ${module.path}`,
                    description: repoPath,
                    command: {
                        command: 'moduleSelector.select',
                        title: 'Select Module',
                        arguments: [{ name: module.name, path: module.path, state: 'none', repoName: module.repoName, isPsaeInternal: module.isPsaeInternal }]
                    }
                });
            }
        }

        // Sort: psae-internal first, then 🟢 (install) and 🟡 (upgrade), then the rest
        treeItems.sort((a, b) => {
            const getPriority = (label: string | vscode.TreeItemLabel | undefined) => {
                if (typeof label === 'string') {
                    if (label.includes('psae-internal')) {return -1;} // psae-internal first
                    if (label.startsWith('🟢')) {return 0;}
                    if (label.startsWith('🟡')) {return 1;}
                }
                return 2;
            };
            return getPriority(a.label) - getPriority(b.label);
        });
        return treeItems;
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
        showError('No database selected');
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
    await SettingsStore.saveWithoutComments(data);
}

export async function togglePsaeInternalModule(event: any): Promise<void> {
    const { path: psaeInternalPath, repoName, hasSelectedModules, isManuallyIncluded, modules: psaeModules } = event;

    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }

    const { data, project } = result;
    const db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        showError('No database selected');
        return;
    }

    // Initialize includedPsaeInternalPaths if it doesn't exist (for backward compatibility)
    if (!project.includedPsaeInternalPaths) {
        project.includedPsaeInternalPaths = [];
    }

    if (hasSelectedModules || isManuallyIncluded) {
        // If it's included either way, we need to decide what to do
        if (hasSelectedModules && isManuallyIncluded) {
            // Both selected modules and manually included - remove manual inclusion but keep modules
            const pathIndex = project.includedPsaeInternalPaths.indexOf(psaeInternalPath);
            if (pathIndex > -1) {
                project.includedPsaeInternalPaths.splice(pathIndex, 1);
            }
            await SettingsStore.saveWithoutComments(data);
            showInfo(`Removed manual inclusion of psae-internal (${repoName}). Will still be included due to selected modules.`);
        } else if (hasSelectedModules) {
            // Only has selected modules - remove all modules
            const moduleNamesToRemove = psaeModules.map((m: any) => m.name);
            db.modules = db.modules.filter(dbModule => !moduleNamesToRemove.includes(dbModule.name));
            await SettingsStore.saveWithoutComments(data);
            showInfo(`Removed all modules from psae-internal (${repoName}) from the project`);
        } else {
            // Only manually included - remove manual inclusion
            const pathIndex = project.includedPsaeInternalPaths.indexOf(psaeInternalPath);
            if (pathIndex > -1) {
                project.includedPsaeInternalPaths.splice(pathIndex, 1);
            }
            await SettingsStore.saveWithoutComments(data);
            showInfo(`Excluded psae-internal (${repoName}) from addons path`);
        }
    } else {
        // Not included at all - add manual inclusion
        if (!project.includedPsaeInternalPaths.includes(psaeInternalPath)) {
            project.includedPsaeInternalPaths.push(psaeInternalPath);
        }
        await SettingsStore.saveWithoutComments(data);
        showInfo(`Included psae-internal (${repoName}) in addons path. Modules are now available for selection.`);
    }
}

export async function updateAllModules(): Promise<void> {
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        showError('No project selected');
        return;
    }

    const { data, project } = result;
    const db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        showError('No database selected');
        return;
    }

    // Get all available modules from repositories
    let allModules: {"path": string, "name": string, "repoName": string, "isPsaeInternal": boolean}[] = [];
    let psaeInternalDirs: {"path": string, "repoName": string}[] = [];

    // Add modules from regular repositories
    for (const repo of project.repos) {
        const repoModules = listSubdirectories(repo.path);
        allModules = allModules.concat(repoModules.map(module => ({
            ...module,
            repoName: repo.name,
            isPsaeInternal: false
        })));

        // Check if this repo has psae-internal directory
        const psaeInternalPath = normalizePath(`${repo.path}/psae-internal`);
        if (fs.existsSync(psaeInternalPath)) {
            psaeInternalDirs.push({ path: psaeInternalPath, repoName: repo.name });
        }
    }

    // Add modules from included psae-internal directories
    if (project.includedPsaeInternalPaths) {
        for (const psaePath of project.includedPsaeInternalPaths) {
            if (fs.existsSync(psaePath)) {
                const repoDir = psaeInternalDirs.find(dir => dir.path === psaePath);
                const repoName = repoDir ? repoDir.repoName : 'unknown';
                const psaeModules = listSubdirectories(psaePath);
                allModules = allModules.concat(psaeModules.map(module => ({
                    ...module,
                    repoName: repoName,
                    isPsaeInternal: true
                })));
            }
        }
    }

    const availableModules = allModules.filter(m => m.name !== 'psae-internal');

    if (availableModules.length === 0) {
        showInfo('No modules available to update');
        return;
    }

    // Confirm action
    const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to set all ${availableModules.length} available modules to "upgrade" state regardless of their current state?`,
        { modal: true },
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

    await SettingsStore.saveWithoutComments(data);
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
        showError('No project selected');
        return;
    }

    const { data, project } = result;
    const db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        showError('No database selected');
        return;
    }

    if (!db.modules || db.modules.length === 0) {
        showInfo('No modules found to update');
        return;
    }

    const installedModules = db.modules.filter(module => module.state === 'install');
    if (installedModules.length === 0) {
        showInfo('No modules with "install" state found to update');
        return;
    }

    // Confirm action
    const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to set all ${installedModules.length} modules with "install" state to "upgrade" state?`,
        { modal: true },
        'Update Installed'
    );

    if (confirm !== 'Update Installed') {
        return;
    }

    // Set only installed modules to upgrade state
    installedModules.forEach(module => {
        module.state = 'upgrade';
    });

    await SettingsStore.saveWithoutComments(data);
    showAutoInfo(`${installedModules.length} installed modules set to upgrade state`, 3000);
}

export async function installAllModules(): Promise<void> {
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        showError('No project selected');
        return;
    }

    const { data, project } = result;
    const db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        showError('No database selected');
        return;
    }

    // Get all available modules from repositories
    let allModules: {"path": string, "name": string, "repoName": string, "isPsaeInternal": boolean}[] = [];
    let psaeInternalDirs: {"path": string, "repoName": string}[] = [];

    // Add modules from regular repositories
    for (const repo of project.repos) {
        const repoModules = listSubdirectories(repo.path);
        allModules = allModules.concat(repoModules.map(module => ({
            ...module,
            repoName: repo.name,
            isPsaeInternal: false
        })));

        // Check if this repo has psae-internal directory
        const psaeInternalPath = normalizePath(`${repo.path}/psae-internal`);
        if (fs.existsSync(psaeInternalPath)) {
            psaeInternalDirs.push({ path: psaeInternalPath, repoName: repo.name });
        }
    }

    // Add modules from included psae-internal directories
    if (project.includedPsaeInternalPaths) {
        for (const psaePath of project.includedPsaeInternalPaths) {
            if (fs.existsSync(psaePath)) {
                const repoDir = psaeInternalDirs.find(dir => dir.path === psaePath);
                const repoName = repoDir ? repoDir.repoName : 'unknown';
                const psaeModules = listSubdirectories(psaePath);
                allModules = allModules.concat(psaeModules.map(module => ({
                    ...module,
                    repoName: repoName,
                    isPsaeInternal: true
                })));
            }
        }
    }

    const availableModules = allModules.filter(m => m.name !== 'psae-internal');

    if (availableModules.length === 0) {
        showInfo('No modules available to install');
        return;
    }

    // Confirm action
    const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to set all ${availableModules.length} available modules to "install" state?`,
        { modal: true },
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

    await SettingsStore.saveWithoutComments(data);
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
        showError('No project selected');
        return;
    }

    const { data, project } = result;
    const db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        showError('No database selected');
        return;
    }

    if (!db.modules || db.modules.length === 0) {
        return; // Silently return if no modules to clear
    }

    // Confirm action
    const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to clear all ${db.modules.length} selected modules?`,
        { modal: true },
        'Clear All'
    );

    if (confirm !== 'Clear All') {
        return;
    }

    // Clear all module selections
    const clearedCount = db.modules.length;
    db.modules = [];

    await SettingsStore.saveWithoutComments(data);
    showAutoInfo(`Cleared ${clearedCount} module selections`, 3000);
}
