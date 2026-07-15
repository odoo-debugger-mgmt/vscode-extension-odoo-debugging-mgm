/**
 * Command handlers for the Modules view.
 */
import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { showInfo } from '../services/notifications';
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
    createModuleFromScaffold,
    quickConfigureModules
} from '../module';

/**
 * Tree context menus pass (clickedItem, selectedItems); with canSelectMany
 * enabled a bulk action applies to the whole selection when the clicked
 * item is part of it.
 */
function targetsOf(event: unknown, selection?: unknown[]): unknown[] {
    if (selection && selection.length > 1 && selection.includes(event)) {
        return selection;
    }
    return [event];
}

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

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.setToInstall', async (event, selection?: unknown[]) => {
        for (const target of targetsOf(event, selection)) {
            await setModuleToInstall(target);
        }
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.setToUpgrade', async (event, selection?: unknown[]) => {
        for (const target of targetsOf(event, selection)) {
            await setModuleToUpgrade(target);
        }
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.clearState', async (event, selection?: unknown[]) => {
        for (const target of targetsOf(event, selection)) {
            await clearModuleState(target);
        }
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

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.quickConfigure', async () => {
        await quickConfigureModules();
        // One refresh when the picker closes, however many states changed.
        await refreshAll();
    }));

    // Same reveal behavior as the Project Repos view, triggered from a
    // module item (module nodes carry moduleData.path, not a resourceUri).
    const modulePathOf = (event: unknown): string | undefined =>
        (event as { moduleData?: { path?: string } } | undefined)?.moduleData?.path;

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.revealInExplorer', async (event) => {
        const modulePath = modulePathOf(event);
        if (!modulePath) {
            void showInfo('Could not identify the module to reveal.');
            return;
        }
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(modulePath));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.revealInOS', async (event) => {
        const modulePath = modulePathOf(event);
        if (!modulePath) {
            void showInfo('Could not identify the module to reveal.');
            return;
        }
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(modulePath));
    }));
}
