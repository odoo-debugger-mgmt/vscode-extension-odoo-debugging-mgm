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
import { branchToSeries, statesSeries } from '../services/versionProposal';
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
import { listSeriesBranches } from '../services/gitService';
import { BACK, isBack, multiPickStep, pickStep, inputStep, runWizard, step, StepResult, WizardStep } from '../services/wizard';
import { RepoModel } from '../models/repo';

/** The branch the previous repository answered for this side, as a seed. */
function previousAnswer(
    answers: Map<string, { from?: string; to?: string }>,
    repoName: string,
    side: 'from' | 'to'
): string | undefined {
    let seed: string | undefined;
    for (const [name, answer] of answers) {
        if (name === repoName) {
            break;
        }
        seed = answer[side] ?? seed;
    }
    return seed;
}

/**
 * The Odoo series one side of the upgrade runs.
 *
 * Parsed from the branch names when they state it, asked when they do not:
 * refusing "dev/upgrade-client" as "not an Odoo series" was rejecting a
 * perfectly ordinary branch name after five answers had already been given.
 * Repositories must agree, because one pair of versions serves them all.
 */
async function resolveSeries(
    repos: UpgradeRepo[],
    side: 'from' | 'to',
    knownSeries: string[]
): Promise<StepResult<string>> {
    const branches = repos.map(repo => (side === 'from' ? repo.fromBranch : repo.toBranch));
    const stated = Array.from(new Set(
        branches.filter(statesSeries).map(branch => branchToSeries(branch) as string)
    ));

    if (stated.length > 1) {
        void showError(
            `The "upgrading ${side}" branches name different Odoo series (${stated.join(', ')}). `
            + 'One upgrade runs between two series.');
        return undefined;
    }
    if (stated.length === 1 && branches.every(statesSeries)) {
        return stated[0];
    }

    const unnamed = branches.filter(branch => !statesSeries(branch));
    const label = side === 'from' ? 'upgrading from' : 'upgrading to';
    const rows: Array<vscode.QuickPickItem & { series?: string; custom?: boolean }> = [
        ...knownSeries.map(series => ({
            label: series,
            description: series === stated[0] ? 'named by the other branches' : undefined,
            series
        })),
        { label: '$(pencil) Enter a series...', description: 'e.g. "17.0", "saas-18.4", "master"', custom: true }
    ];

    const picked = await pickStep(rows, {
        title: `Which Odoo version is "${label}"?`,
        placeHolder: `${unnamed.join(', ')} ${unnamed.length === 1 ? 'does' : 'do'} not say, so it has to be told`,
        canGoBack: true,
        matchOnDescription: true,
        activeItem: item => (item as { series?: string }).series === stated[0]
    });

    if (picked === undefined || isBack(picked)) {
        return picked;
    }
    if (!picked.custom) {
        return picked.series;
    }

    const entered = await inputStep({
        title: `Which Odoo version is "${label}"?`,
        prompt: 'The Odoo series these branches run',
        placeHolder: '17.0',
        value: stated[0] ?? '',
        canGoBack: true,
        validateInput: value => value.trim() ? undefined : 'A series is required.'
    });
    if (entered === undefined) {
        return undefined;
    }
    return isBack(entered) ? BACK : entered.trim();
}

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

            // Every question is backable, and the branch pickers no longer
            // refuse a branch whose name does not state its Odoo series -
            // plenty of real branches are called "dev/upgrade-client". The
            // series is asked for instead, right after the branch it belongs
            // to, so a flow six answers deep never dies on the last one.
            const knownSeries = Array.from(new Set([
                ...versionsService.getVersions().map(version => version.odooVersion),
                ...(readSetupState().sourceRepo
                    ? await listSeriesBranches(readSetupState().sourceRepo as string).catch(() => [])
                    : [])
            ].map(entry => entry.trim()).filter(Boolean)));

            let upgradeRepos: UpgradeRepo[] = [];
            let fromSeries: string | undefined;
            let toSeries: string | undefined;

            // Looped so backing out of the first branch question returns to the
            // repository selection rather than closing the flow.
            for (;;) {
                const pickedRepos = await multiPickStep(
                    repos.map(repo => ({ label: repo.name, description: repo.path, repo })),
                    {
                        title: 'Set Up an Upgrade',
                        placeHolder: 'Which repositories are being upgraded?',
                        selected: () => true,
                        canGoBack: false
                    }
                );
                if (!pickedRepos || isBack(pickedRepos) || pickedRepos.length === 0) {
                    return;
                }

                upgradeRepos = [];
                const answers = new Map<string, { from?: string; to?: string }>();
                const steps: WizardStep[] = [];

                for (const pick of pickedRepos) {
                    const repoPath = normalizePath(pick.repo.path);
                    const repoName = pick.repo.name;
                    answers.set(repoName, {});

                    steps.push(step<string>(
                        async canGoBack => {
                            const onDisk = await getRepoBranch(repoPath);
                            const seed = previousAnswer(answers, repoName, 'from') ?? onDisk ?? undefined;
                            return pickRepoBranch(
                                repoPath,
                                `Upgrading from \u2014 ${repoName}`,
                                'The branch this repository is on today',
                                seed,
                                undefined,
                                canGoBack
                            );
                        },
                        branch => { answers.get(repoName)!.from = branch; }
                    ));

                    steps.push(step<string>(
                        async canGoBack => pickRepoBranch(
                            repoPath,
                            `Upgrading to \u2014 ${repoName}`,
                            'The branch this repository is upgraded on',
                            previousAnswer(answers, repoName, 'to'),
                            answers.get(repoName)!.from,
                            canGoBack
                        ),
                        branch => { answers.get(repoName)!.to = branch; }
                    ));
                }

                const outcome = await runWizard(steps);
                if (outcome === 'cancelled') {
                    return;
                }
                if (outcome === 'back') {
                    continue; // Back to the repository selection.
                }

                upgradeRepos = pickedRepos.map(pick => ({
                    name: pick.repo.name,
                    path: pick.repo.path,
                    fromBranch: answers.get(pick.repo.name)!.from!.trim(),
                    toBranch: answers.get(pick.repo.name)!.to!.trim()
                }));

                // The series each side runs, asked only when a branch name does
                // not state one. Agreement across repositories still matters:
                // one pair of versions serves them all.
                const resolvedFrom = await resolveSeries(upgradeRepos, 'from', knownSeries);
                if (resolvedFrom === undefined) {
                    return;
                }
                const resolvedTo = await resolveSeries(upgradeRepos, 'to', knownSeries);
                if (resolvedTo === undefined) {
                    return;
                }
                if (isBack(resolvedFrom) || isBack(resolvedTo)) {
                    continue;
                }

                if (resolvedFrom === resolvedTo) {
                    void showError(
                        `Both sides are on Odoo ${resolvedFrom}, so there is nothing to run side by side.`);
                    return;
                }
                fromSeries = resolvedFrom;
                toSeries = resolvedTo;
                break;
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
