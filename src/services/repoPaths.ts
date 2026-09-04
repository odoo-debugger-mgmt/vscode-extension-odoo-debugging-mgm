/**
 * Where a repository's code actually lives for a given branch.
 *
 * In `checkout` mode that is always the repository itself - the behaviour that
 * predates this module. In `worktree` mode each branch gets its own directory
 * under the provisioning root, so two versions can run against their own
 * custom code at once, and the original checkout becomes a source only.
 *
 * Pure: mapping is decided here, creating directories is not.
 */
import * as path from 'node:path';
import { RepoModel, RepoBranchMode, normalizeBranchMode } from '../models/repo';
import type { ProjectRepoBranchAssignment } from '../models/db';
import { normalizePath } from '../utils';

export interface ResolvedRepo {
    repo: RepoModel;
    /** Directory to use: the source checkout, or a worktree for the branch. */
    path: string;
    /** The branch this path is on, when one is assigned. */
    branch?: string;
    mode: RepoBranchMode;
    /** True when `path` is a worktree rather than the source checkout. */
    isWorktree: boolean;
}

/** Anything illegal or confusing in a directory name becomes a dash. */
function slug(value: string): string {
    return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function worktreeDirName(repoName: string, branch: string): string {
    return `${slug(repoName)}@${slug(branch)}`;
}

export function resolveRepoPath(repo: RepoModel, branch: string | undefined, root: string): ResolvedRepo {
    const mode = normalizeBranchMode(repo.branchMode);
    const trimmedBranch = branch?.trim() || undefined;

    // No branch to key a worktree on: the source is all there is.
    if (mode !== 'worktree' || !trimmedBranch) {
        return {
            repo,
            path: normalizePath(repo.path),
            branch: trimmedBranch,
            mode,
            isWorktree: false
        };
    }

    return {
        repo,
        path: path.join(root, worktreeDirName(repo.name, trimmedBranch)),
        branch: trimmedBranch,
        mode,
        isWorktree: true
    };
}

export function resolveProjectRepos(
    repos: RepoModel[],
    assignments: ProjectRepoBranchAssignment[],
    root: string
): ResolvedRepo[] {
    const byPath = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const assignment of assignments) {
        if (!assignment.branch) {
            continue;
        }
        if (assignment.repoPath) {
            byPath.set(normalizePath(assignment.repoPath), assignment.branch);
        }
        if (assignment.repoName) {
            byName.set(assignment.repoName.toLowerCase(), assignment.branch);
        }
    }

    return repos.map(repo => {
        // Path first: a renamed repo still matches. Name second: a moved one does.
        const branch = byPath.get(normalizePath(repo.path)) ?? byName.get(repo.name.toLowerCase());
        return resolveRepoPath(repo, branch, root);
    });
}

/**
 * Resolved repos in the shape `discoverModulesInRepos` expects, so module
 * discovery and the addons path see worktrees rather than source checkouts
 * without every downstream signature changing.
 */
export function toDiscoveryRepos(resolved: ResolvedRepo[]): RepoModel[] {
    return resolved.map(entry => new RepoModel(
        entry.repo.name,
        entry.path,
        entry.repo.isSelected,
        entry.repo.addedAt,
        entry.mode
    ));
}

/** Whether `child` is `parent` itself or sits inside it. */
function isInside(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Which repo and branch a file on disk belongs to, for the wrong-copy warning.
 * Only worktrees are considered: a file in a source checkout is not "the wrong
 * copy", it is simply not part of what any version runs.
 */
export function identifyWorktreeOwner(
    filePath: string,
    resolved: ResolvedRepo[]
): { repo: RepoModel; branch: string } | undefined {
    const target = path.resolve(filePath);
    for (const entry of resolved) {
        if (entry.isWorktree && entry.branch && isInside(target, path.resolve(entry.path))) {
            return { repo: entry.repo, branch: entry.branch };
        }
    }
    return undefined;
}

/** The confirmation shown before a repository changes branch mode. */
export function describeModeChange(
    repoName: string,
    mode: RepoBranchMode,
    root: string,
    branches: string[],
    repoPath?: string
): string {
    const original = repoPath ?? repoName;

    if (mode === 'checkout') {
        return `Switch "${repoName}" back to a single checkout?\n\n`
            + `The copies the extension created for it will be removed. `
            + `Any with uncommitted changes are kept and reported.`;
    }

    // A project whose databases carry no branch assignments yet is the ordinary
    // state before the branch picker has ever been used, and it produced a
    // dialog that promised directories and then listed none.
    if (branches.length === 0) {
        return `Give "${repoName}" one working copy per branch?\n\n`
            + `No branches are mapped to it yet, so nothing is created now. A copy appears under\n`
            + `  ${root}\n`
            + `the first time a database maps this repository to a branch.\n\n`
            + `The original checkout at ${original} becomes a source only: it stays yours to switch `
            + `freely, and nothing that happens to it changes what a version runs.`;
    }

    const dirs = branches.map(branch => `  ${path.join(root, worktreeDirName(repoName, branch))}`).join('\n');
    return `Give "${repoName}" one working copy per branch?\n\n`
        + `These directories will be created, and this is where you will edit that branch's code:\n\n${dirs}\n\n`
        + `The original checkout at ${original} becomes a source only: it stays yours to switch freely, `
        + `and nothing that happens to it changes what a version runs.`;
}
