import { SettingsModel } from "./models/settings";
import { saveToFile, readFromFile, camelCaseToTitleCase } from './common';
import * as vscode from "vscode";

export class SettingsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem>{
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    constructor(private context: vscode.ExtensionContext) {
        this.context = context;
        this._onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem>();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }
    async getChildren(element?: any): Promise<vscode.TreeItem[] | undefined> {
        let workspaceSettings = await readFromFile();
        if (!workspaceSettings) {
            vscode.window.showErrorMessage('Error reading settings');
            return;
        }
        let settings = workspaceSettings['settings'];
        if (!settings) {
            settings = new SettingsModel();
            workspaceSettings['settings'] = settings;
            await saveToFile(workspaceSettings);
        }
        if (typeof settings === 'string') {
            vscode.window.showErrorMessage('Error reading settings');
            return [];
        }
        const settingsTreeItems: vscode.TreeItem[] = [];
        for (const key in settings) {
            const setting = settings[key];
            const item = `✏️ ${camelCaseToTitleCase(key)}: ${setting}`;
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
    let workspaceSettings = await readFromFile();
    if (!workspaceSettings) {
        vscode.window.showErrorMessage('Error reading settings');
        return;
    }
    let settings = workspaceSettings['settings'];
    if (!settings) {
        vscode.window.showErrorMessage('Error reading settings');
        return;
    }
    const currentValue = settings[key];
    const newValue = await vscode.window.showInputBox({ prompt: `Edit ${camelCaseToTitleCase(key)}`, value: currentValue });
    if (newValue !== undefined) {
        settings[key] = newValue;
        workspaceSettings['settings'] = settings;
        await saveToFile(workspaceSettings);
        vscode.window.showInformationMessage(`Setting ${key} updated to ${newValue}`);
    }
}
