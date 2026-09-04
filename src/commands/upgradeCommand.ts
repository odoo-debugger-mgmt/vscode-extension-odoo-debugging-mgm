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
import { pickRepoBranch } from './branchPick';
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

            // Asked per repository. Reading both branches from the first
            // repository and applying them to the rest produced one correct
            // assignment and one naming a branch the second repository does
            // not have - surfacing much later as a checkout failure during a
            // database switch. Each picker is seeded with the previous
            // repository's answer, so repos that share a naming convention
            // are still Enter-Enter.
            const upgradeRepos: UpgradeRepo[] = [];
            let seedFrom: string | undefined;
            let seedTo: string | undefined;

            for (const pick of pickedRepos) {
                const repoPath = normalizePath(pick.repo.path);
                const onDisk = await getRepoBranch(repoPath);

                const fromBranch = await pickRepoBranch(
                    repoPath,
                    `Upgrading from — ${pick.repo.name}`,
                    'The branch this repository is on today',
                    seedFrom ?? onDisk ?? undefined
                );
                if (!fromBranch) {
                    return;
                }

                const toBranch = await pickRepoBranch(
                    repoPath,
                    `Upgrading to — ${pick.repo.name}`,
                    'The branch this repository is upgraded on',
                    seedTo,
                    fromBranch
                );
                if (!toBranch) {
                    return;
                }

                seedFrom = fromBranch;
                seedTo = toBranch;
                upgradeRepos.push({
                    name: pick.repo.name,
                    path: pick.repo.path,
                    fromBranch: fromBranch.trim(),
                    toBranch: toBranch.trim()
                });
            }

            // The series must agree across repositories: they are what the two
            // versions are built for, and one pair of versions serves them all.
            const seriesOf = (branches: string[], label: string): string | undefined => {
                const mapped = branches.map(branch => branchToSeries(branch));
                const bad = mapped.findIndex(series => !series);
                if (bad >= 0) {
                    void showError(`"${branches[bad]}" does not name an Odoo series (e.g. "17.0-client").`);
                    return undefined;
                }
                const unique = Array.from(new Set(mapped as string[]));
                if (unique.length > 1) {
                    void showError(
                        `The "${label}" branches are on different Odoo series (${unique.join(', ')}). `
                        + 'One upgrade runs between two series.');
                    return undefined;
                }
                return unique[0];
            };

            const fromSeries = seriesOf(upgradeRepos.map(repo => repo.fromBranch), 'upgrading from');
            const toSeries = seriesOf(upgradeRepos.map(repo => repo.toBranch), 'upgrading to');
            if (!fromSeries || !toSeries) {
                return;
            }
            if (fromSeries === toSeries) {
                void showError('Both branches are on the same Odoo series, so there is nothing to run side by side.');
                return;
            }

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

            // A modal, not a quick pick: the plan is several lines and a quick
            // pick's detail is one truncated line. Nothing is written until
            // this is accepted, so the interruption buys something.
            const confirmed = await showModalWarning(
                `Upgrade ${upgradeRepos.map(repo => repo.name).join(', ')}: ${fromSeries} → ${toSeries}\n\n`
                + `${describeUpgradePlan(plan, input)}\n\n`
                + 'Nothing has been written yet.',
                'Use These'
            );
            if (confirmed !== 'Use These') {
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
                // Each repository's own pair: the modal names the directories
                // that will be created, and those follow this repo's branches.
                const planned = upgradeRepos.find(entry => entry.name === repo.name);
                const confirm = await showModalWarning(
                    describeModeChange(
                        repo.name,
                        'worktree',
                        root,
                        planned ? [planned.fromBranch, planned.toBranch] : [],
                        normalizePath(repo.path)
                    ),
                    'Create Copies'
                );
                if (confirm !== 'Create Copies') {
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
