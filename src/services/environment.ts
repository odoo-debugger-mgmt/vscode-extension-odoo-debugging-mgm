import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseModel, ProjectRepoBranchAssignment } from '../models/db';
import { RepoModel, normalizeBranchMode } from '../models/repo';
import { SettingsModel } from '../models/settings';
import { VersionModel } from '../models/version';
import { VersionsService } from '../versionsService';
import { normalizePath, showAutoInfo, showWarning } from '../utils';
import { getRepoBranch } from './branches';
import { alignCoreRepos, checkoutRepoBranch } from './checkout';
import { branchSatisfiesTarget } from './worktree';
import { logger } from './logger';
import { showInfo } from './notifications';
import { SettingsStore } from '../settingsStore';
import { runRecords } from './debugSessions';
import { describeHeldBack, heldBackCheckouts, type AlongsideRunCheckouts, type HeldCheckout } from './alongside';
import { resolveReposForDatabase } from './versionRepos';
import { readSetupState } from './setupState';

export type SwitchBehavior = 'auto' | 'ask' | 'never';

const LEGACY_BEHAVIOR_MAP: Record<string, SwitchBehavior> = {
    'auto-both': 'auto',
    'auto-version-only': 'auto',
    'auto-branch-only': 'auto'
};

/**
 * Normalizes the databaseSwitchBehavior setting, mapping pre-1.2 values
 * (auto-both / auto-version-only / auto-branch-only) onto the new enum.
 */
export function getDatabaseSwitchBehavior(): SwitchBehavior {
    const raw = vscode.workspace.getConfiguration('odooDebugger').get<string>('databaseSwitchBehavior', 'auto') ?? 'auto';
    if (raw === 'auto' || raw === 'ask' || raw === 'never') {
        return raw;
    }
    return LEGACY_BEHAVIOR_MAP[raw] ?? 'auto';
}

/**
 * One-time write-back of legacy databaseSwitchBehavior values in whichever
 * scope defines them, so users' settings match the new enum.
 */
export async function migrateLegacySwitchBehaviorSetting(): Promise<void> {
    try {
        const config = vscode.workspace.getConfiguration('odooDebugger');
        const inspection = config.inspect<string>('databaseSwitchBehavior');
        if (!inspection) {
            return;
        }

        const scopes: Array<[string | undefined, vscode.ConfigurationTarget]> = [
            [inspection.globalValue, vscode.ConfigurationTarget.Global],
            [inspection.workspaceValue, vscode.ConfigurationTarget.Workspace],
            [inspection.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder]
        ];

        for (const [value, target] of scopes) {
            if (typeof value === 'string' && LEGACY_BEHAVIOR_MAP[value]) {
                await config.update('databaseSwitchBehavior', LEGACY_BEHAVIOR_MAP[value], target);
            }
        }
    } catch (error) {
        logger.warn('Failed to migrate databaseSwitchBehavior setting:', error);
    }
}

export function sanitizeProjectRepoBranchAssignments(source: any): ProjectRepoBranchAssignment[] {
    if (!Array.isArray(source)) {
        return [];
    }

    return source
        .filter(entry => !!entry && typeof entry.branch === 'string' && entry.branch.trim() !== '')
        .map(entry => ({
            repoName: entry.repoName || '',
            repoPath: entry.repoPath ? normalizePath(entry.repoPath) : '',
            branch: entry.branch.trim()
        }));
}

export function resolveProjectRepoBranchAssignments(database: DatabaseModel | any, projectRepos: RepoModel[]): ProjectRepoBranchAssignment[] {
    const assignments = sanitizeProjectRepoBranchAssignments(database?.projectRepoBranches);
    if (assignments.length === 0 || projectRepos.length === 0) {
        return [];
    }

    const byPath = new Map<string, ProjectRepoBranchAssignment>();
    const byName = new Map<string, ProjectRepoBranchAssignment>();
    for (const entry of assignments) {
        if (entry.repoPath) {
            byPath.set(normalizePath(entry.repoPath), entry);
        }
        if (entry.repoName) {
            byName.set(entry.repoName.toLowerCase(), entry);
        }
    }

    const resolved: ProjectRepoBranchAssignment[] = [];
    const seenPaths = new Set<string>();
    for (const repo of projectRepos) {
        const repoPath = normalizePath(repo.path);
        const assignment = byPath.get(repoPath) ?? byName.get(repo.name.toLowerCase());
        if (!assignment || !assignment.branch || seenPaths.has(repoPath)) {
            continue;
        }
        seenPaths.add(repoPath);
        resolved.push({
            repoName: repo.name,
            repoPath,
            branch: assignment.branch
        });
    }

    return resolved;
}

/**
 * The assignments a `git checkout` may satisfy: repositories in `checkout`
 * mode only.
 *
 * A worktree-mode repository already holds its branch in its own directory.
 * Checking that branch out in the source would move a directory the user owns,
 * take the branch away from the worktree that needs it - git allows one
 * checkout of a branch - and leave the source conflicting with its own copy,
 * which is what raised "using the source checkout" after every switch.
 *
 * Deliberately separate from `resolveProjectRepoBranchAssignments`: that one
 * answers "where does this repository's code live", which the debugger, module
 * discovery and the repos explorer all need answered for worktrees too.
 */
export function resolveProjectRepoCheckouts(database: DatabaseModel | any, projectRepos: RepoModel[]): ProjectRepoBranchAssignment[] {
    return resolveProjectRepoBranchAssignments(
        database,
        projectRepos.filter(repo => normalizeBranchMode(repo.branchMode) === 'checkout')
    );
}

export interface EnvironmentTarget {
    /** Version profile to activate. */
    versionId?: string;
    /** Branch for the core repos; defaults to the target version's branch. */
    coreBranch?: string;
    /**
     * Per-project-repo branches to check out. Build these with
     * `resolveProjectRepoCheckouts`: worktree-mode repositories must not appear
     * here, because nothing is checked out for them.
     */
    repoAssignments?: ProjectRepoBranchAssignment[];
}

/**
 * Builds the environment a database expects: its version, the version's core
 * branch (or the legacy per-DB branch for unmigrated data), and its project
 * repo branch mapping.
 */
export function buildDatabaseEnvironmentTarget(database: DatabaseModel | any, projectRepos: RepoModel[]): EnvironmentTarget {
    const legacyBranch = typeof database?.odooVersion === 'string' && database.odooVersion.trim() !== ''
        ? database.odooVersion.trim()
        : undefined;

    return {
        versionId: database?.versionId || undefined,
        coreBranch: database?.versionId ? undefined : legacyBranch,
        repoAssignments: resolveProjectRepoCheckouts(database, projectRepos)
    };
}

export interface SwitchSummaryInput {
    versionName?: string;
    core?: { branch: string; needsCheckout: boolean; missingEnvironment: boolean };
    repoBranchCount: number;
}

/**
 * How a pending switch is described to the user. A provisioned version's
 * worktree is already on the right branch, so nothing is checked out - saying
 * nothing there reads as though a branch switch were about to happen, which is
 * what this wording exists to avoid.
 */
export function describeSwitch(input: SwitchSummaryInput): string[] {
    const parts: string[] = [];

    if (input.versionName) {
        parts.push(`version "${input.versionName}"`);
    }

    if (input.core?.missingEnvironment) {
        parts.push(`core repositories for "${input.core.branch}" are missing`);
    } else if (input.core?.needsCheckout) {
        parts.push(`core branch "${input.core.branch}"`);
    } else if (input.core) {
        parts.push(`its existing "${input.core.branch}" worktree`);
    }

    if (input.repoBranchCount > 0) {
        parts.push(`${input.repoBranchCount} project repo branch(es)`);
    }

    return parts;
}

interface EnvironmentDiff {
    versionToActivate?: VersionModel;
    settings: SettingsModel;
    /**
     * Present when the version changed or a branch differs. `needsCheckout` is
     * false for a provisioned version, whose worktree is already correct - the
     * pipeline then runs post-switch hooks only.
     */
    coreRepoPipeline?: { branch: string; needsCheckout: boolean; missingEnvironment: boolean };
    repoCheckouts: ProjectRepoBranchAssignment[];
    /** Checkouts left alone: an alongside run uses that checkout on another branch. */
    heldBack: HeldCheckout[];
    descriptions: string[];
}

/**
 * The repositories each alongside run in this window runs from, resolved the
 * way Run Alongside resolved them. The version's primary run is not among
 * them: F5 restarts it on whatever the switch checks out.
 */
async function liveAlongsideCheckouts(): Promise<AlongsideRunCheckouts[]> {
    const alongside = runRecords().filter(record => record.kind === 'alongside' && !!record.dbId);
    if (alongside.length === 0) {
        return [];
    }
    const projects = await SettingsStore.getProjects();
    const versionsService = VersionsService.getInstance();
    const root = readSetupState().provisioningRoot;
    const runs: AlongsideRunCheckouts[] = [];
    for (const run of alongside) {
        const project = projects.find(candidate => (candidate.dbs ?? []).some(db => db.id === run.dbId));
        const db = project?.dbs.find(candidate => candidate.id === run.dbId);
        if (!project || !db) {
            continue;
        }
        try {
            const entries = await resolveReposForDatabase(project, db, { version: versionsService.getVersion(run.versionId), root });
            runs.push({
                dbId: db.id,
                entries: entries.map(entry => ({
                    repoName: entry.repo.name, path: entry.path, branch: entry.branch, isWorktree: entry.isWorktree
                }))
            });
        } catch (error) {
            logger.debug(`[environment] could not resolve the repositories "${db.id}" runs alongside from:`, error);
        }
    }
    return runs;
}

/**
 * The planned checkouts that may run, and those held back because an
 * alongside run uses that checkout on another branch (heldBackCheckouts).
 */
export function splitHeldBack(
    repoCheckouts: ProjectRepoBranchAssignment[],
    runs: AlongsideRunCheckouts[]
): { proceed: ProjectRepoBranchAssignment[]; heldBack: HeldCheckout[] } {
    const heldBack = heldBackCheckouts(
        repoCheckouts.map(assignment => ({ path: assignment.repoPath, branch: assignment.branch })),
        runs
    );
    const heldPaths = new Set(heldBack.map(entry => entry.path));
    return { proceed: repoCheckouts.filter(assignment => !heldPaths.has(assignment.repoPath)), heldBack };
}

async function computeEnvironmentDiff(target: EnvironmentTarget): Promise<EnvironmentDiff> {
    const versionsService = VersionsService.getInstance();
    await versionsService.initialize();

    const targetVersion = target.versionId ? versionsService.getVersion(target.versionId) : undefined;
    const versionToActivate = targetVersion && !targetVersion.isActive ? targetVersion : undefined;
    const settings = new SettingsModel(targetVersion?.settings ?? await versionsService.getActiveVersionSettings());

    const coreBranchTarget = target.coreBranch?.trim() || targetVersion?.odooVersion?.trim() || undefined;
    let coreRepoPipeline: { branch: string; needsCheckout: boolean; missingEnvironment: boolean } | undefined;
    if (coreBranchTarget) {
        const configuredPaths = [settings.odooPath, settings.enterprisePath, settings.designThemesPath]
            .filter(entry => entry && entry.trim() !== '')
            .map(entry => normalizePath(entry));
        const existingPaths = configuredPaths.filter(entry => fs.existsSync(entry));

        // Configured but absent is "not provisioned", not "needs a checkout":
        // promising a branch switch into directories that do not exist is the
        // misleading message this distinction removes.
        const missingEnvironment = configuredPaths.length > 0 && existingPaths.length === 0;
        let needsCheckout = false;
        for (const repoPath of existingPaths) {
            // A provisioned worktree reports its managed branch (odt/19.0) while
            // the version targets the series (19.0); asking git to check out
            // 19.0 there would fail, since the source repo still holds it.
            if (!branchSatisfiesTarget(await getRepoBranch(repoPath), coreBranchTarget)) {
                needsCheckout = true;
                break;
            }
        }

        // A version change alone is enough: post-switch hooks must run even
        // when every worktree is already on the right branch.
        if (needsCheckout || missingEnvironment || versionToActivate) {
            coreRepoPipeline = { branch: coreBranchTarget, needsCheckout, missingEnvironment };
        }
    }

    const repoCheckouts: ProjectRepoBranchAssignment[] = [];
    for (const assignment of target.repoAssignments ?? []) {
        if (!assignment.repoPath) {
            continue;
        }
        if (!fs.existsSync(assignment.repoPath)) {
            // Keep missing repos so the failure is reported instead of silently skipped.
            repoCheckouts.push(assignment);
            continue;
        }
        const current = await getRepoBranch(assignment.repoPath);
        if (current !== assignment.branch) {
            repoCheckouts.push(assignment);
        }
    }

    // Never switch a branch under a server running alongside from that checkout.
    const { proceed, heldBack } = repoCheckouts.length > 0
        ? splitHeldBack(repoCheckouts, await liveAlongsideCheckouts())
        : { proceed: repoCheckouts, heldBack: [] };

    const descriptions = describeSwitch({
        versionName: versionToActivate?.name,
        core: coreRepoPipeline,
        repoBranchCount: proceed.length
    });

    return { versionToActivate, settings, coreRepoPipeline, repoCheckouts: proceed, heldBack, descriptions };
}

async function applyRepoCheckouts(assignments: ProjectRepoBranchAssignment[]): Promise<Array<{ assignment: ProjectRepoBranchAssignment; ok: boolean; message: string }>> {
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Switching project repository branches',
        cancellable: false
    }, async (progress) => {
        const total = assignments.length;
        let completed = 0;
        const results: Array<{ assignment: ProjectRepoBranchAssignment; ok: boolean; message: string }> = [];

        for (const assignment of assignments) {
            completed += 1;
            const repoLabel = assignment.repoName || path.basename(assignment.repoPath);
            progress.report({
                message: `${repoLabel} (${completed}/${total})`,
                increment: total > 0 ? (100 / total) : 0
            });

            if (!fs.existsSync(assignment.repoPath)) {
                results.push({ assignment, ok: false, message: `Repository path not found: ${assignment.repoPath}` });
                continue;
            }
            if (!fs.existsSync(path.join(assignment.repoPath, '.git'))) {
                results.push({ assignment, ok: false, message: 'Not a git repository' });
                continue;
            }

            const checkoutResult = await checkoutRepoBranch(assignment.repoPath, assignment.branch);
            results.push({ assignment, ok: checkoutResult.ok, message: checkoutResult.message });
        }

        return results;
    });
}

export interface AlignmentOptions {
    /** Human label for messages, e.g. `Database "crm-17"`. */
    label: string;
    /** Overrides the databaseSwitchBehavior setting for this call. */
    behavior?: SwitchBehavior;
}

/**
 * Aligns the workbench (active version, core repo branches, project repo
 * branches) to the given target. This is the single switch pipeline used by
 * database selection, project selection, and version activation.
 *
 * No-ops silently when everything already matches. Failures never throw; they
 * are summarized in a single warning.
 */
/**
 * Token for the pending `ask` notification. A newer switch invalidates the
 * older one, so an answer that arrives after the workspace has moved on is
 * discarded rather than applied to a workspace it was never about.
 */
let pendingSwitchToken = 0;

/** Claims the pending slot for a new prompt, invalidating any older one. */
export function claimSwitchToken(): number {
    pendingSwitchToken += 1;
    return pendingSwitchToken;
}

export function isCurrentSwitch(token: number): boolean {
    return token === pendingSwitchToken;
}

/** Invalidates the pending prompt without claiming the slot for a new one. */
export function supersedePendingSwitch(): void {
    pendingSwitchToken += 1;
}

export async function alignEnvironment(target: EnvironmentTarget, options: AlignmentOptions): Promise<void> {
    const behavior = options.behavior ?? getDatabaseSwitchBehavior();
    if (behavior === 'never') {
        return;
    }

    const diff = await computeEnvironmentDiff(target);
    if (isEmptyDiff(diff)) {
        warnHeldBack(diff.heldBack);
        return;
    }

    if (behavior === 'ask') {
        // Fire-and-forget so the selection itself (and the tree refresh) is not
        // held hostage by an unanswered notification.
        const token = claimSwitchToken();
        void showInfo(
            `${options.label} targets ${diff.descriptions.join(', ')}. Align your workspace?`,
            'Switch',
            'Keep Current'
        ).then(async choice => {
            if (choice !== 'Switch' || !isCurrentSwitch(token)) {
                return;
            }
            try {
                // Recompute: the workspace may have changed while the
                // notification sat unanswered.
                const freshDiff = await computeEnvironmentDiff(target);
                if (!isEmptyDiff(freshDiff)) {
                    await applyEnvironmentDiff(freshDiff, options.label);
                } else {
                    warnHeldBack(freshDiff.heldBack);
                }
                await vscode.commands.executeCommand('projectSelector.refresh');
            } catch (error: any) {
                void showWarning(`${options.label}: environment switch failed: ${error.message}`);
            }
        });
        return;
    }

    await applyEnvironmentDiff(diff, options.label);
}

/** One warning for every checkout the switch left alone, offering a copy per branch. */
function warnHeldBack(heldBack: HeldCheckout[]): void {
    if (heldBack.length === 0) {
        return;
    }
    const message = describeHeldBack(heldBack);
    logger.info(`[environment] ${message}`);
    void showWarning(message, 'Use One Copy Per Branch').then(choice => {
        if (choice === 'Use One Copy Per Branch') {
            void vscode.commands.executeCommand('odt.repo.toggleBranchMode', vscode.Uri.file(heldBack[0].path));
        }
    });
}

function isEmptyDiff(diff: EnvironmentDiff): boolean {
    return !diff.versionToActivate && !diff.coreRepoPipeline && diff.repoCheckouts.length === 0;
}

async function applyEnvironmentDiff(diff: EnvironmentDiff, label: string): Promise<void> {
    warnHeldBack(diff.heldBack);
    const applied: string[] = [];
    const failures: string[] = [];

    if (diff.versionToActivate) {
        const versionsService = VersionsService.getInstance();
        const ok = await versionsService.setActiveVersion(diff.versionToActivate.id);
        if (ok) {
            applied.push(`version "${diff.versionToActivate.name}"`);
        } else {
            failures.push(`could not activate version "${diff.versionToActivate.name}"`);
        }
    }

    if (diff.coreRepoPipeline) {
        const { branch, needsCheckout, missingEnvironment } = diff.coreRepoPipeline;
        if (missingEnvironment) {
            failures.push(`the core repositories for "${branch}" are missing - provision this version again`);
        }
        const results = await alignCoreRepos(diff.settings, branch, needsCheckout);
        const failed = results.filter(result => !result.success);
        if (failed.length === 0) {
            if (needsCheckout) {
                applied.push(`branch "${branch}"`);
            }
        } else {
            if (failed.length < results.length && needsCheckout) {
                applied.push(`branch "${branch}" (partially)`);
            }
            failures.push(...failed.map(result => `${result.name}: ${result.message}`));
        }
    }

    if (diff.repoCheckouts.length > 0) {
        const results = await applyRepoCheckouts(diff.repoCheckouts);
        const failed = results.filter(result => !result.ok);
        const succeeded = results.length - failed.length;
        if (succeeded > 0) {
            applied.push(`${succeeded} project repo branch(es)`);
        }
        failures.push(...failed.map(result => `${result.assignment.repoName || path.basename(result.assignment.repoPath)}: ${result.message}`));
    }

    if (failures.length === 0) {
        // A hooks-only run applies nothing visible; staying silent is correct.
        if (applied.length > 0) {
            showAutoInfo(`${label}: switched ${applied.join(', ')}`, 3000);
        }
    } else {
        failures.forEach(failure => logger.error(`[environment] ${label}: ${failure}`));
        void showWarning(`${label}: environment switch finished with issues — ${failures.join('; ')}`);
    }
}
