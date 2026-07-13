/**
 * Editor-context commands acting on the active file's Odoo module.
 * Menu visibility is gated by odooDebugger.editorActions.enabled; the
 * commands themselves stay callable from the palette.
 */
import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { findModuleForFile } from '../services/manifest';
import { setModuleToUpgrade } from '../module';
import { prepareTestRunForFile } from '../testing';
import { startDebugServer } from '../debugger';
import { showInfo } from '../services/notifications';

interface ActiveModule {
    name: string;
    path: string;
    fileFsPath: string;
}

async function moduleForActiveEditor(): Promise<ActiveModule | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
        void showInfo('Open a file inside an Odoo module first.');
        return undefined;
    }
    const fileFsPath = editor.document.uri.fsPath;
    const module = await findModuleForFile(fileFsPath);
    if (!module) {
        void showInfo('The active file does not belong to an Odoo module (no __manifest__.py found).');
        return undefined;
    }
    return { ...module, fileFsPath };
}

export function registerEditorCommands(deps: CommandDeps): void {
    const { context, providers, moduleTreeView, refreshAll } = deps;

    context.subscriptions.push(vscode.commands.registerCommand('odoo.upgradeCurrentModule', async () => {
        const module = await moduleForActiveEditor();
        if (!module) {
            return;
        }
        if (!(await setModuleToUpgrade({ name: module.name }))) {
            return;
        }
        await refreshAll();
        const choice = await showInfo(`Module "${module.name}" marked for upgrade.`, 'Restart Server');
        if (choice === 'Restart Server') {
            await startDebugServer();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.runTestsForCurrentFile', async () => {
        const module = await moduleForActiveEditor();
        if (!module) {
            return;
        }
        if (!(await prepareTestRunForFile(module.fileFsPath, module.name))) {
            return;
        }
        await refreshAll();
        await startDebugServer();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.revealModuleInView', async () => {
        const module = await moduleForActiveEditor();
        if (!module) {
            return;
        }
        const node = await providers.module.findModuleNode(module.name);
        if (!node) {
            void showInfo(`Module "${module.name}" was not found in the Modules view - is its repository part of the active project?`);
            return;
        }
        await moduleTreeView.reveal(node, { select: true, focus: true });
    }));
}
