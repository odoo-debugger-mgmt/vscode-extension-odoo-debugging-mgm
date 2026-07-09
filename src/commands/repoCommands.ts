import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { selectRepo } from '../repos';
import { rebuildProjectWorkspace } from '../projectWorkspace';

export function registerRepoCommands(deps: CommandDeps): void {
    const { context, refreshAll } = deps;

    context.subscriptions.push(vscode.commands.registerCommand('repoSelector.selectRepo', async (event) => {
        await selectRepo(event);
        await rebuildProjectWorkspace(context);
        await refreshAll();
    }));
}
