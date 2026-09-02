/**
 * "I am upgrading this repository from 17.0 to 19.0" is one sentence. It maps
 * onto three things that already exist: two versions, a per-branch copy of
 * the repository, and a branch mapping per database. This module does the
 * mapping; the command applies it.
 *
 * Pure: nothing here touches git, settings or the filesystem.
 */

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
    existingVersions: string[];
    dbs: Array<{ id: string; versionId?: string }>;
    /** Version id per series, for the series that already have one. */
    versionIdBySeries: Record<string, string | undefined>;
}

export interface UpgradePlan {
    versionsToCreate: string[];
    reposToWorktree: string[];
    assignments: Array<{ dbId: string; repoName: string; repoPath: string; branch: string }>;
}

export function buildUpgradePlan(input: UpgradeInput): UpgradePlan {
    const existing = new Set(input.existingVersions.map(entry => entry.trim()));
    const versionsToCreate = [input.fromSeries, input.toSeries]
        .filter(series => series.trim() && !existing.has(series.trim()));

    const branchForSeries = (series: string, repo: UpgradeRepo): string | undefined => {
        if (series === input.fromSeries) {
            return repo.fromBranch;
        }
        return series === input.toSeries ? repo.toBranch : undefined;
    };

    const assignments: UpgradePlan['assignments'] = [];
    for (const db of input.dbs) {
        if (!db.versionId) {
            continue;
        }
        // Only the two series in the upgrade are touched: a database on some
        // other version has nothing to do with this.
        const series = [input.fromSeries, input.toSeries]
            .find(candidate => input.versionIdBySeries[candidate] === db.versionId);
        if (!series) {
            continue;
        }
        for (const repo of input.repos) {
            const branch = branchForSeries(series, repo);
            if (branch) {
                assignments.push({ dbId: db.id, repoName: repo.name, repoPath: repo.path, branch });
            }
        }
    }

    return {
        versionsToCreate,
        reposToWorktree: input.repos.map(repo => repo.name),
        assignments
    };
}

export function describeUpgradePlan(plan: UpgradePlan, input: UpgradeInput): string {
    const versionRow = [input.fromSeries, input.toSeries]
        .map(series => plan.versionsToCreate.includes(series)
            ? `Odoo ${series} (will be built)`
            : `Odoo ${series} (exists)`)
        .join(', ');

    // One line per repository: a single joined line was unreadable past two
    // repositories, and this is shown in a modal that can hold the lines.
    const mapping = input.repos
        .map(repo => `    ${repo.name}: ${repo.fromBranch} → Odoo ${input.fromSeries}, ${repo.toBranch} → Odoo ${input.toSeries}`)
        .join('\n');

    return [
        `Versions      ${versionRow}`,
        `Custom code   ${plan.reposToWorktree.join(', ')} — one copy per branch`,
        'Branches',
        mapping
    ].join('\n');
}
