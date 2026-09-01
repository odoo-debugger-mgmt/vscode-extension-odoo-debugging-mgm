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
 * database regardless - which is the behaviour that existed before.
 */
export function resolveDbForVersion<T extends VersionScopedDb>(
    dbs: T[],
    selectedDbByVersion: Record<string, string> | undefined,
    versionId: string | undefined
): T | undefined {
    const selected = dbs.find(db => db.isSelected);

    if (versionId) {
        const rememberedId = selectedDbByVersion?.[versionId];
        const remembered = rememberedId ? dbs.find(db => db.id === rememberedId) : undefined;
        if (remembered) {
            return remembered;
        }
        if (selected?.versionId === versionId) {
            return selected;
        }
    }

    return selected;
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
