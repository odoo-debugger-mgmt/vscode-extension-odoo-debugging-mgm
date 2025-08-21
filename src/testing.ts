import * as vscode from "vscode";
import * as fs from 'fs';
import { SettingsStore } from './settingsStore';
import { TestTag, TestingConfigModel } from './models/testing';
import { ModuleModel } from './models/module';
import { InstalledModuleInfo } from './models/module';
import { showError, showInfo, showAutoInfo, showWarning, stripSettings } from './utils';
import { execSync } from 'child_process';
import { updateTestingContext } from './extension';

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

/**
 * Ensures we have a proper TestingConfigModel instance
 * Handles converting plain objects from JSON storage back to class instances
 */
function ensureTestingConfigModel(testingConfig: any): TestingConfigModel {
    if (!testingConfig) {
        return new TestingConfigModel();
    }
    if (testingConfig instanceof TestingConfigModel) {
        return testingConfig;
    }

    // Convert plain object to TestingConfigModel instance
    try {
        return new TestingConfigModel(
            testingConfig.isEnabled || false,
            Array.isArray(testingConfig.testTags) ? testingConfig.testTags : [],
            testingConfig.testFile,
            testingConfig.stopAfterInit || false,
            Array.isArray(testingConfig.savedModuleStates) ? testingConfig.savedModuleStates : undefined
        );
    } catch (error) {
        console.warn('Error converting testing config, creating new instance:', error);
        return new TestingConfigModel();
    }
}

export class TestingTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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
            return [this.createInfoItem('No project selected')];
        }

        const { data, project } = result;
        const db = project.dbs.find(db => db.isSelected === true);
        if (!db) {
            return [this.createInfoItem('No database selected')];
        }

        let testingConfig = ensureTestingConfigModel(project.testingConfig);
        if (testingConfig !== project.testingConfig) {
            // Save the converted model back to persist the conversion
            project.testingConfig = testingConfig;
            await SettingsStore.saveWithoutComments(stripSettings(data)).catch(error => {
                console.warn('Failed to save converted testing config:', error);
            });
        }

        // Handle test tags section expansion
        if (element && element.contextValue === 'testTagsSection') {
            const tagItems: vscode.TreeItem[] = [];

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

                const tagItem = new vscode.TreeItem(
                    `${prefix} ${typeIcon} ${tag.value}`,
                    vscode.TreeItemCollapsibleState.None
                );
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
                tagItems.push(this.createInfoItem('No test targets configured.'));
            }

            return tagItems;
        }

        const treeItems: vscode.TreeItem[] = [];

        // Testing enabled/disabled toggle
        const enableToggle = new vscode.TreeItem(
            testingConfig.isEnabled ? '🟢 Testing Enabled' : '⚪ Testing Disabled',
            vscode.TreeItemCollapsibleState.None
        );
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
            const testTagsSection = new vscode.TreeItem(
                `📋 Test Targets (${testingConfig.testTags.length} total, ${activeTags.length} active)`,
                testingConfig.testTags.length > 0
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.Collapsed
            );
            testTagsSection.contextValue = 'testTagsSection';
            testTagsSection.tooltip = 'Test targets - Click targets to cycle states: 🟢 Include → 🔴 Exclude → ⚪ Disabled. Right-click to remove.';
            treeItems.push(testTagsSection);

            // Test File section
            const testFileSection = new vscode.TreeItem(
                testingConfig.testFile ? `📄 Test File: ${testingConfig.testFile}` : '📄 No Test File Set',
                vscode.TreeItemCollapsibleState.None
            );
            testFileSection.command = {
                command: 'testingSelector.setTestFile',
                title: 'Set Test File'
            };
            testFileSection.tooltip = 'Click to set or change test file path';
            treeItems.push(testFileSection);

            // Stop After Init toggle
            const stopAfterInitToggle = new vscode.TreeItem(
                testingConfig.stopAfterInit ? '🟢 Stop After Init' : '⚪ Stop After Init',
                vscode.TreeItemCollapsibleState.None
            );
            stopAfterInitToggle.command = {
                command: 'testingSelector.toggleStopAfterInit',
                title: 'Toggle Stop After Init'
            };
            stopAfterInitToggle.tooltip = 'Toggle --stop-after-init option';
            treeItems.push(stopAfterInitToggle);

            // Current command preview
            const commandPreview = this.generateCommandPreview(testingConfig);
            if (commandPreview) {
                const previewItem = new vscode.TreeItem(
                    `⚡ Command: ${commandPreview}`,
                    vscode.TreeItemCollapsibleState.None
                );
                previewItem.tooltip = `Full command: ${commandPreview}`;
                treeItems.push(previewItem);
            }
        } else if (testingConfig.savedModuleStates && testingConfig.savedModuleStates.length > 0) {
            // Show info about saved states when testing is disabled
            const savedStatesInfo = new vscode.TreeItem(
                `💾 ${testingConfig.savedModuleStates.length} module states saved`,
                vscode.TreeItemCollapsibleState.None
            );
            savedStatesInfo.tooltip = 'Module states from before enabling testing are saved and will be restored';
            treeItems.push(savedStatesInfo);
        }

        return treeItems;
    }

    private createInfoItem(message: string): vscode.TreeItem {
        const item = new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.None);
        item.contextValue = 'info';
        return item;
    }

    private getTypeIcon(type: string): string {
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

    private generateCommandPreview(testingConfig: TestingConfigModel): string {
        const parts: string[] = ['--test-enable'];

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

export async function toggleTesting(event: any): Promise<void> {
    try {
        const { isEnabled } = event;
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            showError('No project selected');
            return;
        }

        const { data, project } = result;
        const db = project.dbs.find(db => db.isSelected === true);
        if (!db) {
            showError('No database selected');
            return;
        }

        // Ensure we have a proper TestingConfigModel instance
        project.testingConfig = ensureTestingConfigModel(project.testingConfig);

        if (isEnabled) {
            // Disable testing - restore module states
            const confirm = await vscode.window.showWarningMessage(
                'Are you sure you want to disable testing? This will restore the previous module states.',
                { modal: true },
                'Disable Testing'
            );

            if (confirm !== 'Disable Testing') {
                return;
            }

            project.testingConfig.isEnabled = false;

            // Restore saved module states
            if (project.testingConfig.savedModuleStates) {
                db.modules = project.testingConfig.savedModuleStates.map(saved =>
                    new ModuleModel(saved.name, saved.state as any)
                );
                project.testingConfig.savedModuleStates = undefined;
            }

            await SettingsStore.saveWithoutComments(stripSettings(data));
            updateTestingContext(false);
            showAutoInfo('Testing disabled. Module states restored.', 3000);

        } else {
            // Enable testing - save current states and clear modules
            const confirm = await vscode.window.showWarningMessage(
                'Enabling testing will clear all current module selections (install/upgrade). The current states will be saved and can be restored when testing is disabled. Continue?',
                { modal: true },
                'Enable Testing'
            );

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

            await SettingsStore.saveWithoutComments(stripSettings(data));
            updateTestingContext(true);
            showAutoInfo('Testing enabled. Module selections cleared and saved for restoration.', 4000);
        }
    } catch (error) {
        console.error('Error in toggleTesting:', error);
        showError(`Failed to toggle testing: ${error}`);
    }
}

export async function toggleStopAfterInit(): Promise<void> {
    try {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            showError('No project selected');
            return;
        }

        const { data, project } = result;
        project.testingConfig = ensureTestingConfigModel(project.testingConfig);

        project.testingConfig.stopAfterInit = !project.testingConfig.stopAfterInit;
        await SettingsStore.saveWithoutComments(stripSettings(data));

        const status = project.testingConfig.stopAfterInit ? 'enabled' : 'disabled';
        showAutoInfo(`Stop after init ${status}`, 2000);
    } catch (error) {
        console.error('Error in toggleStopAfterInit:', error);
        showError(`Failed to toggle stop after init: ${error}`);
    }
}

export async function setTestFile(): Promise<void> {
    try {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            showError('No project selected');
            return;
        }

        const { data, project } = result;
        project.testingConfig = ensureTestingConfigModel(project.testingConfig);

        const currentPath = project.testingConfig.testFile || '';
        const newPath = await vscode.window.showInputBox({
            prompt: 'Enter test file path (relative to project root)',
            value: currentPath,
            placeHolder: 'e.g., addons/my_module/tests/test_example.py'
        });

        if (newPath !== undefined) {
            project.testingConfig.testFile = newPath.trim() || undefined;
            await SettingsStore.saveWithoutComments(stripSettings(data));

            if (project.testingConfig.testFile) {
                showAutoInfo(`Test file set to: ${project.testingConfig.testFile}`, 2000);
            } else {
                showAutoInfo('Test file cleared', 2000);
            }
        }
    } catch (error) {
        console.error('Error in setTestFile:', error);
        showError(`Failed to set test file: ${error}`);
    }
}

export async function addTestTag(): Promise<void> {
    try {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            showError('No project selected');
            return;
        }

        const { data, project } = result;
        project.testingConfig = ensureTestingConfigModel(project.testingConfig);

        if (!project.testingConfig.isEnabled) {
            showError('Testing is not enabled');
            return;
        }

        const db = project.dbs.find(db => db.isSelected === true);
        if (!db) {
            showError('No database selected');
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
                const installedModules = await getInstalledModules(db.id);
                if (installedModules.length === 0) {
                    showInfo('No installed modules found');
                    return;
                }

                // Create better module selection with grouping
                const moduleOptions = installedModules.map((module: InstalledModuleInfo) => ({
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
                        const newTag: TestTag = {
                            id: `tag-${Date.now()}-${Math.random()}`,
                            value: selected.moduleName, // Store just the module name
                            state: 'include', // Default to include
                            type: 'module'
                        };
                        project.testingConfig.testTags.push(newTag);
                    }

                    await SettingsStore.saveWithoutComments(stripSettings(data));
                    showAutoInfo(`Added ${selectedModules.length} module test targets.`, 4000);
                }
            } catch (error) {
                showError(`Failed to get installed modules: ${error}`);
            }
        } else {
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
                validateInput: (value: string) => {
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
                const newTag: TestTag = {
                    id: `tag-${Date.now()}`,
                    value: userInput.trim(),
                    state: 'include', // Default to include
                    type: selectedType.value as 'tag' | 'module' | 'class' | 'method'
                };

                project.testingConfig.testTags.push(newTag);
                await SettingsStore.saveWithoutComments(stripSettings(data));

                let formatInfo = '';
                if (selectedType.value === 'class') {
                    formatInfo = ` (will be formatted as :${userInput.trim()})`;

                    // Show naming convention suggestion if applicable
                    if (!userInput.trim().startsWith('Test') && !userInput.trim().includes('Test')) {
                        showWarning(`Warning: Class names typically start with "Test" (e.g., "TestSalesAccessRights").`);
                    }
                } else if (selectedType.value === 'method') {
                    formatInfo = ` (will be formatted as .${userInput.trim()})`;

                    // Show naming convention suggestion if applicable
                    if (!userInput.trim().startsWith('test_')) {
                        showWarning(`Warning: Method names typically start with "test_" (e.g., "test_workflow_invoice").`);
                    }
                }

                showAutoInfo(`Added ${selectedType.value} "${userInput.trim()}"${formatInfo} as test target.`, 4000);
            }
        }
    } catch (error) {
        console.error('Error in addTestTag:', error);
        showError(`Failed to add test tag: ${error}`);
    }
}

export async function cycleTestTagState(tag: TestTag): Promise<void> {
    try {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            showError('No project selected');
            return;
        }

        const { data, project } = result;
        project.testingConfig = ensureTestingConfigModel(project.testingConfig);

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

            await SettingsStore.saveWithoutComments(stripSettings(data));
        } else {
            showError('Test tag not found');
        }
    } catch (error) {
        console.error('Error in cycleTestTagState:', error);
        showError(`Failed to cycle test tag state: ${error}`);
    }
}

export async function removeTestTag(tagOrTreeItem: TestTag | vscode.TreeItem): Promise<void> {
    try {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            showError('No project selected');
            return;
        }

        const { data, project } = result;
        project.testingConfig = ensureTestingConfigModel(project.testingConfig);

        // Handle both direct tag objects and tree items from context menu
        let tagId: string;
        let tagValue: string = 'unknown';

        // Check if it's a TestTag object (has all required properties)
        if (tagOrTreeItem && typeof tagOrTreeItem === 'object' &&
            'id' in tagOrTreeItem && 'value' in tagOrTreeItem &&
            'state' in tagOrTreeItem && 'type' in tagOrTreeItem) {
            // Direct TestTag object
            const tag = tagOrTreeItem as TestTag;
            tagId = tag.id;
            tagValue = tag.value;
        } else if (tagOrTreeItem && typeof tagOrTreeItem === 'object' &&
                   'id' in tagOrTreeItem && typeof tagOrTreeItem.id === 'string') {
            // Tree item from context menu
            tagId = tagOrTreeItem.id;
            const tag = project.testingConfig.testTags.find(t => t.id === tagId);
            if (tag) {
                tagValue = tag.value;
            }
        } else {
            console.error('Invalid tag reference:', tagOrTreeItem);
            showError('Invalid tag reference');
            return;
        }

        const tagIndex = project.testingConfig.testTags.findIndex(t => t.id === tagId);
        if (tagIndex > -1) {
            project.testingConfig.testTags.splice(tagIndex, 1);
            await SettingsStore.saveWithoutComments(stripSettings(data));
            showAutoInfo(`Removed test target: ${tagValue}`, 2000);
        } else {
            showError('Test tag not found');
        }
    } catch (error) {
        console.error('Error in removeTestTag:', error);
        showError(`Failed to remove test tag: ${error}`);
    }
}
