/**
 * Setup Odoo flow: clones the Odoo repositories for a chosen branch
 * (shallow single-branch or full history), optionally continues with a
 * Python virtualenv + requirements, and offers to create a matching
 * version profile.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { showInfo, showError, showWarning } from './utils';
import { runCommand } from './services/process';
import { logger, errorMessage } from './services/logger';
import { showModalWarning } from './services/notifications';
import { VersionsService } from './versionsService';
import type { VersionModel } from './models/version';
import { probeProvision, buildPlan, isFullySatisfied, executeProvision, ProvisionSpec } from './services/provisioning';
import { summarizeMissing } from './services/systemDeps';
import { venvPythonPath } from './services/pythonToolchain';
import { readSetupState } from './services/setupState';

interface CloneTarget {
    /** Directory name inside the workspace. */
    dirName: string;
    /** Clone URLs, tried in order (ssh first for enterprise). */
    urls: string[];
    label: string;
}

const CLONE_TARGETS: Record<string, CloneTarget> = {
    odoo: {
        dirName: 'odoo',
        urls: ['https://github.com/odoo/odoo.git'],
        label: 'Community (odoo)'
    },
    enterprise: {
        dirName: 'enterprise',
        urls: ['git@github.com:odoo/enterprise.git', 'https://github.com/odoo/enterprise.git'],
        label: 'Enterprise'
    },
    designThemes: {
        dirName: 'design-themes',
        urls: ['https://github.com/odoo/design-themes.git'],
        label: 'Design Themes'
    }
};

const BRANCH_OPTIONS = [
    { label: '19.0', description: 'Latest stable version' },
    { label: '18.0', description: 'Stable version' },
    { label: '17.0', description: 'Previous stable version' },
    { label: 'master', description: 'Development branch (unstable)' },
    { label: 'saas-19.2', description: 'SaaS version' },
    { label: 'saas-19.1', description: 'SaaS version' },
    { label: 'saas-18.4', description: 'SaaS version' },
    { label: 'Custom', description: 'Enter a custom branch name' }
];

async function pickBranch(): Promise<string | undefined> {
    const selected = await vscode.window.showQuickPick(BRANCH_OPTIONS, {
        placeHolder: 'Select an Odoo branch to clone',
        ignoreFocusOut: true
    });
    if (!selected) {
        return undefined;
    }
    if (selected.label !== 'Custom') {
        return selected.label;
    }
    const custom = await vscode.window.showInputBox({
        prompt: 'Enter the branch name',
        placeHolder: 'e.g., 19.0, master, saas-19.2',
        ignoreFocusOut: true
    });
    return custom?.trim() || undefined;
}

/** Where to clone: the workspace folder by default, or any picked folder. */
async function pickDestination(workspaceDir: string): Promise<string | undefined> {
    const choice = await vscode.window.showQuickPick(
        [
            {
                label: 'Workspace folder',
                description: workspaceDir,
                custom: false
            },
            {
                label: 'Choose a different folder…',
                description: 'The repositories are cloned inside the selected folder',
                custom: true
            }
        ],
        { placeHolder: 'Where should the repositories be cloned?', ignoreFocusOut: true }
    );
    if (!choice) {
        return undefined;
    }
    if (!choice.custom) {
        return workspaceDir;
    }
    const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(workspaceDir),
        openLabel: 'Clone Here',
        title: 'Select the folder to clone the repositories into'
    });
    return picked?.[0]?.fsPath;
}

async function pickCloneDepth(): Promise<boolean | undefined> {
    const choice = await vscode.window.showQuickPick(
        [
            {
                label: 'Shallow copy (recommended)',
                description: 'Single branch, no history — fast and small (--depth 1)',
                shallow: true
            },
            {
                label: 'Full clone',
                description: 'All branches and full history — several GB for odoo',
                shallow: false
            }
        ],
        { placeHolder: 'How should the repositories be cloned?', ignoreFocusOut: true }
    );
    return choice?.shallow;
}

async function pickCloneTargets(): Promise<CloneTarget[] | undefined> {
    const picks = await vscode.window.showQuickPick(
        [
            { label: CLONE_TARGETS.odoo.label, target: CLONE_TARGETS.odoo, picked: true },
            { label: CLONE_TARGETS.enterprise.label, target: CLONE_TARGETS.enterprise, picked: true },
            { label: CLONE_TARGETS.designThemes.label, target: CLONE_TARGETS.designThemes, picked: false }
        ],
        {
            placeHolder: 'Select the repositories to clone',
            canPickMany: true,
            ignoreFocusOut: true
        }
    );
    if (!picks) {
        return undefined;
    }
    if (picks.length === 0) {
        void showInfo('Select at least one repository to clone.');
        return undefined;
    }
    return picks.map(pick => pick.target);
}

async function confirmExistingDirectories(baseDir: string, dirNames: string[]): Promise<boolean> {
    const existing = dirNames.filter(name => fs.existsSync(path.join(baseDir, name)));
    if (existing.length === 0) {
        return true;
    }
    const confirm = await showModalWarning(
        `The following directories already exist: ${existing.join(', ')}\n\ngit clone will fail on non-empty directories. Continue anyway?`,
        'Continue Anyway'
    );
    return confirm === 'Continue Anyway';
}

/** Clones one repository, trying each URL in order; reports git progress. */
async function cloneRepository(
    target: CloneTarget,
    options: { baseDir: string; branch: string; shallow: boolean },
    progress: vscode.Progress<{ message?: string }>,
    token: vscode.CancellationToken
): Promise<void> {
    const args = ['clone', '--progress', '--branch', options.branch];
    if (options.shallow) {
        args.push('--depth', '1', '--single-branch');
    }

    let lastError: unknown;
    for (const url of target.urls) {
        if (token.isCancellationRequested) {
            throw new Error('Cancelled');
        }
        try {
            await runCommand('git', [...args, url, target.dirName], {
                cwd: options.baseDir,
                token,
                onStderrLine: line => {
                    const trimmed = line.trim();
                    if (trimmed) {
                        progress.report({ message: `${target.dirName}: ${trimmed}` });
                    }
                }
            });
            return;
        } catch (error) {
            lastError = error;
            logger.warn(`Clone of ${url} failed:`, error);
        }
    }
    throw lastError instanceof Error ? lastError : new Error(`Failed to clone ${target.dirName}`);
}

/**
 * Provisions the environment for `branch` - worktree, interpreter, virtualenv,
 * requirements - and creates the matching version profile pointing at it.
 * Returns undefined when the user cancels or provisioning fails.
 */
export async function provisionAndCreateVersion(branch: string, name: string): Promise<VersionModel | undefined> {
    const setup = readSetupState();
    if (!setup.isConfigured || !setup.sourceRepo) {
        // Offer the fix rather than instructing the user to find it.
        const choice = await showWarning('Odoo DevTools is not set up yet.', 'Set Up');
        if (choice === 'Set Up') {
            await vscode.commands.executeCommand('odoo.setup');
        }
        return undefined;
    }

    const spec: ProvisionSpec = {
        branch,
        sourceRepoPath: setup.sourceRepo,
        enterpriseRepoPath: setup.enterpriseRepo,
        designThemesRepoPath: setup.designThemesRepo,
        root: setup.provisioningRoot
    };

    const plan = buildPlan(spec, await probeProvision(spec));
    const detail = plan
        .map(step => `${step.status === 'satisfied' ? '$(check)' : '$(add)'} ${step.label}`)
        .join('  ');

    const choice = await vscode.window.showQuickPick(
        [
            {
                label: isFullySatisfied(plan) ? 'Create profile (already provisioned)' : 'Provision',
                detail,
                provision: true
            },
            {
                label: 'Profile only',
                detail: 'Create the version without building an environment',
                provision: false
            }
        ],
        { title: `Provision Odoo ${branch}?`, placeHolder: 'Choose how to create this version', ignoreFocusOut: true }
    );
    if (!choice) {
        return undefined;
    }

    if (!choice.provision) {
        return VersionsService.getInstance().createVersion(name, branch);
    }

    const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Provisioning Odoo ${branch}`,
        cancellable: true
    }, async (progress, token) => {
        try {
            return await executeProvision(spec, progress, token);
        } catch (error) {
            if (token.isCancellationRequested) {
                void showInfo('Provisioning cancelled. Run it again to resume where it stopped.');
            } else {
                logger.error('Provisioning failed:', error);
                void showError(`Provisioning failed: ${errorMessage(error)}`);
            }
            return undefined;
        }
    });

    if (!result) {
        return undefined;
    }

    const version = await VersionsService.getInstance().createVersion(name, branch, {
        odooPath: result.paths.odooPath,
        enterprisePath: result.paths.enterprisePath ?? '',
        designThemesPath: result.paths.designThemesPath ?? '',
        pythonPath: venvPythonPath(result.paths.venvPath),
        managedPaths: result.managedPaths
    });

    const notes = [...result.warnings];
    const missing = summarizeMissing(result.deps);
    if (missing) {
        notes.push(`Missing: ${missing}`);
    }
    if (notes.length > 0) {
        void showWarning(`Provisioned ${branch} on Python ${result.pythonVersion}. ${notes.join(' ')}`);
    } else {
        void showInfo(`Provisioned ${branch} on Python ${result.pythonVersion}.`);
    }

    return version;
}

/**
 * Clones the Odoo repositories and returns the path of the odoo checkout, so
 * the caller can record it. The previous version of this function cloned and
 * returned nothing, leaving configuration pointing at `./odoo` regardless of
 * where the user actually put the repositories.
 */
export async function cloneOdooRepositories(defaultBaseDir: string): Promise<string | undefined> {
    const baseDir = await pickDestination(defaultBaseDir);
    if (!baseDir) {
        return undefined;
    }

    const targets = await pickCloneTargets();
    if (!targets) {
        return undefined;
    }

    const branch = await pickBranch();
    if (!branch) {
        return undefined;
    }

    const shallow = await pickCloneDepth();
    if (shallow === undefined) {
        return undefined;
    }

    if (!(await confirmExistingDirectories(baseDir, targets.map(target => target.dirName)))) {
        return undefined;
    }

    const cloned: string[] = [];
    const succeeded = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Cloning Odoo ${branch}${shallow ? ' (shallow)' : ''}\u2026`,
        cancellable: true
    }, async (progress, token) => {
        try {
            for (const target of targets) {
                progress.report({ message: `Cloning ${target.dirName}\u2026` });
                await cloneRepository(target, { baseDir, branch, shallow }, progress, token);
                cloned.push(target.dirName);
            }
            return true;
        } catch (error) {
            if (token.isCancellationRequested) {
                void showInfo(`Clone cancelled.${cloned.length ? ` Completed: ${cloned.join(', ')}.` : ''}`);
            } else {
                logger.error('Setup clone failed:', error);
                void showError(`Clone failed: ${errorMessage(error)}`);
            }
            return false;
        }
    });

    if (!succeeded) {
        return undefined;
    }

    // The odoo repo is the one that matters; enterprise and design-themes are
    // found beside it by detection.
    const odooTarget = targets.find(target => fs.existsSync(path.join(baseDir, target.dirName, 'odoo-bin')));
    return odooTarget ? path.join(baseDir, odooTarget.dirName) : undefined;
}
