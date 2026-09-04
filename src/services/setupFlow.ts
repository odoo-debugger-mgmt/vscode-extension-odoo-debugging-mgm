/**
 * The setup flow: detect what is already on the machine, propose it in one
 * confirmation, write the result, and hand off to provisioning. Replaces a
 * five-question wizard that asked everything up front and - the bug this
 * exists to fix - never recorded where it put anything.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { showError, showInfo, showModalWarning } from './notifications';
import { errorMessage, logger } from './logger';
import { getRepoBranch } from './branches';
import { rememberCustomAddonsFolder } from '../commands/customAddonsCommand';
import {
    countCustomRepos,
    detectCustomAddonsRoot,
    detectRepos,
    pickBest,
    readAddonsChildren,
    searchRoots,
    RepoKind
} from './setupDetection';
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
    /** Where the user's own repositories live. Optional: not everyone has any. */
    customAddonsPath?: string;
    customAddonsCount?: number;
}

/** The per-version key that every repository-discovery site already reads. */
const CUSTOM_ADDONS_KEY = 'defaultVersion.customAddonsPath';

function readConfiguredCustomAddons(): string | undefined {
    const configured = vscode.workspace
        .getConfiguration('odooDebugger')
        .get<string>(CUSTOM_ADDONS_KEY, '')
        .trim();
    // A configured value only counts when it is there; the shipped default is
    // a workspace-relative path that usually is not.
    return configured && fs.existsSync(configured) ? configured : undefined;
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
    const customAddonsPath = readConfiguredCustomAddons() ?? detectCustomAddonsRoot(roots);

    return {
        sourceRepo,
        enterpriseRepo: pick('enterprise', raw.enterpriseRepo),
        designThemesRepo: pick('design-themes', raw.designThemesRepo),
        provisioningRoot: raw.provisioningRoot?.trim() || defaultProvisioningRoot(),
        sourceBranch: sourceRepo ? (await getRepoBranch(sourceRepo)) ?? undefined : undefined,
        customAddonsPath,
        customAddonsCount: customAddonsPath
            ? countCustomRepos(readAddonsChildren(customAddonsPath))
            : undefined
    };
}

/**
 * One line per fact, for a modal.
 *
 * This used to be joined with bullets into a quick pick's `detail`, which VS
 * Code renders as a single truncated line: everything after "Source:" was off
 * the end of the dialog. That mattered because detection reaches outside the
 * workspace - it can propose enterprise, design-themes and an addons folder
 * from anywhere on the machine, and all five values are written at user scope
 * on one keystroke. A confirmation the user cannot read is not a confirmation.
 */
export function describe(proposal: SetupProposal): string {
    const rows = [
        `Source repository   ${proposal.sourceRepo ?? 'not found'}${proposal.sourceBranch ? `  (on ${proposal.sourceBranch})` : ''}`,
        proposal.enterpriseRepo ? `Enterprise          ${proposal.enterpriseRepo}` : undefined,
        proposal.designThemesRepo ? `Design themes       ${proposal.designThemesRepo}` : undefined,
        proposal.customAddonsPath
            ? `Custom addons       ${proposal.customAddonsPath}  (${proposal.customAddonsCount ?? 0} repositories)`
            : 'Custom addons       not found - you can choose it later',
        `Environments        ${proposal.provisioningRoot}${fs.existsSync(proposal.provisioningRoot) ? '' : '  (will be created)'}`
    ];
    return rows.filter(Boolean).join('\n');
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

    // Optional: someone doing pure Odoo work has no custom addons, and the
    // repository picker in project creation recovers when this is unset.
    const addons = await browseForFolder(
        'Select the folder holding your addon repositories (Esc to skip)',
        proposal.customAddonsPath ?? path.dirname(source)
    );
    const customAddonsPath = addons ?? proposal.customAddonsPath;

    return {
        sourceRepo: source,
        enterpriseRepo: proposal.enterpriseRepo ?? sibling('enterprise'),
        designThemesRepo: proposal.designThemesRepo ?? sibling('design-themes'),
        provisioningRoot: root,
        sourceBranch: (await getRepoBranch(source)) ?? undefined,
        customAddonsPath,
        customAddonsCount: customAddonsPath
            ? countCustomRepos(readAddonsChildren(customAddonsPath))
            : undefined
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

    // Written at user scope like the rest of the setup, *and* onto the active
    // version. The user-level value is only a default for versions created
    // afterwards, but repository discovery reads the active version's own copy
    // - so writing one alone left setup reporting success while Create Project
    // searched the shipped `./custom-addons`, which has never existed.
    if (proposal.customAddonsPath) {
        await rememberCustomAddonsFolder(proposal.customAddonsPath);
    }

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

    // A modal, so every proposed path is legible before it is written at user
    // scope. Detection reaches outside the workspace, so these values can name
    // repositories that belong to entirely different work.
    const answer = await showModalWarning(
        `Set up Odoo DevTools with these?\n\n${describe(proposal)}\n\n`
        + 'These are saved for every workspace on this machine.',
        'Use These',
        'Change...'
    );
    if (!answer) {
        return false;
    }
    const confirmed = { edit: answer === 'Change...' };

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
