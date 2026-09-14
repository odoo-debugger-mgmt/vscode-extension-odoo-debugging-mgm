/**
 * Start/stop/restart server (with and without debugging) and shell commands.
 */
import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { startDebugServer, startDebugShell, startServerForVersion, stopDebugServer, buildOdooCommandLine } from '../debugger';
import { openServerInBrowser, waitForPort } from '../services/server';
import { showBriefStatus, showError } from '../services/notifications';
import { SettingsStore } from '../settingsStore';
import { VersionsService } from '../versionsService';
import { ensureUpgradeConfigModel } from '../models/upgrade';
import type { DatabaseModel } from '../models/db';

export function registerDebugCommands(deps: CommandDeps): void {
    const { context } = deps;

    context.subscriptions.push(vscode.commands.registerCommand('odoo.startServer', async () => {
        await startDebugServer();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.startServerNoDebug', async () => {
        await startDebugServer({ noDebug: true });
    }));

    // startDebugServer already stops the extension's own session first, so a
    // restart is a plain start; the separate command exists for
    // discoverability (palette + keybinding).
    context.subscriptions.push(vscode.commands.registerCommand('odt.server.restart', async () => {
        await startDebugServer();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.startShell', async () => {
        await startDebugShell();
    }));

    // Both sides of an upgrade at once. Started in order and waited on: the
    // second server's port probe races the first's startup otherwise, and two
    // interpreters resolving their addons paths at the same moment is the one
    // way to make a cold start look like a hang.
    context.subscriptions.push(vscode.commands.registerCommand('odoo.startBothServers', async () => {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            return;
        }
        const config = ensureUpgradeConfigModel(result.project.upgradeConfig);
        if (!config.isActive()) {
            void showError('No upgrade is set up, so there is no pair to start.', 'Set Up an Upgrade')
                .then(choice => {
                    if (choice === 'Set Up an Upgrade') {
                        void vscode.commands.executeCommand('odoo.setUpUpgrade');
                    }
                });
            return;
        }

        const sides: Array<{ label: string; versionId?: string; port?: number }> = [
            { label: `Odoo ${config.from?.series}`, versionId: config.from?.versionId },
            { label: `Odoo ${config.to?.series}`, versionId: config.to?.versionId }
        ];

        const failures: string[] = [];
        for (const side of sides) {
            // A side whose version is still being built has no id yet, and
            // startServerForVersion falls back to the active version - which
            // would start the wrong server, twice.
            if (!side.versionId) {
                failures.push(`${side.label}: its version is still being built`);
                continue;
            }
            const outcome = await startServerForVersion(side.versionId, { quiet: true });
            if (!outcome.ok) {
                failures.push(`${side.label}: ${outcome.message ?? 'could not start'}`);
                continue;
            }
            const version = VersionsService.getInstance().getVersion(side.versionId ?? '');
            if (version?.settings.portNumber) {
                // Best-effort: a server that is slow to bind is not a failure,
                // it just means the next one starts alongside it.
                await waitForPort(version.settings.portNumber, 30000);
            }
        }

        if (failures.length > 0) {
            void showError(`Could not start both servers. ${failures.join('. ')}.`);
        } else {
            showBriefStatus('Both upgrade servers are starting');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.stopServer', async () => {
        await stopDebugServer();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.openInBrowser', async () => {
        const result = await SettingsStore.getSelectedProject();
        const selectedDb = (result?.project.dbs as DatabaseModel[] | undefined)?.find(db => db.isSelected);
        await openServerInBrowser(selectedDb?.id, selectedDb?.versionId);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.copyCommand', async () => {
        const command = await buildOdooCommandLine(false);
        if (!command) {
            return;
        }
        await vscode.env.clipboard.writeText(command);
        showBriefStatus('Copied the Odoo command to the clipboard');
    }));
}
