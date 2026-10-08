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
import { alsoOffSource, upgradePair, type PairProject } from './viewPairing';
import { withCheckpointOpen } from '../services/checkpointReads';

/** workspaceState: whether "Other inactive views" also lists those the original has off too. */
export const SHOW_ALSO_OFF_KEY = 'viewDoctor.showAlsoOff';

export interface DoctorRowOptions {
    /** The partner the "also off" views are read from (the upgrade's original, a checkpoint or a clone). */
    originalDb?: string;
    showAlsoOff?: boolean;
}

export interface ViewDoctorOptions {
    showAlsoOff?(): boolean;
    /** Told on every load whether the tree compares with an original database. */
    onComparing?(comparing: boolean): void;
}

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
    constructor(readonly dbName: string, readonly view: ViewRow, section: 'upgrade' | 'edited' | 'other', versions: string[] = [], alsoOffIn?: string) {
        super(view.name, vscode.TreeItemCollapsibleState.None);
        // Keyed by state too: a row that changes state is a different row.
        this.id = `${dbName}:${section}:${view.id}:${view.active ? 'on' : 'off'}`;
        this.description = `${view.model || view.type} · ${view.xmlid ?? `#${view.id}`}${alsoOffIn ? ` · off in ${alsoOffIn} too` : ''}`;
        this.iconPath = new vscode.ThemeIcon(view.active ? 'pass' : 'circle-slash');
        this.contextValue = [
            'odooView',
            view.active ? 'active' : 'inactive',
            view.inheritId ? 'hasParent' : 'root',
            // Its root is further up than its parent: Open Root has somewhere else to go.
            ...(view.inheritId && view.rootId !== view.inheritId ? ['deep'] : []),
            ...(view.xmlid ? [] : ['noXmlid'])
        ].join('.');
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

export function buildDoctorRows(dbName: string, groups: ViewGroups, options: DoctorRowOptions = {}): vscode.TreeItem[] {
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

    if (groups.edited.length > 0) {
        rows.push(new ViewGroupItem(
            'Edited here',
            `${dbName}:group:edited`,
            groups.edited.map(view => new ViewItem(dbName, view, 'edited')),
            true,
            String(groups.edited.length)
        ));
    }

    const alsoOff = groups.alsoOffInOriginal ?? [];
    if (groups.otherInactive.length > 0 || alsoOff.length > 0) {
        const original = options.originalDb ?? 'the original';
        const shown = options.showAlsoOff
            ? [...groups.otherInactive, ...alsoOff].sort((a, b) => a.model.localeCompare(b.model) || a.id - b.id)
            : groups.otherInactive;
        const alsoOffIds = new Set(alsoOff.map(view => view.id));
        const children: vscode.TreeItem[] = shown.map(view =>
            new ViewItem(dbName, view, 'other', [], alsoOffIds.has(view.id) ? original : undefined));
        if (shown.length === 0) {
            children.push(messageItem(`All ${alsoOff.length} are off in ${original} too.`, 'eye-closed'));
        }
        rows.push(new ViewGroupItem(
            'Other inactive views',
            `${dbName}:group:other`,
            children,
            false,
            alsoOff.length > 0 ? `${shown.length} · ${alsoOff.length} also off in ${original}` : String(shown.length)
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
        private readonly describe?: (text: string | undefined) => void,
        private readonly options: ViewDoctorOptions = {}
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
        const project = result?.project as PairProject | undefined;
        const target = resolveViewDoctorTarget(project as Parameters<typeof resolveViewDoctorTarget>[0]);
        this.describe?.(target?.dbName);
        // Upgrade mode tree shows the To side, so its source is the original; else the stored partner, if a copy.
        const source = target ? alsoOffSource(project, target.dbName, upgradePair(project)) : undefined;
        let comparing = !!target && !!source && source.dbName !== target.dbName;
        this.options.onComparing?.(comparing);
        if (!target) {
            return [];
        }
        try {
            let groups: ViewGroups;
            if (comparing && source?.checkpoint) {
                try {
                    groups = await withCheckpointOpen(source.dbName, () => this.service.doctorGroups(target.dbName, source.dbName));
                } catch (error) {
                    // The checkpoint could not be opened (or read): show every inactive view, as for an unreadable original.
                    logger.warn(`Could not read which views are off in ${source.dbName}; showing every inactive view:`, error);
                    comparing = false;
                    this.options.onComparing?.(false);
                    groups = await this.service.doctorGroups(target.dbName);
                }
            } else {
                groups = await this.service.doctorGroups(target.dbName, comparing ? source?.dbName : undefined);
            }
            return buildDoctorRows(target.dbName, groups, {
                originalDb: comparing ? source?.dbName : undefined,
                showAlsoOff: this.options.showAlsoOff?.() ?? false
            });
        } catch (error) {
            logger.warn(`Could not read the views of ${target.dbName}:`, error);
            return [messageItem(`Could not read the views of ${target.dbName}: ${errorMessage(error)}`, 'error')];
        }
    }
}
