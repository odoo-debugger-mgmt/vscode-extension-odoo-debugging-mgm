/**
 * Command handlers for the Repos view.
 */
import type { CommandDeps } from './index';
import { selectRepo } from '../repos';
import { rebuildProjectWorkspace } from '../projectWorkspace';
import { registerCommand } from './registerCommand';

export function registerRepoCommands(deps: CommandDeps): void {
    const { context, refreshAll } = deps;

    context.subscriptions.push(registerCommand('repoSelector.selectRepo', async (event) => {
        await selectRepo(event);
        await rebuildProjectWorkspace(context);
        await refreshAll();
    }));
}
