import { ModuleModel, InstalledModuleInfo } from "./models/module";
import { DatabaseModel } from "./models/db";
import * as vscode from "vscode";
import * as fs from 'fs';
import { listSubdirectories, showError, showInfo, showAutoInfo, normalizePath } from './utils';
import { SettingsStore } from './settingsStore';
import { execSync } from 'child_process';

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

        // Check if testing is enabled
        const isTestingEnabled = project.testingConfig && project.testingConfig.isEnabled;

        // Get installed modules from database
        const installedModules = await getInstalledModules(db.id);
        const installedModuleNames = new Set(installedModules.map(m => m.name));

        let allModules: {"path": string, "name": string, "repoName": string, "isPsaeInternal": boolean, "psInternalDirName"?: string}[] = [];
        let psaeInternalDirs: {"path": string, "repoName": string, "dirName": string}[] = [];

        // Add modules from regular repositories
        for (const repo of project.repos) {
            const repoModules = listSubdirectories(repo.path);
            allModules = allModules.concat(repoModules.map(module => ({
                ...module,
                repoName: repo.name,
                isPsaeInternal: false
            })));

            // Check for ps*-internal directories in this repo
            try {
                const repoDirContents = fs.readdirSync(repo.path);
                for (const item of repoDirContents) {
                    // Match pattern: ps followed by any letters, then -internal
                    if (/^ps[a-z]*-internal$/i.test(item)) {
                        const psInternalPath = `${repo.path}/${item}`;
                        if (fs.existsSync(psInternalPath) && fs.statSync(psInternalPath).isDirectory()) {
                            // Add ps*-internal directory as a special entry
                            psaeInternalDirs.push({
                                path: psInternalPath,
                                repoName: repo.name,
                                dirName: item
                            });

                            try {
                                const psModules = listSubdirectories(psInternalPath);
                                allModules = allModules.concat(psModules.map(module => ({
                                    ...module,
                                    repoName: repo.name,
                                    isPsaeInternal: true,
                                    psInternalDirName: item
                                })));
                            } catch (error) {
                                console.warn(`Failed to read ${item} modules from ${psInternalPath}:`, error);
                            }
                        }
                    }
                }
            } catch (error) {
                console.warn(`Failed to read repo directory ${repo.path}:`, error);
            }
        }

        let treeItems: vscode.TreeItem[] = [];

        // ALWAYS add testing mode notification first when testing is enabled
        if (isTestingEnabled) {
            const testingModeItem = new vscode.TreeItem(
                '⚠️ Module Management Disabled (Testing Mode)',
                vscode.TreeItemCollapsibleState.None
            );
            testingModeItem.tooltip = 'Testing is enabled. Disable testing to manage modules again.';
            testingModeItem.description = 'Go to Testing tab to disable';
            treeItems.push(testingModeItem);
        }

        // Add psae-internal directories as special meta-modules
        for (const psaeDir of psaeInternalDirs) {
            const psaeInternalModules = allModules.filter(m =>
                m.isPsaeInternal && m.repoName === psaeDir.repoName && m.psInternalDirName === psaeDir.dirName
            );

            // Check if any modules from this ps*-internal are selected OR installed in DB
            const hasSelectedModules = psaeInternalModules.some(m =>
                modules.some(dbModule =>
                    dbModule.name === m.name && (dbModule.state === 'install' || dbModule.state === 'upgrade')
                )
            );

            const hasInstalledModules = psaeInternalModules.some(m =>
                installedModuleNames.has(m.name)
            );

            const isManuallyIncluded = project.includedPsaeInternalPaths?.includes(psaeDir.path) || false;

            // Manual override has highest priority
            // If manually included: always included regardless of modules
            // If manually excluded: never auto-include regardless of modules
            // If not manually set: auto-include if has selected OR installed modules
            const shouldBeIncluded = isManuallyIncluded || (!project.includedPsaeInternalPaths?.includes(`!${psaeDir.path}`) && (hasSelectedModules || hasInstalledModules));

            // Determine icon and tooltip based on status
            let psaeIcon: string;
            let psaeTooltip: string;

            if (shouldBeIncluded) {
                psaeIcon = '📦'; // Package icon when included in addons path
                const reasons = [];
                if (isManuallyIncluded) reasons.push('manually included');
                if (hasSelectedModules) reasons.push('has selected modules');
                if (hasInstalledModules) reasons.push('has installed modules');

                psaeTooltip = `${psaeDir.dirName}: Included (${reasons.join(' + ')})\nRepo: ${psaeDir.repoName}\nPath: ${psaeDir.path}\nClick to exclude from addons path`;
            } else {
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
                        hasInstalledModules: hasInstalledModules,
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

                let moduleIcon: string;

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

                treeItems.push({
                    label: `${moduleIcon} ${module.name}`,
                    tooltip: `Module: ${module.name}\nState: ${existingModule.state}\nSource: ${repoPath}\nPath: ${module.path}`,
                    description: repoPath,
                    command: isTestingEnabled ? undefined : {
                        command: 'moduleSelector.select',
                        title: 'Select Module',
                        arguments: [{ name: module.name, path: module.path, state: existingModule.state, repoName: module.repoName, isPsaeInternal: module.isPsaeInternal, isInstalled: existingModule.isInstalled }]
                    }
                });
            } else {
                // Module not in our managed list
                const moduleIcon = isInstalledInDb ? '⚫' : '⚪'; // Black circle for installed, white for not installed
                const moduleState = isInstalledInDb ? 'Installed' : 'none';

                treeItems.push({
                    label: `${moduleIcon} ${module.name}`,
                    tooltip: `Module: ${module.name}\nState: ${moduleState}\nSource: ${repoPath}\nPath: ${module.path}`,
                    description: repoPath,
                    command: isTestingEnabled ? undefined : {
                        command: 'moduleSelector.select',
                        title: 'Select Module',
                        arguments: [{ name: module.name, path: module.path, state: 'none', repoName: module.repoName, isPsaeInternal: module.isPsaeInternal, isInstalled: isInstalledInDb }]
                    }
                });
            }
        }

        // Sort: Testing warning first, then ps*-internal, then 🟢 (install) and 🟡 (upgrade), then the rest
        treeItems.sort((a, b) => {
            const getPriority = (label: string | vscode.TreeItemLabel | undefined) => {
                if (typeof label === 'string') {
                    if (label.includes('⚠️ Module Management Disabled (Testing Mode)')) {return -2;} // Warning message first
                    if (/ps[a-z]*-internal/i.test(label)) {return -1;} // ps*-internal second
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

    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        showError('Module management is disabled while testing is enabled. Disable testing to manage modules.');
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
    const {
        path: psaeInternalPath,
        repoName,
        dirName,
        hasSelectedModules,
        hasInstalledModules,
        isManuallyIncluded,
        shouldBeIncluded,
        modules: psaeModules
    } = event;

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

    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        showError('Module management is disabled while testing is enabled. Disable testing to manage modules.');
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
                const moduleNamesToRemove = psaeModules.map((m: any) => m.name);
                db.modules = db.modules.filter(dbModule => !moduleNamesToRemove.includes(dbModule.name));
                await SettingsStore.saveWithoutComments(data);
                showInfo(`Manually excluded ${dirName} (${repoName}) and removed selected modules from addons path`);
            } else {
                await SettingsStore.saveWithoutComments(data);
                showInfo(`Removed manual inclusion of ${dirName} (${repoName})`);
            }
        } else {
            // Currently auto-included - add manual exclusion to override and remove selected modules
            project.includedPsaeInternalPaths.push(excludePath);
            // Remove selected modules from this psae-internal directory
            const moduleNamesToRemove = psaeModules.map((m: any) => m.name);
            db.modules = db.modules.filter(dbModule => !moduleNamesToRemove.includes(dbModule.name));
            await SettingsStore.saveWithoutComments(data);
            showInfo(`Manually excluded ${dirName} (${repoName}) and removed selected modules from addons path`);
        }
    } else {
        if (isManuallyExcluded) {
            // Currently manually excluded - remove exclusion (may auto-include)
            const pathIndex = project.includedPsaeInternalPaths.indexOf(excludePath);
            if (pathIndex > -1) {
                project.includedPsaeInternalPaths.splice(pathIndex, 1);
            }
            await SettingsStore.saveWithoutComments(data);
            if (hasSelectedModules || hasInstalledModules) {
                showInfo(`Removed manual exclusion of ${dirName} (${repoName}). Now auto-included due to modules.`);
            } else {
                showInfo(`Removed manual exclusion of ${dirName} (${repoName})`);
            }
        } else {
            // Currently not included - add manual inclusion
            project.includedPsaeInternalPaths.push(psaeInternalPath);
            await SettingsStore.saveWithoutComments(data);
            showInfo(`Manually included ${dirName} (${repoName}) in addons path`);
        }
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

    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        showError('Module management is disabled while testing is enabled. Disable testing to manage modules.');
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

        // Check if this repo has ps*-internal directories
        try {
            const repoDirContents = fs.readdirSync(repo.path);
            for (const item of repoDirContents) {
                if (/^ps[a-z]*-internal$/i.test(item)) {
                    const psInternalPath = normalizePath(`${repo.path}/${item}`);
                    if (fs.existsSync(psInternalPath)) {
                        psaeInternalDirs.push({ path: psInternalPath, repoName: repo.name });
                    }
                }
            }
        } catch (error) {
            console.warn(`Failed to read repo directory ${repo.path}:`, error);
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

    const availableModules = allModules.filter(m => !m.name.match(/^ps[a-z]*-internal$/i));

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

    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        showError('Module management is disabled while testing is enabled. Disable testing to manage modules.');
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

    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        showError('Module management is disabled while testing is enabled. Disable testing to manage modules.');
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

        // Check if this repo has ps*-internal directories
        try {
            const repoDirContents = fs.readdirSync(repo.path);
            for (const item of repoDirContents) {
                if (/^ps[a-z]*-internal$/i.test(item)) {
                    const psInternalPath = normalizePath(`${repo.path}/${item}`);
                    if (fs.existsSync(psInternalPath)) {
                        psaeInternalDirs.push({ path: psInternalPath, repoName: repo.name });
                    }
                }
            }
        } catch (error) {
            console.warn(`Failed to read repo directory ${repo.path}:`, error);
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

    const availableModules = allModules.filter(m => !m.name.match(/^ps[a-z]*-internal$/i));

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

    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        showError('Module management is disabled while testing is enabled. Disable testing to manage modules.');
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

/**
 * Gets installed modules from the database using psql
 */
async function getInstalledModules(dbName: string): Promise<InstalledModuleInfo[]> {
    try {
        const query = `SELECT id, name, shortdesc, latest_version, state, application FROM ir_module_module WHERE state IN ('installed','to upgrade') ORDER BY name;`;
        const command = `psql ${dbName} -t -A -F'|' -c "${query}"`;

        const output = execSync(command, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const lines = output.trim().split('\n').filter(line => line.trim());
        const installedModules: InstalledModuleInfo[] = [];

        for (const line of lines) {
            const [id, name, shortdesc, latest_version, state, application] = line.split('|');

            // Parse shortdesc JSON and extract en_US description
            let description = '';
            try {
                if (shortdesc) {
                    const descObj = JSON.parse(shortdesc);
                    description = descObj.en_US || descObj[Object.keys(descObj)[0]] || '';
                }
            } catch (error) {
                description = shortdesc || '';
            }

            installedModules.push({
                id: parseInt(id),
                name: name || '',
                shortdesc: description,
                installed_version: latest_version || null,
                latest_version: latest_version || null,
                state: state || '',
                application: application === 't'
            });
        }

        return installedModules;
    } catch (error) {
        console.warn(`Failed to get installed modules from database ${dbName}:`, error);
        return [];
    }
}

export async function viewInstalledModules(): Promise<void> {
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        showError('No project selected');
        return;
    }

    const { project } = result;
    const db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        showError('No database selected');
        return;
    }

    try {
        // Get all installed modules from database
        const installedModules = await getInstalledModules(db.id);

        if (installedModules.length === 0) {
            showInfo('No installed modules found in the database');
            return;
        }

        // Create quick pick items with detailed information
        const quickPickItems = installedModules.map(module => ({
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
            title: `Installed Modules in ${db.name}`
        });

    } catch (error) {
        showError(`Failed to retrieve installed modules: ${error}`);
    }
}
