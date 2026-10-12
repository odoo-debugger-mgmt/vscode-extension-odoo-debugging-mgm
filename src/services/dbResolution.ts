/**
 * Which database a version launches against. Selection used to be one flag
 * per project, so two versions running at once shared a single `-d`; each
 * version now remembers its own, falling back to the project selection.
 */

export interface VersionScopedDb {
    id: string;
    isSelected?: boolean;
    versionId?: string;
}

/**
 * Resolution order: the database remembered for this version, then the
 * selected database when it belongs to this version, then the selected
 * database only when it belongs to no version at all (one from before
 * databases had versions). A database of another version is never used:
 * running 19.0 code against a 17.0 database is not a better default than
 * asking for one.
 */
export function resolveDbForVersion<T extends VersionScopedDb>(
    dbs: T[],
    selectedDbByVersion: Record<string, string> | undefined,
    versionId: string | undefined
): T | undefined {
    const selected = dbs.find(db => db.isSelected);

    if (versionId) {
        const rememberedId = selectedDbByVersion?.[versionId];
        // A remembered database moved to another version since is no longer this one's.
        const remembered = rememberedId
            ? dbs.find(db => db.id === rememberedId && (!db.versionId || db.versionId === versionId))
            : undefined;
        if (remembered) {
            return remembered;
        }
        if (selected?.versionId === versionId) {
            return selected;
        }
        return selected && !selected.versionId ? selected : undefined;
    }

    return selected;
}

/**
 * What the status bar shows for the active version: the database it
 * launches, or that it has none of its own while the project has databases.
 * Nothing when the project has no databases at all.
 */
export function statusBarDatabase<T extends VersionScopedDb>(
    project: { dbs?: T[]; selectedDbByVersion?: Record<string, string> } | undefined,
    versionId: string | undefined
): { db: T } | { missingFor: string } | undefined {
    const db = project ? resolveDbForVersion(project.dbs ?? [], project.selectedDbByVersion, versionId) : undefined;
    if (db) {
        return { db };
    }
    return versionId && (project?.dbs?.length ?? 0) > 0 ? { missingFor: versionId } : undefined;
}

/** Records `dbId` against `versionId`, leaving other versions' memory intact. */
export function rememberDbForVersion(
    existing: Record<string, string> | undefined,
    versionId: string | undefined,
    dbId: string
): Record<string, string> {
    const base = { ...(existing ?? {}) };
    if (!versionId) {
        return base;
    }
    base[versionId] = dbId;
    return base;
}

interface ProjectLike {
    uid?: string;
    name?: string;
    dbs?: VersionScopedDb[];
    selectedDbByVersion?: Record<string, string>;
}

function projectKey(project: ProjectLike): string | undefined {
    return project.uid || project.name;
}

/**
 * Records, in place, the database the selection is leaving under that
 * database's own version, when that version remembers nothing yet.
 *
 * A version launches only its own databases: the selection counts for its
 * version, and the memory for the others. A database that was selected but
 * never picked - every selection made before 1.3 - is in no memory, so moving
 * the selection to another version's database left the first version with
 * none. An existing memory is never overwritten.
 *
 * `previous` is the data as it was last read or saved.
 */
export function keepLeftDatabase<T extends { projects?: ProjectLike[] }>(
    data: T,
    previous: { projects?: ProjectLike[] } | undefined
): T {
    if (!previous || !Array.isArray(previous.projects) || !Array.isArray(data.projects)) {
        return data;
    }
    const leftByProject = new Map<string, string>();
    for (const project of previous.projects) {
        const key = projectKey(project);
        const selectedId = project.dbs?.find(db => db?.isSelected)?.id;
        if (key && selectedId) {
            leftByProject.set(key, selectedId);
        }
    }
    for (const project of data.projects) {
        const key = projectKey(project);
        const leftId = key ? leftByProject.get(key) : undefined;
        const dbs = project.dbs ?? [];
        const nowId = dbs.find(db => db?.isSelected)?.id;
        const left = leftId && leftId !== nowId ? dbs.find(db => db?.id === leftId) : undefined;
        if (!left?.versionId || project.selectedDbByVersion?.[left.versionId]) {
            continue;
        }
        project.selectedDbByVersion = { ...(project.selectedDbByVersion ?? {}), [left.versionId]: left.id };
    }
    return data;
}
