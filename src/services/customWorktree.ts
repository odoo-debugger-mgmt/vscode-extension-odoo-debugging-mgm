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
import { branchesHeldByWorktrees, ensureRealBranchWorktree, worktreeAlreadySatisfies } from './worktree';
import { invalidateGitBranchCache } from './runtimeCache';
import { listAllBranches } from './gitService';
import { classifySourceConflict, describeSourceConflict, parsePorcelainStatus } from './sourceConflict';
import type { ResolvedRepo } from './repoPaths';

async function dirtyFiles(repoPath: string): Promise<string[]> {
    const stdout = await tryRunCommand('git', ['status', '--porcelain'], { cwd: repoPath });
    return stdout === undefined ? [] : parsePorcelainStatus(stdout);
}

/**
 * The branches a source checkout can move to: not the one being freed, not
 * one another worktree holds (git refuses a second checkout of it), and not
 * one this run is about to give its own worktree. A remote-only branch is
 * offered by its short name, which `git switch` turns into a tracking branch.
 */
export function branchesToMoveTo(
    names: string[],
    exclude: string,
    held: ReadonlySet<string>,
    reserved: ReadonlySet<string>
): string[] {
    const local = new Set(names.filter(name => !name.includes('/')));
    const offered: string[] = [];
    for (const name of names) {
        const slash = name.indexOf('/');
        const short = slash < 0 ? name : name.slice(slash + 1);
        if (slash >= 0 && (short === 'HEAD' || !short || local.has(short))) {
            continue;
        }
        if (short === exclude || held.has(short) || reserved.has(short) || offered.includes(short)) {
            continue;
        }
        offered.push(short);
    }
    return offered;
}

async function pickOtherBranch(sourcePath: string, exclude: string, reserved: ReadonlySet<string>): Promise<string | undefined> {
    const names = branchesToMoveTo(
        await listAllBranches(sourcePath),
        exclude,
        await branchesHeldByWorktrees(sourcePath),
        reserved
    );
    if (names.length === 0) {
        void showWarning(
            `"${sourcePath}" has no free branch to move to: the others are checked out in worktrees, `
            + 'or needed by this one. Detach it instead, or create a branch first.'
        );
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
 *
 * `interactive` is what separates a command from a sync. The debugger sync
 * runs after almost every command and on a 200 ms debounce; raising a modal
 * about someone's working tree from there is a question nobody asked, and
 * running `git switch` in a directory they own is worse. Non-interactive
 * callers report the conflict instead and leave the decision to the offer.
 */
async function freeBranch(
    sourcePath: string,
    repoName: string,
    branch: string,
    interactive: boolean,
    reserved: ReadonlySet<string>
): Promise<boolean> {
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
        if (interactive) {
            void showWarning(message);
        }
        return false;
    }

    if (!interactive) {
        // Arbitration belongs to a command the user started.
        return false;
    }

    // Moving is offered first: it leaves the checkout on a branch, so pull
    // works and tooling that rejects a detached HEAD keeps working.
    const choice = await showModalWarning(message, 'Move to Another Branch', 'Detach It');
    if (choice === 'Move to Another Branch') {
        const target = await pickOtherBranch(sourcePath, branch, reserved);
        if (!target) {
            return false;
        }
        await runCommand('git', ['switch', target], { cwd: sourcePath });
        // The branch reader caches for a few seconds; without this the next
        // entry for the same source still sees the branch just moved off, and
        // re-raises a conflict that no longer exists.
        invalidateGitBranchCache(sourcePath);
        logger.info(`[worktree] moved ${sourcePath} to ${target} to free ${branch}`);
        return true;
    }

    if (choice !== 'Detach It') {
        return false;
    }

    await runCommand('git', ['checkout', '--detach'], { cwd: sourcePath });
    invalidateGitBranchCache(sourcePath);
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
    token?: vscode.CancellationToken,
    options: {
        interactive?: boolean;
        /**
         * Copies a later call in the same operation will make - the other side
         * of an upgrade. Their branches are not offered to move the source
         * onto, since the source would then hold what that call needs.
         */
        alsoNeeded?: ResolvedRepo[];
    } = {}
): Promise<{ ready: ResolvedRepo[]; problems: string[]; needsResolution: string[] }> {
    const interactive = options.interactive ?? false;
    const ready: ResolvedRepo[] = [];
    const problems: string[] = [];
    /** Repositories a command could still fix by asking. */
    const needsResolution: string[] = [];

    for (const entry of resolved) {
        if (!entry.isWorktree || !entry.branch) {
            ready.push(entry);
            continue;
        }

        const sourcePath = entry.repo.path;
        try {
            // Nothing to free when the copy already holds the branch: git allows
            // one checkout of it, so the source cannot also be on it. Asking
            // anyway is how a correctly built set of copies kept raising the
            // "using the source checkout" modal on every refresh.
            const satisfied = await worktreeAlreadySatisfies(sourcePath, entry.branch, entry.path);

            // The branches this run, or the one after it, gives other copies of
            // the same repository.
            const reserved = new Set([...resolved, ...(options.alsoNeeded ?? [])]
                .filter(other => other.isWorktree && other.branch && other.repo.path === sourcePath)
                .map(other => other.branch!));
            if (!satisfied && !(await freeBranch(sourcePath, entry.repo.name, entry.branch, interactive, reserved))) {
                problems.push(`${entry.repo.name}: could not free "${entry.branch}" from its source checkout`);
                needsResolution.push(entry.repo.name);
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

    return { ready, problems, needsResolution };
}
