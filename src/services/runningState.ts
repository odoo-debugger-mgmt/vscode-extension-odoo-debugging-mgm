/**
 * Which Odoo databases are live right now, from two merged signals: the
 * extension's own debug sessions (authoritative for what it started, each
 * read for the database and port it was launched with) and a
 * pg_stat_activity probe (catches servers started from a terminal or another
 * window). Exists as a service, not tree-decoration logic, so later features -
 * split-view comparison of two running instances - share one state source.
 */
import { getActiveDatabaseNames } from './database';
import { runRecords } from './debugSessions';
import type { RunRecord } from './runRecords';
import { invalidateActiveDatabasesCache } from './runtimeCache';
import { logger } from './logger';

export interface RunningInstance {
    versionId?: string;
    debuggerName?: string;
    dbName: string;
    port?: number;
    origin: 'managed' | 'external';
    kind?: 'primary' | 'alongside';
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

/** One instance per recorded run that names its database. */
export function instancesFromRuns(records: RunRecord[]): RunningInstance[] {
    return records
        .filter(record => !!record.dbId)
        .map(record => ({
            versionId: record.versionId,
            debuggerName: record.name,
            dbName: record.dbId as string,
            port: record.port,
            origin: 'managed' as const,
            kind: record.kind
        }));
}

/** Sessions this extension started, as the databases they run. */
async function collectManaged(): Promise<RunningInstance[]> {
    return instancesFromRuns(runRecords());
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

/**
 * Running instances keyed by version. When a version has both a primary and an
 * alongside run, the primary one is kept: the version row describes it.
 */
export function runningByVersion(instances: RunningInstance[]): Map<string, RunningInstance> {
    const map = new Map<string, RunningInstance>();
    for (const instance of instances) {
        if (!instance.versionId) {
            continue;
        }
        const kept = map.get(instance.versionId);
        if (!kept || (kept.kind === 'alongside' && instance.kind !== 'alongside')) {
            map.set(instance.versionId, instance);
        }
    }
    return map;
}
