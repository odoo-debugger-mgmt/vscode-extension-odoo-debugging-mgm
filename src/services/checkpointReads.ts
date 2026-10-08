/**
 * Reading a checkpoint. A checkpoint refuses connections so that it cannot
 * change (checkpoints spec §3.1); a comparison still has to read it. Each read
 * opens it, and the last of any reads running at once closes it again, in a
 * finally.
 */
import { quotePgIdentifier, runSql } from './postgres';
import { SettingsStore } from '../settingsStore';
import { checkpointsOf } from './checkpoints';
import { sqlText } from './views/viewQueries';
import { logger } from './logger';

export interface CheckpointOpener {
    open(db: string): Promise<void>;
    close(db: string): Promise<void>;
}

export const realCheckpointOpener: CheckpointOpener = {
    open: async db => { await runSql('postgres', `ALTER DATABASE ${quotePgIdentifier(db)} WITH ALLOW_CONNECTIONS true;`); },
    close: async db => { await runSql('postgres', `ALTER DATABASE ${quotePgIdentifier(db)} WITH ALLOW_CONNECTIONS false;`); }
};

const openings = new Map<string, { count: number; ready: Promise<void> }>();
/** Closes in flight per database; a new opening waits for them so the ALTERs cannot land out of order. */
const closing = new Map<string, Promise<void>>();

/** Closes through the per-database chain. Never rejects. */
async function closeChained(db: string, opener: CheckpointOpener): Promise<void> {
    const done = (closing.get(db) ?? Promise.resolve())
        .then(() => opener.close(db))
        .catch(error => logger.warn(`Could not close checkpoint ${db} again:`, error));
    closing.set(db, done);
    await done;
    if (closing.get(db) === done) {
        closing.delete(db);
    }
}

export async function withCheckpointOpen<T>(db: string, read: () => Promise<T>, opener: CheckpointOpener = realCheckpointOpener): Promise<T> {
    let entry = openings.get(db);
    if (!entry) {
        const ready = (closing.get(db) ?? Promise.resolve()).then(() => opener.open(db));
        entry = { count: 0, ready };
        openings.set(db, entry);
        const created = entry;
        ready.catch(() => {
            if (openings.get(db) === created) {
                openings.delete(db);
            }
        });
    }
    entry.count++;
    try {
        await entry.ready;
    } catch (error) {
        entry.count--;
        throw error;
    }
    try {
        return await read();
    } finally {
        entry.count--;
        if (entry.count === 0 && openings.get(db) === entry) {
            openings.delete(db);
            await closeChained(db, opener);
        }
    }
}

export interface SweepDeps {
    recorded(): Promise<string[]>;
    openNow(names: string[]): Promise<string[]>;
    connected(name: string): Promise<boolean>;
    opener: CheckpointOpener;
}

/** The sweep's core: closes recorded checkpoints left open that nobody is reading. */
export async function closeOpenCheckpointsWith(deps: SweepDeps): Promise<string[]> {
    const names = await deps.recorded();
    if (names.length === 0) {
        return [];
    }
    const closed: string[] = [];
    for (const name of await deps.openNow(names)) {
        if (openings.has(name)) {
            continue;
        }
        const connected = await deps.connected(name).catch(() => true);
        // Re-check synchronously: a read may have started during the round trip,
        // before its own connection showed up. Nothing yields between here and
        // closeChained registering the close.
        if (connected || openings.has(name)) {
            continue;
        }
        await closeChained(name, deps.opener);
        closed.push(name);
    }
    return closed;
}

/** Closes every recorded checkpoint left open, e.g. by a host that died mid-read. */
export async function closeOpenCheckpoints(): Promise<string[]> {
    return closeOpenCheckpointsWith({
        recorded: async () => {
            const data = await SettingsStore.get('odoo-debugger-data.json').catch(() => undefined);
            return (data?.projects ?? []).flatMap(project => (project.dbs ?? []).flatMap(db => checkpointsOf(db ?? {}).map(cp => cp.id)));
        },
        openNow: async names => (await runSql('postgres',
            `SELECT datname FROM pg_database WHERE datistemplate AND datallowconn AND datname IN (${names.map(sqlText).join(', ')});`))
            .split('\n').map(line => line.trim()).filter(Boolean),
        connected: async name => Number((await runSql('postgres',
            `SELECT count(*) FROM pg_stat_activity WHERE datname = ${sqlText(name)};`)).trim()) > 0,
        opener: realCheckpointOpener
    });
}
