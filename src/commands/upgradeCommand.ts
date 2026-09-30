/**
 * `odoo.setUpUpgrade`: configures one upgrade from the two databases it runs
 * between.
 *
 * Naming the databases is the whole input. Each one says which Odoo series it
 * runs, each series picks a version, and branch names usually say which side
 * they belong to - so the flow asks two questions and deduces the rest, where
 * it used to ask two per repository plus two more and never ask about
 * databases at all.
 *
 * One dialog blocks, and only when something is about to be created on disk.
 * The plan is reviewed and edited in a quick pick before that, which is a
 * screen you change things on rather than a warning you dismiss.
 */
import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { SettingsStore } from '../settingsStore';
import { stripSettings, normalizePath } from '../utils';
import { showError, showInfo, showModalInfo } from '../services/notifications';
import { errorMessage, logger } from '../services/logger';
import { pickRepoBranch } from './branchPick';
import { buildUpgradePlan, describeUpgradePlan, UpgradeInput, UpgradePlan } from '../services/upgradePlan';
import { applyUpgradeSetup, UpgradeSetup } from '../services/upgradeApply';
import { proposeBranchForSeries, resolveDatabaseSeries } from '../services/upgradeSetup';
import {
    drainProvisionQueue,
    enqueue,
    readQueue,
    setQueueSnapshot,
    writeQueue
} from '../services/provisionQueue';
import { readSetupState } from '../services/setupState';
import { listAllBranches, listSeriesBranches } from '../services/gitService';
import { generateDatabaseIdentifiers } from '../services/dbNaming';
import { takenDatabaseNames } from '../dbs';
import {
    currentUpgradeConfig,
    disableUpgradeMode,
    readUpgradeConfig,
    syncUpgradeContext,
    toggleSourceModules
} from '../upgrade';
import { isBack, pickStep, inputStep, runWizard, step, StepResult, WizardStep } from '../services/wizard';
import { RepoModel, normalizeBranchMode } from '../models/repo';
import type { DatabaseModel } from '../models/db';
import type { ProjectModel } from '../models/project';
import type { UpgradeConfigModel } from '../models/upgrade';
import { VersionsService } from '../versionsService';
import { registerCommand } from './registerCommand';
import * as path from 'node:path';
import { locateRepoCheckouts } from '../services/repoLocations';
import { extraRootsFor } from '../services/versionRepos';
import { refreshRegistry } from '../services/workspaceRegistry';

/** Everything the wizard collects, filled in as it goes. */
interface SetupDraft {
    fromDb?: DatabaseModel;
    /** The chosen existing target, or undefined when a new one is being made. */
    toDb?: DatabaseModel;
    /** Name for the database to create, when the target is new. */
    newTargetName?: string;
    fromSeries?: string;
    toSeries?: string;
    /** Per repository name, the branch on each side. */
    branches: Map<string, { from?: string; to?: string }>;
}

type DbRow = vscode.QuickPickItem & { db?: DatabaseModel; create?: boolean };
type SeriesRow = vscode.QuickPickItem & { series?: string; custom?: boolean };

/** How a database is described in the picker, without probing every one. */
function describeDatabase(db: DatabaseModel, versionsService: VersionsService): string {
    const version = db.versionId ? versionsService.getVersion(db.versionId) : undefined;
    if (version) {
        return version.name;
    }
    const legacy = typeof db.odooVersion === 'string' ? db.odooVersion.trim() : '';
    return legacy ? `Odoo ${legacy}` : 'no version linked';
}

/** The series a database is linked to, as a fallback when probing fails. */
function linkedSeries(db: DatabaseModel | undefined, versionsService: VersionsService): string | undefined {
    if (!db) {
        return undefined;
    }
    const version = db.versionId ? versionsService.getVersion(db.versionId) : undefined;
    return version?.odooVersion?.trim() || (typeof db.odooVersion === 'string' ? db.odooVersion.trim() : undefined);
}

/** Asks which Odoo series a side runs, when it could not be deduced. */
async function askSeries(
    label: string,
    reason: string,
    knownSeries: string[],
    canGoBack: boolean
): Promise<StepResult<string>> {
    const rows: SeriesRow[] = [
        ...knownSeries.map(series => ({ label: series, series })),
        { label: '$(pencil) Enter a series...', description: 'e.g. "17.0", "saas-18.4", "master"', custom: true }
    ];

    const picked = await pickStep(rows, {
        title: `Which Odoo version is "${label}"?`,
        placeHolder: reason,
        canGoBack,
        matchOnDescription: true
    });
    if (picked === undefined || isBack(picked)) {
        return picked as StepResult<string>;
    }
    if (!picked.custom) {
        return picked.series;
    }

    const entered = await inputStep({
        title: `Which Odoo version is "${label}"?`,
        prompt: 'The Odoo series this side runs',
        placeHolder: '17.0',
        canGoBack: true,
        validateInput: value => value.trim() ? undefined : 'A series is required.'
    });
    if (entered === undefined) {
        return undefined;
    }
    return isBack(entered) ? entered : entered.trim();
}

/** Branch lists are read once per repository, not once per question. */
const branchCache = new Map<string, string[]>();

async function branchesOf(repoPath: string): Promise<string[]> {
    const cached = branchCache.get(repoPath);
    if (cached) {
        return cached;
    }
    const branches = await listAllBranches(repoPath).catch(() => [] as string[]);
    branchCache.set(repoPath, branches);
    return branches;
}

/**
 * Whether a repository is part of this upgrade at all.
 *
 * A project holds repositories that have nothing to do with the two series
 * being run - a shared library on `main`, a tooling repo. Asking two questions
 * about each of those is how a two-question flow turns back into a ten-question
 * one, so a repository with no branch on either side simply drops out.
 */
async function repoIsInvolved(repo: RepoModel, fromSeries: string, toSeries: string): Promise<boolean> {
    const [fromBranches, toBranches] = await Promise.all([
        branchesOf(await checkoutForSeries(repo, fromSeries)),
        branchesOf(await checkoutForSeries(repo, toSeries))
    ]);
    return proposeBranchForSeries(fromBranches, fromSeries).candidates.length > 0
        || proposeBranchForSeries(toBranches, toSeries).candidates.length > 0;
}

/**
 * The checkout a side of the upgrade runs `repo` from, whose branches are
 * the ones to offer: with a folder or a workspace per version, the other
 * side's clone has branches this one does not. The repository's own path
 * when the series has no version yet, or the repository keeps copies.
 */
async function checkoutForSeries(repo: RepoModel, series: string): Promise<string> {
    const version = VersionsService.getInstance().getVersions().find(entry => entry.odooVersion.trim() === series);
    if (!version || normalizeBranchMode(repo.branchMode) === 'worktree') {
        return normalizePath(repo.path);
    }
    await refreshRegistry();
    const located = await locateRepoCheckouts([repo], version, undefined, extraRootsFor(version));
    return normalizePath(located.get(repo.name)?.path ?? repo.path);
}

/**
 * The branch a repository uses on one side.
 *
 * Deduced when the repository has exactly one branch on that series, asked
 * otherwise - two branches on 17.0 is a question only the developer can answer.
 */
async function resolveRepoBranch(
    repo: RepoModel,
    series: string,
    side: 'from' | 'to',
    exclude: string | undefined,
    canGoBack: boolean
): Promise<StepResult<string>> {
    const repoPath = await checkoutForSeries(repo, series);
    const proposal = proposeBranchForSeries(await branchesOf(repoPath), series);

    if (proposal.branch && proposal.branch !== exclude) {
        return proposal.branch;
    }

    return pickRepoBranch(
        repoPath,
        `Upgrading ${side} — ${repo.name}`,
        `Which branch of ${repo.name} runs Odoo ${series}?`,
        proposal.candidates.find(candidate => candidate !== exclude),
        exclude,
        canGoBack
    );
}

/** A row in the review screen. */
interface ReviewRow extends vscode.QuickPickItem {
    edit?: 'from-branch' | 'to-branch';
    repoName?: string;
    confirm?: boolean;
}

/**
 * Each version's own checkout of each repository, where the two sides were
 * found in different directories (design §7): those need no per-branch
 * copies. A side whose version is not built yet cannot be located, so its
 * repositories are left to the copies, as before.
 */
async function ownCheckoutsFor(
    repos: RepoModel[],
    versions: VersionsService,
    fromSeries: string,
    toSeries: string
): Promise<Record<string, { from: string; to: string }>> {
    const bySeries = (series: string) => versions.getVersions().find(version => version.odooVersion.trim() === series);
    const fromVersion = bySeries(fromSeries);
    const toVersion = bySeries(toSeries);
    const own: Record<string, { from: string; to: string }> = {};
    // Which workspace runs which version, for finding the other side's clone.
    await refreshRegistry();
    const candidates = repos.filter(repo => normalizeBranchMode(repo.branchMode) === 'checkout');
    if (!fromVersion || !toVersion || candidates.length === 0) {
        return own;
    }
    const [from, to] = await Promise.all([
        locateRepoCheckouts(candidates, fromVersion, undefined, extraRootsFor(fromVersion)),
        locateRepoCheckouts(candidates, toVersion, undefined, extraRootsFor(toVersion))
    ]);
    for (const repo of candidates) {
        const fromPath = from.get(repo.name)?.path;
        const toPath = to.get(repo.name)?.path;
        if (fromPath && toPath && path.resolve(normalizePath(fromPath)) !== path.resolve(normalizePath(toPath))) {
            own[repo.name] = { from: normalizePath(fromPath), to: normalizePath(toPath) };
        }
    }
    return own;
}

export function registerUpgradeCommand(deps: CommandDeps): void {
    const { context, versionsService, refreshAll } = deps;

    /** The resolved setup, with each side's version looked up by series. */
    const buildSetup = (
        input: UpgradeInput,
        plan: UpgradePlan,
        root: string,
        extra: { createTarget: boolean; previous?: UpgradeConfigModel; resume?: boolean }
    ): UpgradeSetup => {
        const versionIdFor = (series: string): string | undefined =>
            versionsService.getVersions().find(version => version.odooVersion.trim() === series)?.id;
        return {
            fromDbId: input.fromDbId,
            toDbId: input.toDbId,
            fromSeries: input.fromSeries,
            toSeries: input.toSeries,
            fromVersionId: versionIdFor(input.fromSeries),
            toVersionId: versionIdFor(input.toSeries),
            repos: input.repos.map(repo => ({
                repoName: repo.name,
                repoPath: repo.path,
                fromBranch: repo.fromBranch,
                toBranch: repo.toBranch
            })),
            createTarget: extra.createTarget,
            root,
            plan,
            previous: extra.previous,
            resume: extra.resume,
            ownCheckouts: input.ownCheckouts
        };
    };

    /**
     * Writes a setup under one progress notification, queues any version
     * that is missing, and offers to start both servers. Shared by setting an
     * upgrade up and by resuming one, which differ only in where the answers
     * came from.
     */
    const applyAndFinish = async (
        data: any,
        project: ProjectModel,
        input: UpgradeInput,
        plan: UpgradePlan,
        setup: UpgradeSetup,
        verb: 'set up' | 'resumed'
    ): Promise<void> => {
        const applied = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `${verb === 'resumed' ? 'Resuming' : 'Setting up'} the ${input.fromSeries} → ${input.toSeries} upgrade`,
            cancellable: true
        }, async (progress, token) => {
            try {
                if (setup.createTarget) {
                    progress.report({ message: `Creating ${setup.toDbId}`, increment: 20 });
                }
                progress.report({ message: 'Creating per-branch copies', increment: 40 });
                const outcome = await applyUpgradeSetup(
                    project,
                    setup,
                    versionId => versionsService.getVersion(versionId ?? '')?.settings,
                    token
                );
                progress.report({ message: 'Saving', increment: 40 });
                await SettingsStore.saveWithoutComments(stripSettings(data));
                return outcome;
            } catch (error) {
                logger.error('[upgrade] applying the setup failed:', error);
                void showError(`Could not ${verb === 'resumed' ? 'resume' : 'set up'} the upgrade: ${errorMessage(error)}`);
                return undefined;
            }
        });

        if (!applied) {
            return;
        }

        // Versions last: building them takes minutes, and the upgrade is
        // already configured and visible by the time they finish.
        if (plan.versionsToCreate.length > 0) {
            const queued = enqueue(
                readQueue(context),
                plan.versionsToCreate.map(branch => ({ branch, name: `Odoo ${branch}` }))
            );
            setQueueSnapshot(queued);
            await writeQueue(context, queued);
            void drainProvisionQueue(context, () => void refreshAll({ reason: 'ui' }));
        }

        syncUpgradeContext(readUpgradeConfig(project));
        await refreshAll();

        const notes: string[] = [];
        if (applied.staged.length > 0) {
            notes.push(`${applied.staged.length} module(s) staged onto ${setup.toDbId}`);
        }
        if (applied.unavailable.length > 0) {
            notes.push(`${applied.unavailable.length} left out, missing from Odoo ${input.toSeries}`);
        }
        if (applied.problems.length > 0) {
            notes.push(applied.problems.join('; '));
        }
        const summary = notes.length > 0 ? ` ${notes.join('. ')}.` : '';
        const headline = `Upgrade ${verb}: ${input.fromSeries} → ${input.toSeries}.${summary}`;

        // Both versions have to exist before anything can run.
        if (plan.versionsToCreate.length > 0) {
            void showInfo(`${headline} The servers can start once the versions finish building.`);
            return;
        }

        const action = await showInfo(headline, 'Start Both Servers');
        if (action === 'Start Both Servers') {
            await vscode.commands.executeCommand('odoo.startBothServers');
        }
    };

    /**
     * Turns a remembered upgrade back on, as it was left.
     *
     * Runs through the same apply as setting one up, because the mode was off
     * and nothing guarded the pair meanwhile: a copy switched back to a single
     * checkout, a version deleted or a branch remapped is put back rather
     * than resumed around. Only disk work that has to be redone is confirmed.
     */
    const resumeUpgrade = async (): Promise<void> => {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            return;
        }
        const { data, project } = result;
        const remembered = readUpgradeConfig(project);
        if (!remembered.isRemembered()) {
            return;
        }

        const existingDbs = new Set((project.dbs ?? []).map(db => db.id));
        const missing = remembered.pairedDbIds().filter(id => !existingDbs.has(id));
        if (missing.length > 0) {
            const choice = await showError(
                `The remembered upgrade runs on "${missing.join('" and "')}", which `
                + `${missing.length === 1 ? 'no longer exists' : 'no longer exist'}.`,
                'Set Up an Upgrade');
            if (choice === 'Set Up an Upgrade') {
                await vscode.commands.executeCommand('odoo.setUpUpgrade');
            }
            return;
        }

        const repos: RepoModel[] = project.repos ?? [];
        const root = readSetupState().provisioningRoot;
        const inProject = (name: string) => repos.some(repo => repo.name.toLowerCase() === name.toLowerCase());
        const input: UpgradeInput = {
            // A repository removed from the project while the mode was off
            // drops out of the upgrade rather than being mapped onto nothing.
            repos: remembered.repos
                .filter(entry => inProject(entry.repoName))
                .map(entry => ({
                    name: entry.repoName,
                    path: entry.repoPath,
                    fromBranch: entry.fromBranch,
                    toBranch: entry.toBranch
                })),
            fromSeries: remembered.from!.series,
            toSeries: remembered.to!.series,
            fromDbId: remembered.from!.dbId,
            toDbId: remembered.to!.dbId,
            existingVersions: versionsService.getVersions().map(version => version.odooVersion),
            worktreeRepos: repos
                .filter(repo => normalizeBranchMode(repo.branchMode) === 'worktree')
                .map(repo => repo.name),
            root,
            ownCheckouts: await ownCheckoutsFor(repos, versionsService, remembered.from!.series, remembered.to!.series)
        };
        const plan = buildUpgradePlan(input);

        if (plan.reposToWorktree.length > 0 || plan.reposOnOwnCheckouts.length > 0 || plan.versionsToCreate.length > 0) {
            const confirmed = await showModalInfo(describeUpgradePlan(plan, input), 'Resume');
            if (confirmed !== 'Resume') {
                return;
            }
        }

        await applyAndFinish(
            data, project, input, plan,
            buildSetup(input, plan, root, { createTarget: false, previous: remembered, resume: true }),
            'resumed');
    };

    // Receives the current state and inverts it, the way the testing toggle
    // does, so the tree row needs no knowledge of what happens next. Off keeps
    // the upgrade; on resumes a kept one, and sets one up only when there is
    // nothing to resume.
    context.subscriptions.push(registerCommand(
        'upgradeSelector.toggleUpgrade',
        async (payload?: { isEnabled?: boolean }) => {
            try {
                const config = await currentUpgradeConfig();
                const enabled = payload?.isEnabled ?? config.isActive();
                if (enabled) {
                    if (await disableUpgradeMode()) {
                        await refreshAll();
                    }
                    return;
                }
                if (config.isRemembered()) {
                    await resumeUpgrade();
                    return;
                }
                await vscode.commands.executeCommand('odoo.setUpUpgrade');
            } catch (error) {
                logger.error('Toggling upgrade mode failed:', error);
                void showError(`Could not toggle upgrade mode: ${errorMessage(error)}`);
            }
        }
    ));

    context.subscriptions.push(registerCommand(
        'upgradeSelector.toggleSourceModules',
        async () => {
            if (await toggleSourceModules()) {
                await refreshAll();
            }
        }
    ));

    // Changing an upgrade is setting one up with the current one preselected:
    // the review step is where any single answer is changed.
    context.subscriptions.push(registerCommand(
        'upgradeSelector.changeUpgrade',
        () => vscode.commands.executeCommand('odoo.setUpUpgrade')
    ));

    context.subscriptions.push(registerCommand('odoo.setUpUpgrade', async () => {
        try {
            const result = await SettingsStore.getSelectedProject();
            if (!result) {
                return;
            }
            const { data, project } = result;
            // Changing an upgrade starts from the one already stored.
            const remembered = readUpgradeConfig(project);
            const previous = remembered.isComplete() ? remembered : undefined;

            const dbs: DatabaseModel[] = project.dbs ?? [];
            if (dbs.length === 0) {
                const choice = await showError(
                    'An upgrade runs between two databases, and this project has none.',
                    'Create Database');
                if (choice === 'Create Database') {
                    await vscode.commands.executeCommand('dbSelector.create');
                }
                return;
            }

            const repos: RepoModel[] = project.repos ?? [];
            const setupState = readSetupState();
            const root = setupState.provisioningRoot;
            const knownSeries = Array.from(new Set([
                ...versionsService.getVersions().map(version => version.odooVersion),
                ...(setupState.sourceRepo
                    ? await listSeriesBranches(setupState.sourceRepo).catch(() => [])
                    : [])
            ].map(entry => entry.trim()).filter(Boolean)));

            // Cached for this run only: a re-run must see branches pushed since.
            branchCache.clear();
            const draft: SetupDraft = { branches: new Map() };

            // ---- The questions -------------------------------------------------
            const steps: WizardStep[] = [];

            steps.push(step<DbRow>(
                canGoBack => pickStep<DbRow>(
                    dbs.map(db => ({
                        label: db.id,
                        description: describeDatabase(db, versionsService),
                        db
                    })),
                    {
                        title: 'Set Up an Upgrade',
                        placeHolder: 'Which database are you upgrading from?',
                        canGoBack,
                        matchOnDescription: true,
                        activeItem: row => !!previous && (row as DbRow).db?.id === previous.from?.dbId
                    }
                ),
                picked => { draft.fromDb = picked.db; }
            ));

            steps.push(step<DbRow>(
                canGoBack => pickStep<DbRow>(
                    [
                        ...dbs
                            .filter(db => db.id !== draft.fromDb?.id)
                            .map(db => ({
                                label: db.id,
                                description: describeDatabase(db, versionsService),
                                db
                            })),
                        {
                            label: '$(add) Create a new database...',
                            description: 'empty, on the version you are upgrading to',
                            detail: 'Its modules are installed from the set the source database runs.',
                            create: true
                        }
                    ],
                    {
                        title: 'Set Up an Upgrade',
                        placeHolder: 'Which database are you upgrading to?',
                        canGoBack,
                        matchOnDescription: true,
                        activeItem: row => !!previous && (row as DbRow).db?.id === previous.to?.dbId
                    }
                ),
                picked => {
                    draft.toDb = picked.db;
                    // A new database is defined by the series rather than
                    // probed for one, so clear any answer from a previous pass.
                    draft.newTargetName = picked.create ? draft.newTargetName : undefined;
                    if (!picked.create) {
                        draft.toSeries = undefined;
                    }
                }
            ));

            // The source's series: probed, because a version link is whatever
            // was assigned when the database was made and may never have been
            // revisited. Only asked when the probe and the link both fail.
            steps.push(step<string>(
                async canGoBack => {
                    const detected = await resolveDatabaseSeries(
                        draft.fromDb!.id,
                        linkedSeries(draft.fromDb, versionsService));
                    return detected ?? await askSeries(
                        draft.fromDb!.id,
                        `"${draft.fromDb!.id}" does not say which Odoo series it runs, so it has to be told`,
                        knownSeries,
                        canGoBack);
                },
                series => { draft.fromSeries = series.trim(); }
            ));

            steps.push(step<string>(
                async canGoBack => {
                    if (draft.toDb) {
                        const detected = await resolveDatabaseSeries(
                            draft.toDb.id,
                            linkedSeries(draft.toDb, versionsService));
                        if (detected) {
                            return detected;
                        }
                    }
                    // A database about to be created is empty, so there is
                    // nothing to probe: the series defines it instead.
                    return askSeries(
                        draft.toDb ? draft.toDb.id : 'the new database',
                        draft.toDb
                            ? `"${draft.toDb.id}" does not say which Odoo series it runs, so it has to be told`
                            : 'The Odoo series the new database will run',
                        knownSeries.filter(series => series !== draft.fromSeries),
                        canGoBack);
                },
                series => { draft.toSeries = series.trim(); }
            ));

            // One branch question per repository per side, asked only for the
            // repositories this upgrade actually involves and only where their
            // branches do not already answer it. An empty answer means "not
            // part of this upgrade" and records nothing.
            for (const repo of repos) {
                const record = (side: 'from' | 'to') => (branch: string) => {
                    if (!branch.trim()) {
                        draft.branches.delete(repo.name);
                        return;
                    }
                    const entry = draft.branches.get(repo.name) ?? {};
                    entry[side] = branch.trim();
                    draft.branches.set(repo.name, entry);
                };

                steps.push(step<string>(
                    async canGoBack => (await repoIsInvolved(repo, draft.fromSeries!, draft.toSeries!))
                        ? resolveRepoBranch(repo, draft.fromSeries!, 'from', undefined, canGoBack)
                        : '',
                    record('from')
                ));
                steps.push(step<string>(
                    async canGoBack => draft.branches.get(repo.name)?.from
                        ? resolveRepoBranch(
                            repo, draft.toSeries!, 'to', draft.branches.get(repo.name)?.from, canGoBack)
                        : '',
                    record('to')
                ));
            }

            const outcome = await runWizard(steps);
            if (outcome !== 'completed') {
                return;
            }

            if (draft.fromSeries === draft.toSeries) {
                void showError(
                    `Both databases are on Odoo ${draft.fromSeries}, so there is nothing to run side by side.`);
                return;
            }

            // A new target database gets its name now, so the review and the
            // confirmation can both name it. It is created when they are
            // accepted, not before.
            if (!draft.toDb && !draft.newTargetName) {
                draft.newTargetName = generateDatabaseIdentifiers({
                    projectName: project.name,
                    kind: `upgrade-${draft.toSeries}`,
                    existingInternalNames: await takenDatabaseNames()
                }).internalName;
            }

            const toDbId = draft.toDb?.id ?? draft.newTargetName!;

            // ---- Review ---------------------------------------------------------
            // Located once: which repositories each side already has its own
            // checkout of, so the plan copies only the shared ones.
            const ownCheckouts = await ownCheckoutsFor(repos, versionsService, draft.fromSeries!, draft.toSeries!);
            const buildInput = (): UpgradeInput => ({
                repos: repos.map(repo => ({
                    name: repo.name,
                    path: normalizePath(repo.path),
                    fromBranch: draft.branches.get(repo.name)?.from ?? '',
                    toBranch: draft.branches.get(repo.name)?.to ?? ''
                })).filter(entry => entry.fromBranch && entry.toBranch),
                fromSeries: draft.fromSeries!,
                toSeries: draft.toSeries!,
                fromDbId: draft.fromDb!.id,
                toDbId,
                existingVersions: versionsService.getVersions().map(version => version.odooVersion),
                worktreeRepos: repos
                    .filter(repo => normalizeBranchMode(repo.branchMode) === 'worktree')
                    .map(repo => repo.name),
                root,
                ownCheckouts
            });

            for (;;) {
                const input = buildInput();
                const plan = buildUpgradePlan(input);

                const rows: ReviewRow[] = [
                    {
                        label: '$(check) Set up this upgrade',
                        description: `${draft.fromSeries} → ${draft.toSeries}`,
                        confirm: true
                    },
                    {
                        label: 'Databases',
                        description: `${draft.fromDb!.id} → ${toDbId}${draft.toDb ? '' : ' (will be created)'}`
                    },
                    {
                        label: 'Versions',
                        description: [input.fromSeries, input.toSeries]
                            .map(series => plan.versionsToCreate.includes(series)
                                ? `Odoo ${series} (will be built)`
                                : `Odoo ${series}`)
                            .join(', ')
                    },
                    ...input.repos.flatMap(repo => ([
                        {
                            label: `    ${repo.name} — from`,
                            description: repo.fromBranch,
                            detail: 'Select to change',
                            edit: 'from-branch' as const,
                            repoName: repo.name
                        },
                        {
                            label: `    ${repo.name} — to`,
                            description: repo.toBranch,
                            detail: 'Select to change',
                            edit: 'to-branch' as const,
                            repoName: repo.name
                        }
                    ]))
                ];

                const picked = await pickStep(rows, {
                    title: 'Set Up an Upgrade',
                    placeHolder: 'Review the plan, or select a line to change it',
                    matchOnDescription: true
                });
                if (!picked || isBack(picked)) {
                    return;
                }
                if (picked.confirm) {
                    break;
                }

                const repo = repos.find(entry => entry.name === picked.repoName);
                if (!repo) {
                    continue;
                }
                const entry = draft.branches.get(repo.name) ?? {};
                const side = picked.edit === 'from-branch' ? 'from' : 'to';
                const changed = await pickRepoBranch(
                    await checkoutForSeries(repo, side === 'from' ? draft.fromSeries! : draft.toSeries!),
                    `Upgrading ${side} — ${repo.name}`,
                    `Which branch of ${repo.name} runs Odoo ${side === 'from' ? draft.fromSeries : draft.toSeries}?`,
                    side === 'from' ? entry.from : entry.to,
                    side === 'from' ? entry.to : entry.from,
                    false
                );
                if (changed && !isBack(changed)) {
                    entry[side] = changed.trim();
                    draft.branches.set(repo.name, entry);
                }
            }

            const input = buildInput();
            const plan = buildUpgradePlan(input);

            // ---- The one blocking dialog, and only when disk is touched --------
            // Switching each side's own checkout to its branch is touching disk
            // too: the user sees which checkouts before it happens.
            const createsSomething = plan.reposToWorktree.length > 0
                || plan.reposOnOwnCheckouts.length > 0
                || plan.versionsToCreate.length > 0
                || !draft.toDb;
            if (createsSomething) {
                const confirmed = await showModalInfo(
                    describeUpgradePlan(plan, input),
                    'Set It Up'
                );
                if (confirmed !== 'Set It Up') {
                    return;
                }
            }

            // ---- Apply ----------------------------------------------------------
            await applyAndFinish(
                data, project, input, plan,
                buildSetup(input, plan, root, { createTarget: !draft.toDb, previous }),
                'set up');
        } catch (error) {
            logger.error('Set Up an Upgrade failed:', error);
            void showError(`Could not set up the upgrade: ${errorMessage(error)}`);
        }
    }));
}
