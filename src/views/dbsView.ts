import * as vscode from 'vscode';
import * as path from 'node:path';
import { BaseTreeProvider } from './baseTreeProvider';
import { DatabaseModel } from '../models/db';
import { SettingsStore } from '../settingsStore';
import { VersionsService } from '../versionsService';
import { SortPreferences } from '../sortPreferences';
import { getDefaultSortOption } from '../sortOptions';
import { getDatabaseLabel } from '../utils';
import { activeIcon } from './icons';
import { sanitizeProjectRepoBranchAssignments } from '../services/environment';
import { getEffectiveOdooVersion } from '../dbs';
import { getRunningInstances, runningDescriptionPart, RunningInstance } from '../services/runningState';

/** Tree provider for the Databases view of the selected project. */
export class DbsTreeProvider extends BaseTreeProvider<vscode.TreeItem> {

    constructor(private readonly sortPreferences: SortPreferences) {
        super();
    }

    getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
        return item;
    }

    async getChildren(_element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        const result = await SettingsStore.getSelectedProject();
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

        return sortedDbs.map(db => this.buildDatabaseItem(db, running.get(db.id)));
    }

    private buildDatabaseItem(db: DatabaseModel, running?: RunningInstance): vscode.TreeItem {
        // Handle date parsing defensively
        let editedDate = new Date(db.createdAt);
        if (isNaN(editedDate.getTime())) {
            editedDate = new Date();
        }

        const formattedDate = `${editedDate.toISOString().split('T')[0]} ${editedDate.toTimeString().split(' ')[0]}`;

        const dbLabel = getDatabaseLabel(db);

        const treeItem = new vscode.TreeItem(dbLabel, vscode.TreeItemCollapsibleState.None);
        treeItem.id = db.id;
        treeItem.iconPath = db.isSelected ? activeIcon : new vscode.ThemeIcon('database');
        treeItem.description = this.buildDescription(db, running);
        treeItem.tooltip = new vscode.MarkdownString(this.buildTooltip(db, dbLabel, formattedDate, running));
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
