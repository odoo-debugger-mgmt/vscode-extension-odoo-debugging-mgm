/**
 * The project's repositories resolved for one database - or version - in one
 * call: each version's own checkout (repoLocations.ts), then the branch the
 * database maps and, in "one copy per branch" mode, that branch's copy
 * (repoPaths.ts). Everything that needs "where does this code live for this
 * database" goes through here, so the answer is the same everywhere.
 */
import * as vscode from 'vscode';
import type { DatabaseModel } from '../models/db';
import type { ProjectModel } from '../models/project';
import type { VersionModel } from '../models/version';
import type { RepoModel } from '../models/repo';
import { VersionsService } from '../versionsService';
import { resolveProjectRepoBranchAssignments } from './environment';
import { projectReposForVersion } from './repoLocations';
import { resolveProjectRepos, type ResolvedRepo } from './repoPaths';
import { readSetupState } from './setupState';
import { boundVersionId } from './workspaceBinding';
import { otherWorkspaceRootsFor } from './workspaceRegistry';

/**
 * Where to look first for `version`'s checkouts (see locateRepoCheckouts):
 * this window's folders when it is bound to that version, and the folders of
 * the other workspaces the shared store's registry has bound to it. The
 * second is how a 17.0 window finds the 19.0 side of an upgrade in the 19.0
 * workspace's clone, rather than in a same-remote clone under Custom Addons.
 * The registry is read as last refreshed (refreshRegistry).
 */
export function extraRootsFor(version: { id?: string } | undefined): string[] {
    if (!version?.id) {
        return [];
    }
    const own = version.id === boundVersionId()
        ? (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)
        : [];
    return [...new Set([...own, ...otherWorkspaceRootsFor(version.id)])];
}

/** The database's own version, or the active one when it has none. */
export function versionOfDatabase(db: { versionId?: string } | undefined): VersionModel | undefined {
    const versions = VersionsService.getInstance();
    return (db?.versionId ? versions.getVersion(db.versionId) : undefined) ?? versions.getActiveVersion();
}

/**
 * The project's repositories as the database's version sees them: what a
 * database switch checks out, and where. A 19.0 database checks out in the
 * 19.0 checkout, and never touches the 17.0 one.
 */
export function reposSeenByDatabase(
    project: Pick<ProjectModel, 'repos'>,
    db: { versionId?: string } | undefined
): Promise<RepoModel[]> {
    const version = versionOfDatabase(db);
    return projectReposForVersion(project.repos, version, undefined, extraRootsFor(version));
}

export async function resolveReposForDatabase(
    project: Pick<ProjectModel, 'repos'>,
    db: DatabaseModel | undefined,
    options: { version?: VersionModel; root?: string } = {}
): Promise<ResolvedRepo[]> {
    const version = options.version ?? versionOfDatabase(db);
    const repos = await projectReposForVersion(project.repos, version, undefined, extraRootsFor(version));
    return resolveProjectRepos(
        repos,
        db ? resolveProjectRepoBranchAssignments(db, repos) : [],
        options.root ?? readSetupState().provisioningRoot
    );
}
