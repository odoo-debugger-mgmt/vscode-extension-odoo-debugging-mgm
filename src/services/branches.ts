import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { getCurrentBranchViaSourceControl } from './gitService';
import { runtimeCache } from './runtimeCache';
import { logger } from './logger';

/**
 * The single branch reader for the extension. Prefers the built-in git
 * extension's API (accurate for worktrees, detached heads, etc.), falls back
 * to reading .git/HEAD directly, and caches results briefly via runtimeCache.
 * Checkout flows invalidate the cache through invalidateGitBranchCache.
 */

function resolveRepoPath(repoPath: string): string {
    if (path.isAbsolute(repoPath)) {
        return path.normalize(repoPath);
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
        return path.normalize(path.join(workspaceRoot, repoPath));
    }
    return path.normalize(path.resolve(repoPath));
}

async function readBranchFromHeadFile(repoPath: string): Promise<string | null> {
    const gitHeadPath = path.join(repoPath, '.git', 'HEAD');
    try {
        const headContent = (await fs.readFile(gitHeadPath, 'utf-8')).trim();
        const match = /^ref: refs\/heads\/(.+)$/.exec(headContent);
        return match ? match[1] : headContent;
    } catch (error) {
        logger.debug(`Failed to read branch for ${repoPath}`, error);
        return null;
    }
}

/**
 * Returns the current branch of the repository at `repoPath` (relative paths
 * resolve against the first workspace folder), or null when unavailable.
 */
export async function getRepoBranch(repoPath: string | undefined): Promise<string | null> {
    if (!repoPath) {
        return null;
    }
    const resolved = resolveRepoPath(repoPath);
    return runtimeCache.getGitBranch(resolved, async () => {
        const sourceControlBranch = await getCurrentBranchViaSourceControl(resolved);
        if (sourceControlBranch) {
            return sourceControlBranch;
        }
        return readBranchFromHeadFile(resolved);
    });
}
