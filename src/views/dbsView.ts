import * as vscode from 'vscode';
import * as path from 'node:path';
import { BaseTreeProvider } from './baseTreeProvider';
import { DatabaseModel } from '../models/db';
import { SettingsStore, noneOnStoreRead } from '../settingsStore';
import { VersionsService } from '../versionsService';
import { SortPreferences } from '../sortPreferences';
import { getDefaultSortOption } from '../sortOptions';
import { getDatabaseLabel } from '../utils';
import { activeIcon, selectedIcon } from './icons';
import { readUpgradeConfig } from '../upgrade';
import { sanitizeProjectRepoBranchAssignments } from '../services/environment';
import { getEffectiveOdooVersion } from '../dbs';
import { getRunningInstances, runningDescriptionPart, RunningInstance } from '../services/runningState';
import { checkpointsOf, checkpointSizeSql, formatAge, formatBytes, parseSizes, CheckpointModel } from '../services/checkpoints';
import { runSql } from '../services/postgres';
import { logger } from '../services/logger';

type DbRow = vscode.TreeItem & { database?: DatabaseModel };
type CheckpointRow = vscode.TreeItem & { database: DatabaseModel; checkpoint: CheckpointModel };

export function extractCheckpointFromEvent(event: unknown): { database: DatabaseModel; checkpoint: CheckpointModel } | null {
    const row = event as Partial<CheckpointRow> | undefined;
    if (row && row.contextValue === 'checkpoint' && row.database && row.checkpoint) {
        return { database: row.database, checkpoint: row.checkpoint };
    }
    return null;
}

/** Tree provider for the Databases view of the selected project. */
export class DbsTreeProvider extends BaseTreeProvider<vscode.TreeItem> {
    /**
     * The row object per database, reused across refreshes. `TreeView.reveal`
     * finds a row by object identity, so a row rebuilt from scratch on every
     * refresh could never be revealed - and reveal is the only way to move the
     * view's own highlight.
     */
    private readonly rows = new Map<string, vscode.TreeItem>();

    /** Checkpoint rows by id, reused for reveal like `rows`. */
    private readonly checkpointRowCache = new Map<string, CheckpointRow>();
    /** pg_database_size of every checkpoint, read once per refresh. */
    private checkpointSizes = new Map<string, number>();

    constructor(private readonly sortPreferences: SortPreferences) {
        super();
    }

    getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
        return item;
    }

    /** Checkpoint rows sit under their database's row; databases are top-level. */
    getParent(item: vscode.TreeItem): vscode.TreeItem | undefined {
        if (item.contextValue === 'checkpoint') {
            const db = (item as CheckpointRow).database;
            return db ? this.rows.get(db.id) : undefined;
        }
        return undefined;
    }

    setCheckpointSizes(sizes: Map<string, number>): void {
        this.checkpointSizes = sizes;
    }

    checkpointRows(db: DatabaseModel): vscode.TreeItem[] {
        const now = new Date();
        return checkpointsOf(db)
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
            .map(checkpoint => {
                const id = `${db.id}::checkpoint::${checkpoint.id}`;
                const size = this.checkpointSizes.get(checkpoint.id);
                const fresh = new vscode.TreeItem(checkpoint.label, vscode.TreeItemCollapsibleState.None) as CheckpointRow;
                fresh.id = id;
                fresh.iconPath = new vscode.ThemeIcon('history');
                fresh.contextValue = 'checkpoint';
                fresh.description = [formatAge(checkpoint.createdAt, now), size === undefined ? '' : formatBytes(size)]
                    .filter(Boolean).join(' \u2022 ');
                const created = new Date(checkpoint.createdAt);
                fresh.tooltip = new vscode.MarkdownString([
                    `**${checkpoint.label}**`,
                    `**Checkpoint of:** ${db.id}`,
                    `**Created:** ${isNaN(created.getTime()) ? checkpoint.createdAt : created.toLocaleString()}`,
                    ...(size === undefined ? [] : [`**Size:** ${formatBytes(size)}`]),
                    `**Filestore:** ${checkpoint.filestore ? 'yes' : 'none (the database had no filestore folder)'}`,
                    `**PostgreSQL name:** ${checkpoint.id}`
                ].join('\n\n'));
                fresh.database = db;
                fresh.checkpoint = checkpoint;
                const row = Object.assign(this.checkpointRowCache.get(id) ?? fresh, fresh);
                this.checkpointRowCache.set(id, row);
                return row;
            });
    }

    private async readCheckpointSizes(dbs: DatabaseModel[]): Promise<void> {
        const names = dbs.flatMap(db => checkpointsOf(db).map(cp => cp.id));
        if (names.length === 0) {
            this.checkpointSizes = new Map();
            return;
        }
        try {
            this.checkpointSizes = parseSizes(await runSql('postgres', checkpointSizeSql(names)));
        } catch (error) {
            logger.debug('Could not read checkpoint sizes:', error);
            this.checkpointSizes = new Map();
        }
    }

    /** The row currently shown for a database, when the view has drawn one. */
    rowFor(dbId: string): vscode.TreeItem | undefined {
        return this.rows.get(dbId);
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        // A row asks for its own children: only a database row has any. Falling
        // through to the root list here would make every collapsible row recurse.
        if (element) {
            const db = (element as DbRow).database;
            return element.contextValue === 'database' && db ? this.checkpointRows(db) : [];
        }

        // Silent: an empty list shows the view's welcome content.
        const result = await SettingsStore.peekSelectedProject().catch(noneOnStoreRead);
        if (!result) {
            return [];
        }

        // Empty list: the view's welcome content offers "Create Database".
        const { project } = result;
        const dbs: DatabaseModel[] = project.dbs;
        if (!dbs) {
            return [];
        }

        const sortId = this.sortPreferences.get('dbSelector', getDefaultSortOption('dbSelector'));
        const sortedDbs = [...dbs].sort((a, b) => this.compareDatabases(a, b, sortId));

        // Probed once per refresh, not once per row.
        const running = new Map<string, RunningInstance>(
            (await getRunningInstances()).map(instance => [instance.dbName, instance])
        );

        await this.readCheckpointSizes(dbs);

        const upgradeConfig = readUpgradeConfig(project);
        const previous = new Map(this.rows);
        this.rows.clear();
        return sortedDbs.map(db => {
            const fresh = this.buildDatabaseItem(db, running.get(db.id), upgradeConfig.sideForDb(db.id));
            // Every field is set on each build, so copying over the old object
            // leaves nothing stale behind.
            const row = Object.assign(previous.get(db.id) ?? fresh, fresh);
            this.rows.set(db.id, row);
            return row;
        });
    }

    private buildDatabaseItem(
        db: DatabaseModel,
        running?: RunningInstance,
        upgradeSide?: 'from' | 'to'
    ): vscode.TreeItem {
        // Handle date parsing defensively
        let editedDate = new Date(db.createdAt);
        if (isNaN(editedDate.getTime())) {
            editedDate = new Date();
        }

        const formattedDate = `${editedDate.toISOString().split('T')[0]} ${editedDate.toTimeString().split(' ')[0]}`;

        const dbLabel = getDatabaseLabel(db);

        const treeItem = new vscode.TreeItem(
            dbLabel,
            checkpointsOf(db).length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );
        treeItem.id = db.id;
        // Both databases of an upgrade read as checked, but the selected one
        // still has to stand out: during an upgrade, selecting a side is how
        // you choose whose modules the Modules view edits, so "which one am I
        // looking at" is the question the icon has to keep answering.
        let icon: vscode.ThemeIcon = new vscode.ThemeIcon('database');
        if (db.isSelected) {
            icon = activeIcon;
        } else if (upgradeSide) {
            icon = selectedIcon;
        }
        treeItem.iconPath = icon;

        const descriptionParts = [this.buildDescription(db, running)];
        if (upgradeSide) {
            descriptionParts.push(upgradeSide === 'from' ? 'upgrading from' : 'upgrading to');
        }
        const checkpointCount = checkpointsOf(db).length;
        if (checkpointCount > 0) {
            descriptionParts.push(`${checkpointCount} checkpoint${checkpointCount === 1 ? '' : 's'}`);
        }
        treeItem.description = descriptionParts.filter(Boolean).join(' \u2022 ');
        treeItem.tooltip = new vscode.MarkdownString(this.buildTooltip(db, dbLabel, formattedDate, running));
        // Unchanged for a pair member: the menus are keyed to `database`.
        treeItem.contextValue = 'database';

        // Store the database object for commands that need it
        (treeItem as vscode.TreeItem & { database?: DatabaseModel }).database = db;

        treeItem.command = {
            command: 'dbSelector.selectDb',
            title: 'Select DB',
            arguments: [db]
        };
        return treeItem;
    }

    /** Description shows running state, branch, version and origin as subtext. */
    private buildDescription(db: DatabaseModel, running?: RunningInstance): string {
        const parts: string[] = [];

        // Running state leads: when switching databases, what is already up is
        // the thing worth seeing first.
        const runningPart = runningDescriptionPart(running);
        if (runningPart) {
            parts.push(runningPart);
        }

        // The repo mapping used to be discoverable only by hovering the row.
        const repoBranches = sanitizeProjectRepoBranchAssignments(db.projectRepoBranches);
        if (repoBranches.length > 0) {
            parts.push(`${repoBranches.length} repo${repoBranches.length === 1 ? '' : 's'}`);
        }

        // The version is the only source of the core branch; a database with
        // none falls back to its legacy odooVersion.
        if (db.versionId) {
            const version = this.lookupVersion(db.versionId);
            parts.push(version ? version.name : `${db.versionId.substring(0, 8)}...`);
        } else {
            const effectiveOdooVersion = getEffectiveOdooVersion(db);
            if (effectiveOdooVersion && effectiveOdooVersion.trim() !== '') {
                parts.push(effectiveOdooVersion);
            }
        }

        if (db.isItABackup) {
            parts.push('backup');
        }
        if (db.isExisting) {
            parts.push('existing');
        }

        return parts.join(' • ');
    }

    private buildTooltip(db: DatabaseModel, dbLabel: string, formattedDate: string, running?: RunningInstance): string {
        const tooltipDetails: string[] = [];

        tooltipDetails.push(`**${dbLabel}**`);
        tooltipDetails.push(`**Internal name:** ${db.id}`);

        if (running) {
            tooltipDetails.push(
                running.origin === 'managed'
                    ? `**Status:** running${running.port ? ` on port ${running.port}` : ''}`
                    : `**Status:** running outside this window`
            );
        }

        if (db.versionId) {
            const version = this.lookupVersion(db.versionId);
            if (version) {
                tooltipDetails.push(`**Version:** ${version.name}`);
                tooltipDetails.push(`**Odoo Version:** ${version.odooVersion}`);
            } else {
                tooltipDetails.push(`**Version ID:** ${db.versionId}`);
            }
        } else {
            tooltipDetails.push(`**Version:** None`);
            const effectiveOdooVersion = getEffectiveOdooVersion(db);
            if (effectiveOdooVersion) {
                tooltipDetails.push(`**Odoo Version:** ${effectiveOdooVersion}`);
            }
        }

        const projectRepoBranches = sanitizeProjectRepoBranchAssignments(db.projectRepoBranches);
        if (projectRepoBranches.length > 0) {
            const formattedRepoBranches = projectRepoBranches
                .map(entry => `- ${entry.repoName || path.basename(entry.repoPath)}: \`${entry.branch}\``)
                .join('\n');
            tooltipDetails.push(`**Project Repo Branches:**\n${formattedRepoBranches}`);
        }

        tooltipDetails.push(`**Created:** ${formattedDate}`);

        if (db.kind === 'template') {
            tooltipDetails.push(`**Type:** Created from template`);
        } else if (db.isItABackup) {
            tooltipDetails.push(`**Type:** Restored from backup`);
            if (db.sqlFilePath) {
                tooltipDetails.push(`**Backup Path:** ${db.sqlFilePath}`);
            }
        } else if (db.isExisting) {
            tooltipDetails.push(`**Type:** Connected to existing database`);
        } else {
            tooltipDetails.push(`**Type:** Fresh database`);
        }

        if (db.isSelected) {
            tooltipDetails.push(`**Status:** Currently selected`);
        }

        if (db.modules && db.modules.length > 0) {
            tooltipDetails.push(`**Modules:** ${db.modules.length} installed`);
        }

        return tooltipDetails.join('\n\n');
    }

    private lookupVersion(versionId: string) {
        try {
            return VersionsService.getInstance().getVersion(versionId);
        } catch {
            return undefined;
        }
    }

    private compareDatabases(a: DatabaseModel, b: DatabaseModel, sortId: string): number {
        const activeDelta = Number(b.isSelected) - Number(a.isSelected);
        if (activeDelta !== 0) {
            return activeDelta;
        }

        switch (sortId) {
            case 'db:name:asc':
                return this.getNameValue(a).localeCompare(this.getNameValue(b));
            case 'db:name:desc':
                return this.getNameValue(b).localeCompare(this.getNameValue(a));
            case 'db:created:newest':
                return this.getCreatedTimestamp(b) - this.getCreatedTimestamp(a);
            case 'db:created:oldest':
                return this.getCreatedTimestamp(a) - this.getCreatedTimestamp(b);
            case 'db:branch:asc':
                return this.compareBranch(a, b, false);
            case 'db:branch:desc':
                return this.compareBranch(a, b, true);
            default:
                return this.getNameValue(a).localeCompare(this.getNameValue(b));
        }
    }

    private getCreatedTimestamp(db: DatabaseModel): number {
        if (db.createdAt instanceof Date) {
            return db.createdAt.getTime();
        }
        const date = new Date(db.createdAt);
        return isNaN(date.getTime()) ? 0 : date.getTime();
    }

    private getBranchValue(db: DatabaseModel): string {
        const effective = getEffectiveOdooVersion(db);
        return effective ? effective.toLowerCase() : '';
    }

    private getNameValue(db: DatabaseModel): string {
        return getDatabaseLabel(db).toLowerCase();
    }

    private compareBranch(a: DatabaseModel, b: DatabaseModel, descending: boolean): number {
        const aBranch = this.getBranchValue(a);
        const bBranch = this.getBranchValue(b);
        const aHas = aBranch.trim().length > 0;
        const bHas = bBranch.trim().length > 0;

        const missingDelta = Number(bHas) - Number(aHas);
        if (missingDelta !== 0) {
            return descending ? -missingDelta : missingDelta;
        }

        if (descending) {
            return bBranch.localeCompare(aBranch);
        }
        return aBranch.localeCompare(bBranch);
    }
}
