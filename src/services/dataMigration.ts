import { SettingsStore } from '../settingsStore';
import { VersionsService } from '../versionsService';
import { VersionModel } from '../models/version';
import { getDefaultVersionSettings } from '../utils';
import type { DebuggerData } from '../utils';
import { logger } from './logger';
import { showWarning } from './notifications';

/** Branch names that denote a real Odoo series, e.g. "17.0", "saas-17.4", "master". */
const ODOO_SERIES_PATTERN = /^((saas-)?\d+(\.\d+)?|master)$/i;

function findMatchingVersionId(versions: Array<{ id?: string; odooVersion?: string }>, branch: string): string | undefined {
    return versions.find(version => version?.odooVersion === branch)?.id;
}

/**
 * Finds legacy per-database branches that still drive branch switching but
 * have no version profile to carry them. These need a profile created so the
 * database keeps switching branches after the migration removes the legacy
 * field. Pure function for unit testing.
 */
export function collectLegacyBranchesNeedingVersions(data: Partial<DebuggerData>): string[] {
    const versions = Object.values(data.versions ?? {}) as Array<{ id?: string; odooVersion?: string }>;
    const branches = new Set<string>();

    for (const project of data.projects ?? []) {
        for (const db of (project as any).dbs ?? []) {
            if (!db || typeof db !== 'object' || db.versionId) {
                continue;
            }
            const legacyBranch = typeof db.odooVersion === 'string' ? db.odooVersion.trim() : '';
            if (legacyBranch && ODOO_SERIES_PATTERN.test(legacyBranch) && !findMatchingVersionId(versions, legacyBranch)) {
                branches.add(legacyBranch);
            }
        }
    }

    return Array.from(branches);
}

/**
 * Folds the legacy per-database `odooVersion` field into the current model:
 * link the database to the Version whose branch matches, otherwise keep the
 * string as the display label. Returns true when anything changed.
 *
 * Pure transform so it can be unit-tested without VS Code.
 */
export function applyDatabaseFieldMigration(data: Partial<DebuggerData>): boolean {
    let changed = false;
    const versions = Object.values(data.versions ?? {}) as Array<{ id?: string; odooVersion?: string }>;

    for (const project of data.projects ?? []) {
        for (const db of (project as any).dbs ?? []) {
            if (!db || typeof db !== 'object' || !('odooVersion' in db)) {
                continue;
            }

            const legacyBranch = typeof db.odooVersion === 'string' ? db.odooVersion.trim() : '';
            if (legacyBranch && !db.versionId) {
                const matchId = findMatchingVersionId(versions, legacyBranch);
                if (matchId) {
                    db.versionId = matchId;
                } else if (!db.branchName) {
                    db.branchName = legacyBranch;
                }
            }

            delete db.odooVersion;
            changed = true;
        }
    }

    return changed;
}

/**
 * One-time, non-fatal migration of odoo-debugger-data.json to the v1.2 shape.
 * Runs at activation after the legacy-settings migration and after the tree
 * providers are constructed (so the versions-changed refresh command exists).
 */
export async function migrateDebuggerData(): Promise<void> {
    try {
        const data = await SettingsStore.get('odoo-debugger-data.json');

        // Legacy branches with no profile keep driving branch switching only
        // through a version, so create the missing profiles first.
        const missingBranches = collectLegacyBranchesNeedingVersions(data);
        if (missingBranches.length > 0) {
            data.versions = data.versions ?? {};
            for (const branch of missingBranches) {
                const version = new VersionModel(`Odoo ${branch}`, branch, getDefaultVersionSettings());
                data.versions[version.id] = version.toJSON();
            }
        }

        const changed = applyDatabaseFieldMigration(data);
        const hookResult = applyHookMigration(data);
        if (hookResult.prependedVersionNames.length > 0) {
            void showWarning(
                `Pre-checkout commands were merged into postSwitchCommands for: ${hookResult.prependedVersionNames.join(', ')}. ` +
                'They now run after the branch switch rather than before.'
            );
        }
        if (changed || hookResult.changed || missingBranches.length > 0) {
            // Save as-is (no settings strip): if the legacy-settings migration
            // has not run yet, its data must survive this write.
            await SettingsStore.saveWithoutComments(data);
        }

        if (missingBranches.length > 0) {
            // Reload the in-memory versions so the new profiles are usable now.
            await VersionsService.getInstance().refresh();
        }
    } catch (error) {
        logger.warn('Debugger data migration skipped:', error);
    }
}

/**
 * Migrates the two legacy hook arrays onto `postSwitchCommands`. Pre-checkout
 * commands are prepended rather than dropped, but they now run *after* the
 * switch - the caller surfaces that, because a `git stash` guard changes
 * meaning.
 */
export function applyHookMigration(data: DebuggerData): { changed: boolean; prependedVersionNames: string[] } {
    let changed = false;
    const prependedVersionNames: string[] = [];

    for (const version of Object.values(data.versions ?? {})) {
        const settings = version?.settings;
        if (!settings || typeof settings !== 'object') {
            continue;
        }

        const hasPre = 'preCheckoutCommands' in settings;
        const hasPost = 'postCheckoutCommands' in settings;
        if (!hasPre && !hasPost) {
            continue;
        }

        const pre: string[] = Array.isArray(settings.preCheckoutCommands) ? settings.preCheckoutCommands : [];
        const post: string[] = Array.isArray(settings.postCheckoutCommands) ? settings.postCheckoutCommands : [];
        const existing: string[] = Array.isArray(settings.postSwitchCommands) ? settings.postSwitchCommands : [];

        settings.postSwitchCommands = [...pre, ...post, ...existing];
        delete settings.preCheckoutCommands;
        delete settings.postCheckoutCommands;
        changed = true;

        if (pre.length > 0) {
            prependedVersionNames.push(version.name ?? version.id ?? 'unnamed version');
        }
    }

    return { changed, prependedVersionNames };
}
