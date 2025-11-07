import * as vscode from 'vscode';
import * as path from 'node:path';
import type { GitExtension, Repository, Branch, BranchType } from '../types/git';

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
        console.warn(`Git API checkout failed for ${repoPath}:`, error);
        return false;
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
        console.warn(`Git API branch listing failed for ${repoPath}:`, error);
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
