import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { registerCommand } from './registerCommand';
import { ViewItem, resolveViewDoctorTarget } from '../views/viewDoctorView';
import { VIEW_SCHEME, clearViewDiagnostics, parseViewUri, viewUri } from '../views/viewFileSystem';
import { showBriefStatus, showError, showInfo, showModalWarning, showWarning } from '../services/notifications';
import { SettingsStore } from '../settingsStore';
import { compareTargets, diffArguments, findCounterpart, upgradePair, type PairProject } from '../views/viewPairing';
import { errorMessage } from '../services/logger';
import { qwebMessage } from '../services/views/renderPlan';
import type { RenderTarget } from '../services/views/renderSession';
import { createUpgradeScript } from '../views/upgradeScriptFlow';
import { readableArchError } from '../services/views/archErrors';
import { checkResultText } from '../services/views/xpathReport';
import { descendants, type ViewRow } from '../services/views/viewQueries';
import { findView, pickView } from '../views/findViewFlow';
import { viewTarget, type ViewTarget } from '../views/viewTarget';

function viewItem(arg: unknown): ViewItem | undefined {
    return arg instanceof ViewItem ? arg : undefined;
}

async function openArch(dbName: string, viewId: number, xmlid: string | null): Promise<void> {
    await vscode.window.showTextDocument(viewUri(dbName, viewId, xmlid ?? `view-${viewId}`), { preview: true });
}

/** The view's open arch - revealed when no editor shows it - or the arch opened now. */
async function archDocument(dbName: string, view: ViewRow): Promise<vscode.TextDocument> {
    const open = vscode.workspace.textDocuments.find(document => {
        const ref = document.uri.scheme === VIEW_SCHEME ? parseViewUri(document.uri) : undefined;
        return ref?.dbName === dbName && ref.viewId === view.id;
    });
    if (open && vscode.window.visibleTextEditors.some(editor => editor.document === open)) {
        return open;
    }
    return (await vscode.window.showTextDocument(open?.uri ?? viewUri(dbName, view.id, view.xmlid ?? `view-${view.id}`), { preview: true })).document;
}

export function registerViewDoctorCommands(deps: CommandDeps): void {
    const { context, providers, viewService, viewNotes, viewDiagnostics, xpathDiagnostics, viewRender } = deps;

    /** The view a command acts on (a row, an arch editor, or the active editor); the error is shown when it is gone. */
    const target = async (arg: unknown): Promise<ViewTarget | undefined> => {
        try {
            return await viewTarget(arg, (dbName, ids) => viewService.rows(dbName, ids));
        } catch (error) {
            void showError(errorMessage(error));
            return undefined;
        }
    };

    context.subscriptions.push(registerCommand('viewDoctor.refresh', () => providers.views.refresh()));

    context.subscriptions.push(registerCommand('viewDoctor.openArch', async (arg: unknown) => {
        const item = viewItem(arg);
        if (item) {
            await openArch(item.dbName, item.view.id, item.view.xmlid);
        }
    }));

    context.subscriptions.push(registerCommand('viewDoctor.openParent', async (arg: unknown) => {
        const item = await target(arg);
        if (!item) {
            return;
        }
        if (!item.view.inheritId) {
            void showInfo(`${item.view.name} inherits no view.`);
            return;
        }
        const [parent] = await viewService.rows(item.dbName, [item.view.inheritId]);
        await openArch(item.dbName, item.view.inheritId, parent?.xmlid ?? null);
    }));

    context.subscriptions.push(registerCommand('viewDoctor.openRoot', async (arg: unknown) => {
        const item = await target(arg);
        if (!item) {
            return;
        }
        if (item.view.rootId === item.view.id) {
            void showInfo(`${item.view.name} is a root view.`);
            return;
        }
        const [root] = await viewService.rows(item.dbName, [item.view.rootId]);
        await openArch(item.dbName, item.view.rootId, root?.xmlid ?? null);
    }));

    context.subscriptions.push(registerCommand('viewDoctor.compare', async (arg: unknown) => {
        const item = await target(arg);
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
        const item = await target(arg);
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
                    startLabel: 'Start Both Servers',
                    notice: counterpart === 'none' ? `${pair.original.dbName} has no matching view; showing the upgraded side only.` : undefined
                });
                return;
            }
            const db = project?.dbs?.find(entry => entry.id === item.dbName);
            await viewRender.show({
                title: item.view.name,
                targets: [{ dbName: item.dbName, versionId: db?.versionId, viewId: item.view.id, title: item.dbName }],
                startCommand: 'odoo.startServer',
                startLabel: 'Start Server'
            });
        } catch (error) {
            void showError(`Could not render ${item.view.name}: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(registerCommand('viewDoctor.checkXpaths', async (arg: unknown) => {
        const item = await target(arg);
        if (!item) {
            return;
        }
        if (!item.view.inheritId) {
            void showInfo(`${item.view.name} inherits no view: it has no locators to check.`);
            return;
        }
        try {
            const document = await archDocument(item.dbName, item.view);
            const text = document.getText();
            const report = await viewService.checkXpaths(item.dbName, item.view.id, text);
            // Closed while the shell answered: closing cleared its diagnostics, keep it so.
            if (!document.isClosed) {
                xpathDiagnostics.show(document.uri, text, report);
            }
            const result = checkResultText(report);
            void (result.level === 'info' ? showInfo(result.text) : showWarning(result.text));
        } catch (error) {
            void showError(`Could not check ${item.view.name}: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(registerCommand('viewDoctor.activate', async (arg: unknown) => {
        const item = viewItem(arg);
        if (!item) {
            return;
        }
        try {
            await viewService.activate(item.dbName, item.view.id);
            await viewNotes.recordActivate(item.dbName, item.view.id);
            viewRender.reloadDatabase(item.dbName);
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
            viewRender.reloadDatabase(item.dbName);
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

    const openView = (dbName: string, view: ViewRow) => openArch(dbName, view.id, view.xmlid);

    context.subscriptions.push(registerCommand('viewDoctor.findView', async () => {
        const project = (await SettingsStore.peekSelectedProject().catch(() => null))?.project;
        const where = resolveViewDoctorTarget(project as Parameters<typeof resolveViewDoctorTarget>[0]);
        if (!where) {
            void showInfo('Select a database first.');
            return;
        }
        try {
            await findView(where.dbName, openView);
        } catch (error) {
            void showError(`Could not search the views of ${where.dbName}: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(registerCommand('viewDoctor.showInheriting', async (arg: unknown) => {
        const item = await target(arg);
        if (!item) {
            return;
        }
        try {
            const rows = await descendants(item.dbName, item.view.id);
            if (rows.length <= 1) {
                void showInfo(`No view inherits ${item.view.name}.`);
                return;
            }
            await pickView(item.dbName, rows, `Views inheriting ${item.view.name}`, openView);
        } catch (error) {
            void showError(`Could not list the views inheriting ${item.view.name}: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(registerCommand('viewDoctor.createScript', async () => {
        const project = (await SettingsStore.peekSelectedProject().catch(() => null))?.project;
        const target = resolveViewDoctorTarget(project as Parameters<typeof resolveViewDoctorTarget>[0]);
        if (!target) {
            void showInfo('Select a database first.');
            return;
        }
        try {
            await createUpgradeScript(deps, target.dbName);
        } catch (error) {
            void showError(`Could not create the upgrade script: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(registerCommand('viewDoctor.addToScript', async (arg: unknown) => {
        const item = await target(arg);
        if (!item) {
            return;
        }
        try {
            await createUpgradeScript(deps, item.dbName, item.view.id);
        } catch (error) {
            void showError(`Could not add ${item.view.name} to an upgrade script: ${errorMessage(error)}`);
        }
    }));
}
