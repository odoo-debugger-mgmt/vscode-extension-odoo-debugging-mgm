/**
 * Bridge to the built-in git extension's API: current branch, branch
 * listings and checkouts via source control (with type-safe fallbacks).
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { GitExtension, Repository, Branch, BranchType } from '../types/git';
import { logger } from './logger';
import { runCommand } from './process';

function resolveRepoPath(repoPath: string): string {
    if (path.isAbsolute(repoPath)) {
        return path.normalize(repoPath);
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        return path.normalize(path.join(workspaceFolders[0].uri.fsPath, repoPath));
    }

    return path.normalize(path.resolve(repoPath));
}

async function getRepository(repoPath: string): Promise<Repository | undefined> {
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExtension) {
        return undefined;
    }

    const extension = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    const api = extension.getAPI(1);
    const targetPath = path.resolve(resolveRepoPath(repoPath));

    const repositories = api.repositories;
    return repositories.find(repo => {
        const repoPathResolved = path.resolve(repo.rootUri.fsPath);
        return repoPathResolved === targetPath || repoPathResolved.toLowerCase() === targetPath.toLowerCase();
    });
}

export async function checkoutBranchViaSourceControl(repoPath: string, branch: string): Promise<boolean> {
    try {
        const repo = await getRepository(repoPath);
        if (!repo) {
            return false;
        }
        await repo.checkout(branch, false);
        return true;
    } catch (error) {
        logger.warn(`Git API checkout failed for ${repoPath}:`, error);
        return false;
    }
}

export async function getCurrentBranchViaSourceControl(repoPath: string): Promise<string | null> {
    try {
        const repo = await getRepository(repoPath);
        const headName = repo?.state?.HEAD?.name;
        return headName && headName.trim().length > 0 ? headName : null;
    } catch (error) {
        logger.warn(`Git API branch lookup failed for ${repoPath}:`, error);
        return null;
    }
}

function normalizeBranchName(value: string): string {
    if (value.startsWith('remotes/origin/')) {
        return value.replace('remotes/origin/', '');
    }
    if (value.startsWith('origin/')) {
        return value.replace('origin/', '');
    }
    return value;
}

export async function getBranchesWithMetadata(repoPath: string): Promise<Array<{ name: string; type: BranchType }>> {
    try {
        const repo = await getRepository(repoPath);
        if (!repo || !repo.getBranches) {
            return [];
        }

        const [localBranches, remoteBranches] = await Promise.all([
            repo.getBranches({ remote: false }),
            repo.getBranches({ remote: true })
        ]);

        const branchMap = new Map<string, BranchType>();

        const addBranches = (branches: Branch[], type: BranchType) => {
            for (const branch of branches) {
                const name = branch.name;
                if (!name || !name.trim()) {
                    continue;
                }
                const normalized = normalizeBranchName(name.trim());
                if (type === 'local' || !branchMap.has(normalized)) {
                    branchMap.set(normalized, type);
                }
            }
        };

        addBranches(localBranches, 'local');
        addBranches(remoteBranches, 'remote');

        return Array.from(branchMap.entries())
            .map(([name, type]) => ({ name, type }))
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
        logger.warn(`Git API branch listing failed for ${repoPath}:`, error);
        return [];
    }
}

export async function getBranchesViaSourceControl(repoPath: string): Promise<string[] | undefined> {
    const metadata = await getBranchesWithMetadata(repoPath);
    if (!metadata || metadata.length === 0) {
        return undefined;
    }
    return metadata.map(branch => branch.name);
}

// ---------------------------------------------------------------------------
// Fast branch listing
//
// The git extension's getBranches() returns every ref. On the odoo repository
// that is ~68,700 remote refs (measured: 1.6s of git time, 7.6 MB of output),
// almost all of them PR branches on the `dev` remote, and every one of them
// gets marshalled across the extension-host boundary and turned into a quick
// pick item before the user sees anything. These helpers read only the refs a
// version could plausibly be built from, via `git for-each-ref`.
// ---------------------------------------------------------------------------

/** Odoo release branches: `17.0`, `saas-17.4`, `master`. */
const ODOO_SERIES_PATTERN = /^((saas-)?\d+(\.\d+)?|master)$/i;

export function isOdooSeriesBranch(name: string): boolean {
    return ODOO_SERIES_PATTERN.test(name.trim());
}

/** Parses `for-each-ref`/`branch` output into unique short branch names. */
export function parseRefList(stdout: string): string[] {
    const seen = new Set<string>();
    const names: string[] = [];

    for (const rawLine of stdout.split('\n')) {
        const name = normalizeBranchName(rawLine.trim());
        if (!name || name === 'HEAD' || name.endsWith('/HEAD')) {
            continue;
        }
        if (seen.has(name)) {
            continue;
        }
        seen.add(name);
        names.push(name);
    }

    return names;
}

function seriesSortKey(name: string): [number, number] {
    if (/^master$/i.test(name)) {
        return [Number.MAX_SAFE_INTEGER, 0];
    }
    const match = /^(?:saas-)?(\d+)(?:\.(\d+))?$/i.exec(name);
    if (!match) {
        return [-1, 0];
    }
    return [Number(match[1]), Number(match[2] ?? 0)];
}

/** Series branches first (newest first), then everything else alphabetically. */
export function rankBranches(names: string[]): string[] {
    const series = names.filter(isOdooSeriesBranch);
    const rest = names.filter(name => !isOdooSeriesBranch(name));

    series.sort((a, b) => {
        const [aMajor, aMinor] = seriesSortKey(a);
        const [bMajor, bMinor] = seriesSortKey(b);
        return bMajor - aMajor || bMinor - aMinor || a.localeCompare(b);
    });
    rest.sort((a, b) => a.localeCompare(b));

    return [...series, ...rest];
}

async function forEachRef(repoPath: string, patterns: string[]): Promise<string[]> {
    try {
        const { stdout } = await runCommand(
            'git',
            ['for-each-ref', '--format=%(refname:short)', ...patterns],
            { cwd: resolveRepoPath(repoPath) }
        );
        return parseRefList(stdout);
    } catch (error) {
        logger.warn(`Failed to list refs in ${repoPath}:`, error);
        return [];
    }
}

/**
 * Local branches plus the release branches on `origin` - the ones a version is
 * actually built from. Cheap enough to run before showing UI.
 */
export async function listSeriesBranches(repoPath: string): Promise<string[]> {
    const names = await forEachRef(repoPath, ['refs/heads', 'refs/remotes/origin']);
    return rankBranches(names.filter(isOdooSeriesBranch));
}

/** Every branch, including PR branches on every remote. Can be very slow. */
export async function listAllBranches(repoPath: string): Promise<string[]> {
    return rankBranches(await forEachRef(repoPath, ['refs/heads', 'refs/remotes']));
}
