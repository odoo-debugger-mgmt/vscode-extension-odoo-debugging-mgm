import { ModuleModel, InstalledModuleInfo } from "./models/module";
import { DatabaseModel } from "./models/db";
import { ProjectModel } from "./models/project";
import { RepoModel } from "./models/repo";
import * as vscode from "vscode";
import { discoverModulesInRepos, showError, showInfo, showAutoInfo, stripSettings, createInfoTreeItem, ModuleDiscoveryResult, getDatabaseLabel, normalizePath } from './utils';
import { spawn, execFileSync } from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

function collectModuleDiscovery(project: ProjectModel): ModuleDiscoveryResult {
    const manualIncludes = (project.includedPsaeInternalPaths ?? []).filter(entry => !entry.startsWith('!'));
    return discoverModulesInRepos(project.repos, { manualIncludePaths: manualIncludes });
}
import { SettingsStore } from './settingsStore';
import { getInstalledModuleNames, getInstalledModules } from './services/database';
import { SortPreferences } from './sortPreferences';
import { getDefaultSortOption } from './sortOptions';
import { VersionsService } from './versionsService';
import { showWarning } from './services/notifications';
import { showModalWarning } from './services/notifications';

export class ModuleTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    constructor(private context: vscode.ExtensionContext, private sortPreferences: SortPreferences) {
        this.context = context;
    }
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }
    async getChildren(_element?: any): Promise<vscode.TreeItem[] | undefined> {
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

        // Check if testing is enabled
        const isTestingEnabled = project.testingConfig && project.testingConfig.isEnabled;

        const { modules: allModules, psaeDirectories } = collectModuleDiscovery(project);
        const installedModuleNames = await getInstalledModuleNames(db.id);
        const dbModulesByName = new Map(modules.map(module => [module.name, module]));
        const selectedDbModuleNames = new Set(
            modules
                .filter(module => module.state === 'install' || module.state === 'upgrade')
                .map(module => module.name)
        );
        const manuallyIncludedPaths = new Set((project.includedPsaeInternalPaths ?? []).filter(entry => !entry.startsWith('!')));
        const manuallyExcludedPaths = new Set((project.includedPsaeInternalPaths ?? []).filter(entry => entry.startsWith('!')).map(entry => entry.substring(1)));

        const modulesByPsaeDir = new Map<string, typeof allModules>();
        for (const module of allModules) {
            if (!module.isPsaeInternal || !module.psInternalDirPath) {
                continue;
            }
            const existing = modulesByPsaeDir.get(module.psInternalDirPath) ?? [];
            existing.push(module);
            modulesByPsaeDir.set(module.psInternalDirPath, existing);
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
        for (const psaeDir of psaeDirectories) {
            const psaeInternalModules = modulesByPsaeDir.get(psaeDir.path) ?? [];

            // Check if any modules from this ps*-internal are selected OR installed in DB
            const hasSelectedModules = psaeInternalModules.some(m =>
                selectedDbModuleNames.has(m.name)
            );

            // Check if any modules from this ps*-internal directory are installed/to upgrade in DB
            const hasDbModules = psaeInternalModules.some(m =>
                installedModuleNames.has(m.name)
            );

            const isManuallyIncluded = manuallyIncludedPaths.has(psaeDir.path);

            // Auto-include if has selected OR database modules
            // If not manually set: auto-include if has selected OR database modules
            const shouldBeIncluded = isManuallyIncluded || (!manuallyExcludedPaths.has(psaeDir.path) && (hasSelectedModules || hasDbModules));

            // Determine icon and tooltip based on status
            let psaeIcon: string;
            let psaeTooltip: string;

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
            } else {
                psaeIcon = '📋'; // Clipboard icon when not included
                const reason = manuallyExcludedPaths.has(psaeDir.path) ? 'manually excluded' : 'no modules';
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
            const existingModule = dbModulesByName.get(module.name);
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
                } as vscode.TreeItem & { contextValue: string };

                // Store module data for context menu commands
                (managedModuleItem as any).moduleData = {
                    name: module.name,
                    path: module.path,
                    state: existingModule.state,
                    repoName: module.repoName,
                    isPsaeInternal: module.isPsaeInternal,
                    isInstalled: existingModule.isInstalled
                };

                treeItems.push(managedModuleItem);
            } else {
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
                } as vscode.TreeItem & { contextValue: string };

                // Store module data for context menu commands
                (unmanagedModuleItem as any).moduleData = {
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

        const sortId = this.sortPreferences.get('moduleSelector', getDefaultSortOption('moduleSelector'));
        return this.sortModuleItems(treeItems, sortId);
    }

    private sortModuleItems(items: vscode.TreeItem[], sortId: string): vscode.TreeItem[] {
        const testingItems: vscode.TreeItem[] = [];
        const psaeItems: vscode.TreeItem[] = [];
        const moduleItems: vscode.TreeItem[] = [];
        const otherItems: vscode.TreeItem[] = [];

        for (const item of items) {
            if (typeof item.label === 'string' && item.label.includes('⚠️ Module Management Disabled (Testing Mode)')) {
                testingItems.push(item);
            } else if ((item.command?.command === 'moduleSelector.togglePsaeInternalModule') || (typeof item.label === 'string' && /ps[a-z]*-internal/i.test(item.label))) {
                psaeItems.push(item);
            } else if ((item as any).moduleData) {
                moduleItems.push(item);
            } else {
                otherItems.push(item);
            }
        }

        moduleItems.sort((a, b) => this.compareModules(a, b, sortId));

        return [...testingItems, ...psaeItems, ...moduleItems, ...otherItems];
    }

    private compareModules(itemA: vscode.TreeItem, itemB: vscode.TreeItem, sortId: string): number {
        const dataA = (itemA as any).moduleData;
        const dataB = (itemB as any).moduleData;

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
        showError('Select a database before running this action.');
        return;
    }

    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        showError('Disable testing mode before changing module selections.');
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
    await new Promise<void>((resolve, reject) => {
        const child = spawn(
            pythonPath,
            [odooBinPath, 'scaffold', moduleName, targetPath],
            { stdio: ['ignore', 'pipe', 'pipe'] }
        );

        let stderr = '';
        let stdout = '';

        child.stderr?.on('data', chunk => {
            stderr += chunk.toString();
        });
        child.stdout?.on('data', chunk => {
            stdout += chunk.toString();
        });

        child.on('error', error => {
            reject(new Error(`Failed to start scaffold command: ${error.message}`));
        });

        child.on('close', code => {
            if (code === 0) {
                resolve();
                return;
            }

            const details = stderr.trim() || stdout.trim();
            reject(new Error(details || `Scaffold command exited with code ${code ?? 'unknown'}`));
        });
    });
}

function resolveRepositoryRoot(repoPath: string): string {
    try {
        const resolved = execFileSync(
            'git',
            ['-C', repoPath, 'rev-parse', '--show-toplevel'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        ).trim();

        if (resolved && fs.existsSync(resolved)) {
            return resolved;
        }
    } catch {
        // Fall back to the selected path if git resolution is unavailable.
    }

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
        showError(`Project "${targetProject.name}" has no selected repositories.`);
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
        showError('Select a destination repository.');
        return;
    }

    const versionsService = VersionsService.getInstance();
    const settings = await versionsService.getActiveVersionSettings();

    const normalizedPythonPath = normalizePath(settings.pythonPath);
    const normalizedOdooPath = normalizePath(settings.odooPath);
    const destinationPath = normalizePath(targetRepo.path);
    const repositoryRootPath = resolveRepositoryRoot(destinationPath);
    const odooBinPath = path.join(normalizedOdooPath, 'odoo-bin');

    if (!normalizedPythonPath || !fs.existsSync(normalizedPythonPath)) {
        showError(`Python executable not found: ${normalizedPythonPath}`);
        return;
    }

    if (!normalizedOdooPath || !fs.existsSync(normalizedOdooPath)) {
        showError(`Odoo path not found: ${normalizedOdooPath}`);
        return;
    }

    if (!fs.existsSync(odooBinPath)) {
        showError(`odoo-bin not found at: ${odooBinPath}`);
        return;
    }

    if (!repositoryRootPath || !fs.existsSync(repositoryRootPath)) {
        showError(`Destination repository path not found: ${repositoryRootPath}`);
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
        showError(`Failed to scaffold module "${sanitizedModuleName}": ${error.message}`);
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
        showError('Select a database before running this action.');
        return;
    }

    // Check if testing is enabled
    if (project.testingConfig && project.testingConfig.isEnabled) {
        showError('Disable testing mode before changing module selections.');
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
        showError('Select a database before running this action.');
        return;
    }

    // Check if testing is enabled
    if (project.testingConfig && project.testingConfig.isEnabled) {
        showError('Disable testing mode before changing module selections.');
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
        showError('Select a database before running this action.');
        return;
    }

    // Check if testing is enabled
    if (project.testingConfig && project.testingConfig.isEnabled) {
        showError('Disable testing mode before changing module selections.');
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

export async function togglePsaeInternalModule(event: any): Promise<void> {
    const {
        path: psaeInternalPath,
        repoName,
        dirName,
        hasSelectedModules,
        hasDbModules,
        hasInstalledModules,
        isManuallyIncluded,
        shouldBeIncluded,
        modules: psaeModules
    } = event;
    const hasInstalledOrDbModules = Boolean(hasInstalledModules ?? hasDbModules);

    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }

    const { data, project } = result;
    const db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        showError('Select a database before running this action.');
        return;
    }

    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        showError('Disable testing mode before changing module selections.');
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
            if (hasSelectedModules || hasInstalledOrDbModules) {
                project.includedPsaeInternalPaths.push(excludePath);
                // Remove selected modules from this psae-internal directory
                const moduleNamesToRemove = psaeModules.map((m: any) => m.name);
                db.modules = db.modules.filter(dbModule => !moduleNamesToRemove.includes(dbModule.name));
                await SettingsStore.saveWithoutComments(stripSettings(data));
                showInfo(`Manually excluded ${dirName} (${repoName}) and removed selected modules from addons path`);
            } else {
                await SettingsStore.saveWithoutComments(stripSettings(data));
                showInfo(`Removed manual inclusion of ${dirName} (${repoName})`);
            }
        } else {
            // Currently auto-included - add manual exclusion to override and remove selected modules
            project.includedPsaeInternalPaths.push(excludePath);
            // Remove selected modules from this psae-internal directory
            const moduleNamesToRemove = psaeModules.map((m: any) => m.name);
            db.modules = db.modules.filter(dbModule => !moduleNamesToRemove.includes(dbModule.name));
            await SettingsStore.saveWithoutComments(stripSettings(data));
            showInfo(`Manually excluded ${dirName} (${repoName}) and removed selected modules from addons path`);
        }
    } else {
        if (isManuallyExcluded) {
            // Currently manually excluded - remove exclusion (may auto-include)
            const pathIndex = project.includedPsaeInternalPaths.indexOf(excludePath);
            if (pathIndex > -1) {
                project.includedPsaeInternalPaths.splice(pathIndex, 1);
            }
            await SettingsStore.saveWithoutComments(stripSettings(data));
            if (hasSelectedModules || hasInstalledOrDbModules) {
                showInfo(`Removed manual exclusion of ${dirName} (${repoName}). Now auto-included due to modules.`);
            } else {
                showInfo(`Removed manual exclusion of ${dirName} (${repoName})`);
            }
        } else {
            // Currently not included - add manual inclusion
            project.includedPsaeInternalPaths.push(psaeInternalPath);
            await SettingsStore.saveWithoutComments(stripSettings(data));
            showInfo(`Manually included ${dirName} (${repoName}) in addons path`);
        }
    }
}

export async function updateAllModules(): Promise<void> {
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        showError('Select a project before running this action.');
        return;
    }

    const { data, project } = result;
    const db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        showError('Select a database before running this action.');
        return;
    }

    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        showError('Disable testing mode before changing module selections.');
        return;
    }

    const { modules: allModules } = collectModuleDiscovery(project);

    const availableModules = allModules.filter(m => !m.name.match(/^ps[a-z]*-internal$/i));

    if (availableModules.length === 0) {
        showInfo('No modules are available to update.');
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
        showError('Select a project before running this action.');
        return;
    }

    const { data, project } = result;
    const db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        showError('Select a database before running this action.');
        return;
    }

    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        showError('Disable testing mode before changing module selections.');
        return;
    }

    if (!db.modules || db.modules.length === 0) {
        showInfo('No modules are configured for this database to update');
        return;
    }

    const installedModules = db.modules.filter(module => module.state === 'install');
    if (installedModules.length === 0) {
        showInfo('No modules are currently marked with the "install" state.');
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
        showError('Select a project before running this action.');
        return;
    }

    const { data, project } = result;
    const db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        showError('Select a database before running this action.');
        return;
    }

    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        showError('Disable testing mode before changing module selections.');
        return;
    }

    const { modules: allModules } = collectModuleDiscovery(project);

    const availableModules = allModules.filter(m => !m.name.match(/^ps[a-z]*-internal$/i));

    if (availableModules.length === 0) {
        showInfo('No modules are available to install.');
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
        showError('Select a project before running this action.');
        return;
    }

    const { data, project } = result;
    const db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        showError('Select a database before running this action.');
        return;
    }

    // Check if testing is enabled - prevent module modifications
    if (project.testingConfig && project.testingConfig.isEnabled) {
        showError('Disable testing mode before changing module selections.');
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
        showError('Select a project before running this action.');
        return;
    }

    const { project } = result;
    const db = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!db) {
        showError('Select a database before running this action.');
        return;
    }

    try {
        // Get all installed modules from database
        const installedModules = await getInstalledModules(db.id);

        if (installedModules.length === 0) {
            showInfo('No installed modules were found in the database');
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
        showError(`Failed to retrieve installed modules: ${error}`);
    }
}
