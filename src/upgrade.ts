/**
 * Upgrade view and upgrade mode.
 *
 * An upgrade is two servers on two databases on two versions, run side by
 * side. That is a mode rather than a one-off wizard: it changes what the other
 * views mean, and several actions would quietly break the pair while it is on,
 * so it gets its own view and its own guards - the shape testing mode already
 * uses.
 *
 * Only the *rendering* is a pair. Which single version is active is left
 * alone: launch.json carries one entry per provisioned version already, so two
 * servers need no second active version, and making the active version plural
 * would reach every one of its consumers.
 */
import * as vscode from 'vscode';
import { SettingsStore } from './settingsStore';
import { ProjectModel } from './models/project';
import { UpgradeConfigModel, ensureUpgradeConfigModel } from './models/upgrade';
import { updateUpgradeContext, updateUpgradeRememberedContext } from './context';
import { stageTargetModules, unstageTargetModules } from './services/upgradeApply';
import { showBriefStatus, showError } from './services/notifications';
import { logger } from './services/logger';
import { stripSettings } from './utils';
import { VersionsService } from './versionsService';
import { BaseTreeProvider } from './views/baseTreeProvider';
import { selectedIcon, unselectedIcon } from './views/icons';

/**
 * The project's upgrade configuration, normalized.
 *
 * Every read goes through here: what comes back from settings is a plain
 * object with no methods, and a setup interrupted halfway leaves half a pair.
 */
export function readUpgradeConfig(project: ProjectModel | undefined): UpgradeConfigModel {
    return ensureUpgradeConfigModel(project?.upgradeConfig);
}

/**
 * Refuses an action that would break the pair, and offers the way out.
 *
 * The `when`-clauses hide these actions, but the command palette and
 * keybindings route around `when`, so the guard has to be imperative too -
 * the same reason `ensureModuleEditable` exists for testing mode.
 */
export function refuseDuringUpgrade(config: UpgradeConfigModel, what: string): boolean {
    if (!config.isActive()) {
        return false;
    }
    void showError(`${what} while an upgrade is set up.`, 'Exit Upgrade Mode')
        .then(choice => {
            if (choice === 'Exit Upgrade Mode') {
                void vscode.commands.executeCommand('upgradeSelector.toggleUpgrade', { isEnabled: true });
            }
        });
    return true;
}

/** Reads the selected project's upgrade config without a full project load. */
export async function currentUpgradeConfig(): Promise<UpgradeConfigModel> {
    const result = await SettingsStore.getSelectedProject();
    return readUpgradeConfig(result?.project);
}

/**
 * Links a side of the pair to its version once that version exists.
 *
 * A version the upgrade queued is built minutes later, so the side is stored
 * with a series and no version id. Nothing else fills that in, and without it
 * the side has no port, no launch entry and no way to be started.
 *
 * Returns true when something changed and the caller should save.
 */
export function healUpgradePairVersions(project: ProjectModel): boolean {
    const config = readUpgradeConfig(project);
    if (!config.isActive()) {
        return false;
    }

    const versions = VersionsService.getInstance().getVersions();
    let changed = false;

    for (const side of [config.from, config.to]) {
        if (!side || side.versionId) {
            continue;
        }
        const match = versions.find(version => version.odooVersion.trim() === side.series);
        if (!match) {
            continue;
        }
        side.versionId = match.id;
        // Each side's server has to find its own database once it can run.
        project.selectedDbByVersion = { ...(project.selectedDbByVersion ?? {}) };
        project.selectedDbByVersion[match.id] = side.dbId;
        changed = true;
    }

    if (changed) {
        project.upgradeConfig = config;
    }
    return changed;
}

/**
 * Keeps the selected database on a side of the pair while the mode is on.
 *
 * Setting an upgrade up (or resuming one) never moved the selection, so a
 * database picked before the mode kept its "selected" icon beside the two
 * checked pair members - and could not be moved off, since selecting anything
 * outside the pair is refused. The Modules view and every module action follow
 * the selection too, so it pointed them at a database the upgrade is not using.
 *
 * Returns true when something changed and the caller should save.
 */
export function healUpgradeSelection(project: ProjectModel): boolean {
    const config = readUpgradeConfig(project);
    const dbs = project.dbs ?? [];
    if (!config.isActive() || dbs.length === 0) {
        return false;
    }
    if (config.sideForDb(dbs.find(db => db.isSelected)?.id)) {
        return false;
    }

    const target = [config.from?.dbId, config.to?.dbId]
        .find(id => id && dbs.some(db => db.id === id));
    if (!target) {
        return false;
    }
    dbs.forEach(db => (db.isSelected = db.id === target));
    return true;
}

/** Both upgrade context keys, from one config so they cannot disagree. */
export function syncUpgradeContext(config: UpgradeConfigModel): void {
    updateUpgradeContext(config.isActive());
    updateUpgradeRememberedContext(config.isComplete());
}

/** Keeps the context keys in step with what is stored, and heals the pair. */
export async function initializeUpgradeContext(): Promise<void> {
    try {
        const result = await SettingsStore.getSelectedProject();
        const config = readUpgradeConfig(result?.project);
        syncUpgradeContext(config);

        // Both run: `||` would skip the second whenever the first healed.
        const healedVersions = !!result && healUpgradePairVersions(result.project);
        const healedSelection = !!result && healUpgradeSelection(result.project);
        if (result && (healedVersions || healedSelection)) {
            await SettingsStore.saveWithoutComments(stripSettings(result.data));
        }
    } catch (error) {
        logger.warn('Failed to initialize upgrade context:', error);
        updateUpgradeContext(false);
        updateUpgradeRememberedContext(false);
    }
}

export class UpgradeTreeProvider extends BaseTreeProvider<vscode.TreeItem> {
    constructor(_context: vscode.ExtensionContext) {
        super();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    /** What one side of the upgrade runs: its version, database and branches. */
    private describeSideDetails(config: UpgradeConfigModel, side: 'from' | 'to'): vscode.TreeItem[] {
        const entry = side === 'from' ? config.from : config.to;
        if (!entry) {
            return [];
        }
        const version = entry.versionId
            ? VersionsService.getInstance().getVersion(entry.versionId)
            : undefined;

        const rows: vscode.TreeItem[] = [];

        const versionRow = new vscode.TreeItem(
            version ? version.name : `Odoo ${entry.series}`,
            vscode.TreeItemCollapsibleState.None
        );
        versionRow.iconPath = new vscode.ThemeIcon('versions');
        versionRow.description = version
            ? `port ${version.settings.portNumber}`
            : 'still being built';
        rows.push(versionRow);

        const dbRow = new vscode.TreeItem(entry.dbId, vscode.TreeItemCollapsibleState.None);
        dbRow.iconPath = new vscode.ThemeIcon('database');
        dbRow.description = 'database';
        rows.push(dbRow);

        for (const repo of config.repos) {
            const branch = side === 'from' ? repo.fromBranch : repo.toBranch;
            const row = new vscode.TreeItem(repo.repoName, vscode.TreeItemCollapsibleState.None);
            row.iconPath = new vscode.ThemeIcon('git-branch');
            row.description = branch;
            row.tooltip = `"${repo.repoName}" runs ${branch} on this side, in its own copy.`;
            rows.push(row);
        }

        return rows;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        // An empty list falls through to the view's welcome content, which
        // explains that a project has to be selected first.
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            return [];
        }

        const config = readUpgradeConfig(result.project);

        // Expanding a side lists what that side runs. Answering the root list
        // for every element - which ignoring this argument amounts to - makes
        // the view recurse into itself.
        if (element) {
            if (element.contextValue === 'upgradeFrom') {
                return this.describeSideDetails(config, 'from');
            }
            if (element.contextValue === 'upgradeTo') {
                return this.describeSideDetails(config, 'to');
            }
            return [];
        }

        const items: vscode.TreeItem[] = [];

        const toggle = new vscode.TreeItem(
            config.isActive() ? 'Upgrade Enabled' : 'Upgrade Disabled',
            vscode.TreeItemCollapsibleState.None
        );
        toggle.iconPath = config.isActive()
            ? new vscode.ThemeIcon('arrow-up', new vscode.ThemeColor('charts.green'))
            : new vscode.ThemeIcon('arrow-up');
        toggle.command = {
            command: 'upgradeSelector.toggleUpgrade',
            title: 'Toggle Upgrade Mode',
            arguments: [{ isEnabled: config.isActive() }]
        };
        if (config.isActive()) {
            toggle.tooltip = 'Click to turn upgrade mode off. The upgrade is remembered, so turning it back on resumes it.';
        } else if (config.isRemembered()) {
            toggle.tooltip = `Click to resume the ${config.from?.series} → ${config.to?.series} upgrade `
                + `(${config.from?.dbId} → ${config.to?.dbId}).`;
        } else {
            toggle.tooltip = 'Click to set up an upgrade between two databases.';
        }
        toggle.contextValue = 'upgradeToggle';
        items.push(toggle);

        if (!config.isComplete()) {
            return items;
        }

        const versionsService = VersionsService.getInstance();
        const describeSide = (side: 'from' | 'to'): vscode.TreeItem => {
            const entry = side === 'from' ? config.from : config.to;
            const version = entry?.versionId ? versionsService.getVersion(entry.versionId) : undefined;
            // A remembered pair is shown so it can be checked before resuming,
            // folded because none of it is running.
            const item = new vscode.TreeItem(
                `${side === 'from' ? 'From' : 'To'}  Odoo ${entry?.series ?? '?'}`,
                config.isActive()
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.Collapsed
            );
            item.iconPath = config.isActive() ? selectedIcon : new vscode.ThemeIcon('history');
            // Its own id per state: VS Code keeps a row's expansion keyed by
            // id (or label), so without it the folded default never applies
            // to a side that was expanded while the mode was on.
            item.id = `upgrade-${side}-${config.isActive() ? 'active' : 'remembered'}`;
            item.description = version
                ? `${entry?.dbId} • port ${version.settings.portNumber}`
                : `${entry?.dbId} • version still building`;
            item.contextValue = side === 'from' ? 'upgradeFrom' : 'upgradeTo';
            return item;
        };

        items.push(describeSide('from'), describeSide('to'));

        if (!config.isActive()) {
            return items;
        }

        // A toggle row, the shape of testing's "Stop After Init".
        const count = config.stagedModules.length;
        const modules = new vscode.TreeItem(
            `Install ${count} module${count === 1 ? '' : 's'} from ${config.from?.dbId}`,
            vscode.TreeItemCollapsibleState.None
        );
        modules.iconPath = config.installSourceModules ? selectedIcon : unselectedIcon;
        modules.description = [
            config.installSourceModules ? 'on' : 'off',
            config.unavailableModules.length > 0
                ? `${config.unavailableModules.length} not in Odoo ${config.to?.series}`
                : ''
        ].filter(Boolean).join(' • ');
        modules.command = {
            command: 'upgradeSelector.toggleSourceModules',
            title: 'Toggle Installing the Source Modules'
        };
        modules.tooltip = [
            config.installSourceModules
                ? `Marked to install on ${config.to?.dbId}. Click to leave ${config.to?.dbId} with its own modules instead.`
                : `${config.to?.dbId} keeps its own modules. Click to install the set ${config.from?.dbId} runs.`,
            config.unavailableModules.length > 0
                ? `Left out, missing from Odoo ${config.to?.series}: ${config.unavailableModules.join(', ')}`
                : ''
        ].filter(Boolean).join('\n\n');
        modules.contextValue = 'upgradeModules';
        items.push(modules);

        const start = new vscode.TreeItem('Start Both Servers', vscode.TreeItemCollapsibleState.None);
        start.iconPath = new vscode.ThemeIcon('run-all');
        start.command = { command: 'odoo.startBothServers', title: 'Start Both Servers' };
        start.tooltip = 'Starts each side on its own database and port.';
        items.push(start);

        return items;
    }
}

/**
 * Turns upgrade mode off, keeping the upgrade.
 *
 * Only the target's modules change: they go back to its own, and the staged
 * set is kept so turning the mode back on restores it as it was left. The
 * pair, the branches, the copies and the versions all stay, so nothing here
 * needs confirming - turning the mode back on undoes it.
 */
export async function disableUpgradeMode(): Promise<boolean> {
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return false;
    }
    const { data, project } = result;
    const config = readUpgradeConfig(project);
    if (!config.isActive()) {
        return false;
    }

    unstageTargetModules(project, config);
    config.isEnabled = false;
    project.upgradeConfig = config;
    await SettingsStore.saveWithoutComments(stripSettings(data));
    syncUpgradeContext(config);
    showBriefStatus(`Upgrade off. ${config.from?.series} → ${config.to?.series} is remembered; turn it on to resume.`, 3000);
    return true;
}

/**
 * Flips whether the source's module set is installed on the target.
 *
 * Off gives the target its own modules back; on puts the set back as it was
 * left, per-module changes included.
 */
export async function toggleSourceModules(): Promise<boolean> {
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return false;
    }
    const { data, project } = result;
    const config = readUpgradeConfig(project);
    if (!config.isActive()) {
        void showError('Upgrade mode is off, so there is no module set to install.');
        return false;
    }

    config.installSourceModules = !config.installSourceModules;
    if (config.installSourceModules) {
        stageTargetModules(project, config);
    } else {
        unstageTargetModules(project, config);
    }
    project.upgradeConfig = config;
    await SettingsStore.saveWithoutComments(stripSettings(data));
    showBriefStatus(config.installSourceModules
        ? `Installing the modules from ${config.from?.dbId} on ${config.to?.dbId}.`
        : `${config.to?.dbId} is back to its own modules.`, 3000);
    return true;
}
