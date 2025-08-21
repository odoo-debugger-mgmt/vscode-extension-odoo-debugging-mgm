import { getSettingDisplayName, getSettingDisplayValue, showError } from './utils';
import * as vscode from "vscode";
import { VersionsService } from './versionsService';

type TreeDataChangeEvent = vscode.TreeItem | undefined | null | void;

export class SettingsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly _onDidChangeTreeData: vscode.EventEmitter<TreeDataChangeEvent> = new vscode.EventEmitter<TreeDataChangeEvent>();
    readonly onDidChangeTreeData: vscode.Event<TreeDataChangeEvent> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    constructor(private readonly context: vscode.ExtensionContext) {
        this.context = context;
        this._onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem>();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: any): Promise<vscode.TreeItem[] | undefined> {
        const versionsService = VersionsService.getInstance();
        const settings = await versionsService.getActiveVersionSettings();

        if (!settings) {
            showError('No active version found');
            return [];
        }

        if (typeof settings === 'string') {
            showError('Error reading settings');
            return [];
        }

        const settingsTreeItems: vscode.TreeItem[] = [];
        for (const key in settings) {
            const setting = settings[key];
            const displayValue = getSettingDisplayValue(key, setting);
            const item = `✏️ ${getSettingDisplayName(key)}: ${displayValue}`;
            const treeItem = new vscode.TreeItem(item);
            treeItem.command = {
                command: 'workspaceSettings.editSetting',
                title: 'Edit Setting',
                arguments: [key]
            };
            settingsTreeItems.push(treeItem);
        }
        return settingsTreeItems;
    }
}

export async function editSetting(event: any) {
    const key = event;
    const versionsService = VersionsService.getInstance();
    const settings = await versionsService.getActiveVersionSettings();

    if (!settings) {
        showError('No active version found');
        return;
    }

    const currentValue = settings[key];
    // Show clean value for editing
    const displayValue = getSettingDisplayValue(key, currentValue);
    const newValue = await vscode.window.showInputBox({
        prompt: `Edit ${getSettingDisplayName(key)}`,
        value: displayValue,
        placeHolder: key === 'devMode' ? 'Enter development mode (e.g., all, xml, reload)' : undefined
    });

    if (newValue !== undefined) {
        // Convert back to full format if needed
        let finalValue = newValue;
        if (key === 'devMode' && newValue.trim()) {
            // Add --dev= prefix if not already present and not empty
            finalValue = newValue.startsWith('--dev=') ? newValue : `--dev=${newValue}`;
        } else if (key === 'devMode' && !newValue.trim()) {
            // Empty string means no dev mode
            finalValue = '';
        }

        // Update the setting in the active version
        await versionsService.updateActiveSettings({ [key]: finalValue });

        // Refresh the UI
        vscode.commands.executeCommand('workspaceSettings.refresh');
    }
}
