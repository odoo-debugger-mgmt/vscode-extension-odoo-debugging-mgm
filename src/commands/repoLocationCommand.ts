import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { extractVersionId } from './args';
import { registerCommand } from './registerCommand';
import { SettingsStore } from '../settingsStore';
import { showInfo, showModalWarning } from '../services/notifications';
import { locateRepoCheckouts, remoteOf } from '../services/repoLocations';
import { extraRootsFor } from '../services/versionRepos';
import { normalizePath } from '../utils';

const DESCRIBE_SOURCE: Record<string, string> = {
    override: 'set by hand',
    remote: 'found by its remote',
    name: 'found by its folder name',
    default: "the repository's own path"
};

/**
 * Odoo DevTools: Set Repository Location for a Version…
 *
 * For the layout where one repository has a different home per version that
 * the custom addons folder cannot find: another name and another remote, or a
 * folder outside it.
 */
export function registerRepoLocationCommand(deps: CommandDeps): void {
    const { context, versionsService, refreshAll } = deps;

    context.subscriptions.push(registerCommand('odoo.setRepoLocation', async (versionIdOrTreeItem?: unknown) => {
        await versionsService.initialize();
        let versionId = extractVersionId(versionIdOrTreeItem);
        if (!versionId) {
            const active = versionsService.getActiveVersion();
            const picked = await vscode.window.showQuickPick(
                versionsService.getVersions()
                    .map(version => ({
                        label: version.name,
                        description: version.odooVersion,
                        detail: version.id === active?.id ? '$(check) Active' : undefined,
                        versionId: version.id
                    }))
                    .sort((a, b) => Number(b.versionId === active?.id) - Number(a.versionId === active?.id)),
                { title: 'Set Repository Location', placeHolder: 'Which version?' }
            );
            versionId = picked?.versionId;
        }
        const version = versionId ? versionsService.getVersion(versionId) : undefined;
        if (!version) {
            return;
        }

        const result = await SettingsStore.getSelectedProject();
        const repos = result?.project.repos ?? [];
        if (repos.length === 0) {
            void showInfo('The selected project has no repositories yet.');
            return;
        }

        const located = await locateRepoCheckouts(repos, version, undefined, extraRootsFor(version));
        const repoPick = await vscode.window.showQuickPick(
            repos.map(repo => {
                const at = located.get(repo.name);
                return {
                    label: repo.name,
                    description: at?.path,
                    detail: at ? DESCRIBE_SOURCE[at.source] : undefined,
                    repo
                };
            }),
            { title: `Repository location for ${version.name}`, placeHolder: 'Which repository?' }
        );
        if (!repoPick) {
            return;
        }
        const repo = repoPick.repo;

        const current = version.settings.repoPaths ?? {};
        const actions: Array<{ label: string; action: 'choose' | 'clear' }> = [
            { label: '$(folder-opened) Choose a Folder…', action: 'choose' }
        ];
        if (current[repo.name]) {
            actions.push({ label: '$(discard) Use the Default', action: 'clear' });
        }
        const action = await vscode.window.showQuickPick(actions, {
            title: `${repo.name} for ${version.name}`,
            placeHolder: current[repo.name]
                ? `Set by hand: ${current[repo.name]}`
                : 'Found automatically; choose a folder to set it by hand'
        });
        if (!action) {
            return;
        }

        const next = { ...current };
        if (action.action === 'clear') {
            delete next[repo.name];
        } else {
            const folder = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: `Use for ${version.name}`,
                defaultUri: vscode.Uri.file(located.get(repo.name)?.path ?? normalizePath(repo.path))
            });
            const chosen = folder?.[0]?.fsPath;
            if (!chosen) {
                return;
            }
            if (!fs.existsSync(path.join(chosen, '.git'))) {
                void showInfo(`${chosen} is not a git checkout, so it was not set.`);
                return;
            }
            const [chosenRemote, repoRemote] = await Promise.all([remoteOf(chosen), remoteOf(normalizePath(repo.path))]);
            if (chosenRemote && repoRemote && chosenRemote !== repoRemote) {
                const confirmed = await showModalWarning(
                    `${chosen} is a clone of ${chosenRemote}, not of ${repoRemote} like "${repo.name}". Use it for ${version.name} anyway?`,
                    'Use It'
                );
                if (confirmed !== 'Use It') {
                    return;
                }
            }
            next[repo.name] = chosen;
        }

        await versionsService.updateVersion(version.id, { settings: { ...version.settings, repoPaths: next } });
        void showInfo(action.action === 'clear'
            ? `${version.name} finds "${repo.name}" automatically again.`
            : `${version.name} now uses ${next[repo.name]} for "${repo.name}".`);
        await refreshAll();
    }));
}
