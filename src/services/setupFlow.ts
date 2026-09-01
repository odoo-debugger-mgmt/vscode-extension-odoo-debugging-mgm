/**
 * The setup flow: detect what is already on the machine, propose it in one
 * confirmation, write the result, and hand off to provisioning. Replaces a
 * five-question wizard that asked everything up front and - the bug this
 * exists to fix - never recorded where it put anything.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { showError, showInfo } from './notifications';
import { errorMessage, logger } from './logger';
import { getRepoBranch } from './branches';
import { detectRepos, pickBest, searchRoots, RepoKind } from './setupDetection';
import {
    defaultProvisioningRoot,
    readRawSetupSettings,
    readSetupState,
    writeSetupSettings,
    RawSetupSettings
} from './setupState';

export interface SetupProposal {
    sourceRepo?: string;
    enterpriseRepo?: string;
    designThemesRepo?: string;
    provisioningRoot: string;
    sourceBranch?: string;
}

function workspaceFolderPaths(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
}

/** Builds the proposal shown for confirmation: current settings, then detection. */
export async function buildProposal(): Promise<SetupProposal> {
    const raw = readRawSetupSettings();
    const roots = searchRoots(
        [raw.sourceRepo, raw.enterpriseRepo, raw.designThemesRepo],
        workspaceFolderPaths()
    );
    const best = pickBest(detectRepos(roots));

    const pick = (kind: RepoKind, configured: string | undefined) =>
        configured?.trim() || best[kind]?.path;

    const sourceRepo = pick('odoo', raw.sourceRepo);
    return {
        sourceRepo,
        enterpriseRepo: pick('enterprise', raw.enterpriseRepo),
        designThemesRepo: pick('design-themes', raw.designThemesRepo),
        provisioningRoot: raw.provisioningRoot?.trim() || defaultProvisioningRoot(),
        sourceBranch: sourceRepo ? (await getRepoBranch(sourceRepo)) ?? undefined : undefined
    };
}

function describe(proposal: SetupProposal): string {
    const rows = [
        `Source: ${proposal.sourceRepo ?? 'not found'}${proposal.sourceBranch ? ` (${proposal.sourceBranch})` : ''}`,
        proposal.enterpriseRepo ? `Enterprise: ${proposal.enterpriseRepo}` : undefined,
        proposal.designThemesRepo ? `Design themes: ${proposal.designThemesRepo}` : undefined,
        `Environments: ${proposal.provisioningRoot}${fs.existsSync(proposal.provisioningRoot) ? '' : ' (will be created)'} \u2014 worktrees, virtualenvs and per-branch copies of custom repos`
    ];
    return rows.filter(Boolean).join('  •  ');
}

async function browseForFolder(title: string, defaultPath?: string): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        title,
        openLabel: 'Select',
        defaultUri: defaultPath && fs.existsSync(defaultPath) ? vscode.Uri.file(defaultPath) : undefined
    });
    return picked?.[0]?.fsPath;
}

/** The "Change…" path: only reached when detection got something wrong. */
async function editProposal(proposal: SetupProposal): Promise<SetupProposal | undefined> {
    const source = await browseForFolder('Select the Odoo source repository', proposal.sourceRepo);
    if (!source) {
        return undefined;
    }
    if (!fs.existsSync(path.join(source, 'odoo-bin'))) {
        void showError(`${source} does not look like an Odoo repository (no odoo-bin).`);
        return undefined;
    }

    const root = await browseForFolder('Select where environments should be built', proposal.provisioningRoot);
    if (!root) {
        return undefined;
    }

    // Optional repos are looked for beside the source repo rather than asked
    // about: they are almost always siblings, and a wrong guess is harmless.
    const parent = path.dirname(source);
    const sibling = (name: string) => {
        const candidate = path.join(parent, name);
        return fs.existsSync(candidate) ? candidate : undefined;
    };

    return {
        sourceRepo: source,
        enterpriseRepo: proposal.enterpriseRepo ?? sibling('enterprise'),
        designThemesRepo: proposal.designThemesRepo ?? sibling('design-themes'),
        provisioningRoot: root,
        sourceBranch: (await getRepoBranch(source)) ?? undefined
    };
}

async function persist(proposal: SetupProposal): Promise<void> {
    const values: RawSetupSettings = {
        sourceRepo: proposal.sourceRepo,
        enterpriseRepo: proposal.enterpriseRepo ?? '',
        designThemesRepo: proposal.designThemesRepo ?? '',
        provisioningRoot: proposal.provisioningRoot
    };
    await writeSetupSettings(values);
    fs.mkdirSync(proposal.provisioningRoot, { recursive: true });
}

/**
 * Runs setup. Returns true when the machine ends up configured, so callers can
 * chain straight into creating a version.
 */
export async function runSetup(options: { cloneFallback: () => Promise<string | undefined> }): Promise<boolean> {
    let proposal = await buildProposal();

    if (!proposal.sourceRepo) {
        const choice = await showInfo(
            'No Odoo repository found on this machine.',
            'Clone One',
            'Choose Folder…'
        );
        if (choice === 'Clone One') {
            const cloned = await options.cloneFallback();
            if (!cloned) {
                return false;
            }
            proposal = await buildProposal();
        } else if (choice === 'Choose Folder…') {
            const edited = await editProposal(proposal);
            if (!edited) {
                return false;
            }
            proposal = edited;
        } else {
            return false;
        }
    }

    if (!proposal.sourceRepo) {
        return false;
    }

    const confirmed = await vscode.window.showQuickPick(
        [
            { label: '$(check) Use these', detail: describe(proposal), edit: false },
            { label: '$(edit) Change…', detail: 'Pick the source repository and environment directory yourself', edit: true }
        ],
        { title: 'Set up Odoo DevTools', placeHolder: 'Confirm where Odoo lives', ignoreFocusOut: true }
    );
    if (!confirmed) {
        return false;
    }

    if (confirmed.edit) {
        const edited = await editProposal(proposal);
        if (!edited) {
            return false;
        }
        proposal = edited;
    }

    try {
        await persist(proposal);
    } catch (error) {
        logger.error('Failed to save setup:', error);
        void showError(`Could not save the setup: ${errorMessage(error)}`);
        return false;
    }

    return readSetupState().isConfigured;
}
