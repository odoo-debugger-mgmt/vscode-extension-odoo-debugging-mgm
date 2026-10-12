/**
 * Applying an upgrade setup: everything that touches disk, under one progress
 * notification.
 *
 * Copies used to be created lazily by the debugger sync, minutes later and
 * with no indication at all, after a modal had already promised they would be
 * created. They are created here instead, while the notification that promised
 * them is still on screen.
 */
import * as vscode from 'vscode';
import { DatabaseModel, ProjectRepoBranchAssignment } from '../models/db';
import { ModuleModel, ModuleState } from '../models/module';
import { ProjectModel } from '../models/project';
import { RepoModel, normalizeBranchMode } from '../models/repo';
import { StashedModuleStates, UpgradeConfigModel, UpgradeRepoPair, ensureUpgradeConfigModel } from '../models/upgrade';
import { createDatabase } from './postgres';
import { getInstalledModuleNames } from './database';
import { sanitizeProjectRepoBranchAssignments } from './environment';
import { errorMessage, logger } from './logger';
import { resolveProjectRepos } from './repoPaths';
import { ensureCustomWorktrees } from './customWorktree';
import { collectAvailableModules, coreAddonsPaths, splitStagedModules } from './upgradeSetup';
import { UpgradePlan } from './upgradePlan';

/** What the wizard resolved, ready to be written. */
export interface UpgradeSetup {
    fromDbId: string;
    /** Name of the target database, existing or about to be created. */
    toDbId: string;
    fromSeries: string;
    toSeries: string;
    fromVersionId?: string;
    toVersionId?: string;
    repos: UpgradeRepoPair[];
    /** Set when the target database still has to be created. */
    createTarget?: boolean;
    /** Where per-branch copies live. */
    root: string;
    plan: UpgradePlan;
    /**
     * The upgrade stored before this one, on or off. Passed in rather than
     * read here: a project loaded from settings is plain JSON, and this
     * function must never read the config it is about to write.
     */
    previous?: UpgradeConfigModel;
    /** Turning a remembered upgrade back on: its module set is reused, not re-read. */
    resume?: boolean;
}

export interface UpgradeApplyResult {
    /** Repositories whose copies could not be built. */
    problems: string[];
    staged: string[];
    unavailable: string[];
}

/**
 * The addons a version can install, or undefined when it is not built yet.
 * Undefined defers the check to the first launch rather than holding back
 * every module the source had.
 */
function availableModulesFor(
    versionSettings: { odooPath?: string; enterprisePath?: string; designThemesPath?: string } | undefined
): Set<string> | undefined {
    if (!versionSettings) {
        return undefined;
    }
    return collectAvailableModules(coreAddonsPaths(versionSettings));
}

/**
 * Creates an empty PostgreSQL database and registers it against a version.
 *
 * The upgrade's target: an empty database on the new version, which its server
 * then builds by installing the module set staged onto it. Deliberately not a
 * clone - the point is to rebuild the same scope on the new version rather
 * than carry the old one across.
 *
 * Lives here rather than in dbs.ts to keep that module out of this one's
 * import graph: dbs.ts consults the upgrade config for its own guards, and the
 * cycle that would close is the kind context.ts exists to avoid.
 */
async function createFreshDatabaseForVersion(options: {
    project: ProjectModel;
    name: string;
    versionId?: string;
    projectRepoBranches?: ProjectRepoBranchAssignment[];
}): Promise<DatabaseModel> {
    await createDatabase(options.name);

    const database = new DatabaseModel(options.name, new Date(), {
        isSelected: false,
        isItABackup: false,
        isExisting: false,
        versionId: options.versionId,
        displayName: options.name,
        internalName: options.name,
        kind: 'fresh',
        projectRepoBranches: sanitizeProjectRepoBranchAssignments(options.projectRepoBranches)
    });
    options.project.dbs.push(database);
    return database;
}

/** Replaces one repository's assignment on a database, keeping the others. */
function assignBranch(database: DatabaseModel | any, assignment: ProjectRepoBranchAssignment): void {
    const existing = sanitizeProjectRepoBranchAssignments(database.projectRepoBranches)
        .filter(entry => entry.repoName !== assignment.repoName);
    database.projectRepoBranches = [...existing, assignment];
}

/**
 * Writes the upgrade: the target database when it is new, the per-branch
 * copies, the branch mapping, the staged module set and the mode itself.
 *
 * Never throws for one repository's sake - a copy that cannot be built is
 * reported so the rest of the upgrade still stands.
 */
export async function applyUpgradeSetup(
    project: ProjectModel,
    setup: UpgradeSetup,
    versionSettingsFor: (versionId: string | undefined) => {
        odooPath?: string; enterprisePath?: string; designThemesPath?: string;
    } | undefined,
    token?: vscode.CancellationToken
): Promise<UpgradeApplyResult> {
    const problems: string[] = [];
    const dbs: DatabaseModel[] = project.dbs ?? [];

    // 1. The target database, when the flow asked for a new one.
    if (setup.createTarget) {
        await createFreshDatabaseForVersion({
            project,
            name: setup.toDbId,
            versionId: setup.toVersionId
        });
    }

    const findDb = (id: string) => dbs.find(entry => entry.id === id);
    const sourceDb = findDb(setup.fromDbId);
    const targetDb = findDb(setup.toDbId);

    // 2. Per-branch copies. Mode first: resolveProjectRepos reads it to decide
    //    which directory each repository's branch lives in.
    const repos: RepoModel[] = project.repos ?? [];
    const involved = new Set(setup.repos.map(entry => entry.repoName.toLowerCase()));
    for (const repo of repos) {
        if (involved.has(repo.name.toLowerCase())) {
            repo.branchMode = 'worktree';
        }
    }

    // 3. The branch mapping, one side per database.
    for (const assignment of setup.plan.assignments) {
        const database = findDb(assignment.dbId);
        if (!database) {
            continue;
        }
        assignBranch(database, {
            repoName: assignment.repoName,
            repoPath: assignment.repoPath,
            branch: assignment.branch
        });
    }

    // 4. Build the copies for both sides, now rather than on some later sync.
    //    Both are resolved first, so freeing a branch for one side never
    //    moves the source onto the branch the other side is about to need.
    const worktreeRepos = repos.filter(repo => normalizeBranchMode(repo.branchMode) === 'worktree');
    const sides = [sourceDb, targetDb]
        .filter((database): database is NonNullable<typeof database> => !!database)
        .map(database => resolveProjectRepos(
            worktreeRepos,
            sanitizeProjectRepoBranchAssignments(database.projectRepoBranches),
            setup.root
        ));
    for (const [index, resolved] of sides.entries()) {
        if (token?.isCancellationRequested) {
            continue;
        }
        const alsoNeeded = sides.filter((_, other) => other !== index).flat();
        try {
            const outcome = await ensureCustomWorktrees(resolved, token, { interactive: true, alsoNeeded });
            problems.push(...outcome.problems);
        } catch (error) {
            logger.error('[upgrade] building per-branch copies failed:', error);
            problems.push(errorMessage(error));
        }
    }

    // 5. The module set: what the source runs, rebuilt on the target.
    const previous = setup.previous;
    // Whatever an earlier upgrade staged goes back first, so what gets stashed
    // below is always the target's own modules and never an old staged set.
    if (previous) {
        unstageTargetModules(project, previous);
    }

    let staged: string[] = [];
    let unavailable: string[] = [];
    let perModuleEdits: StashedModuleStates | undefined;
    // Staging an empty set because the source could not be read would wipe
    // the target's modules for nothing, so staging waits on a real answer.
    let stagingKnown = false;
    if (setup.resume && previous) {
        // The set was read when the upgrade was set up, and the changes made
        // to it were kept when the mode was turned off.
        staged = previous.stagedModules;
        unavailable = previous.unavailableModules;
        perModuleEdits = previous.upgradeTargetModuleStates;
        stagingKnown = true;
    } else if (sourceDb && targetDb) {
        try {
            const installed = await getInstalledModuleNames(sourceDb.id);
            const staging = splitStagedModules(installed, availableModulesFor(versionSettingsFor(setup.toVersionId)));
            staged = staging.staged;
            unavailable = staging.unavailable;
            stagingKnown = true;
        } catch (error) {
            logger.warn('[upgrade] could not read the source module set:', error);
            problems.push(`Could not read the modules installed in "${sourceDb.id}": ${errorMessage(error)}`);
        }
    }

    // A choice about this target, so it survives setting the same target up
    // again, and starts on for a different one.
    const installSourceModules = previous && previous.to?.dbId === setup.toDbId
        ? previous.installSourceModules
        : true;

    // 6. Each side's server remembers its own database, so nothing has to be
    //    selected by hand before starting them.
    project.selectedDbByVersion = { ...(project.selectedDbByVersion ?? {}) };
    if (setup.fromVersionId) {
        project.selectedDbByVersion[setup.fromVersionId] = setup.fromDbId;
    }
    if (setup.toVersionId) {
        project.selectedDbByVersion[setup.toVersionId] = setup.toDbId;
    }

    // 7. The mode itself.
    // Built from locals, never by reading project.upgradeConfig back: a project
    // loaded from settings is a plain object, so that field is undefined until
    // this assignment - reading through it threw, and the throw was swallowed
    // by the staging try/catch as a bogus "could not read the modules" report.
    const config = new UpgradeConfigModel(
        true,
        { versionId: setup.fromVersionId, dbId: setup.fromDbId, series: setup.fromSeries },
        { versionId: setup.toVersionId, dbId: setup.toDbId, series: setup.toSeries },
        setup.repos,
        undefined,
        staged,
        unavailable,
        installSourceModules,
        perModuleEdits
    );
    if (installSourceModules && stagingKnown) {
        stageTargetModules(project, config);
    }
    project.upgradeConfig = config;

    return { problems, staged: config.isTargetStaged() ? staged : [], unavailable };
}

function snapshotModules(modules: ModuleModel[] | undefined): StashedModuleStates {
    return (modules ?? []).map(module => ({ name: module.name, state: module.state as ModuleState }));
}

function restoreModules(states: StashedModuleStates): ModuleModel[] {
    return states.map(entry => new ModuleModel(entry.name, entry.state, false));
}

/**
 * Puts the source's module set onto the target, stashing the target's own.
 *
 * Changes made to the set during an earlier stretch of the upgrade come back
 * instead of the set as first read, so turning the mode off and on again - or
 * the module toggle off and on - loses nothing.
 */
export function stageTargetModules(project: ProjectModel, config: UpgradeConfigModel): void {
    if (config.isTargetStaged()) {
        return;
    }
    const targetDb = (project.dbs ?? []).find(entry => entry.id === config.to?.dbId);
    if (!targetDb) {
        return;
    }
    config.savedTargetModuleStates = snapshotModules(targetDb.modules);
    targetDb.modules = config.upgradeTargetModuleStates
        ? restoreModules(config.upgradeTargetModuleStates)
        : [
            ...config.stagedModules.map(name => new ModuleModel(name, 'install', false)),
            ...config.unavailableModules.map(name => new ModuleModel(name, 'none', false))
        ];
    config.upgradeTargetModuleStates = undefined;
}

/**
 * Gives the target back its own modules, keeping the staged set as it now
 * stands so staging it again restores it. The inverse of stageTargetModules.
 */
export function unstageTargetModules(project: ProjectModel, config: UpgradeConfigModel): void {
    const saved = config.savedTargetModuleStates;
    if (saved === undefined) {
        return;
    }
    const targetDb = (project.dbs ?? []).find(entry => entry.id === config.to?.dbId);
    if (targetDb) {
        config.upgradeTargetModuleStates = snapshotModules(targetDb.modules);
        targetDb.modules = restoreModules(saved);
    }
    config.savedTargetModuleStates = undefined;
}

/**
 * Undoes what turning the mode on changed in the project's data: the target
 * database's module states.
 *
 * The copies and the versions are deliberately left alone. They are expensive
 * to rebuild, harmless to keep, and the developer may well want them for the
 * next round of the same upgrade.
 */
export function revertUpgradeStaging(project: ProjectModel): void {
    const config = ensureUpgradeConfigModel(project.upgradeConfig);
    unstageTargetModules(project, config);
    project.upgradeConfig = config;
}
