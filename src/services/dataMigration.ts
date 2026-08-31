import * as vscode from 'vscode';
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
        const droppedFromSettings = await migrateHookSettings();
        const dropped = [...new Set([...hookResult.droppedCommands, ...droppedFromSettings])];
        if (dropped.length > 0) {
            // Named explicitly: a pre-checkout guard has no post-switch
            // equivalent, so the user has to decide whether it still applies.
            void showWarning(
                `Pre-checkout commands are no longer supported and were removed: ${dropped.map(command => `"${command}"`).join(', ')}. ` +
                'They ran before a branch switch; there is no longer one to run before. ' +
                'Add them to postSwitchCommands only if they still make sense after the switch.'
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
 * Migrates the legacy hook arrays onto `postSwitchCommands`.
 *
 * `postCheckoutCommands` is renamed; `preCheckoutCommands` is **dropped**, not
 * moved. A pre-checkout entry guards a checkout that is about to happen - the
 * canonical one is `git restore .`, clearing the way so the switch can proceed.
 * Running that after the switch does not guard anything; it discards work. The
 * dropped commands are reported so the caller can tell the user what to re-add
 * if they still want it.
 */
export function applyHookMigration(data: DebuggerData): { changed: boolean; droppedCommands: string[] } {
    let changed = false;
    const dropped = new Set<string>();

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

        const post: string[] = Array.isArray(settings.postCheckoutCommands) ? settings.postCheckoutCommands : [];
        const existing: string[] = Array.isArray(settings.postSwitchCommands) ? settings.postSwitchCommands : [];

        if (Array.isArray(settings.preCheckoutCommands)) {
            for (const command of settings.preCheckoutCommands) {
                if (typeof command === 'string' && command.trim()) {
                    dropped.add(command);
                }
            }
        }

        settings.postSwitchCommands = [...post, ...existing];
        delete settings.preCheckoutCommands;
        delete settings.postCheckoutCommands;
        changed = true;
    }

    return { changed, droppedCommands: [...dropped] };
}

/**
 * The settings half of the same migration. `odooDebugger.defaultVersion.`
 * `postCheckoutCommands` becomes `postSwitchCommands` in whichever scope
 * defines it, and `preCheckoutCommands` is removed - following the write-back
 * pattern used by migrateLegacySwitchBehaviorSetting.
 */
export async function migrateHookSettings(): Promise<string[]> {
    const dropped = new Set<string>();
    try {
        const config = vscode.workspace.getConfiguration('odooDebugger.defaultVersion');

        const scopes = (inspection: ReturnType<typeof config.inspect<string[]>>) => ([
            [inspection?.globalValue, vscode.ConfigurationTarget.Global],
            [inspection?.workspaceValue, vscode.ConfigurationTarget.Workspace],
            [inspection?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder]
        ] as Array<[string[] | undefined, vscode.ConfigurationTarget]>);

        const post = config.inspect<string[]>('postCheckoutCommands');
        for (const [value, target] of scopes(post)) {
            if (!Array.isArray(value)) {
                continue;
            }
            const existing = config.inspect<string[]>('postSwitchCommands');
            const alreadySet = [existing?.globalValue, existing?.workspaceValue, existing?.workspaceFolderValue]
                .some(entry => Array.isArray(entry) && entry.length > 0);
            if (!alreadySet && value.length > 0) {
                await config.update('postSwitchCommands', value, target);
            }
            await config.update('postCheckoutCommands', undefined, target);
        }

        const pre = config.inspect<string[]>('preCheckoutCommands');
        for (const [value, target] of scopes(pre)) {
            if (!Array.isArray(value)) {
                continue;
            }
            value.filter(command => typeof command === 'string' && command.trim()).forEach(command => dropped.add(command));
            await config.update('preCheckoutCommands', undefined, target);
        }
    } catch (error) {
        logger.warn('Failed to migrate checkout hook settings:', error);
    }
    return [...dropped];
}
