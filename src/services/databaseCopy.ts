/**
 * Copying, dropping and swapping whole databases, with their filestore. One
 * routine for checkpoints, Clone and Templates. Pure over `CopyBackend`, so
 * step order and rollback are tested as data; copyRuntime.ts wires the real
 * psql and file system in. Releasing the source - stopping a server, ending
 * connections - is the caller's job (connectionRelease.ts), done once around
 * however many steps need it.
 */
import * as path from 'node:path';
import type { LinkTreeResult } from './filestore';
import { quotePgIdentifier } from './postgres';
import { sqlText } from './views/viewQueries';
import { derivedDbName } from './checkpoints';

export interface FilestoreOps {
    exists(dir: string): Promise<boolean>;
    linkTree(src: string, dst: string): Promise<LinkTreeResult>;
    rename(from: string, to: string): Promise<void>;
    remove(dir: string): Promise<void>;
}

export interface CopyBackend {
    /** One statement on the `postgres` maintenance database; trimmed stdout. */
    sql(statement: string): Promise<string>;
    /** Ends the extension's own backends on `db`: query probes, View Doctor shells. */
    freeOwnConnections(db: string): Promise<void>;
    files: FilestoreOps;
    log(message: string): void;
    sleep(ms: number): Promise<void>;
}

export interface CopyOptions {
    /** `<data dir>/filestore`; without it the filestore is left alone. */
    filestoreRoot?: string;
    /** Makes the copy a checkpoint: refuses connections, is a template, carries this comment. */
    protect?: { comment: string };
}

export interface CopyResult {
    filestore: boolean;
    copiedFiles: number;
}

const BUSY = /is being accessed by other users/;
const BUSY_ATTEMPTS = 4;
const BUSY_DELAY_MS = 500;

const versionCache = new WeakMap<CopyBackend, Promise<number>>();

export function serverVersionNum(backend: CopyBackend): Promise<number> {
    let cached = versionCache.get(backend);
    if (!cached) {
        cached = backend.sql('SHOW server_version_num;').then(out => Number.parseInt(out, 10) || 0);
        versionCache.set(backend, cached);
    }
    return cached;
}

/**
 * FILE_COPY copies the data files instead of writing every page to the WAL:
 * seconds instead of minutes on a large database. Before 15 that was the
 * only strategy, and the keyword does not exist.
 */
export function createDatabaseSql(target: string, source: string, versionNum: number): string {
    const strategy = versionNum >= 150000 ? ' STRATEGY FILE_COPY' : '';
    return `CREATE DATABASE ${quotePgIdentifier(target)} TEMPLATE ${quotePgIdentifier(source)}${strategy};`;
}

export async function databaseExistsVia(backend: CopyBackend, name: string): Promise<boolean> {
    return (await backend.sql(`SELECT 1 FROM pg_database WHERE datname = ${sqlText(name)};`)) === '1';
}

/**
 * Runs `run`, retrying while PostgreSQL says `db` has other sessions. Between
 * tries only the extension's own backends are ended - the View Doctor's arch
 * poll reconnects every 3 s. Anyone else's connection is the release step's
 * to ask about, never ended here.
 */
export async function retryWhileBusy<T>(backend: CopyBackend, db: string, run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await run();
        } catch (error) {
            if (attempt >= BUSY_ATTEMPTS || !BUSY.test(String((error as Error)?.message ?? error))) {
                throw error;
            }
            await backend.freeOwnConnections(db);
            await backend.sleep(BUSY_DELAY_MS);
        }
    }
}

export async function copyDatabase(backend: CopyBackend, source: string, target: string, options: CopyOptions): Promise<CopyResult> {
    if (await databaseExistsVia(backend, target)) {
        throw new Error(`A database named "${target}" already exists.`);
    }
    const versionNum = await serverVersionNum(backend);
    const root = options.filestoreRoot;
    let createdDb = false;
    let createdFiles = false;
    try {
        await retryWhileBusy(backend, source, () => backend.sql(createDatabaseSql(target, source, versionNum)));
        createdDb = true;

        let filestore = false;
        let copiedFiles = 0;
        if (root && await backend.files.exists(path.join(root, source))) {
            const to = path.join(root, target);
            // No database owns a folder under a name that has no database.
            if (await backend.files.exists(to)) {
                await backend.files.remove(to);
            }
            createdFiles = true;
            const linked = await backend.files.linkTree(path.join(root, source), to);
            filestore = true;
            copiedFiles = linked.copied;
            if (linked.copied > 0) {
                backend.log(`Filestore of ${source}: links were refused, so ${linked.copied} of ${linked.files} files were copied.`);
            }
        }

        if (options.protect) {
            await backend.sql(`COMMENT ON DATABASE ${quotePgIdentifier(target)} IS ${sqlText(options.protect.comment)};`);
            await backend.sql(`ALTER DATABASE ${quotePgIdentifier(target)} WITH ALLOW_CONNECTIONS false IS_TEMPLATE true;`);
        }
        return { filestore, copiedFiles };
    } catch (error) {
        if (createdDb) {
            await discardDatabase(backend, target).catch(cleanup => backend.log(`Could not drop the partial copy ${target}: ${cleanup}`));
        }
        if (createdFiles && root) {
            await backend.files.remove(path.join(root, target)).catch(cleanup => backend.log(`Could not remove ${target}'s filestore: ${cleanup}`));
        }
        throw error;
    }
}

/** Drops a database - a protected one too - and its filestore folder. */
export async function discardDatabase(backend: CopyBackend, name: string, filestoreRoot?: string): Promise<void> {
    if (await databaseExistsVia(backend, name)) {
        await backend.sql(`ALTER DATABASE ${quotePgIdentifier(name)} WITH IS_TEMPLATE false;`);
        await retryWhileBusy(backend, name, () => backend.sql(`DROP DATABASE IF EXISTS ${quotePgIdentifier(name)};`));
    }
    if (filestoreRoot) {
        await backend.files.remove(path.join(filestoreRoot, name));
    }
}

const rename = (from: string, to: string) => `ALTER DATABASE ${quotePgIdentifier(from)} RENAME TO ${quotePgIdentifier(to)};`;

/**
 * Restore, part one: the checkpoint copied to `<db>__restoring`, unprotected,
 * while the database and its server are still untouched.
 */
export async function stageRestore(backend: CopyBackend, db: string, checkpointDb: string, filestoreRoot?: string): Promise<string> {
    const replaced = derivedDbName(db, '__replaced');
    if (await databaseExistsVia(backend, replaced)) {
        throw new Error(`"${replaced}" is left over from an interrupted restore and may hold the data of "${db}". Rename or drop it in psql first.`);
    }
    const staged = derivedDbName(db, '__restoring');
    // A leftover staging copy is only ever a copy of a checkpoint.
    await discardDatabase(backend, staged, filestoreRoot);
    await copyDatabase(backend, checkpointDb, staged, { filestoreRoot });
    return staged;
}

/**
 * Restore, part two, with `db` released: renamed out of the way, the staged
 * copy renamed in, the filestore folders swapped the same way, then the old
 * state dropped. The database never goes missing: any failure undoes the
 * steps done, in reverse.
 */
export async function swapInRestored(backend: CopyBackend, db: string, staged: string, filestoreRoot?: string): Promise<void> {
    const replaced = derivedDbName(db, '__replaced');
    const undo: Array<() => Promise<unknown>> = [];
    try {
        await retryWhileBusy(backend, db, () => backend.sql(rename(db, replaced)));
        undo.push(() => backend.sql(rename(replaced, db)));
        await backend.sql(rename(staged, db));
        undo.push(() => backend.sql(rename(db, staged)));

        if (filestoreRoot) {
            const live = path.join(filestoreRoot, db);
            const old = path.join(filestoreRoot, replaced);
            const next = path.join(filestoreRoot, staged);
            if (await backend.files.exists(old)) {
                await backend.files.remove(old);
            }
            if (await backend.files.exists(live)) {
                await backend.files.rename(live, old);
                undo.push(() => backend.files.rename(old, live));
            }
            if (await backend.files.exists(next)) {
                await backend.files.rename(next, live);
                undo.push(() => backend.files.rename(live, next));
            }
        }
    } catch (error) {
        let undone = true;
        for (const step of undo.reverse()) {
            try {
                await step();
            } catch (undoError) {
                undone = false;
                backend.log(`Could not undo a restore step: ${undoError}`);
            }
        }
        if (!undone) {
            throw new Error(`Restoring "${db}" failed and could not be undone: its previous state is in "${replaced}". ${(error as Error)?.message ?? error}`);
        }
        throw error;
    }

    try {
        await discardDatabase(backend, replaced, filestoreRoot);
    } catch (error) {
        backend.log(`Restored "${db}", but could not drop its previous state "${replaced}": ${error}`);
    }
}
