/**
 * Command handlers for the Modules view.
 */
import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import {
    selectModule,
    setModuleToInstall,
    setModuleToUpgrade,
    clearModuleState,
    togglePsaeInternalModule,
    updateAllModules,
    installAllModules,
    clearAllModuleSelections,
    updateInstalledModules,
    viewInstalledModules,
    createModuleFromScaffold
} from '../module';

export function registerModuleCommands(deps: CommandDeps): void {
    const { context, refreshAll } = deps;

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.select', async (event) => {
        await selectModule(event);
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.togglePsaeInternalModule', async (event) => {
        await togglePsaeInternalModule(event);
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.create', async () => {
        await createModuleFromScaffold();
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.setToInstall', async (event) => {
        await setModuleToInstall(event);
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.setToUpgrade', async (event) => {
        await setModuleToUpgrade(event);
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.clearState', async (event) => {
        await clearModuleState(event);
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.updateAll', async () => {
        await updateAllModules();
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.updateInstalled', async () => {
        await updateInstalledModules();
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.installAll', async () => {
        await installAllModules();
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.clearAll', async () => {
        await clearAllModuleSelections();
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.viewInstalled', async () => {
        await viewInstalledModules();
    }));
}
