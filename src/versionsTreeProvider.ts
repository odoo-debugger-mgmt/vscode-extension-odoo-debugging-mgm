/**
 * Versions view: version profiles with their settings as editable children.
 */
import * as vscode from 'vscode';
import { VersionModel } from './models/version';
import { VersionsService } from './versionsService';
import { getSettingDisplayName, getSettingDisplayValue, resolveOptionalPath } from './utils';
import { isVersionProvisioned } from './services/provisioning';
import { getRunningInstances, RunningInstance } from './services/runningState';
import { activeIcon } from './views/icons';
import { SortPreferences } from './sortPreferences';
import { getDefaultSortOption } from './sortOptions';
import { logger } from './services/logger';
import { BaseTreeProvider } from './views/baseTreeProvider';
import { isDerivedSetting } from './services/versionIdentity';

/** Provisioned state for the tree description, from the shared predicate. */
function provisioningLabel(version: VersionModel): string {
    return isVersionProvisioned(resolveOptionalPath(version.settings.pythonPath))
        ? 'provisioned'
        : 'not provisioned';
}

export class VersionTreeItem extends vscode.TreeItem {
    constructor(
        public readonly version: VersionModel,
        public override readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly running?: RunningInstance
    ) {
        super(version.name, collapsibleState);

        this.id = version.id;
        this.tooltip = VersionTreeItem.buildTooltip(version, running);
        // The port is always visible: with several versions runnable at once,
        // knowing which localhost to open is the first thing you need.
        const parts = [version.odooVersion];
        if (version.settings.portNumber) {
            parts.push(`:${version.settings.portNumber}`);
        }
        parts.push(running ? 'running' : provisioningLabel(version));
        this.description = parts.join(' \u2022 ');
        this.contextValue = version.isActive ? 'activeVersion' : 'version';
        this.iconPath = version.isActive ? activeIcon : new vscode.ThemeIcon('versions');

        // Add command to switch to this version when clicked
        this.command = {
            command: 'odoo.setActiveVersion',
            title: '',
            arguments: [version.id]
        };
    }

    private static buildTooltip(version: VersionModel, running?: RunningInstance): vscode.MarkdownString {
        const lines: string[] = [
            `**${version.name}**${version.isActive ? ' (active)' : ''}`,
            `**Odoo Version:** ${version.odooVersion}`
        ];
        const settings = version.settings ?? {};
        if (running) {
            lines.push(`**Status:** running${running.dbName ? ` on \`${running.dbName}\`` : ''}`);
        }
        if (settings.portNumber) {
            lines.push(`**Port:** ${settings.portNumber} \u2014 http://localhost:${settings.portNumber}`);
        }
        if (settings.shellPortNumber) {
            lines.push(`**Shell Port:** ${settings.shellPortNumber}`);
        }
        if (settings.odooPath) {
            lines.push(`**Odoo Path:** ${settings.odooPath}`);
        }
        if (settings.pythonPath) {
            lines.push(`**Python:** ${settings.pythonPath}`);
        }
        if (settings.customAddonsPath) {
            lines.push(`**Custom Addons:** ${settings.customAddonsPath}`);
        }
        return new vscode.MarkdownString(lines.join('\n\n'));
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

        this.id = `${versionId}:${key}`;
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

        // Derived identity is shown but never editable: it is a function of
        // the version's branch, and editing it would let two versions collide.
        if (isDerivedSetting(key)) {
            this.contextValue = 'versionSettingDerived';
            this.description = 'derived from branch';
            this.tooltip = `${displayName}: ${displayValue}\n\nDerived from the version's branch (${key}). Not editable.`;
            return;
        }

        this.command = {
            command: 'odoo.editVersionSetting',
            title: 'Edit Setting',
            arguments: [versionId, key, value]
        };
    }
}

export class VersionsTreeProvider extends BaseTreeProvider<VersionTreeItem | VersionSettingTreeItem> {
    private readonly versionsService: VersionsService;

    constructor(private readonly sortPreferences: SortPreferences) {
        super();
        this.versionsService = VersionsService.getInstance();
    }

    getTreeItem(element: VersionTreeItem | VersionSettingTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: VersionTreeItem | VersionSettingTreeItem): Thenable<(VersionTreeItem | VersionSettingTreeItem)[]> {
        if (!element) {
            // Root level - show versions
            return this.versionsService.initialize().then(async () => {
                const sortId = this.sortPreferences.get('versionsManager', getDefaultSortOption('versionsManager'));
                const versions = this.versionsService.getVersions().slice().sort((a, b) => this.compareVersions(a, b, sortId));
                // Probed once per refresh, not once per row.
                const running = new Map<string, RunningInstance>(
                    (await getRunningInstances())
                        .filter(instance => !!instance.versionId)
                        .map(instance => [instance.versionId!, instance])
                );
                return versions.map(version =>
                    new VersionTreeItem(version, vscode.TreeItemCollapsibleState.Collapsed, running.get(version.id))
                );
            }).catch(error => {
                logger.error('Failed to load versions for tree view:', error);
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

    private compareVersions(a: VersionModel, b: VersionModel, sortId: string): number {
        const activeDelta = Number(b.isActive) - Number(a.isActive);
        if (activeDelta !== 0) {
            return activeDelta;
        }

        switch (sortId) {
            case 'version:name:asc':
                return a.name.localeCompare(b.name);
            case 'version:name:desc':
                return b.name.localeCompare(a.name);
            case 'version:created:newest':
                return this.getTimestamp(b.createdAt) - this.getTimestamp(a.createdAt);
            case 'version:created:oldest':
                return this.getTimestamp(a.createdAt) - this.getTimestamp(b.createdAt);
            case 'version:odoo:asc':
                return a.odooVersion.localeCompare(b.odooVersion);
            case 'version:odoo:desc':
                return b.odooVersion.localeCompare(a.odooVersion);
            default:
                return a.name.localeCompare(b.name);
        }
    }

    private getTimestamp(value: Date): number {
        return value instanceof Date ? value.getTime() : new Date(value).getTime();
    }
}
