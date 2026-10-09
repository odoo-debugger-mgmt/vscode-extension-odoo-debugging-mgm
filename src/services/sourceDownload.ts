/**
 * Download Odoo Sources: a plain shallow copy of one Odoo branch, to read the
 * code. It is not a version and not a worktree source; nothing records it.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { runCommand } from './process';
import { logger } from './logger';
import { isOdooSeriesBranch, rankBranches } from './gitService';

export interface SourceRepo {
    label: string;
    /** Folder name prefix: `<prefix>-<branch>`. */
    prefix: string;
    /** Clone URLs, tried in order (ssh first for enterprise). */
    urls: string[];
}

export const SOURCE_REPOS = {
    odoo: { label: 'Community (odoo)', prefix: 'odoo', urls: ['https://github.com/odoo/odoo.git'] },
    enterprise: {
        label: 'Enterprise',
        prefix: 'enterprise',
        urls: ['git@github.com:odoo/enterprise.git', 'https://github.com/odoo/enterprise.git']
    },
    designThemes: { label: 'Design Themes', prefix: 'design-themes', urls: ['https://github.com/odoo/design-themes.git'] }
} satisfies Record<string, SourceRepo>;

/** Series branches (`master`, `saas-17.4`, `17.0`) from `git ls-remote --heads`, newest first. */
export function seriesFromLsRemote(stdout: string): string[] {
    const names = stdout.split('\n')
        .map(line => /\trefs\/heads\/(.+)$/.exec(line.trim())?.[1])
        .filter((name): name is string => !!name && isOdooSeriesBranch(name));
    return rankBranches([...new Set(names)]);
}

export function folderNameFor(repo: SourceRepo, branch: string): string {
    return `${repo.prefix}-${branch.replace(/\//g, '-')}`;
}

/** A plain branch name: no option-like start, no spaces, none of git's forbidden sequences. */
export function isValidBranchName(name: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)
        && !name.includes('..')
        && !name.includes('//')
        && !name.endsWith('/')
        && !name.endsWith('.')
        && !name.endsWith('.lock');
}

/** True when `folder` is `root` or below it. */
export function isInside(folder: string, root: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(folder));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export interface PlannedClone { repo: SourceRepo; folder: string }

/** A folder that is missing or empty is cloned into; anything else is skipped. */
export async function planDownload(baseDir: string, repos: SourceRepo[], branch: string): Promise<{ clone: PlannedClone[]; skip: PlannedClone[] }> {
    const clone: PlannedClone[] = [];
    const skip: PlannedClone[] = [];
    for (const repo of repos) {
        const folder = path.join(baseDir, folderNameFor(repo, branch));
        (await isMissingOrEmptyDir(folder) ? clone : skip).push({ repo, folder });
    }
    return { clone, skip };
}

async function isMissingOrEmptyDir(folder: string): Promise<boolean> {
    try {
        const stat = await fs.stat(folder);
        return stat.isDirectory() && (await fs.readdir(folder)).length === 0;
    } catch {
        return true;
    }
}

/** Lists the remote's series branches; throws when the remote cannot be reached. */
export async function listRemoteSeries(url: string = SOURCE_REPOS.odoo.urls[0], token?: vscode.CancellationToken): Promise<string[]> {
    const { stdout } = await runCommand('git', ['ls-remote', '--heads', url], {
        token,
        timeoutMs: 30000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    return seriesFromLsRemote(stdout);
}

/**
 * Clones `branch` of the first URL that works into `dest`, shallow and single-branch.
 * `dest` must be missing or empty. On failure or cancellation `dest` is removed:
 * this function created it, so nothing of the user's is lost.
 */
export async function cloneShallow(
    urls: string[],
    branch: string,
    dest: string,
    options: { token?: vscode.CancellationToken; onLine?: (line: string) => void } = {}
): Promise<void> {
    if (!isValidBranchName(branch)) {
        throw new Error(`"${branch}" is not a branch name.`);
    }
    if (!(await isMissingOrEmptyDir(dest))) {
        throw new Error(`${dest} already exists and is not empty.`);
    }
    // An empty folder is removed so that, from here on, `dest` is always ours to delete.
    await fs.rm(dest, { recursive: true, force: true });

    let lastError: unknown;
    for (const url of urls) {
        if (options.token?.isCancellationRequested) {
            break;
        }
        let fatal: string | undefined;
        try {
            await runCommand('git', ['clone', '--progress', '--depth', '1', '--single-branch', '--branch', branch, '--', url, dest], {
                cwd: path.dirname(dest),
                token: options.token,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
                onStderrLine: line => {
                    const trimmed = line.trim();
                    if (/^(fatal|error):/i.test(trimmed)) {
                        fatal = trimmed.replace(/^(fatal|error):\s*/i, '');
                    }
                    if (trimmed) {
                        options.onLine?.(trimmed);
                    }
                }
            });
            if (!options.token?.isCancellationRequested) {
                return;
            }
        } catch (error) {
            // git's own reason ("Remote branch 9.9 not found", "could not read Username") says more than the command line.
            lastError = fatal ? new Error(fatal) : error;
            logger.warn(`[download] clone of ${url} (${branch}) failed:`, error);
        }
        await fs.rm(dest, { recursive: true, force: true });
    }
    await fs.rm(dest, { recursive: true, force: true });
    if (options.token?.isCancellationRequested) {
        throw new Error('Cancelled');
    }
    throw lastError instanceof Error ? lastError : new Error(`Could not clone ${branch}.`);
}
