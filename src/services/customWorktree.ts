/**
 * Creates the worktrees a set of resolved repositories needs, resolving the
 * "source checkout holds this branch" conflict with the user rather than
 * around them. Never detaches silently and never stashes.
 */
import * as vscode from 'vscode';
import { runCommand, tryRunCommand } from './process';
import { logger, errorMessage } from './logger';
import { showModalWarning, showWarning } from './notifications';
import { getRepoBranch } from './branches';
import { ensureRealBranchWorktree } from './worktree';
import { listAllBranches } from './gitService';
import { classifySourceConflict, describeSourceConflict, parsePorcelainStatus } from './sourceConflict';
import type { ResolvedRepo } from './repoPaths';

async function dirtyFiles(repoPath: string): Promise<string[]> {
    const stdout = await tryRunCommand('git', ['status', '--porcelain'], { cwd: repoPath });
    return stdout === undefined ? [] : parsePorcelainStatus(stdout);
}

/** Branches the source could move to, excluding the one being freed. */
async function pickOtherBranch(sourcePath: string, exclude: string): Promise<string | undefined> {
    const names = (await listAllBranches(sourcePath)).filter(name => name !== exclude);
    if (names.length === 0) {
        void showWarning(`"${sourcePath}" has no other branch to move to. Detach it instead, or create a branch first.`);
        return undefined;
    }
    return vscode.window.showQuickPick(names, {
        title: `Move this checkout off "${exclude}"`,
        placeHolder: 'Pick the branch the source checkout should sit on',
        ignoreFocusOut: true
    });
}

/**
 * Frees `branch` from the source checkout, asking first. Returns true when the
 * branch is available afterwards.
 */
async function freeBranch(sourcePath: string, repoName: string, branch: string): Promise<boolean> {
    const conflict = classifySourceConflict(
        await getRepoBranch(sourcePath),
        branch,
        await dirtyFiles(sourcePath)
    );

    if (conflict.kind === 'none') {
        return true;
    }

    const message = describeSourceConflict(conflict, repoName);
    if (conflict.kind === 'dirty') {
        void showWarning(message);
        return false;
    }

    // Moving is offered first: it leaves the checkout on a branch, so pull
    // works and tooling that rejects a detached HEAD keeps working.
    const choice = await showModalWarning(message, 'Move to Another Branch', 'Detach It');
    if (choice === 'Move to Another Branch') {
        const target = await pickOtherBranch(sourcePath, branch);
        if (!target) {
            return false;
        }
        await runCommand('git', ['switch', target], { cwd: sourcePath });
        logger.info(`[worktree] moved ${sourcePath} to ${target} to free ${branch}`);
        return true;
    }

    if (choice !== 'Detach It') {
        return false;
    }

    await runCommand('git', ['checkout', '--detach'], { cwd: sourcePath });
    logger.info(`[worktree] detached ${sourcePath} to free ${branch}`);
    return true;
}

/**
 * Ensures every worktree-mode entry has its directory. Entries that cannot be
 * satisfied are reported and fall back to their source checkout, so one
 * problem repo never blocks the rest of the project.
 */
export async function ensureCustomWorktrees(
    resolved: ResolvedRepo[],
    token?: vscode.CancellationToken
): Promise<{ ready: ResolvedRepo[]; problems: string[] }> {
    const ready: ResolvedRepo[] = [];
    const problems: string[] = [];

    for (const entry of resolved) {
        if (!entry.isWorktree || !entry.branch) {
            ready.push(entry);
            continue;
        }

        const sourcePath = entry.repo.path;
        try {
            if (!(await freeBranch(sourcePath, entry.repo.name, entry.branch))) {
                problems.push(`${entry.repo.name}: could not free "${entry.branch}" from its source checkout`);
                ready.push({ ...entry, path: sourcePath, isWorktree: false });
                continue;
            }

            const result = await ensureRealBranchWorktree(sourcePath, entry.branch, entry.path, token);
            ready.push({ ...entry, path: result.path });
        } catch (error) {
            logger.error(`[worktree] ${entry.repo.name}:`, error);
            problems.push(`${entry.repo.name}: ${errorMessage(error)}`);
            ready.push({ ...entry, path: sourcePath, isWorktree: false });
        }
    }

    return { ready, problems };
}
