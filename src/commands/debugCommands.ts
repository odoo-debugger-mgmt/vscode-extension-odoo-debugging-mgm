import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { startDebugServer, startDebugShell } from '../debugger';

export function registerDebugCommands(deps: CommandDeps): void {
    const { context } = deps;

    context.subscriptions.push(vscode.commands.registerCommand('odoo.startServer', async () => {
        await startDebugServer();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.startShell', async () => {
        await startDebugShell();
    }));
}
