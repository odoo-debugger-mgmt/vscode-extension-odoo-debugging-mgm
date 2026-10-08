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

export async function withCheckpointOpen<T>(db: string, read: () => Promise<T>, opener: CheckpointOpener = realCheckpointOpener): Promise<T> {
    let entry = openings.get(db);
    if (!entry) {
        const ready = opener.open(db);
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
            await opener.close(db).catch(error => logger.warn(`Could not close checkpoint ${db} again:`, error));
        }
    }
}

/** Closes every recorded checkpoint left open, e.g. by a host that died mid-read. */
export async function closeOpenCheckpoints(): Promise<string[]> {
    const data = await SettingsStore.get('odoo-debugger-data.json').catch(() => undefined);
    const names = (data?.projects ?? []).flatMap(project => (project.dbs ?? []).flatMap(db => checkpointsOf(db ?? {}).map(cp => cp.id)));
    if (names.length === 0) {
        return [];
    }
    const open = (await runSql('postgres',
        `SELECT datname FROM pg_database WHERE datistemplate AND datallowconn AND datname IN (${names.map(sqlText).join(', ')});`))
        .split('\n').map(line => line.trim()).filter(Boolean);
    for (const name of open) {
        await realCheckpointOpener.close(name).catch(error => logger.warn(`Could not close checkpoint ${name}:`, error));
    }
    return open;
}
