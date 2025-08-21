import * as vscode from 'vscode';
import { VersionModel } from './models/version';
import { VersionsService } from './versionsService';
import { addActiveIndicator, getSettingDisplayName, getSettingDisplayValue } from './utils';

export class VersionTreeItem extends vscode.TreeItem {
    constructor(
        public readonly version: VersionModel,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        // Use the same pattern as projects and databases - emoji in label
        super(addActiveIndicator(version.name, version.isActive), collapsibleState);

        this.tooltip = `${version.name} (${version.odooVersion})`;
        this.description = version.odooVersion;
        this.contextValue = version.isActive ? 'activeVersion' : 'version';

        // No icon needed - using emoji in label like other tabs

        // Add command to switch to this version when clicked
        this.command = {
            command: 'odoo.setActiveVersion',
            title: '',
            arguments: [version.id]
        };
    }
}

export class VersionSettingTreeItem extends vscode.TreeItem {
    constructor(
        public readonly key: string,
        public readonly value: any,
        public readonly versionId: string
    ) {
        const displayName = getSettingDisplayName(key);
        const displayValue = getSettingDisplayValue(key, value);
        super(`${displayName}: ${displayValue}`, vscode.TreeItemCollapsibleState.None);

        this.tooltip = `${displayName}: ${displayValue}`;
        this.contextValue = 'versionSetting';

        // Set appropriate icon based on setting type
        if (key === 'portNumber' || key === 'shellPortNumber') {
            this.iconPath = new vscode.ThemeIcon('plug');
        } else if (key === 'debuggerName' || key === 'debuggerVersion') {
            this.iconPath = new vscode.ThemeIcon('debug');
        } else if (key === 'devMode') {
            this.iconPath = new vscode.ThemeIcon('tools');
        } else if (key === 'limitTimeReal' || key === 'limitTimeCpu') {
            this.iconPath = new vscode.ThemeIcon('clock');
        } else if (key === 'maxCronThreads') {
            this.iconPath = new vscode.ThemeIcon('server-process');
        } else if (key === 'pythonPath') {
            this.iconPath = new vscode.ThemeIcon('terminal');
        } else if (key === 'extraParams') {
            this.iconPath = new vscode.ThemeIcon('settings-gear');
        } else if (key === 'installApps' || key === 'upgradeApps') {
            this.iconPath = new vscode.ThemeIcon('package');
        } else if (key.includes('Path') || key.includes('Dir') || key === 'dumpsFolder') {
            this.iconPath = new vscode.ThemeIcon('folder');
        } else {
            this.iconPath = new vscode.ThemeIcon('gear');
        }

        // Add command to edit this setting
        this.command = {
            command: 'odoo.editVersionSetting',
            title: 'Edit Setting',
            arguments: [versionId, key, value]
        };
    }
}

type TreeDataChangeEvent = VersionTreeItem | VersionSettingTreeItem | undefined | null | void;

export class VersionsTreeProvider implements vscode.TreeDataProvider<VersionTreeItem | VersionSettingTreeItem> {
    private readonly _onDidChangeTreeData: vscode.EventEmitter<TreeDataChangeEvent> = new vscode.EventEmitter<TreeDataChangeEvent>();
    readonly onDidChangeTreeData: vscode.Event<TreeDataChangeEvent> = this._onDidChangeTreeData.event;

    private readonly versionsService: VersionsService;

    constructor() {
        this.versionsService = VersionsService.getInstance();

        // Listen for version changes
        vscode.commands.registerCommand('odoo.versionsChanged', () => {
            this.refresh();
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: VersionTreeItem | VersionSettingTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: VersionTreeItem | VersionSettingTreeItem): Thenable<(VersionTreeItem | VersionSettingTreeItem)[]> {
        if (!element) {
            // Root level - show versions
            return this.versionsService.initialize().then(() => {
                const versions = this.versionsService.getVersions();
                return versions.map(version =>
                    new VersionTreeItem(version, vscode.TreeItemCollapsibleState.Collapsed)
                );
            }).catch(error => {
                console.error('Failed to load versions for tree view:', error);
                return [];
            });
        } else if (element instanceof VersionTreeItem) {
            // Show settings for this version
            const settings = element.version.settings;
            const settingItems: VersionSettingTreeItem[] = [];

            Object.entries(settings).forEach(([key, value]) => {
                settingItems.push(new VersionSettingTreeItem(key, value, element.version.id));
            });

            return Promise.resolve(settingItems);
        }

        return Promise.resolve([]);
    }

    getParent(element: VersionTreeItem | VersionSettingTreeItem): vscode.ProviderResult<VersionTreeItem | VersionSettingTreeItem> {
        if (element instanceof VersionSettingTreeItem) {
            // Find the parent version
            const versions = this.versionsService.getVersions();
            const parentVersion = versions.find(v => v.id === element.versionId);
            if (parentVersion) {
                return new VersionTreeItem(parentVersion, vscode.TreeItemCollapsibleState.Collapsed);
            }
        }
        return undefined;
    }
}
