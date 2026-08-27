/**
 * git worktree operations. Each version gets its own worktree of the core
 * repositories, so versions never compete for one checkout. Worktrees share
 * the repository object store, so an extra version costs one working tree
 * rather than a full clone.
 */
import * as fs from 'node:fs';
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
    /** An existing worktree or the main checkout was reused. */
    adopted: boolean;
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

async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
    const { stdout } = await runCommand('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
    return parseWorktreeList(stdout);
}

async function hasLocalBranch(repoPath: string, branch: string): Promise<boolean> {
    try {
        await runCommand('git', ['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: repoPath });
        return true;
    } catch {
        return false;
    }
}

/**
 * Ensures `branch` is checked out at `destPath` as a worktree of `repoPath`.
 *
 * Three cases are handled explicitly: the branch may be missing from a
 * shallow clone (fetch it first - valid and cheap on a shallow clone), it may
 * already be checked out somewhere (git refuses duplicates, so reuse that
 * path), or the destination may already exist (never delete it).
 */
export async function ensureWorktree(
    repoPath: string,
    branch: string,
    destPath: string,
    token?: vscode.CancellationToken
): Promise<WorktreeResult> {
    const existing = await listWorktrees(repoPath);

    const holding = findWorktreeForBranch(existing, branch);
    if (holding) {
        logger.info(`[worktree] ${branch} already checked out at ${holding.path}`);
        return { path: holding.path, created: false, adopted: true };
    }

    if (fs.existsSync(destPath)) {
        throw new Error(`Cannot create a worktree at ${destPath}: the path already exists and is not a worktree for ${branch}.`);
    }

    if (!(await hasLocalBranch(repoPath, branch))) {
        logger.info(`[worktree] fetching ${branch} into ${repoPath}`);
        await runCommand('git', ['fetch', '--depth', '1', 'origin', `${branch}:${branch}`], { cwd: repoPath, token });
    }

    await runCommand('git', ['worktree', 'add', destPath, branch], { cwd: repoPath, token });
    return { path: destPath, created: true, adopted: false };
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    await runCommand('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoPath });
}
