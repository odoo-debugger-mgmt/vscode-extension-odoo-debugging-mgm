/**
 * Upgrade configuration model: the two sides of one upgrade - a version, a
 * database and a branch per repository on each - plus the module states
 * stashed on the target database while upgrade mode is on.
 *
 * Turning the mode off keeps all of it, the way testing mode keeps its
 * targets: the pair is remembered and turning the mode back on resumes it.
 *
 * The pair lives here rather than as a second "active version" because
 * launch.json already carries one entry per provisioned version and the
 * running state already models several servers at once. Two servers therefore
 * need no change to which single version is active; they need only to be
 * named, which is what this records.
 */
import { logger } from '../services/logger';
import type { ModuleState } from './module';

/** One side of an upgrade: what a server on that side runs. */
export interface UpgradePairSide {
    /** Version profile. Absent while the version is still being provisioned. */
    versionId?: string;
    /** Database id, which is also its PostgreSQL name. */
    dbId: string;
    /** Odoo series, e.g. "17.0" or "saas-18.4". */
    series: string;
}

/** A project repository's branch on each side of the upgrade. */
export interface UpgradeRepoPair {
    repoName: string;
    repoPath: string;
    fromBranch: string;
    toBranch: string;
}

export type StashedModuleStates = Array<{ name: string; state: ModuleState }>;

export interface UpgradeConfig {
    isEnabled: boolean;
    from?: UpgradePairSide;
    to?: UpgradePairSide;
    repos: UpgradeRepoPair[];
    /**
     * The target database's own module states, stashed while the source's
     * set is staged onto it. Defined exactly when the target is staged, so
     * it doubles as that flag.
     */
    savedTargetModuleStates?: StashedModuleStates;
    /** Modules staged as `install` on the target database. */
    stagedModules: string[];
    /** Source modules with no counterpart in the target version. */
    unavailableModules: string[];
    /** Whether the source's module set is installed on the target at all. */
    installSourceModules: boolean;
    /**
     * The target's module states as they were while staged, kept when the
     * staging is lifted, so per-module changes made during the upgrade come
     * back with it instead of being rebuilt from the source.
     */
    upgradeTargetModuleStates?: StashedModuleStates;
}

export class UpgradeConfigModel implements UpgradeConfig {
    public isEnabled: boolean;
    public from?: UpgradePairSide;
    public to?: UpgradePairSide;
    public repos: UpgradeRepoPair[];
    public savedTargetModuleStates?: StashedModuleStates;
    public stagedModules: string[];
    public unavailableModules: string[];
    public installSourceModules: boolean;
    public upgradeTargetModuleStates?: StashedModuleStates;

    constructor(
        isEnabled: boolean = false,
        from?: UpgradePairSide,
        to?: UpgradePairSide,
        repos: UpgradeRepoPair[] = [],
        savedTargetModuleStates?: StashedModuleStates,
        stagedModules: string[] = [],
        unavailableModules: string[] = [],
        installSourceModules: boolean = true,
        upgradeTargetModuleStates?: StashedModuleStates
    ) {
        this.isEnabled = isEnabled;
        this.from = from;
        this.to = to;
        this.repos = repos;
        this.savedTargetModuleStates = savedTargetModuleStates;
        this.stagedModules = stagedModules;
        this.unavailableModules = unavailableModules;
        this.installSourceModules = installSourceModules;
        this.upgradeTargetModuleStates = upgradeTargetModuleStates;
    }

    /**
     * Whether both sides are named. `isEnabled` alone is not enough to render
     * or launch anything - half a pair is a broken upgrade, not an upgrade.
     */
    isComplete(): boolean {
        return !!this.from && !!this.to;
    }

    /** True when the mode is on and both sides are known. */
    isActive(): boolean {
        return this.isEnabled && this.isComplete();
    }

    /** A complete pair kept while the mode is off, ready to be resumed. */
    isRemembered(): boolean {
        return !this.isEnabled && this.isComplete();
    }

    /** Whether the source's module set is currently staged onto the target. */
    isTargetStaged(): boolean {
        return this.savedTargetModuleStates !== undefined;
    }

    /** Which side of the upgrade a version is, if either. */
    sideForVersion(versionId: string | undefined): 'from' | 'to' | undefined {
        if (!versionId || !this.isActive()) {
            return undefined;
        }
        if (this.from?.versionId === versionId) {
            return 'from';
        }
        return this.to?.versionId === versionId ? 'to' : undefined;
    }

    /** Which side of the upgrade a database is, if either. */
    sideForDb(dbId: string | undefined): 'from' | 'to' | undefined {
        if (!dbId || !this.isActive()) {
            return undefined;
        }
        if (this.from?.dbId === dbId) {
            return 'from';
        }
        return this.to?.dbId === dbId ? 'to' : undefined;
    }

    /** The version ids in the pair, for guards that refuse to break it. */
    pairedVersionIds(): string[] {
        return [this.from?.versionId, this.to?.versionId].filter((id): id is string => !!id);
    }

    /** The database ids in the pair. */
    pairedDbIds(): string[] {
        return [this.from?.dbId, this.to?.dbId].filter((id): id is string => !!id);
    }

    /** Whether a repository's copies are load-bearing for this upgrade. */
    involvesRepo(repoName: string | undefined): boolean {
        if (!repoName || !this.isActive()) {
            return false;
        }
        const wanted = repoName.toLowerCase();
        return this.repos.some(entry => entry.repoName.toLowerCase() === wanted);
    }
}

/** A stored side object, or undefined when it cannot describe a side. */
function normalizeSide(raw: any): UpgradePairSide | undefined {
    const dbId = typeof raw?.dbId === 'string' ? raw.dbId.trim() : '';
    const series = typeof raw?.series === 'string' ? raw.series.trim() : '';
    if (!dbId || !series) {
        return undefined;
    }
    const versionId = typeof raw?.versionId === 'string' && raw.versionId.trim() !== ''
        ? raw.versionId.trim()
        : undefined;
    return { versionId, dbId, series };
}

function normalizeRepos(raw: any): UpgradeRepoPair[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw
        .filter(entry => !!entry
            && typeof entry.repoName === 'string' && entry.repoName.trim() !== ''
            && typeof entry.fromBranch === 'string' && entry.fromBranch.trim() !== ''
            && typeof entry.toBranch === 'string' && entry.toBranch.trim() !== '')
        .map(entry => ({
            repoName: entry.repoName.trim(),
            repoPath: typeof entry.repoPath === 'string' ? entry.repoPath : '',
            fromBranch: entry.fromBranch.trim(),
            toBranch: entry.toBranch.trim()
        }));
}

function normalizeStates(raw: any): StashedModuleStates | undefined {
    return Array.isArray(raw) ? raw : undefined;
}

function normalizeNames(raw: any): string[] {
    return Array.isArray(raw)
        ? raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
        : [];
}

/**
 * Normalizes stored upgrade configuration into an UpgradeConfigModel.
 *
 * Settings round-trip through JSON, so every read site must call this: the
 * stored value is a plain object with no methods, and half-written data from an
 * interrupted setup must read as "no upgrade" rather than crash a tree.
 */
export function ensureUpgradeConfigModel(upgradeConfig: any): UpgradeConfigModel {
    if (!upgradeConfig) {
        return new UpgradeConfigModel();
    }
    if (upgradeConfig instanceof UpgradeConfigModel) {
        return upgradeConfig;
    }

    try {
        const from = normalizeSide(upgradeConfig.from);
        const to = normalizeSide(upgradeConfig.to);
        return new UpgradeConfigModel(
            // A mode that cannot name both sides is off, whatever the flag says.
            Boolean(upgradeConfig.isEnabled) && !!from && !!to,
            from,
            to,
            normalizeRepos(upgradeConfig.repos),
            normalizeStates(upgradeConfig.savedTargetModuleStates),
            normalizeNames(upgradeConfig.stagedModules),
            normalizeNames(upgradeConfig.unavailableModules),
            // Absent on configs written before the toggle existed, all of
            // which installed the set: absence reads as on.
            upgradeConfig.installSourceModules !== false,
            normalizeStates(upgradeConfig.upgradeTargetModuleStates)
        );
    } catch (error) {
        logger.warn('Error converting upgrade config, creating new instance:', error);
        return new UpgradeConfigModel();
    }
}
