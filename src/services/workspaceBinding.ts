/**
 * Binding a workspace to a version (design §6).
 *
 * Someone with one workspace per Odoo version opens the 19.0 workspace and
 * expects it to run 19.0, with the code that workspace holds. The binding is
 * this window's choice, like its selection, so it lives in `workspaceState` -
 * under its own key, because the selection overlay is rewritten from the
 * data on every save. The decisions are pure; the accessors at the bottom
 * touch vscode.
 */
import type * as vscode from 'vscode';
import { branchToSeries } from './versionProposal';

export interface WorkspaceBinding {
    /** The version this workspace runs, when one was chosen. */
    versionId?: string;
    /** Asked once: a choice, or Not Now, is not asked again. */
    asked: boolean;
}

export const BINDING_STATE_KEY = 'odt.workspaceBinding';

const NOT_BOUND: WorkspaceBinding = { asked: false };

export function normalizeBinding(raw: unknown): WorkspaceBinding {
    if (!raw || typeof raw !== 'object') {
        return { versionId: undefined, asked: NOT_BOUND.asked };
    }
    const value = raw as Record<string, unknown>;
    return {
        versionId: typeof value.versionId === 'string' && value.versionId ? value.versionId : undefined,
        asked: value.asked === true
    };
}

/**
 * Whether to ask this window which version it runs: only on a shared store,
 * where workspaces per version are the point - a workspace on its own file
 * notices nothing - only when there is more than one version to choose
 * from, and only once.
 */
export function shouldOfferBinding(storeKind: string | undefined, versionCount: number, binding: WorkspaceBinding): boolean {
    return storeKind === 'sqlite' && versionCount > 1 && !binding.asked;
}

/** A folder of this workspace, as the proposal sees it. */
export interface WorkspaceFolderFacts {
    path: string;
    /** The folder's name. */
    name: string;
    /** Its checked-out branch, when it is a git checkout. */
    branch?: string;
    /** Its `origin`, normalised (see normalizeRemote). */
    remote?: string;
}

interface ProjectFacts {
    repos?: Array<{ name: string; path: string }>;
    dbs?: Array<{ id: string; name?: string; versionId?: string; projectRepoBranches?: Array<{ repoName?: string; branch?: string }> }>;
}

interface VersionFacts {
    id: string;
    name: string;
    odooVersion: string;
}

export interface BindingProposal {
    versionId: string;
    reason: 'data' | 'branch';
    /** Why, in words: "acme here is on main, which acme-db19 runs". */
    because: string;
}

/**
 * Which version this workspace most likely runs, from what it holds.
 *
 * Through the data first: a folder that is a checkout of a project repository
 * (same remote, else same name) on branch B, and a database mapping that
 * repository to B, give that database's version. That works for `main`,
 * `staging` and `dev`, whose names say nothing. Then through a branch named
 * after a series, when exactly one version has that series. Anything
 * ambiguous proposes nothing, and the user is asked.
 */
export function proposeWorkspaceVersion(
    folders: WorkspaceFolderFacts[],
    projects: ProjectFacts[],
    versions: VersionFacts[],
    remoteOfRepo: (repo: { name: string; path: string }) => string | undefined = () => undefined
): BindingProposal | undefined {
    const known = new Set(versions.map(version => version.id));
    const throughData = new Map<string, string>();

    for (const folder of folders) {
        if (!folder.branch) {
            continue;
        }
        for (const project of projects) {
            const repo = (project.repos ?? []).find(candidate => {
                const remote = remoteOfRepo(candidate);
                return (folder.remote && remote && folder.remote === remote)
                    || candidate.name.toLowerCase() === folder.name.toLowerCase();
            });
            if (!repo) {
                continue;
            }
            for (const db of project.dbs ?? []) {
                const maps = (db.projectRepoBranches ?? []).some(entry =>
                    entry.repoName?.toLowerCase() === repo.name.toLowerCase() && entry.branch === folder.branch);
                if (maps && db.versionId && known.has(db.versionId) && !throughData.has(db.versionId)) {
                    throughData.set(db.versionId, `${folder.name} here is on ${folder.branch}, which ${db.name || db.id} runs`);
                }
            }
        }
    }
    if (throughData.size === 1) {
        const [[versionId, because]] = [...throughData];
        return { versionId, reason: 'data', because };
    }
    if (throughData.size > 1) {
        return undefined;
    }

    const bySeries = new Map<string, WorkspaceFolderFacts>();
    for (const folder of folders) {
        const series = folder.branch ? branchToSeries(folder.branch) : undefined;
        const matching = series ? versions.filter(version => version.odooVersion === series) : [];
        if (matching.length === 1) {
            bySeries.set(matching[0].id, folder);
        }
    }
    if (bySeries.size === 1) {
        const [[versionId, folder]] = [...bySeries];
        return { versionId, reason: 'branch', because: `${folder.name} here is on ${folder.branch}` };
    }
    return undefined;
}

/**
 * Whether selecting a database of `dbVersionId` takes this window off the
 * version it is bound to. Not during an upgrade - selecting a side there
 * chooses whose modules to edit, and switches nothing - and not for a
 * database linked to no version.
 */
export function leavesBoundVersion(bound: string | undefined, dbVersionId: string | undefined, upgradeActive: boolean): boolean {
    return !!bound && !!dbVersionId && dbVersionId !== bound && !upgradeActive;
}

// ---------------------------------------------------------------------------
// vscode-backed accessors
// ---------------------------------------------------------------------------

let memento: vscode.Memento | undefined;

/** Called once on activation with the window's workspaceState. */
export function initializeBinding(workspaceState: vscode.Memento | undefined): void {
    memento = workspaceState;
}

export function readBinding(): WorkspaceBinding {
    return normalizeBinding(memento?.get(BINDING_STATE_KEY));
}

export async function writeBinding(binding: WorkspaceBinding): Promise<void> {
    await memento?.update(BINDING_STATE_KEY, binding);
}

/** The version this window is bound to, if any. */
export function boundVersionId(): string | undefined {
    return readBinding().versionId;
}
