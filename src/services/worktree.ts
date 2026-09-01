/**
 * git worktree operations. Each version gets its own worktree of the core
 * repositories, so versions never compete for one checkout. Worktrees share
 * the repository object store, so an extra version costs one working tree
 * rather than a full clone.
 *
 * The source repository is only ever a source: a version never runs out of it,
 * even when it happens to sit on the right branch, because that directory is
 * user-controlled and can be switched away underneath the version. Worktrees
 * therefore always get their own `odt/<branch>` local branch tracking
 * `origin/<branch>` - git refuses to check the same branch out twice, and a
 * conditional name would make provisioning depend on whatever the source repo
 * happened to be on at the time.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { runCommand } from './process';
import { logger } from './logger';

export interface WorktreeEntry {
    path: string;
    branch?: string;
}

export interface WorktreeResult {
    path: string;
    /** A new worktree was added. */
    created: boolean;
    /** The worktree already existed at this path and was reused. */
    adopted: boolean;
    /** The local branch the worktree holds. */
    branch: string;
}

/** The extension-managed local branch a worktree for `branch` checks out. */
export function managedBranchName(branch: string): string {
    return `odt/${branch}`;
}

/**
 * Whether a worktree currently on `current` is already correct for `target`.
 * A managed worktree reports `odt/19.0` while its version targets `19.0`;
 * without this the environment diff would ask git to check out `19.0` inside
 * the worktree, which fails because the source repo still holds that branch.
 */
export function branchSatisfiesTarget(current: string | null | undefined, target: string): boolean {
    if (!current) {
        return false;
    }
    return current === target || current === managedBranchName(target);
}

export function parseWorktreeList(output: string): WorktreeEntry[] {
    const entries: WorktreeEntry[] = [];
    let current: WorktreeEntry | undefined;

    for (const rawLine of output.split('\n')) {
        const line = rawLine.trim();
        if (line.startsWith('worktree ')) {
            current = { path: line.slice('worktree '.length), branch: undefined };
            entries.push(current);
            continue;
        }
        if (current && line.startsWith('branch ')) {
            current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
        }
    }

    return entries;
}

export function findWorktreeForBranch(entries: WorktreeEntry[], branch: string): WorktreeEntry | undefined {
    return entries.find(entry => entry.branch === branch);
}

/**
 * Whether something else already holds the managed branch. git refuses to
 * check one branch out in two worktrees, and it keeps the reservation even
 * after the worktree's directory is deleted - the record is only marked
 * prunable - so a version whose folder was removed by hand blocks its own
 * re-provisioning until the record is pruned.
 */
export type BranchConflict =
    | { kind: 'none' }
    /** The record survives but its directory does not: prune and carry on. */
    | { kind: 'stale'; path: string }
    /** A real worktree elsewhere, typically from an older provisioning root. */
    | { kind: 'live'; path: string };

export function classifyBranchConflict(
    entries: WorktreeEntry[],
    managedBranch: string,
    destPath: string,
    exists: (candidate: string) => boolean
): BranchConflict {
    const holder = findWorktreeForBranch(entries, managedBranch);
    if (!holder || samePath(holder.path, destPath)) {
        return { kind: 'none' };
    }
    return exists(holder.path)
        ? { kind: 'live', path: holder.path }
        : { kind: 'stale', path: holder.path };
}

async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
    const { stdout } = await runCommand('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
    return parseWorktreeList(stdout);
}

async function hasRef(repoPath: string, ref: string): Promise<boolean> {
    try {
        await runCommand('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: repoPath });
        return true;
    } catch {
        return false;
    }
}

function samePath(a: string, b: string): boolean {
    return path.resolve(a) === path.resolve(b);
}

/**
 * Ensures a worktree for `branch` exists at `destPath`, checked out on its
 * managed branch.
 *
 * Only `destPath` is ever adopted - that is the "already provisioned" case.
 * A worktree elsewhere holding the branch (typically the source repo itself)
 * is deliberately not reused; see the module comment.
 */
export async function ensureWorktree(
    repoPath: string,
    branch: string,
    destPath: string,
    token?: vscode.CancellationToken
): Promise<WorktreeResult> {
    const managedBranch = managedBranchName(branch);
    const existing = await listWorktrees(repoPath);

    const atDestination = existing.find(entry => samePath(entry.path, destPath));
    if (atDestination) {
        logger.info(`[worktree] reusing existing worktree at ${destPath}`);
        return { path: destPath, created: false, adopted: true, branch: atDestination.branch ?? managedBranch };
    }

    // git keeps the branch reserved for a worktree whose directory has been
    // deleted, so re-provisioning a version whose folder was removed by hand -
    // or that was built under an older provisioning root - fails without this.
    const conflict = classifyBranchConflict(existing, managedBranch, destPath, fs.existsSync);
    if (conflict.kind === 'stale') {
        logger.info(`[worktree] pruning the stale record for ${conflict.path}`);
        await runCommand('git', ['worktree', 'prune'], { cwd: repoPath, token });
    } else if (conflict.kind === 'live') {
        // Rebuilding would need a second branch and a duplicate checkout;
        // adopting matches provisioning's "adopt rather than rebuild" rule.
        logger.warn(`[worktree] ${managedBranch} is already checked out at ${conflict.path}; reusing it`);
        return { path: conflict.path, created: false, adopted: true, branch: managedBranch };
    }

    if (fs.existsSync(destPath)) {
        throw new Error(`Cannot create a worktree at ${destPath}: the path already exists and is not a worktree of ${repoPath}.`);
    }

    // A managed branch left over from a removed worktree is reused rather than
    // recreated - `git worktree add -b` refuses an existing branch name.
    if (await hasRef(repoPath, `refs/heads/${managedBranch}`)) {
        await runCommand('git', ['worktree', 'add', destPath, managedBranch], { cwd: repoPath, token });
        return { path: destPath, created: true, adopted: false, branch: managedBranch };
    }

    let startPoint = `refs/remotes/origin/${branch}`;
    if (!(await hasRef(repoPath, startPoint))) {
        // Valid and cheap on a shallow clone; the explicit refspec also works
        // on a --single-branch clone, where the default one would not fetch it.
        logger.info(`[worktree] fetching ${branch} into ${repoPath}`);
        const fetched = await runCommand(
            'git',
            ['fetch', '--depth', '1', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
            { cwd: repoPath, token }
        ).then(() => true).catch(() => false);

        if (!fetched || !(await hasRef(repoPath, startPoint))) {
            // No remote, or the branch only exists locally.
            if (!(await hasRef(repoPath, `refs/heads/${branch}`))) {
                throw new Error(`Branch "${branch}" was not found locally or on origin in ${repoPath}.`);
            }
            startPoint = `refs/heads/${branch}`;
        }
    }

    // Branching from a remote-tracking ref sets upstream, so `git pull` works
    // inside the worktree without further setup.
    await runCommand('git', ['worktree', 'add', '-b', managedBranch, destPath, startPoint], { cwd: repoPath, token });
    return { path: destPath, created: true, adopted: false, branch: managedBranch };
}

/**
 * A worktree checked out on `branch` itself, not on a managed `odt/` alias.
 *
 * Custom repositories are committed to and pushed from, so their worktrees
 * must hold the real branch. The caller is responsible for having freed the
 * branch from the source checkout first (see sourceConflict.ts); this function
 * surfaces git's refusal rather than working around it.
 */
export async function ensureRealBranchWorktree(
    repoPath: string,
    branch: string,
    destPath: string,
    token?: vscode.CancellationToken
): Promise<WorktreeResult> {
    const existing = await listWorktrees(repoPath);

    const atDestination = existing.find(entry => samePath(entry.path, destPath));
    if (atDestination) {
        logger.info(`[worktree] reusing existing worktree at ${destPath}`);
        return { path: destPath, created: false, adopted: true, branch: atDestination.branch ?? branch };
    }

    const conflict = classifyBranchConflict(existing, branch, destPath, fs.existsSync);
    if (conflict.kind === 'stale') {
        logger.info(`[worktree] pruning the stale record for ${conflict.path}`);
        await runCommand('git', ['worktree', 'prune'], { cwd: repoPath, token });
    } else if (conflict.kind === 'live') {
        logger.warn(`[worktree] ${branch} is already checked out at ${conflict.path}; reusing it`);
        return { path: conflict.path, created: false, adopted: true, branch };
    }

    if (fs.existsSync(destPath)) {
        throw new Error(`Cannot create a worktree at ${destPath}: the path already exists and is not a worktree of ${repoPath}.`);
    }

    if (await hasRef(repoPath, `refs/heads/${branch}`)) {
        await runCommand('git', ['worktree', 'add', destPath, branch], { cwd: repoPath, token });
        return { path: destPath, created: true, adopted: false, branch };
    }

    const remote = `refs/remotes/origin/${branch}`;
    if (!(await hasRef(repoPath, remote))) {
        throw new Error(`Branch "${branch}" was not found locally or on origin in ${repoPath}.`);
    }
    // Branching from the remote-tracking ref sets upstream, so push and pull
    // work inside the worktree without further setup.
    await runCommand('git', ['worktree', 'add', '-b', branch, destPath, remote], { cwd: repoPath, token });
    return { path: destPath, created: true, adopted: false, branch };
}

/** The main repository a worktree belongs to, or undefined when it is not one. */
export async function resolveSourceRepo(worktreePath: string): Promise<string | undefined> {
    try {
        const { stdout } = await runCommand('git', ['rev-parse', '--git-common-dir'], { cwd: worktreePath });
        const commonDir = stdout.trim();
        if (!commonDir) {
            return undefined;
        }
        const absolute = path.isAbsolute(commonDir) ? commonDir : path.resolve(worktreePath, commonDir);
        return path.dirname(absolute);
    } catch {
        return undefined;
    }
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    await runCommand('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoPath });
}

/**
 * Deletes the managed branch a removed worktree left behind. Best effort:
 * `git worktree remove` does not delete it, but a branch the user has since
 * taken over must not disappear silently either, so failures are logged only.
 */
export async function removeManagedBranch(repoPath: string, branch: string): Promise<void> {
    try {
        await runCommand('git', ['branch', '-D', managedBranchName(branch)], { cwd: repoPath });
    } catch (error) {
        logger.warn(`[worktree] could not delete ${managedBranchName(branch)}:`, error);
    }
}
