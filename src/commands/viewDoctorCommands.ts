import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { registerCommand } from './registerCommand';
import { ViewItem } from '../views/viewDoctorView';
import { clearViewDiagnostics, viewUri } from '../views/viewFileSystem';
import { showBriefStatus, showError, showInfo, showModalWarning } from '../services/notifications';
import { SettingsStore } from '../settingsStore';
import { compareTargets, diffArguments, findCounterpart, upgradePair, type PairProject } from '../views/viewPairing';
import { errorMessage } from '../services/logger';
import { qwebMessage } from '../services/views/renderPlan';
import type { RenderTarget } from '../services/views/renderSession';
import { readableArchError } from '../services/views/archErrors';

function viewItem(arg: unknown): ViewItem | undefined {
    return arg instanceof ViewItem ? arg : undefined;
}

async function openArch(dbName: string, viewId: number, xmlid: string | null): Promise<void> {
    await vscode.window.showTextDocument(viewUri(dbName, viewId, xmlid ?? `view-${viewId}`), { preview: true });
}

export function registerViewDoctorCommands(deps: CommandDeps): void {
    const { context, providers, viewService, viewDiagnostics, viewRender } = deps;

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

    context.subscriptions.push(registerCommand('viewDoctor.render', async (arg: unknown) => {
        const item = viewItem(arg);
        if (!item) {
            return;
        }
        if (item.view.type === 'qweb') {
            void showInfo(qwebMessage(item.view.isReport));
            return;
        }
        try {
            const project = (await SettingsStore.peekSelectedProject().catch(() => null))?.project as PairProject | undefined;
            const pair = upgradePair(project);
            if (pair && pair.upgraded.dbName === item.dbName) {
                const counterpart = await findCounterpart(item.view, pair.original.dbName);
                if (counterpart === undefined) {
                    return;
                }
                const targets: RenderTarget[] = [];
                if (counterpart !== 'none') {
                    targets.push({ dbName: pair.original.dbName, versionId: pair.original.versionId, viewId: counterpart.id, title: `Original · ${pair.original.dbName}` });
                }
                targets.push({ dbName: item.dbName, versionId: pair.upgraded.versionId, viewId: item.view.id, title: `Upgraded · ${item.dbName}` });
                await viewRender.show({
                    title: item.view.name,
                    targets,
                    startCommand: 'odoo.startBothServers',
                    notice: counterpart === 'none' ? `${pair.original.dbName} has no matching view; showing the upgraded side only.` : undefined
                });
                return;
            }
            const db = project?.dbs?.find(entry => entry.id === item.dbName);
            await viewRender.show({
                title: item.view.name,
                targets: [{ dbName: item.dbName, versionId: db?.versionId, viewId: item.view.id, title: item.dbName }],
                startCommand: 'odoo.startServer'
            });
        } catch (error) {
            void showError(`Could not render ${item.view.name}: ${errorMessage(error)}`);
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
