/**
 * Which Odoo databases are live right now, from two merged signals: the
 * extension's own debug sessions (authoritative for what it started) and a
 * pg_stat_activity probe (catches servers started from a terminal or another
 * window). Exists as a service, not tree-decoration logic, so later features -
 * split-view comparison of two running instances - share one state source.
 */
import { SettingsStore } from '../settingsStore';
import { VersionsService } from '../versionsService';
import { getActiveDatabaseNames } from './database';
import { runningDebuggerNames } from './debugSessions';
import { resolveDbForVersion } from './dbResolution';
import { invalidateActiveDatabasesCache } from './runtimeCache';
import { logger } from './logger';

export interface RunningInstance {
    versionId?: string;
    debuggerName?: string;
    dbName: string;
    port?: number;
    origin: 'managed' | 'external';
}

/**
 * One entry per database. A managed instance always wins: it knows the
 * version and port, which the external probe cannot report.
 */
export function mergeRunningInstances(managed: RunningInstance[], external: RunningInstance[]): RunningInstance[] {
    const byDb = new Map<string, RunningInstance>();

    for (const instance of external) {
        byDb.set(instance.dbName, instance);
    }
    for (const instance of managed) {
        byDb.set(instance.dbName, instance);
    }

    return Array.from(byDb.values());
}

/** Sessions this extension started, resolved to the database each runs. */
async function collectManaged(): Promise<RunningInstance[]> {
    const names = new Set(runningDebuggerNames());
    if (names.size === 0) {
        return [];
    }

    // Read without getSelectedProject(): this runs on every tree refresh and
    // that helper toasts when no project is selected.
    const data = await SettingsStore.get('odoo-debugger-data.json').catch(() => undefined);
    const project = data?.projects?.find(entry => entry.isSelected);
    const dbs = project?.dbs ?? [];
    const selectedDbByVersion = project?.selectedDbByVersion;

    const instances: RunningInstance[] = [];
    for (const version of VersionsService.getInstance().getVersions()) {
        const debuggerName = version.settings?.debuggerName;
        if (!debuggerName || !names.has(debuggerName)) {
            continue;
        }
        const db = resolveDbForVersion(dbs, selectedDbByVersion, version.id);
        if (!db) {
            continue;
        }
        instances.push({
            versionId: version.id,
            debuggerName,
            dbName: db.id,
            port: Number(version.settings.portNumber) || undefined,
            origin: 'managed'
        });
    }

    return instances;
}

export async function getRunningInstances(): Promise<RunningInstance[]> {
    try {
        const [managed, activeNames] = await Promise.all([collectManaged(), getActiveDatabaseNames()]);
        const external: RunningInstance[] = activeNames.map(dbName => ({ dbName, origin: 'external' }));
        return mergeRunningInstances(managed, external);
    } catch (error) {
        logger.debug('Could not resolve running instances:', error);
        return [];
    }
}

/**
 * The running marker for a database row, as plain text. TreeItem.description
 * does not render codicons - unlike a QuickPickItem - so state is carried by
 * words here, leaving the row's icon free to keep showing selection.
 */
export function runningDescriptionPart(instance: RunningInstance | undefined): string | undefined {
    if (!instance) {
        return undefined;
    }
    if (instance.origin === 'external') {
        return 'running (external)';
    }
    return instance.port ? `running :${instance.port}` : 'running';
}

/** Drops the cached PostgreSQL probe so the next read is fresh. */
export function invalidateRunningState(): void {
    invalidateActiveDatabasesCache();
}
