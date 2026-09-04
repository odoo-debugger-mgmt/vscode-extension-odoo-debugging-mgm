/**
 * The multi-select shown at the end of setup. Candidates come from
 * `proposeVersions`, so this file only renders them and handles the custom
 * branch row.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VersionCandidate, RepoBranch } from '../services/versionProposal';
import { SettingsStore } from '../settingsStore';
import { getRepoBranch } from '../services/branches';
import { normalizePath } from '../utils';
import { logger } from '../services/logger';

interface CandidateItem extends vscode.QuickPickItem {
    branch?: string;
    custom?: boolean;
}

/** Stated, not measured: enough to stop someone ticking four boxes blind. */
const PER_VERSION_COST = '≈2 GB and a few minutes each';

/** Reading every repository's branch would not be worth the wait. */
const MAX_REPOS_SCANNED = 12;

const CUSTOM_ITEM: CandidateItem = {
    label: '$(pencil) Custom branch…',
    description: 'e.g. "saas-18.4"',
    custom: true
};

export async function pickVersionsToBuild(candidates: VersionCandidate[]): Promise<string[] | undefined> {
    if (candidates.length === 0) {
        return [];
    }

    const items: CandidateItem[] = candidates.map(candidate => ({
        label: candidate.branch,
        description: candidate.reason,
        branch: candidate.branch,
        picked: candidate.picked
    }));

    const picks = await vscode.window.showQuickPick([...items, CUSTOM_ITEM], {
        title: `Which Odoo versions do you want?  (${PER_VERSION_COST})`,
        placeHolder: 'Each builds a worktree, a virtualenv and its requirements',
        canPickMany: true,
        ignoreFocusOut: true
    });
    if (!picks) {
        return undefined;
    }

    const branches = picks.map(pick => pick.branch).filter((branch): branch is string => !!branch);

    if (picks.some(pick => pick.custom)) {
        const entered = await vscode.window.showInputBox({
            title: 'Custom branch',
            placeHolder: 'e.g. "saas-18.4", "master"',
            ignoreFocusOut: true,
            validateInput: value => value.trim() ? undefined : 'Branch is required.'
        });
        const trimmed = entered?.trim();
        if (trimmed && !branches.includes(trimmed)) {
            branches.push(trimmed);
        }
    }

    return branches;
}

/**
 * Branches of the repositories across saved projects. On a fresh install
 * there are no projects, so this costs nothing; the cap keeps it cheap for
 * someone with a large workspace.
 */
/** Git repositories directly under the configured custom addons folder. */
function discoverAddonsRepos(): Array<{ name: string; path: string }> {
    const configured = vscode.workspace
        .getConfiguration('odooDebugger')
        .get<string>('defaultVersion.customAddonsPath', '')
        .trim();
    const root = configured ? normalizePath(configured) : '';
    if (!root || !fs.existsSync(root)) {
        return [];
    }
    try {
        return fs.readdirSync(root, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, '.git')))
            .map(entry => ({ name: entry.name, path: path.join(root, entry.name) }));
    } catch {
        return [];
    }
}

export async function collectRepoBranches(): Promise<RepoBranch[]> {
    try {
        const data = await SettingsStore.get('odoo-debugger-data.json');
        let repos: Array<{ name: string; path: string }> = (data.projects ?? [])
            .flatMap((project: { repos?: Array<{ name: string; path: string }> }) => project.repos ?? []);

        // On a first run there are no projects yet, which is exactly when this
        // list is shown - so the repo-derived rows never materialised and every
        // row read "stable release". Fall back to the addons folder setup has
        // just recorded, which is where those repositories are.
        if (repos.length === 0) {
            repos = discoverAddonsRepos();
        }
        repos = repos.slice(0, MAX_REPOS_SCANNED);

        const branches: RepoBranch[] = [];
        for (const repo of repos) {
            const branch = await getRepoBranch(normalizePath(repo.path));
            if (branch) {
                branches.push({ repoName: repo.name, branch });
            }
        }
        return branches;
    } catch (error) {
        logger.debug('Could not read repository branches for the version proposal:', error);
        return [];
    }
}
