import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseModel, ProjectRepoBranchAssignment } from '../models/db';
import { RepoModel } from '../models/repo';
import { SettingsModel } from '../models/settings';
import { VersionModel } from '../models/version';
import { VersionsService } from '../versionsService';
import { normalizePath, getGitBranch, showAutoInfo, showWarning } from '../utils';
import { checkoutCoreRepos, checkoutRepoBranch } from './checkout';

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
        console.warn('Failed to migrate databaseSwitchBehavior setting:', error);
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
 * Captures the current branch of each project repository, used to attach the
 * developer's present working state to a newly created database.
 */
export async function captureCurrentRepoBranches(projectRepos: RepoModel[]): Promise<ProjectRepoBranchAssignment[]> {
    const captured = await Promise.all(projectRepos.map(async repo => {
        const repoPath = normalizePath(repo.path);
        const branch = await getGitBranch(repoPath);
        if (!branch) {
            return undefined;
        }
        return { repoName: repo.name, repoPath, branch } as ProjectRepoBranchAssignment;
    }));

    return captured.filter((entry): entry is ProjectRepoBranchAssignment => !!entry);
}

export interface EnvironmentTarget {
    /** Version profile to activate. */
    versionId?: string;
    /** Branch for the core repos; defaults to the target version's branch. */
    coreBranch?: string;
    /** Per-project-repo branches to check out. */
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
        repoAssignments: resolveProjectRepoBranchAssignments(database, projectRepos)
    };
}

interface EnvironmentDiff {
    versionToActivate?: VersionModel;
    settings: SettingsModel;
    coreBranch?: string;
    repoCheckouts: ProjectRepoBranchAssignment[];
    descriptions: string[];
}

async function computeEnvironmentDiff(target: EnvironmentTarget): Promise<EnvironmentDiff> {
    const versionsService = VersionsService.getInstance();
    await versionsService.initialize();

    const targetVersion = target.versionId ? versionsService.getVersion(target.versionId) : undefined;
    const versionToActivate = targetVersion && !targetVersion.isActive ? targetVersion : undefined;
    const settings = new SettingsModel(targetVersion?.settings ?? await versionsService.getActiveVersionSettings());

    const coreBranchTarget = target.coreBranch?.trim() || targetVersion?.odooVersion?.trim() || undefined;
    let coreBranch: string | undefined;
    if (coreBranchTarget) {
        const corePaths = [settings.odooPath, settings.enterprisePath, settings.designThemesPath]
            .filter(entry => entry && entry.trim() !== '')
            .map(entry => normalizePath(entry))
            .filter(entry => fs.existsSync(entry));

        for (const repoPath of corePaths) {
            const current = await getGitBranch(repoPath);
            if (current !== coreBranchTarget) {
                coreBranch = coreBranchTarget;
                break;
            }
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
        const current = await getGitBranch(assignment.repoPath);
        if (current !== assignment.branch) {
            repoCheckouts.push(assignment);
        }
    }

    const descriptions: string[] = [];
    if (versionToActivate) {
        descriptions.push(`version "${versionToActivate.name}"`);
    }
    if (coreBranch) {
        descriptions.push(`branch "${coreBranch}"`);
    }
    if (repoCheckouts.length > 0) {
        descriptions.push(`${repoCheckouts.length} project repo branch(es)`);
    }

    return { versionToActivate, settings, coreBranch, repoCheckouts, descriptions };
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
export async function alignEnvironment(target: EnvironmentTarget, options: AlignmentOptions): Promise<void> {
    const behavior = options.behavior ?? getDatabaseSwitchBehavior();
    if (behavior === 'never') {
        return;
    }

    const diff = await computeEnvironmentDiff(target);
    if (!diff.versionToActivate && !diff.coreBranch && diff.repoCheckouts.length === 0) {
        return;
    }

    if (behavior === 'ask') {
        const choice = await vscode.window.showInformationMessage(
            `${options.label} targets ${diff.descriptions.join(', ')}. Align your workspace?`,
            'Switch',
            'Keep Current'
        );
        if (choice !== 'Switch') {
            return;
        }
    }

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

    if (diff.coreBranch) {
        const results = await checkoutCoreRepos(diff.settings, diff.coreBranch);
        const failed = results.filter(result => !result.success);
        if (failed.length === 0) {
            applied.push(`branch "${diff.coreBranch}"`);
        } else {
            if (failed.length < results.length) {
                applied.push(`branch "${diff.coreBranch}" (partially)`);
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
        showAutoInfo(`${options.label}: switched ${applied.join(', ')}`, 3000);
    } else {
        failures.forEach(failure => console.error(`[environment] ${options.label}: ${failure}`));
        showWarning(`${options.label}: environment switch finished with issues — ${failures.join('; ')}`);
    }
}
