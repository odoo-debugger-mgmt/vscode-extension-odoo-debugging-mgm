/**
 * Which two databases a view is compared or rendered across: in Upgrade
 * mode the original (From) and the upgraded (To) database, otherwise the
 * tree's database and one the user picks.
 */
import { ensureUpgradeConfigModel } from '../models/upgrade';

/** The project as SettingsStore returns it: plain JSON, not hydrated models. */
export interface PairProject {
    dbs?: Array<{ id: string; versionId?: string; isSelected?: boolean }>;
    upgradeConfig?: unknown;
}

export interface PairSide {
    dbName: string;
    versionId?: string;
    series?: string;
}

export interface UpgradePair {
    original: PairSide;
    upgraded: PairSide;
}

export function upgradePair(project: PairProject | undefined): UpgradePair | undefined {
    if (!project) {
        return undefined;
    }
    const config = ensureUpgradeConfigModel(project.upgradeConfig);
    if (!config.isActive() || !config.from?.dbId || !config.to?.dbId) {
        return undefined;
    }
    return {
        original: { dbName: config.from.dbId, versionId: config.from.versionId, series: config.from.series },
        upgraded: { dbName: config.to.dbId, versionId: config.to.versionId, series: config.to.series }
    };
}

/** The upgrade's original database stays as it was, unless odooDebugger.views.allowEditOriginal is on. */
export function isReadOnlyOriginal(project: PairProject | undefined, dbName: string, allowEditOriginal: boolean): boolean {
    return !allowEditOriginal && upgradePair(project)?.original.dbName === dbName;
}
