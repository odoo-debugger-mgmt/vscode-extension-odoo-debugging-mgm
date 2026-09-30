/**
 * The project's repositories resolved for one database - or version - in one
 * call: each version's own checkout (repoLocations.ts), then the branch the
 * database maps and, in "one copy per branch" mode, that branch's copy
 * (repoPaths.ts). Everything that needs "where does this code live for this
 * database" goes through here, so the answer is the same everywhere.
 */
import type { DatabaseModel } from '../models/db';
import type { ProjectModel } from '../models/project';
import type { VersionModel } from '../models/version';
import type { RepoModel } from '../models/repo';
import { VersionsService } from '../versionsService';
import { resolveProjectRepoBranchAssignments } from './environment';
import { projectReposForVersion } from './repoLocations';
import { resolveProjectRepos, type ResolvedRepo } from './repoPaths';
import { readSetupState } from './setupState';

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
    return projectReposForVersion(project.repos, versionOfDatabase(db));
}

export async function resolveReposForDatabase(
    project: Pick<ProjectModel, 'repos'>,
    db: DatabaseModel | undefined,
    options: { version?: VersionModel; root?: string } = {}
): Promise<ResolvedRepo[]> {
    const repos = await projectReposForVersion(project.repos, options.version ?? versionOfDatabase(db));
    return resolveProjectRepos(
        repos,
        db ? resolveProjectRepoBranchAssignments(db, repos) : [],
        options.root ?? readSetupState().provisioningRoot
    );
}
