import { SettingsStore } from '../settingsStore';
import type { DebuggerData } from '../utils';

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
                const match = versions.find(version => version?.odooVersion === legacyBranch);
                if (match?.id) {
                    db.versionId = match.id;
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
 * Runs at activation after the legacy-settings migration.
 */
export async function migrateDebuggerData(): Promise<void> {
    try {
        const data = await SettingsStore.get('odoo-debugger-data.json');
        if (applyDatabaseFieldMigration(data)) {
            // Save as-is (no settings strip): if the legacy-settings migration
            // has not run yet, its data must survive this write.
            await SettingsStore.saveWithoutComments(data);
        }
    } catch (error) {
        console.warn('Debugger data migration skipped:', error);
    }
}
