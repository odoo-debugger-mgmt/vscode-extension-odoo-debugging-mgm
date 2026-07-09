import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import {
    toggleTesting,
    toggleStopAfterInit,
    setTestFile,
    addTestTag,
    removeTestTag,
    cycleTestTagState,
    toggleLogLevel,
    setSpecificLogLevel
} from '../testing';

export function registerTestingCommands(deps: CommandDeps): void {
    const { context, providers, refreshAll } = deps;

    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.toggleTesting', async (event) => {
        await toggleTesting(event);
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.toggleStopAfterInit', async () => {
        await toggleStopAfterInit();
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.setTestFile', async () => {
        await setTestFile();
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.addTestTag', async () => {
        await addTestTag();
        providers.testing.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.removeTestTag', async (event) => {
        await removeTestTag(event);
        providers.testing.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.cycleTestTagState', async (event) => {
        await cycleTestTagState(event);
        providers.testing.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.toggleLogLevel', async () => {
        await toggleLogLevel();
        providers.testing.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.setSpecificLogLevel', async () => {
        await setSpecificLogLevel();
        providers.testing.refresh();
    }));
}
