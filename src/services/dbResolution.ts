/**
 * Which database a version launches against. Selection used to be one flag
 * per project, so two versions running at once shared a single `-d`; each
 * version now remembers its own, falling back to the project selection.
 *
 * What a version remembers is this window's (see workspaceSelection.ts): with
 * a shared store, one window's choice must never decide what another
 * launches. The active upgrade is the exception, and wins over both, because
 * its pair is shared on purpose - either window can start both sides.
 */
import { ensureUpgradeConfigModel } from '../models/upgrade';

export interface VersionScopedDb {
    id: string;
    isSelected?: boolean;
    versionId?: string;
}

/**
 * Resolution order: the database the active upgrade pins to this version,
 * then the database remembered for this version, then the selected database
 * when it belongs to this version, then the selected database regardless -
 * which is the behaviour that existed before.
 */
export function resolveDbForVersion<T extends VersionScopedDb>(
    dbs: T[],
    selectedDbByVersion: Record<string, string> | undefined,
    versionId: string | undefined,
    pinned?: Record<string, string>
): T | undefined {
    const selected = dbs.find(db => db.isSelected);

    if (versionId) {
        const pinnedId = pinned?.[versionId];
        const pinnedDb = pinnedId ? dbs.find(db => db.id === pinnedId) : undefined;
        if (pinnedDb) {
            return pinnedDb;
        }
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

/** The active upgrade's version -> database, or nothing when no upgrade is on. */
export function upgradePins(upgradeConfig: unknown): Record<string, string> {
    const config = ensureUpgradeConfigModel(upgradeConfig);
    const pins: Record<string, string> = {};
    if (!config.isActive()) {
        return pins;
    }
    for (const side of [config.from, config.to]) {
        if (side?.versionId) {
            pins[side.versionId] = side.dbId;
        }
    }
    return pins;
}

/** The database `versionId` launches against in this window, for a project as SettingsStore returns it. */
export function dbForVersion<T extends VersionScopedDb>(
    project: { dbs?: T[]; selectedDbByVersion?: Record<string, string>; upgradeConfig?: unknown } | undefined,
    versionId: string | undefined
): T | undefined {
    return resolveDbForVersion(
        project?.dbs ?? [],
        project?.selectedDbByVersion,
        versionId,
        upgradePins(project?.upgradeConfig)
    );
}
