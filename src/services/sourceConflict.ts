/**
 * git will not check one branch out in two places. Odoo core worktrees dodge
 * this with a managed `odt/<branch>` alias, but custom code is committed and
 * pushed, so its worktrees must hold the real branch - which means the source
 * checkout has to let go of it first.
 *
 * Deciding that is pure and lives here; doing it is the caller's job, and only
 * ever with the user's explicit confirmation.
 */

export type SourceConflict =
    | { kind: 'none' }
    | { kind: 'movable'; branch: string }
    | { kind: 'dirty'; branch: string; files: string[] };

export function classifySourceConflict(
    sourceBranch: string | null | undefined,
    targetBranch: string,
    dirtyFiles: string[]
): SourceConflict {
    if (!sourceBranch || sourceBranch !== targetBranch) {
        return { kind: 'none' };
    }
    return dirtyFiles.length > 0
        ? { kind: 'dirty', branch: targetBranch, files: dirtyFiles }
        : { kind: 'movable', branch: targetBranch };
}

export function describeSourceConflict(conflict: SourceConflict, repoName: string): string {
    if (conflict.kind === 'none') {
        return '';
    }

    const why = `git can only check a branch out in one place, and this version needs "${conflict.branch}" in its own worktree.`;

    if (conflict.kind === 'movable') {
        // Both consequences below were verified by experiment. The first
        // contradicts an earlier draft of the design, which claimed detaching
        // was reversible with one `git switch`; it is not.
        return `Your checkout of "${repoName}" is on "${conflict.branch}". ${why}\n\n`
            + `Moving it to another branch is recommended: it keeps working normally.\n\n`
            + `Detaching it instead keeps the same commit and files, but the checkout cannot return `
            + `to "${conflict.branch}" until the worktree is removed, and any commit you make there `
            + `would belong to no branch — only the reflog would find it.`;
    }

    const shown = conflict.files.slice(0, 5).join(', ');
    const more = conflict.files.length > 5 ? `, and ${conflict.files.length - 5} more` : '';
    return `Your checkout of "${repoName}" is on "${conflict.branch}" with uncommitted changes (${shown}${more}). `
        + `${why} Commit or stash them first - which of the two is your call, not the extension's.`;
}

/** Changed paths from `git status --porcelain`, staged and unstaged alike. */
export function parsePorcelainStatus(stdout: string): string[] {
    const paths: string[] = [];
    for (const rawLine of stdout.split('\n')) {
        // Status codes occupy the first two columns; the path follows a space.
        const line = rawLine.slice(3).trim();
        if (!line) {
            continue;
        }
        // Renames and copies report "old -> new"; the new path is the live one.
        const arrow = line.indexOf(' -> ');
        paths.push(arrow >= 0 ? line.slice(arrow + 4).trim() : line);
    }
    return paths;
}
