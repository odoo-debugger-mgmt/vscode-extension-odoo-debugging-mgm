/**
 * "I am upgrading this database to that one" is one sentence. It maps onto
 * things that already exist: two versions, a per-branch copy of each custom
 * repository, and a branch mapping per database. This module does the mapping;
 * the command applies it.
 *
 * The two databases are named by the caller rather than discovered from their
 * version links. Deriving them was a correctness bug: on a first upgrade the
 * target series has no version yet, so nothing matched it and the target side
 * of the mapping was silently never written.
 *
 * Pure: nothing here touches git, settings or the filesystem.
 */
import { worktreeDirName } from './repoPaths';
import * as path from 'node:path';

export interface UpgradeRepo {
    name: string;
    path: string;
    fromBranch: string;
    toBranch: string;
}

export interface UpgradeInput {
    repos: UpgradeRepo[];
    fromSeries: string;
    toSeries: string;
    /** The database being upgraded from. */
    fromDbId: string;
    /** The database it is upgraded into. */
    toDbId: string;
    existingVersions: string[];
    /** Repositories already keeping one copy per branch. */
    worktreeRepos?: string[];
    /** Where per-branch copies are built, for naming them in the confirmation. */
    root?: string;
    /**
     * Each version's own checkout of a repository, when the two sides were
     * found in different directories (design §7): a folder per version needs
     * no copies, since each side already has its own. Omitted for a
     * repository whose sides share one directory, or whose target version is
     * not built yet - those get per-branch copies, as before.
     */
    ownCheckouts?: Record<string, { from: string; to: string }>;
}

export interface UpgradePlan {
    versionsToCreate: string[];
    /** Repositories that must switch to one copy per branch. */
    reposToWorktree: string[];
    /** Repositories each version already has its own checkout of: no copies. */
    reposOnOwnCheckouts: string[];
    assignments: Array<{ dbId: string; repoName: string; repoPath: string; branch: string }>;
    /**
     * Absolute directories the copies of the repositories switching to one
     * copy per branch will occupy. Only those: the confirmation says these
     * will be created, and a repository already keeping copies has them.
     */
    worktreeDirs: string[];
}

export function buildUpgradePlan(input: UpgradeInput): UpgradePlan {
    const existing = new Set(input.existingVersions.map(entry => entry.trim()));
    const versionsToCreate = [input.fromSeries, input.toSeries]
        .filter(series => series.trim() && !existing.has(series.trim()));

    const alreadyWorktree = new Set((input.worktreeRepos ?? []).map(name => name.toLowerCase()));
    const ownCheckouts = new Set(Object.keys(input.ownCheckouts ?? {}).map(name => name.toLowerCase()));
    // Only a repository both sides would run from one directory needs copies.
    const needsCopies = (name: string) => !alreadyWorktree.has(name.toLowerCase()) && !ownCheckouts.has(name.toLowerCase());

    const assignments: UpgradePlan['assignments'] = [];
    const worktreeDirs: string[] = [];
    for (const repo of input.repos) {
        // Each side gets its own branch on its own database. Neither depends on
        // a version existing yet, which is the whole point of naming the
        // databases up front.
        assignments.push(
            { dbId: input.fromDbId, repoName: repo.name, repoPath: repo.path, branch: repo.fromBranch },
            { dbId: input.toDbId, repoName: repo.name, repoPath: repo.path, branch: repo.toBranch }
        );
        if (input.root && needsCopies(repo.name)) {
            worktreeDirs.push(
                path.join(input.root, worktreeDirName(repo.name, repo.fromBranch)),
                path.join(input.root, worktreeDirName(repo.name, repo.toBranch))
            );
        }
    }

    return {
        versionsToCreate,
        reposToWorktree: input.repos
            .filter(repo => needsCopies(repo.name))
            .map(repo => repo.name),
        reposOnOwnCheckouts: input.repos
            .filter(repo => !alreadyWorktree.has(repo.name.toLowerCase()) && ownCheckouts.has(repo.name.toLowerCase()))
            .map(repo => repo.name),
        assignments,
        worktreeDirs
    };
}

/**
 * The whole plan, for the one confirmation the flow shows.
 *
 * It names the copy directories itself because it replaced a second modal per
 * repository that existed only to say where they would go - three dialogs for
 * one decision, two of them repeating the first.
 */
export function describeUpgradePlan(plan: UpgradePlan, input: UpgradeInput): string {
    const versionRow = [input.fromSeries, input.toSeries]
        .map(series => plan.versionsToCreate.includes(series)
            ? `Odoo ${series} (will be built)`
            : `Odoo ${series} (exists)`)
        .join(', ');

    const lines = [
        `Databases     ${input.fromDbId} (Odoo ${input.fromSeries}) → ${input.toDbId} (Odoo ${input.toSeries})`,
        `Versions      ${versionRow}`
    ];

    if (input.repos.length > 0) {
        // One line per repository: a single joined line was unreadable past two
        // repositories, and this is shown in a modal that can hold the lines.
        lines.push(
            'Branches',
            ...input.repos.map(repo =>
                `    ${repo.name}: ${repo.fromBranch} → Odoo ${input.fromSeries}, ${repo.toBranch} → Odoo ${input.toSeries}`)
        );
    }

    if (plan.reposOnOwnCheckouts.length > 0) {
        lines.push('', 'Each version already has its own checkout of these, so no copies are made:');
        for (const name of plan.reposOnOwnCheckouts) {
            const own = Object.entries(input.ownCheckouts ?? {})
                .find(([repoName]) => repoName.toLowerCase() === name.toLowerCase())?.[1];
            if (own) {
                lines.push(`    ${name}: ${own.from} (Odoo ${input.fromSeries}), ${own.to} (Odoo ${input.toSeries})`);
            }
        }
    }

    if (plan.reposToWorktree.length > 0 && plan.worktreeDirs.length > 0) {
        lines.push(
            '',
            `${plan.reposToWorktree.join(', ')} will keep one copy per branch. These directories`,
            'will be created, and this is where you will edit that branch\'s code:',
            ...plan.worktreeDirs.map(dir => `    ${dir}`),
            '',
            'The original checkouts become sources only: they stay yours to switch',
            'freely, and nothing that happens to them changes what a version runs.'
        );
    }

    return lines.join('\n');
}
