/**
 * `odoo.chooseCustomAddonsPath`: points the extension at the folder holding
 * the user's own addon repositories.
 *
 * Setup proposes this folder, but skipping it is a legitimate answer and
 * detection can miss it, so every empty repository list needs a way forward
 * that is not "go and find a setting". The write goes to two places on
 * purpose: the active version, because discovery reads the *version's*
 * `customAddonsPath` and a default would not take effect until the next
 * version was created; and the user-level default, so the next version
 * inherits it.
 */
import * as vscode from 'vscode';
import { VersionsService } from '../versionsService';
import { invalidateRepositoryDiscoveryCache } from '../services/runtimeCache';
import { showInfo } from '../services/notifications';
import type { CommandDeps } from './index';

/**
 * Asks for the folder and records it. Returns the chosen path, or undefined
 * when the user cancels.
 */
export async function chooseCustomAddonsFolder(): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Use This Folder',
        title: 'Select the folder holding your addon repositories'
    });
    const chosen = picked?.[0]?.fsPath;
    if (!chosen) {
        return undefined;
    }

    await rememberCustomAddonsFolder(chosen);
    return chosen;
}

/** Writes the folder to the active version and to the user-level default. */
export async function rememberCustomAddonsFolder(folder: string): Promise<void> {
    await vscode.workspace.getConfiguration('odooDebugger').update(
        'defaultVersion.customAddonsPath',
        folder,
        vscode.ConfigurationTarget.Global
    );

    const service = VersionsService.getInstance();
    const active = service.getActiveVersion();
    if (active) {
        await service.updateVersion(active.id, { settings: { customAddonsPath: folder } } as never);
    }

    invalidateRepositoryDiscoveryCache();
}

export function registerCustomAddonsCommand(deps: CommandDeps): void {
    const { context, refreshAll } = deps;

    context.subscriptions.push(
        vscode.commands.registerCommand('odoo.chooseCustomAddonsPath', async () => {
            const chosen = await chooseCustomAddonsFolder();
            if (!chosen) {
                return;
            }
            void showInfo(`Repositories will be discovered in ${chosen}.`);
            await refreshAll();
        })
    );
}
