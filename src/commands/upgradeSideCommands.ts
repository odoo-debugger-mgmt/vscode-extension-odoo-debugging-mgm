/**
 * An upgrade across two workspaces (design §7): each window runs the side
 * its version is, and can open the window that runs the other.
 */
import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { registerCommand } from './registerCommand';
import { SettingsStore } from '../settingsStore';
import { VersionsService } from '../versionsService';
import { startServerForVersion } from '../debugger';
import { ensureUpgradeConfigModel, type UpgradeConfigModel } from '../models/upgrade';
import { boundVersionId } from '../services/workspaceBinding';
import { currentMainStore } from '../services/mainStore';
import { refreshRegistry, thisWorkspaceId } from '../services/workspaceRegistry';
import { showError, showInfo } from '../services/notifications';
import { otherSide, thisSide, type UpgradeSide } from '../services/upgradeSides';


async function currentUpgrade(): Promise<{ config: UpgradeConfigModel; side: UpgradeSide | undefined } | undefined> {
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return undefined;
    }
    const config = ensureUpgradeConfigModel(result.project.upgradeConfig);
    if (!config.isActive()) {
        void showError('No upgrade is set up, so there is no side to start.', 'Set Up an Upgrade').then(choice => {
            if (choice === 'Set Up an Upgrade') {
                void vscode.commands.executeCommand('odoo.setUpUpgrade');
            }
        });
        return undefined;
    }
    const versions = VersionsService.getInstance();
    await versions.initialize();
    return { config, side: thisSide(config, boundVersionId(), versions.getActiveVersion()?.id) };
}

/** Starts the side this window runs, and only that one. */
async function startThisSide(): Promise<void> {
    const upgrade = await currentUpgrade();
    if (!upgrade) {
        return;
    }
    const { config, side } = upgrade;
    if (!side) {
        void showInfo(
            `This window runs neither side of the ${config.from?.series} → ${config.to?.series} upgrade. `
            + 'Start Both Servers starts them from here.',
            'Start Both Servers'
        ).then(choice => {
            if (choice === 'Start Both Servers') {
                void vscode.commands.executeCommand('odoo.startBothServers');
            }
        });
        return;
    }
    const entry = side === 'from' ? config.from : config.to;
    if (!entry?.versionId) {
        void showInfo(`Odoo ${entry?.series}'s version is still being built; it can start once it is.`);
        return;
    }
    await startServerForVersion(entry.versionId);
}

/** Opens the workspace running the other side, from the shared store's registry. */
async function openOtherSide(): Promise<void> {
    const upgrade = await currentUpgrade();
    if (!upgrade) {
        return;
    }
    const { config, side } = upgrade;
    if (!currentMainStore()?.listWorkspaces) {
        void showInfo('Only a shared data store knows which workspace runs the other side. Choose one with Choose Data Store….');
        return;
    }
    // A window running neither side is asked which one to open.
    let target: UpgradeSide | undefined = side ? otherSide(side) : undefined;
    if (!target) {
        const picked = await vscode.window.showQuickPick(
            (['from', 'to'] as const).map(value => ({
                label: `Odoo ${(value === 'from' ? config.from : config.to)?.series}`,
                description: value === 'from' ? 'upgrading from' : 'upgrading to',
                value
            })),
            { title: 'Open the Other Side', placeHolder: 'Which side?' }
        );
        target = picked?.value;
    }
    const entry = target === 'from' ? config.from : target === 'to' ? config.to : undefined;
    if (!entry) {
        return;
    }
    const own = thisWorkspaceId();
    const rows = (await refreshRegistry())
        .filter(row => row.id !== own && !!entry.versionId && row.versionId === entry.versionId);
    if (rows.length === 0) {
        void showInfo(
            `No other workspace on this store runs Odoo ${entry.series} yet. Open one and bind it with `
            + 'Bind This Workspace to a Version…, or run Start Both Servers from here.'
        );
        return;
    }
    const chosen = rows.length === 1
        ? rows[0]
        : (await vscode.window.showQuickPick(
            rows.map(row => ({ label: row.name, detail: vscode.Uri.parse(row.uri).fsPath, row })),
            { title: `Open the Odoo ${entry.series} Workspace`, placeHolder: 'Which workspace?' }
        ))?.row;
    if (chosen) {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(chosen.uri), { forceNewWindow: true });
    }
}

export function registerUpgradeSideCommands(deps: CommandDeps): void {
    deps.context.subscriptions.push(
        registerCommand('odoo.startThisSide', startThisSide),
        registerCommand('odoo.openOtherSide', openOtherSide)
    );
}
