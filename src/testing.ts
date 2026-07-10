/**
 * Testing view and testing mode: toggling stashes/restores module
 * selections and injects --test-enable/--test-tags/--test-file/
 * --stop-after-init/--log-level into the launch configuration.
 */
import * as vscode from "vscode";
import { SettingsStore } from './settingsStore';
import { TestTag, TestingConfigModel, LogLevel, ensureTestingConfigModel } from './models/testing';
import { ModuleModel } from './models/module';
import { InstalledModuleInfo } from './models/module';
import { showError, showInfo, showAutoInfo, stripSettings, createInfoTreeItem } from './utils';
import { updateTestingContext } from './context';
import { setupDebugger } from './debugger';
import { getInstalledModules } from './services/database';
import { logger } from './services/logger';
import { showModalWarning } from './services/notifications';
import { BaseTreeProvider } from './views/baseTreeProvider';

export class TestingTreeProvider extends BaseTreeProvider<vscode.TreeItem> {

    constructor(_context: vscode.ExtensionContext) {
        super();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: any): Promise<vscode.TreeItem[] | undefined> {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            return [createInfoTreeItem('Select a project before running this action.')];
        }

        const { data, project } = result;
        const db = project.dbs.find(db => db.isSelected === true);
        if (!db) {
            return [createInfoTreeItem('Select a database before running this action.')];
        }

        let testingConfig = ensureTestingConfigModel(project.testingConfig);
        if (testingConfig !== project.testingConfig) {
            // Save the converted model back to persist the conversion
            project.testingConfig = testingConfig;
            await SettingsStore.saveWithoutComments(stripSettings(data)).catch(error => {
                logger.warn('Failed to save converted testing config:', error);
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
                tagItems.push(createInfoTreeItem('No test targets configured.'));
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

            // Log Level toggle
            const getLogLevelIcon = (level: LogLevel): string => {
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
            const logLevelToggle = new vscode.TreeItem(
                `${logLevelIcon} ${logLevelDisplay}`,
                vscode.TreeItemCollapsibleState.None
            );
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

    private getTypeIcon(type: string): string {
        switch (type) {
            case 'module': return '📦';
            case 'class': return '🔧';
            case 'method': return '⚙️';
            case 'tag': return '🏷️';
            default:
                logger.warn(`Unknown test tag type: "${type}"`);
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

        if (testingConfig.logLevel && testingConfig.logLevel !== 'disabled') {
            parts.push(`--log-level ${testingConfig.logLevel}`);
        }

        return parts.join(' ');
    }
}

export async function toggleTesting(event: any): Promise<void> {
    try {
        const { isEnabled } = event;
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            void showError('Select a project before running this action.');
            return;
        }

        const { data, project } = result;
        const db = project.dbs.find(db => db.isSelected === true);
        if (!db) {
            void showError('Select a database before running this action.');
            return;
        }

        // Ensure we have a proper TestingConfigModel instance
        project.testingConfig = ensureTestingConfigModel(project.testingConfig);

        if (isEnabled) {
            // Disable testing - restore module states
            const confirm = await showModalWarning(
                'Are you sure you want to disable testing? This will restore the previous module states.',
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
            showAutoInfo('Testing disabled. Previous module states restored.', 3000);
            await setupDebugger();

        } else {
            // Enable testing - save current states and clear modules
            const confirm = await showModalWarning(
                'Enabling testing will clear all current module selections (install/upgrade). The current states will be saved and can be restored when testing is disabled. Continue?',
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
            showAutoInfo('Testing enabled. Current module selections saved and cleared.', 4000);
            await setupDebugger();
        }
    } catch (error) {
        logger.error('Error in toggleTesting:', error);
        void showError(`Failed to toggle testing: ${error}`);
    }
}

export async function toggleStopAfterInit(): Promise<void> {
    try {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            void showError('Select a project before running this action.');
            return;
        }

        const { data, project } = result;
        project.testingConfig = ensureTestingConfigModel(project.testingConfig);

        project.testingConfig.stopAfterInit = !project.testingConfig.stopAfterInit;
        await SettingsStore.saveWithoutComments(stripSettings(data));

        const status = project.testingConfig.stopAfterInit ? 'enabled' : 'disabled';
        showAutoInfo(`Stop after init ${status}`, 2000);

        // Update launch.json with new test configuration
        await setupDebugger();
    } catch (error) {
        logger.error('Error in toggleStopAfterInit:', error);
        void showError(`Failed to toggle stop after init: ${error}`);
    }
}

export async function setTestFile(): Promise<void> {
    try {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            void showError('Select a project before running this action.');
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
                showAutoInfo('Cleared the test file path.', 2000);
            }

            // Update launch.json with new test configuration
            await setupDebugger();
        }
    } catch (error) {
        logger.error('Error in setTestFile:', error);
        void showError(`Failed to set test file: ${error}`);
    }
}

export async function addTestTag(): Promise<void> {
    try {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            void showError('Select a project before running this action.');
            return;
        }

        const { data, project } = result;
        project.testingConfig = ensureTestingConfigModel(project.testingConfig);

        if (!project.testingConfig.isEnabled) {
            void showError('Enable testing before running this command.');
            return;
        }

        const db = project.dbs.find(db => db.isSelected === true);
        if (!db) {
            void showError('Select a database before running this action.');
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
                    void showInfo('No installed modules were found.');
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

                    // Update launch.json with new test configuration
                    await setupDebugger();
                }
            } catch (error) {
                void showError(`Failed to get installed modules: ${error}`);
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
                validateInput: (value: string): string | vscode.InputBoxValidationMessage | null => {
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
                } else if (selectedType.value === 'method') {
                    formatInfo = ` (will be formatted as .${userInput.trim()})`;
                }

                showAutoInfo(`Added ${selectedType.value} "${userInput.trim()}"${formatInfo} as test target.`, 4000);

                // Update launch.json with new test configuration
                await setupDebugger();
            }
        }
    } catch (error) {
        logger.error('Error in addTestTag:', error);
        void showError(`Failed to add test tag: ${error}`);
    }
}

export async function cycleTestTagState(tag: TestTag): Promise<void> {
    try {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            void showError('Select a project before running this action.');
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

            // Update launch.json with new test configuration
            await setupDebugger();
        } else {
            void showError('Could not find that test tag.');
        }
    } catch (error) {
        logger.error('Error in cycleTestTagState:', error);
        void showError(`Failed to cycle test tag state: ${error}`);
    }
}

export async function removeTestTag(tagOrTreeItem: TestTag | vscode.TreeItem): Promise<void> {
    try {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            void showError('Select a project before running this action.');
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
            logger.error('Could not find the referenced test tag:', tagOrTreeItem);
            void showError('Could not find the referenced test tag.');
            return;
        }

        const tagIndex = project.testingConfig.testTags.findIndex(t => t.id === tagId);
        if (tagIndex > -1) {
            project.testingConfig.testTags.splice(tagIndex, 1);
            await SettingsStore.saveWithoutComments(stripSettings(data));
            showAutoInfo(`Removed test target: ${tagValue}`, 2000);

            // Update launch.json with new test configuration
            await setupDebugger();
        } else {
            void showError('Could not find that test tag.');
        }
    } catch (error) {
        logger.error('Error in removeTestTag:', error);
        void showError(`Failed to remove test tag: ${error}`);
    }
}

export async function toggleLogLevel(): Promise<void> {
    try {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            void showError('Select a project before running this action.');
            return;
        }

        const { data, project } = result;
        project.testingConfig = ensureTestingConfigModel(project.testingConfig);

        // Cycle through log levels: disabled -> critical -> error -> warn -> debug -> disabled
        const logLevels: LogLevel[] = ['disabled', 'critical', 'error', 'warn', 'debug'];
        const currentIndex = logLevels.indexOf(project.testingConfig.logLevel);
        const nextIndex = (currentIndex + 1) % logLevels.length;

        project.testingConfig.logLevel = logLevels[nextIndex];
        await SettingsStore.saveWithoutComments(stripSettings(data));

        const displayLevel = project.testingConfig.logLevel === 'disabled' ? 'disabled (no --log-level argument)' : project.testingConfig.logLevel;
        showAutoInfo(`Log level set to: ${displayLevel}`, 2000);

        // Update launch.json with new test configuration
        await setupDebugger();
    } catch (error) {
        logger.error('Error in toggleLogLevel:', error);
        void showError(`Failed to toggle log level: ${error}`);
    }
}

export async function setSpecificLogLevel(): Promise<void> {
    try {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            void showError('Select a project before running this action.');
            return;
        }

        const { data, project } = result;
        project.testingConfig = ensureTestingConfigModel(project.testingConfig);

        const logLevelOptions = [
            {
                label: '⚪ Disabled',
                detail: 'No --log-level argument (default Odoo logging)',
                value: 'disabled' as LogLevel
            },
            {
                label: '🔴 Critical',
                detail: 'Only critical errors',
                value: 'critical' as LogLevel
            },
            {
                label: '🟠 Error',
                detail: 'Critical and error messages',
                value: 'error' as LogLevel
            },
            {
                label: '🟡 Warn',
                detail: 'Critical, error, and warning messages',
                value: 'warn' as LogLevel
            },
            {
                label: '🔵 Debug',
                detail: 'All messages including debug information',
                value: 'debug' as LogLevel
            }
        ];

        const selectedOption = await vscode.window.showQuickPick(logLevelOptions, {
            placeHolder: 'Select log level for testing',
            matchOnDetail: true,
            ignoreFocusOut: true
        });

        if (selectedOption) {
            project.testingConfig.logLevel = selectedOption.value;
            await SettingsStore.saveWithoutComments(stripSettings(data));

            const displayLevel = selectedOption.value === 'disabled' ? 'disabled (no --log-level argument)' : selectedOption.value;
            showAutoInfo(`Log level set to: ${displayLevel}`, 2000);

            // Update launch.json with new test configuration
            await setupDebugger();
        }
    } catch (error) {
        logger.error('Error in setSpecificLogLevel:', error);
        void showError(`Failed to set log level: ${error}`);
    }
}
