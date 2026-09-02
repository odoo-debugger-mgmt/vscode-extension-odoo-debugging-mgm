/**
 * `odoo.setUpUpgrade`: configures the versions, per-branch repository copies
 * and database branch mapping for one upgrade, from a single reviewable plan.
 *
 * Nothing is written before the confirmation, and the repository mode change
 * keeps its own modal: creating per-branch copies moves where the user edits
 * that repository's code, which a wizard is not a reason to do silently.
 */
import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { SettingsStore } from '../settingsStore';
import { stripSettings, normalizePath } from '../utils';
import { showError, showInfo, showModalWarning } from '../services/notifications';
import { errorMessage, logger } from '../services/logger';
import { getRepoBranch } from '../services/branches';
import { branchToSeries } from '../services/versionProposal';
import { buildUpgradePlan, describeUpgradePlan, UpgradeInput, UpgradeRepo } from '../services/upgradePlan';
import { describeModeChange } from '../services/repoPaths';
import {
    drainProvisionQueue,
    enqueue,
    readQueue,
    setQueueSnapshot,
    writeQueue
} from '../services/provisionQueue';
import { sanitizeProjectRepoBranchAssignments } from '../services/environment';
import { readSetupState } from '../services/setupState';
import { RepoModel } from '../models/repo';

export function registerUpgradeCommand(deps: CommandDeps): void {
    const { context, versionsService, refreshAll } = deps;

    context.subscriptions.push(vscode.commands.registerCommand('odoo.setUpUpgrade', async () => {
        try {
            const result = await SettingsStore.getSelectedProject();
            if (!result) {
                return;
            }
            const { data, project } = result;

            const repos: RepoModel[] = project.repos ?? [];
            if (repos.length === 0) {
                void showError('This project has no repositories to upgrade.');
                return;
            }

            const pickedRepos = await vscode.window.showQuickPick(
                repos.map(repo => ({ label: repo.name, description: repo.path, repo, picked: true })),
                {
                    title: 'Set Up an Upgrade',
                    placeHolder: 'Which repositories are being upgraded?',
                    canPickMany: true,
                    ignoreFocusOut: true
                }
            );
            if (!pickedRepos || pickedRepos.length === 0) {
                return;
            }

            const currentBranch = await getRepoBranch(normalizePath(pickedRepos[0].repo.path));
            const fromBranch = await vscode.window.showInputBox({
                title: 'Upgrading from',
                prompt: 'The branch your custom code is on today',
                value: currentBranch ?? '',
                ignoreFocusOut: true,
                validateInput: value => branchToSeries(value) ? undefined : 'Must name an Odoo series, e.g. "17.0-client".'
            });
            if (!fromBranch) {
                return;
            }

            const toBranch = await vscode.window.showInputBox({
                title: 'Upgrading to',
                prompt: 'The branch the upgraded code lives on',
                ignoreFocusOut: true,
                validateInput: value => branchToSeries(value) ? undefined : 'Must name an Odoo series, e.g. "19.0-client".'
            });
            if (!toBranch) {
                return;
            }

            const fromSeries = branchToSeries(fromBranch)!;
            const toSeries = branchToSeries(toBranch)!;
            if (fromSeries === toSeries) {
                void showError('Both branches are on the same Odoo series, so there is nothing to run side by side.');
                return;
            }

            const upgradeRepos: UpgradeRepo[] = pickedRepos.map(pick => ({
                name: pick.repo.name,
                path: pick.repo.path,
                fromBranch: fromBranch.trim(),
                toBranch: toBranch.trim()
            }));

            const versionIdBySeries: Record<string, string | undefined> = {};
            for (const version of versionsService.getVersions()) {
                versionIdBySeries[version.odooVersion] = version.id;
            }

            const input: UpgradeInput = {
                repos: upgradeRepos,
                fromSeries,
                toSeries,
                existingVersions: versionsService.getVersions().map(version => version.odooVersion),
                dbs: (project.dbs ?? []).map((db: { id: string; versionId?: string }) => ({
                    id: db.id,
                    versionId: db.versionId
                })),
                versionIdBySeries
            };
            const plan = buildUpgradePlan(input);

            const confirmed = await vscode.window.showQuickPick(
                [
                    { label: '$(check) Use these', detail: describeUpgradePlan(plan, input), apply: true },
                    { label: '$(x) Cancel', detail: 'Change nothing', apply: false }
                ],
                {
                    title: `Upgrade ${upgradeRepos.map(repo => repo.name).join(', ')}: ${fromSeries} → ${toSeries}`,
                    placeHolder: 'Nothing is written until you accept',
                    ignoreFocusOut: true
                }
            );
            if (!confirmed?.apply) {
                return;
            }

            // Versions first: the repo worktrees and assignments describe an
            // environment those versions run.
            if (plan.versionsToCreate.length > 0) {
                const queued = enqueue(
                    readQueue(context),
                    plan.versionsToCreate.map(branch => ({ branch, name: `Odoo ${branch}` }))
                );
                setQueueSnapshot(queued);
                await writeQueue(context, queued);
                void drainProvisionQueue(context, () => void refreshAll({ reason: 'ui' }));
            }

            const root = readSetupState().provisioningRoot;
            const skipped: string[] = [];

            for (const repo of repos.filter(entry => plan.reposToWorktree.includes(entry.name))) {
                if (repo.branchMode === 'worktree') {
                    continue;
                }
                const confirm = await showModalWarning(
                    describeModeChange(repo.name, 'worktree', root, [fromBranch.trim(), toBranch.trim()]),
                    'Create Worktrees'
                );
                if (confirm !== 'Create Worktrees') {
                    skipped.push(repo.name);
                    continue;
                }
                repo.branchMode = 'worktree';
            }

            for (const assignment of plan.assignments) {
                const db = (project.dbs ?? []).find((entry: { id: string }) => entry.id === assignment.dbId);
                if (!db) {
                    continue;
                }
                const existing = sanitizeProjectRepoBranchAssignments(db.projectRepoBranches)
                    .filter(entry => entry.repoName !== assignment.repoName);
                db.projectRepoBranches = [
                    ...existing,
                    { repoName: assignment.repoName, repoPath: assignment.repoPath, branch: assignment.branch }
                ];
            }

            await SettingsStore.saveWithoutComments(stripSettings(data));

            const note = skipped.length > 0
                ? ` ${skipped.join(', ')} kept a single checkout.`
                : '';
            void showInfo(`Configured the ${fromSeries} → ${toSeries} upgrade.${note}`);
            await refreshAll();
        } catch (error) {
            logger.error('Set Up an Upgrade failed:', error);
            void showError(`Could not set up the upgrade: ${errorMessage(error)}`);
        }
    }));
}
