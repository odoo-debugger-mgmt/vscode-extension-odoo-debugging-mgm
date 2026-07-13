/**
 * Start/stop/restart server (with and without debugging) and shell commands.
 */
import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { startDebugServer, startDebugShell, stopDebugServer } from '../debugger';
import { openServerInBrowser } from '../services/server';
import { SettingsStore } from '../settingsStore';
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
    context.subscriptions.push(vscode.commands.registerCommand('odoo.restartServer', async () => {
        await startDebugServer();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.startShell', async () => {
        await startDebugShell();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.stopServer', async () => {
        await stopDebugServer();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.openInBrowser', async () => {
        const result = await SettingsStore.getSelectedProject();
        const selectedDb = (result?.project.dbs as DatabaseModel[] | undefined)?.find(db => db.isSelected);
        await openServerInBrowser(selectedDb?.id);
    }));
}
