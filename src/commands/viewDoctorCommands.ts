import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { registerCommand } from './registerCommand';
import { ViewItem } from '../views/viewDoctorView';
import { clearViewDiagnostics, viewUri } from '../views/viewFileSystem';
import { showBriefStatus, showError, showInfo, showModalWarning } from '../services/notifications';
import { SettingsStore } from '../settingsStore';
import { compareTargets, diffArguments, findCounterpart, type PairProject } from '../views/viewPairing';
import { errorMessage } from '../services/logger';
import { readableArchError } from '../services/views/archErrors';

function viewItem(arg: unknown): ViewItem | undefined {
    return arg instanceof ViewItem ? arg : undefined;
}

async function openArch(dbName: string, viewId: number, xmlid: string | null): Promise<void> {
    await vscode.window.showTextDocument(viewUri(dbName, viewId, xmlid ?? `view-${viewId}`), { preview: true });
}

export function registerViewDoctorCommands(deps: CommandDeps): void {
    const { context, providers, viewService, viewDiagnostics } = deps;

    context.subscriptions.push(registerCommand('viewDoctor.refresh', () => providers.views.refresh()));

    context.subscriptions.push(registerCommand('viewDoctor.openArch', async (arg: unknown) => {
        const item = viewItem(arg);
        if (item) {
            await openArch(item.dbName, item.view.id, item.view.xmlid);
        }
    }));

    context.subscriptions.push(registerCommand('viewDoctor.openParent', async (arg: unknown) => {
        const item = viewItem(arg);
        if (!item?.view.inheritId) {
            return;
        }
        const [parent] = await viewService.rows(item.dbName, [item.view.inheritId]);
        await openArch(item.dbName, item.view.inheritId, parent?.xmlid ?? null);
    }));

    context.subscriptions.push(registerCommand('viewDoctor.compare', async (arg: unknown) => {
        const item = viewItem(arg);
        if (!item) {
            return;
        }
        try {
            const project = (await SettingsStore.peekSelectedProject().catch(() => null))?.project as PairProject | undefined;
            const originalDb = await compareTargets(project, item);
            if (!originalDb) {
                return;
            }
            const counterpart = await findCounterpart(item.view, originalDb);
            if (counterpart === 'none') {
                void showInfo(`${originalDb} has no ${item.view.type} view of ${item.view.model || 'this model'} to compare with.`);
                return;
            }
            if (!counterpart) {
                return;
            }
            await vscode.commands.executeCommand('vscode.diff',
                ...diffArguments({ dbName: originalDb, view: counterpart }, { dbName: item.dbName, view: item.view }));
        } catch (error) {
            void showError(`Could not compare ${item.view.name}: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(registerCommand('viewDoctor.activate', async (arg: unknown) => {
        const item = viewItem(arg);
        if (!item) {
            return;
        }
        try {
            await viewService.activate(item.dbName, item.view.id);
            // The reason a save left it off no longer holds.
            clearViewDiagnostics(viewDiagnostics, item.dbName, item.view.id);
            showBriefStatus(`${item.view.name} is on.`);
        } catch (error) {
            const choice = await showError(`${item.view.name} cannot be turned on: ${readableArchError(errorMessage(error))}`, 'Open Arch');
            if (choice === 'Open Arch') {
                await openArch(item.dbName, item.view.id, item.view.xmlid);
            }
        } finally {
            providers.views.refresh();
        }
    }));

    context.subscriptions.push(registerCommand('viewDoctor.deactivate', async (arg: unknown) => {
        const item = viewItem(arg);
        if (!item) {
            return;
        }
        const choice = await showModalWarning(`Turn off ${item.view.name} in ${item.dbName}?`, 'Turn Off');
        if (choice !== 'Turn Off') {
            return;
        }
        try {
            await viewService.deactivate(item.dbName, item.view.id);
            showBriefStatus(`${item.view.name} is off.`);
        } catch (error) {
            void showError(`${item.view.name} could not be turned off: ${errorMessage(error)}`);
        } finally {
            providers.views.refresh();
        }
    }));

    context.subscriptions.push(registerCommand('viewDoctor.copyXmlid', async (arg: unknown) => {
        const item = viewItem(arg);
        if (!item) {
            return;
        }
        // The menu hides it for a view without one; never copy the id in its place.
        if (item.view.xmlid) {
            await vscode.env.clipboard.writeText(item.view.xmlid);
            showBriefStatus('Copied.');
        } else {
            showBriefStatus(`${item.view.name} has no external ID.`);
        }
    }));
}
