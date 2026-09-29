/**
 * Command handlers for the Testing view.
 */
import type { CommandDeps } from './index';
import { SettingsStore } from '../settingsStore';
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
import { registerCommand } from './registerCommand';

export function registerTestingCommands(deps: CommandDeps): void {
    const { context, providers, refreshAll } = deps;

    context.subscriptions.push(registerCommand('testingSelector.toggleTesting', async (event) => {
        await toggleTesting(event);
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(registerCommand('testingSelector.toggleStopAfterInit', async () => {
        await toggleStopAfterInit();
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(registerCommand('testingSelector.setTestFile', async () => {
        await setTestFile();
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(registerCommand('testingSelector.addTestTag', async () => {
        await addTestTag();
        providers.testing.refresh();
    }));

    context.subscriptions.push(registerCommand('testingSelector.removeTestTag', async (event) => {
        await removeTestTag(event);
        providers.testing.refresh();
    }));

    context.subscriptions.push(registerCommand('testingSelector.cycleTestTagState', async (event) => {
        await cycleTestTagState(event);
        providers.testing.refresh();
    }));

    context.subscriptions.push(registerCommand('testingSelector.toggleLogLevel', async () => {
        await toggleLogLevel();
        providers.testing.refresh();
    }));

    context.subscriptions.push(registerCommand('testingSelector.setSpecificLogLevel', async () => {
        await setSpecificLogLevel();
        providers.testing.refresh();
    }));

    // No-argument wrapper (keybinding / palette): reads the current state
    // instead of requiring the tree item's payload.
    context.subscriptions.push(registerCommand('odoo.toggleTestingMode', async () => {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            return;
        }
        await toggleTesting({ isEnabled: !!result.project.testingConfig?.isEnabled });
        await refreshAll({ reason: 'ui' });
    }));
}
