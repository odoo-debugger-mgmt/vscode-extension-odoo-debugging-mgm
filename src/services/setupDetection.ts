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
