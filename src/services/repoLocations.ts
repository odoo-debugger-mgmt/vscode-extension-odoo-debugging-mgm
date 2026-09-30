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

async function candidatesUnder(root: string | undefined, list: CheckoutLister, includeRoot = false): Promise<CheckoutCandidate[]> {
    if (!root || !fs.existsSync(root)) {
        return [];
    }
    let found: Array<{ path: string; name: string }>;
    try {
        found = list(root);
    } catch {
        return [];
    }
    // A workspace folder is often the clone itself, not a folder of clones.
    if (includeRoot && fs.existsSync(path.join(root, '.git'))) {
        found = [{ path: root, name: path.basename(root) }, ...found];
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
 * The git checkouts a version can find its repositories among: those in the
 * extra roots (a bound workspace's folders, each possibly a clone itself)
 * first, then those under its custom addons folder, each once.
 */
export async function gatherCheckoutCandidates(
    version: VersionLike | undefined,
    list: CheckoutLister = root => findRepositories(root),
    extraRoots: string[] = []
): Promise<CheckoutCandidate[]> {
    const rawRoot = version?.settings?.customAddonsPath;
    const root = rawRoot ? normalizePath(rawRoot) : undefined;
    const candidates: CheckoutCandidate[] = [];
    const seen = new Set<string>();
    for (const batch of [
        ...(await Promise.all(extraRoots.map(extra => candidatesUnder(extra, list, true)))),
        await candidatesUnder(root, list)
    ]) {
        for (const candidate of batch) {
            const key = path.resolve(candidate.path);
            if (!seen.has(key)) {
                seen.add(key);
                candidates.push(candidate);
            }
        }
    }
    return candidates;
}

export interface RepoRow {
    /** The label: the project repository's name for its checkout, else the folder's. */
    name: string;
    path: string;
    inProject: boolean;
    /** The folder's own name, when the label is the project repository's. */
    folderName?: string;
}

/**
 * The Repos view's rows for a version: every checkout it can find, where the
 * one a project repository runs from carries that repository's name and is
 * marked as in the project. Other clones of a project repository - same
 * remote, or same folder name - are left out: they are not what runs, and a
 * second "acme" on another branch is what made the view misleading.
 */
export function repoRows(
    candidates: CheckoutCandidate[],
    located: ReadonlyMap<string, { path: string }>,
    projectRepos: Array<{ name: string; remote?: string }>
): RepoRow[] {
    const runs = new Map<string, string>();
    for (const [name, entry] of located) {
        runs.set(path.resolve(entry.path), name);
    }
    const rows: RepoRow[] = [];
    for (const candidate of candidates) {
        const projectName = runs.get(path.resolve(candidate.path));
        if (projectName) {
            rows.push({
                name: projectName,
                path: candidate.path,
                inProject: true,
                folderName: candidate.name !== projectName ? candidate.name : undefined
            });
            continue;
        }
        const otherClone = projectRepos.some(repo =>
            (candidate.remote && repo.remote && candidate.remote === repo.remote)
            || candidate.name.toLowerCase() === repo.name.toLowerCase());
        if (!otherClone) {
            rows.push({ name: candidate.name, path: candidate.path, inProject: false });
        }
    }
    return rows;
}

/**
 * Where each repository lives for `version`, by repository name, with how it
 * was found. `list` is injectable for tests; the extension uses the same
 * repository discovery as the Repos view.
 *
 * `extraRoots` are searched before the custom addons folder: the folders of a
 * workspace bound to this version, each of which may be a clone itself or
 * hold clones. That is how the code a version's workspace holds becomes that
 * version's code.
 */
export async function locateRepoCheckouts(
    repos: RepoModel[],
    version: VersionLike | undefined,
    list: CheckoutLister = root => findRepositories(root),
    extraRoots: string[] = []
): Promise<Map<string, LocatedRepo>> {
    const located = new Map<string, LocatedRepo>();
    if (repos.length === 0) {
        return located;
    }
    const candidates = await gatherCheckoutCandidates(version, list, extraRoots);
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
    list?: CheckoutLister,
    extraRoots: string[] = []
): Promise<RepoModel[]> {
    const all = repos ?? [];
    const located = await locateRepoCheckouts(all, version, list, extraRoots);
    return reposForVersion(all, new Map([...located].map(([name, entry]) => [name, entry.path])));
}
