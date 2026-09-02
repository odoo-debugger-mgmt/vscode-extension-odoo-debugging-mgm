/**
 * Finds Odoo checkouts already on the machine so setup can propose them
 * instead of interrogating the user. Classification and ranking are pure;
 * only the scan touches the filesystem, and it is bounded to a fixed root
 * list one level deep so it can never wander a large home directory.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { logger } from './logger';

export type RepoKind = 'odoo' | 'enterprise' | 'design-themes';

export interface RepoCandidate {
    path: string;
    kind: RepoKind;
    /** Lower sorts first: how much the location is trusted. */
    rank: number;
}

/** Directory names that identify the two optional repos. */
const ENTERPRISE_NAMES = new Set(['enterprise', 'odoo-enterprise']);
const DESIGN_THEMES_NAMES = new Set(['design-themes', 'odoo-design-themes', 'themes']);

/**
 * What a directory is, from its name alone. `odoo` is deliberately absent:
 * an Odoo source repo is identified by containing `odoo-bin`, not by being
 * called "odoo", because the fork is often named after the client.
 */
export function classifyByName(dirName: string): RepoKind | undefined {
    const name = dirName.trim().toLowerCase();
    if (ENTERPRISE_NAMES.has(name)) {
        return 'enterprise';
    }
    if (DESIGN_THEMES_NAMES.has(name)) {
        return 'design-themes';
    }
    return undefined;
}

/** The directories scanned, most-trusted first. */
export function searchRoots(
    configured: Array<string | undefined>,
    workspaceFolders: string[],
    home: string = os.homedir()
): string[] {
    const roots: string[] = [];
    const seen = new Set<string>();

    const push = (dir: string | undefined) => {
        const trimmed = dir?.trim();
        if (!trimmed || seen.has(trimmed)) {
            return;
        }
        seen.add(trimmed);
        roots.push(trimmed);
    };

    // A configured path is a statement of intent; its parent is where the
    // sibling repos almost always live.
    for (const dir of configured) {
        push(dir);
        if (dir?.trim()) {
            push(path.dirname(dir.trim()));
        }
    }
    workspaceFolders.forEach(push);
    for (const name of ['src', 'Dev', 'dev', 'Projects', 'odoo', DEFAULT_HOME_DIRNAME]) {
        push(path.join(home, name));
    }
    push(home);

    return roots;
}

const DEFAULT_HOME_DIRNAME = 'odoo-dev';

/**
 * Best candidate per kind: the earliest search root wins, since roots are
 * ordered by how much the location is trusted.
 */
export function pickBest(candidates: RepoCandidate[]): Partial<Record<RepoKind, RepoCandidate>> {
    const best: Partial<Record<RepoKind, RepoCandidate>> = {};
    for (const candidate of [...candidates].sort((a, b) => a.rank - b.rank)) {
        if (!best[candidate.kind]) {
            best[candidate.kind] = candidate;
        }
    }
    return best;
}

function isGitRepo(dir: string): boolean {
    // A worktree carries a .git file rather than a directory, so test presence.
    return fs.existsSync(path.join(dir, '.git'));
}

function inspect(dir: string, rank: number): RepoCandidate | undefined {
    try {
        if (!fs.statSync(dir).isDirectory() || !isGitRepo(dir)) {
            return undefined;
        }
    } catch {
        return undefined;
    }

    if (fs.existsSync(path.join(dir, 'odoo-bin'))) {
        return { path: dir, kind: 'odoo', rank };
    }
    const byName = classifyByName(path.basename(dir));
    return byName ? { path: dir, kind: byName, rank } : undefined;
}

/**
 * Scans the search roots one level deep. Each root is also tested directly,
 * so a configured path that *is* the repo is found without listing its parent.
 */
export function detectRepos(roots: string[]): RepoCandidate[] {
    const found: RepoCandidate[] = [];
    const seen = new Set<string>();

    roots.forEach((root, index) => {
        const rank = index * 100;

        const direct = inspect(root, rank);
        if (direct && !seen.has(direct.path)) {
            seen.add(direct.path);
            found.push(direct);
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) {
                continue;
            }
            const child = path.join(root, entry.name);
            if (seen.has(child)) {
                continue;
            }
            const candidate = inspect(child, rank + 1);
            if (candidate) {
                seen.add(child);
                found.push(candidate);
            }
        }
    });

    logger.debug(`[setup] detected ${found.length} candidate repositories`);
    return found;
}

// ---------------------------------------------------------------------------
// Custom addons
// ---------------------------------------------------------------------------

export interface AddonsChild {
    name: string;
    isGitRepo: boolean;
    hasOdooBin: boolean;
}

/**
 * How many of a directory's children are the user's own repositories. The
 * core repos are excluded by the same rules detection uses elsewhere:
 * `odoo-bin` identifies the source repo whatever it is named, and the two
 * optional repos are identified by name.
 */
export function countCustomRepos(children: AddonsChild[]): number {
    return children.filter(child =>
        child.isGitRepo && !child.hasOdooBin && !classifyByName(child.name)
    ).length;
}

export function readAddonsChildren(dir: string): AddonsChild[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }

    return entries
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => {
            const child = path.join(dir, entry.name);
            return {
                name: entry.name,
                isGitRepo: fs.existsSync(path.join(child, '.git')),
                hasOdooBin: fs.existsSync(path.join(child, 'odoo-bin'))
            };
        });
}

/**
 * The first search root holding at least one repository of the user's own.
 * Roots are already ordered by trust, and the workspace comes before the home
 * directory, which is the common case: the workspace *is* that directory.
 */
export function detectCustomAddonsRoot(roots: string[]): string | undefined {
    for (const root of roots) {
        if (countCustomRepos(readAddonsChildren(root)) > 0) {
            logger.debug(`[setup] custom addons look like they live in ${root}`);
            return root;
        }
    }
    return undefined;
}
