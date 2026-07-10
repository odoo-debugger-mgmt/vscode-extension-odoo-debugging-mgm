import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { startDebugServer, startDebugShell, stopDebugServer } from '../debugger';

export function registerDebugCommands(deps: CommandDeps): void {
    const { context } = deps;

    context.subscriptions.push(vscode.commands.registerCommand('odoo.startServer', async () => {
        await startDebugServer();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.startShell', async () => {
        await startDebugShell();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.stopServer', async () => {
        await stopDebugServer();
    }));
}
