import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { registerCommand } from './registerCommand';
import { ViewItem } from '../views/viewDoctorView';
import { viewUri } from '../views/viewFileSystem';
import { showBriefStatus, showError, showModalWarning } from '../services/notifications';
import { errorMessage } from '../services/logger';

function viewItem(arg: unknown): ViewItem | undefined {
    return arg instanceof ViewItem ? arg : undefined;
}

async function openArch(dbName: string, viewId: number, xmlid: string | null): Promise<void> {
    await vscode.window.showTextDocument(viewUri(dbName, viewId, xmlid ?? `view-${viewId}`), { preview: true });
}

export function registerViewDoctorCommands(deps: CommandDeps): void {
    const { context, providers, viewService } = deps;

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

    context.subscriptions.push(registerCommand('viewDoctor.activate', async (arg: unknown) => {
        const item = viewItem(arg);
        if (!item) {
            return;
        }
        try {
            await viewService.activate(item.dbName, item.view.id);
            showBriefStatus(`${item.view.name} is on.`);
        } catch (error) {
            const choice = await showError(`${item.view.name} cannot be turned on: ${errorMessage(error)}`, 'Open Arch');
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
        if (item) {
            await vscode.env.clipboard.writeText(item.view.xmlid ?? String(item.view.id));
            showBriefStatus('Copied.');
        }
    }));
}
