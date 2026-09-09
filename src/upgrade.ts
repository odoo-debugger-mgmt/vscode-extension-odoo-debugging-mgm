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
import { updateUpgradeContext } from './context';
import { revertUpgradeStaging } from './services/upgradeApply';
import { showError, showModalWarning } from './services/notifications';
import { logger } from './services/logger';
import { stripSettings } from './utils';
import { VersionsService } from './versionsService';
import { BaseTreeProvider } from './views/baseTreeProvider';
import { selectedIcon } from './views/icons';

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

/** Keeps the context key in step with what is stored, and heals the pair. */
export async function initializeUpgradeContext(): Promise<void> {
    try {
        const result = await SettingsStore.getSelectedProject();
        const config = readUpgradeConfig(result?.project);
        updateUpgradeContext(config.isActive());

        if (result && healUpgradePairVersions(result.project)) {
            await SettingsStore.saveWithoutComments(stripSettings(result.data));
        }
    } catch (error) {
        logger.warn('Failed to initialize upgrade context:', error);
        updateUpgradeContext(false);
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
        toggle.tooltip = config.isActive()
            ? 'Click to leave upgrade mode. The copies and versions are kept.'
            : 'Click to set up an upgrade between two databases.';
        toggle.contextValue = 'upgradeToggle';
        items.push(toggle);

        if (!config.isActive()) {
            return items;
        }

        const versionsService = VersionsService.getInstance();
        const describeSide = (side: 'from' | 'to'): vscode.TreeItem => {
            const entry = side === 'from' ? config.from : config.to;
            const version = entry?.versionId ? versionsService.getVersion(entry.versionId) : undefined;
            const item = new vscode.TreeItem(
                `${side === 'from' ? 'From' : 'To'}  Odoo ${entry?.series ?? '?'}`,
                vscode.TreeItemCollapsibleState.Expanded
            );
            item.iconPath = selectedIcon;
            item.description = version
                ? `${entry?.dbId} • port ${version.settings.portNumber}`
                : `${entry?.dbId} • version still building`;
            item.contextValue = side === 'from' ? 'upgradeFrom' : 'upgradeTo';
            return item;
        };

        items.push(describeSide('from'), describeSide('to'));

        const modules = new vscode.TreeItem(
            `Modules: ${config.stagedModules.length} staged for install`,
            vscode.TreeItemCollapsibleState.None
        );
        modules.iconPath = new vscode.ThemeIcon('package');
        modules.description = config.unavailableModules.length > 0
            ? `${config.unavailableModules.length} not in Odoo ${config.to?.series}`
            : `from ${config.from?.dbId}`;
        modules.tooltip = config.unavailableModules.length > 0
            ? `Left out, missing from Odoo ${config.to?.series}: ${config.unavailableModules.join(', ')}`
            : `The module set installed in ${config.from?.dbId}, staged onto ${config.to?.dbId}.`;
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
 * Leaves upgrade mode.
 *
 * The copies and the versions stay: they cost minutes to rebuild, nothing to
 * keep, and the next round of the same upgrade wants them. Only what the mode
 * changed in the project's own data is undone.
 */
export async function exitUpgradeMode(): Promise<boolean> {
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return false;
    }
    const { data, project } = result;
    const config = readUpgradeConfig(project);
    if (!config.isActive()) {
        return false;
    }

    const confirmed = await showModalWarning(
        `Leave the Odoo ${config.from?.series} → ${config.to?.series} upgrade?\n\n`
        + `"${config.to?.dbId}" goes back to the modules it had before.\n\n`
        + 'The per-branch copies, the versions and both databases are kept, so '
        + 'setting the same upgrade up again costs nothing.',
        'Leave Upgrade Mode'
    );
    if (confirmed !== 'Leave Upgrade Mode') {
        return false;
    }

    revertUpgradeStaging(project);
    project.upgradeConfig = new UpgradeConfigModel();
    await SettingsStore.saveWithoutComments(stripSettings(data));
    updateUpgradeContext(false);
    return true;
}
