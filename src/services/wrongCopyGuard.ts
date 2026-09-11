/**
 * Warns when a file being opened belongs to a version other than the active
 * one. Scoping the views (see repoPaths.ts consumers) removes the wrong copy
 * from the UI, but not from search history, bookmarks or external tools - and
 * two directories with identical file trees is the hazard this design
 * introduces, so it gets a second line of defence.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SettingsStore } from '../settingsStore';
import { logger } from './logger';
import { showWarning } from './notifications';
import { readSetupState } from './setupState';
import { resolveProjectRepos, worktreeDirName } from './repoPaths';
import { resolveProjectRepoBranchAssignments } from './environment';
import { ensureUpgradeConfigModel, UpgradeConfigModel } from '../models/upgrade';

const SUPPRESSED_KEY = 'odooDevtools.wrongCopyWarningSuppressed';

/**
 * The repo and branch a path under the provisioning root belongs to, derived
 * from the `<repo>@<branch>` directory name rather than from configuration -
 * the file may belong to a version that is not currently resolvable.
 */
export function parseWorktreeDirName(dirName: string): { repo: string; branch: string } | undefined {
    const at = dirName.lastIndexOf('@');
    if (at <= 0 || at === dirName.length - 1) {
        return undefined;
    }
    return { repo: dirName.slice(0, at), branch: dirName.slice(at + 1) };
}

/**
 * Whether a copy is one of the two an upgrade runs on.
 *
 * Both are live by design while the mode is on - the Project Repos view lists
 * them side by side - so opening a file from the side that is not selected is
 * the point of the mode, not a slip worth a warning.
 */
export function isUpgradePairCopy(config: UpgradeConfigModel, dirName: string): boolean {
    if (!config.isActive()) {
        return false;
    }
    return config.repos.some(entry =>
        [entry.fromBranch, entry.toBranch].some(branch => worktreeDirName(entry.repoName, branch) === dirName));
}

export function registerWrongCopyGuard(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(async document => {
        if (document.uri.scheme !== 'file') {
            return;
        }
        if (context.globalState.get<boolean>(SUPPRESSED_KEY)) {
            return;
        }

        try {
            const root = readSetupState().provisioningRoot;
            const relative = path.relative(root, document.uri.fsPath);
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
                return;
            }

            const dirName = relative.split(path.sep)[0];
            const owner = parseWorktreeDirName(dirName);
            if (!owner) {
                return;
            }

            const result = await SettingsStore.get('odoo-debugger-data.json').catch(() => undefined);
            const project = result?.projects?.find(entry => entry.isSelected);
            if (!project) {
                return;
            }
            if (isUpgradePairCopy(ensureUpgradeConfigModel(project.upgradeConfig), dirName)) {
                return;
            }
            const db = project.dbs?.find(entry => entry.isSelected);
            const active = resolveProjectRepos(
                project.repos ?? [],
                db ? resolveProjectRepoBranchAssignments(db, project.repos ?? []) : [],
                root
            );

            const activeEntry = active.find(entry => entry.repo.name === owner.repo && entry.isWorktree);
            if (!activeEntry || !activeEntry.branch || activeEntry.branch === owner.branch) {
                return;
            }

            const choice = await showWarning(
                `${path.basename(document.uri.fsPath)} belongs to "${owner.branch}", but "${activeEntry.branch}" is active.`,
                `Open the ${activeEntry.branch} copy`,
                'Stay here',
                "Don't warn again"
            );

            if (choice === `Open the ${activeEntry.branch} copy`) {
                const withinWorktree = path.relative(
                    path.join(root, worktreeDirName(owner.repo, owner.branch)),
                    document.uri.fsPath
                );
                const target = vscode.Uri.file(path.join(activeEntry.path, withinWorktree));
                await vscode.window.showTextDocument(target, { preview: false });
            } else if (choice === "Don't warn again") {
                // A developer deliberately comparing two versions must not be nagged.
                await context.globalState.update(SUPPRESSED_KEY, true);
            }
        } catch (error) {
            logger.debug('Wrong-copy guard failed:', error);
        }
    }));
}
