/**
 * Setup Odoo flow: clones the Odoo repositories for a chosen branch
 * (shallow single-branch or full history), optionally continues with a
 * Python virtualenv + requirements, and offers to create a matching
 * version profile.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { getWorkspacePath, showInfo, showError } from './utils';
import { runCommand, tryRunCommand } from './services/process';
import { logger, errorMessage } from './services/logger';
import { showModalWarning } from './services/notifications';
import { VersionsService } from './versionsService';

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

/** Creates the venv and installs Odoo requirements in a visible terminal. */
async function setupPythonEnvironment(baseDir: string, branch: string): Promise<void> {
    let pythonCmd = 'python3';
    if (await tryRunCommand('python3', ['--version']) === undefined) {
        if (await tryRunCommand('python', ['--version']) !== undefined) {
            pythonCmd = 'python';
        } else {
            throw new Error('Python not found. Please install Python 3.8+ first.');
        }
    }

    const terminal = vscode.window.createTerminal({
        name: `Odoo Setup (${branch})`,
        cwd: baseDir
    });
    terminal.show();

    const isWindows = process.platform === 'win32';
    const activateCmd = isWindows ? '.\\venv\\Scripts\\activate' : 'source venv/bin/activate';

    terminal.sendText(`${pythonCmd} -m venv venv`);
    terminal.sendText(`${activateCmd} && pip install --upgrade pip setuptools wheel`);
    terminal.sendText(`${activateCmd} && if [ -f odoo/requirements.txt ]; then pip install -r odoo/requirements.txt; else echo "No requirements.txt found in odoo directory"; fi`);
    terminal.sendText(`echo "✅ Odoo ${branch} environment setup running — wait for pip to finish."`);
}

/** Creates a version profile pointing at the freshly cloned repositories. */
async function createVersionForClone(
    baseDir: string,
    branch: string,
    clonedDirNames: string[]
): Promise<void> {
    const versionsService = VersionsService.getInstance();

    const existingNames = new Set(versionsService.getVersions().map(version => version.name));
    let name = branch;
    for (let counter = 2; existingNames.has(name); counter++) {
        name = `${branch} (${counter})`;
    }

    const overrides: Record<string, string> = {};
    if (clonedDirNames.includes('odoo')) {
        overrides.odooPath = path.join(baseDir, 'odoo');
    }
    if (clonedDirNames.includes('enterprise')) {
        overrides.enterprisePath = path.join(baseDir, 'enterprise');
    }
    if (clonedDirNames.includes('design-themes')) {
        overrides.designThemesPath = path.join(baseDir, 'design-themes');
    }
    const venvPython = path.join(baseDir, 'venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python');
    if (fs.existsSync(venvPython)) {
        overrides.pythonPath = venvPython;
    }

    const version = await versionsService.createVersion(name, branch, overrides);
    const activate = await showInfo(
        `Version profile "${version.name}" created for the cloned repositories.`,
        'Set Active'
    );
    if (activate === 'Set Active') {
        await versionsService.setActiveVersion(version.id);
    }
}

export async function setupOdooBranch() {
    const workspaceDir = getWorkspacePath();
    if (!workspaceDir) {
        void showError('Open a workspace folder before running this command.');
        return;
    }

    const scope = await vscode.window.showQuickPick(
        [
            {
                label: 'Full setup',
                description: 'Clone repositories, create a Python venv and install requirements',
                cloneOnly: false
            },
            {
                label: 'Clone repositories only',
                description: 'Just clone the Odoo repositories — no venv, no requirements',
                cloneOnly: true
            }
        ],
        { placeHolder: 'What should the setup do?', ignoreFocusOut: true }
    );
    if (!scope) {
        return;
    }

    const baseDir = await pickDestination(workspaceDir);
    if (!baseDir) {
        return;
    }

    const targets = await pickCloneTargets();
    if (!targets) {
        return;
    }

    const branch = await pickBranch();
    if (!branch) {
        return;
    }

    const shallow = await pickCloneDepth();
    if (shallow === undefined) {
        return;
    }

    const dirNames = targets.map(target => target.dirName);
    if (!(await confirmExistingDirectories(baseDir, scope.cloneOnly ? dirNames : [...dirNames, 'venv']))) {
        return;
    }

    const cloned: string[] = [];
    const succeeded = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Cloning Odoo ${branch}${shallow ? ' (shallow)' : ''}…`,
        cancellable: true
    }, async (progress, token) => {
        try {
            for (const target of targets) {
                progress.report({ message: `Cloning ${target.dirName}…` });
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
        return;
    }

    if (!scope.cloneOnly) {
        try {
            await setupPythonEnvironment(baseDir, branch);
        } catch (error) {
            void showError(`Python environment setup failed: ${errorMessage(error)}`);
        }
        await createVersionForClone(baseDir, branch, cloned);
        return;
    }

    // Clone-only: offer the follow-ups instead of running them.
    const next = await showInfo(
        `Cloned ${cloned.join(', ')} (${branch}${shallow ? ', shallow' : ''}).`,
        'Create Version Profile',
        'Continue Full Setup'
    );
    if (next === 'Continue Full Setup') {
        try {
            await setupPythonEnvironment(baseDir, branch);
        } catch (error) {
            void showError(`Python environment setup failed: ${errorMessage(error)}`);
        }
        await createVersionForClone(baseDir, branch, cloned);
    } else if (next === 'Create Version Profile') {
        await createVersionForClone(baseDir, branch, cloned);
    }
}
