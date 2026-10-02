/**
 * The Views tree: the views a database has turned off, what an upgrade
 * disabled first. It shows the selected database, or the upgraded side while
 * an upgrade is set up, since that is where views get disabled.
 */
import * as vscode from 'vscode';
import { SettingsStore } from '../settingsStore';
import { ensureUpgradeConfigModel } from '../models/upgrade';
import { errorMessage, logger } from '../services/logger';
import type { ViewService } from '../services/views/viewService';
import type { ViewGroups } from '../services/views/viewGroups';
import type { ViewRow } from '../services/views/viewQueries';
import { BaseTreeProvider } from './baseTreeProvider';

export interface ViewDoctorTarget {
    dbName: string;
    side?: 'to';
}

export function resolveViewDoctorTarget(
    project: { dbs?: Array<{ id: string; isSelected?: boolean }>; upgradeConfig?: unknown } | undefined
): ViewDoctorTarget | undefined {
    if (!project) {
        return undefined;
    }
    const config = ensureUpgradeConfigModel(project.upgradeConfig as Parameters<typeof ensureUpgradeConfigModel>[0]);
    if (config.isActive() && config.to?.dbId) {
        return { dbName: config.to.dbId, side: 'to' };
    }
    const selected = (project.dbs ?? []).find(db => db.isSelected);
    return selected ? { dbName: selected.id } : undefined;
}

export class ViewItem extends vscode.TreeItem {
    constructor(readonly dbName: string, readonly view: ViewRow, section: 'upgrade' | 'other', versions: string[] = []) {
        super(view.name, vscode.TreeItemCollapsibleState.None);
        // Keyed by state too: a row that changes state is a different row.
        this.id = `${dbName}:${section}:${view.id}:${view.active ? 'on' : 'off'}`;
        this.description = `${view.model || view.type} · ${view.xmlid ?? `#${view.id}`}`;
        this.iconPath = new vscode.ThemeIcon(view.active ? 'pass' : 'circle-slash');
        this.contextValue = ['odooView', view.active ? 'active' : 'inactive', view.inheritId ? 'hasParent' : 'root'].join('.');
        const tooltip = new vscode.MarkdownString(undefined, true);
        tooltip.appendMarkdown(`**${view.name}** (${view.type}, id ${view.id})\n\n`);
        tooltip.appendMarkdown(`${view.xmlid ? `\`${view.xmlid}\`` : 'No external id'}\n\n`);
        if (view.inheritId) {
            tooltip.appendMarkdown(`Inherits view ${view.inheritId}, root ${view.rootId}\n\n`);
        }
        if (versions.length > 0) {
            tooltip.appendMarkdown(`Disabled by the ${versions.join(' and ')} upgrade${versions.length > 1 ? 's' : ''}\n\n`);
        }
        tooltip.appendMarkdown(view.active ? 'On now' : 'Off');
        this.tooltip = tooltip;
        this.command = { command: 'viewDoctor.openArch', title: 'Open Arch', arguments: [this] };
    }
}

export class ViewGroupItem extends vscode.TreeItem {
    constructor(label: string, id: string, readonly children: vscode.TreeItem[], expanded: boolean, description: string) {
        super(label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        this.id = id;
        this.description = description;
        this.contextValue = 'odooViewGroup';
    }
}

function messageItem(text: string, icon: string): vscode.TreeItem {
    const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
}

export function buildDoctorRows(dbName: string, groups: ViewGroups): vscode.TreeItem[] {
    const rows: vscode.TreeItem[] = [];

    if (groups.upgradeDisabled.length > 0 || groups.missingIds.length > 0) {
        const off = groups.upgradeDisabled.filter(view => !view.active).length;
        const on = groups.upgradeDisabled.length - off;
        const children: vscode.TreeItem[] = groups.upgradeDisabled.map(view => new ViewItem(dbName, view, 'upgrade', view.versions));
        if (groups.missingIds.length > 0) {
            const count = groups.missingIds.length;
            children.push(messageItem(`${count} listed view${count === 1 ? ' no longer exists' : 's no longer exist'}`, 'trash'));
        }
        const parts = [`${off} off`, ...(on > 0 ? [`${on} re-enabled`] : []), ...(groups.upgradeVersions.length > 0 ? [groups.upgradeVersions.join(', ')] : [])];
        rows.push(new ViewGroupItem('Disabled by upgrade', `${dbName}:group:upgrade`, children, true, parts.join(' · ')));
    }

    if (groups.otherInactive.length > 0) {
        rows.push(new ViewGroupItem(
            'Other inactive views',
            `${dbName}:group:other`,
            groups.otherInactive.map(view => new ViewItem(dbName, view, 'other')),
            false,
            String(groups.otherInactive.length)
        ));
    }

    if (rows.length === 0) {
        rows.push(messageItem(`No views are turned off in ${dbName}.`, 'check'));
    }
    return rows;
}

export class ViewDoctorTreeProvider extends BaseTreeProvider<vscode.TreeItem> {
    private loaded: Promise<vscode.TreeItem[]> | undefined;

    constructor(
        private readonly service: Pick<ViewService, 'doctorGroups'>,
        private readonly describe?: (text: string | undefined) => void
    ) {
        super();
    }

    override refresh(element?: vscode.TreeItem): void {
        if (!element) {
            this.loaded = undefined;
        }
        super.refresh(element);
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (element instanceof ViewGroupItem) {
            return element.children;
        }
        if (element) {
            return [];
        }
        if (!this.loaded) {
            this.loaded = this.load();
        }
        return this.loaded;
    }

    private async load(): Promise<vscode.TreeItem[]> {
        const result = await SettingsStore.peekSelectedProject().catch(() => null);
        const target = resolveViewDoctorTarget(result?.project as Parameters<typeof resolveViewDoctorTarget>[0]);
        this.describe?.(target?.dbName);
        if (!target) {
            return [];
        }
        try {
            return buildDoctorRows(target.dbName, await this.service.doctorGroups(target.dbName));
        } catch (error) {
            logger.warn(`Could not read the views of ${target.dbName}:`, error);
            return [messageItem(`Could not read the views of ${target.dbName}: ${errorMessage(error)}`, 'error')];
        }
    }
}
