/**
 * Finds each version's own checkout of the project's repositories on disk.
 *
 * The decision is `pickRepoCheckout` in repoPaths.ts; this gathers what it
 * decides from: the git checkouts under the version's custom addons folder,
 * and each one's `origin`, so a clone in a folder of another name is still
 * recognised.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RepoModel } from '../models/repo';
import { normalizePath, findRepositories } from '../utils';
import { tryRunCommand } from './process';
import { CheckoutCandidate, RepoLocationSource, normalizeRemote, pickRepoCheckout, reposForVersion } from './repoPaths';

/** What a version carries that decides where its repositories live. */
export interface VersionLike {
    settings?: { customAddonsPath?: string; repoPaths?: Record<string, string> };
}

/** Lists the git checkouts directly usable under a folder. */
export type CheckoutLister = (root: string) => Array<{ path: string; name: string }>;

const remotes = new Map<string, Promise<string | undefined>>();

/** `origin` of the checkout at `repoPath`, normalised; cached for the session. */
export function remoteOf(repoPath: string): Promise<string | undefined> {
    const key = path.resolve(repoPath);
    let pending = remotes.get(key);
    if (!pending) {
        pending = tryRunCommand('git', ['remote', 'get-url', 'origin'], { cwd: key })
            .then(url => normalizeRemote(url))
            .catch(() => undefined);
        remotes.set(key, pending);
    }
    return pending;
}

/** Forgets cached remotes, e.g. after a checkout's origin was changed. */
export function invalidateRemoteCache(): void {
    remotes.clear();
}

async function candidatesUnder(root: string | undefined, list: CheckoutLister): Promise<CheckoutCandidate[]> {
    if (!root || !fs.existsSync(root)) {
        return [];
    }
    let found: Array<{ path: string; name: string }>;
    try {
        found = list(root);
    } catch {
        return [];
    }
    return Promise.all(found.map(async entry => ({
        path: entry.path,
        name: entry.name,
        remote: await remoteOf(entry.path)
    })));
}

export interface LocatedRepo {
    path: string;
    source: RepoLocationSource;
}

/**
 * Where each repository lives for `version`, by repository name, with how it
 * was found. `list` is injectable for tests; the extension uses the same
 * repository discovery as the Repos view.
 */
export async function locateRepoCheckouts(
    repos: RepoModel[],
    version: VersionLike | undefined,
    list: CheckoutLister = root => findRepositories(root)
): Promise<Map<string, LocatedRepo>> {
    const located = new Map<string, LocatedRepo>();
    if (repos.length === 0) {
        return located;
    }
    const rawRoot = version?.settings?.customAddonsPath;
    const root = rawRoot ? normalizePath(rawRoot) : undefined;
    const candidates = await candidatesUnder(root, list);
    const overrides = version?.settings?.repoPaths ?? {};

    for (const repo of repos) {
        const override = overrides[repo.name];
        const repoRemote = override || candidates.length === 0 ? undefined : await remoteOf(normalizePath(repo.path));
        const picked = pickRepoCheckout(
            { name: repo.name, path: repo.path },
            repoRemote,
            override ? normalizePath(override) : undefined,
            candidates
        );
        located.set(repo.name, picked);
    }
    return located;
}

/** The project's repositories as `version` sees them (see reposForVersion). */
export async function projectReposForVersion(
    repos: RepoModel[] | undefined,
    version: VersionLike | undefined,
    list?: CheckoutLister
): Promise<RepoModel[]> {
    const all = repos ?? [];
    const located = await locateRepoCheckouts(all, version, list);
    return reposForVersion(all, new Map([...located].map(([name, entry]) => [name, entry.path])));
}
