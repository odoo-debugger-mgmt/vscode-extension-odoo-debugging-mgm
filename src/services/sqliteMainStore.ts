/**
 * The shared main store: one SQLite file several VS Code windows use at once.
 *
 * Documents, not tables: each project, version and template is one JSON
 * document in one row, with a revision. A save writes only the documents that
 * changed, in one transaction, and a document another window changed since
 * this one read it is merged (mergeDocuments.ts) rather than overwritten.
 *
 * Built on `node:sqlite`, which VS Code's runtime ships from 1.101 (see
 * docs/superpowers/notes/2026-09-29-node-sqlite-spike.md). Its `DatabaseSync`
 * blocks the Extension Host thread every extension shares, so lock waits are
 * kept short and a busy write is retried asynchronously instead. Only the
 * smallest API surface is used - `DatabaseSync`, `exec`, `prepare`, `run` /
 * `get` / `all` - with every setting passed as a PRAGMA, because the module
 * is still experimental on Node 22.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DebuggerData } from '../utils';
import type { CommitResult, Disposable, MainStore, StoreRead } from './mainStore';
import { merge3, stableStringify } from './mergeDocuments';
import { projectKey } from './workspaceSelection';
import { logger } from './logger';

type SqliteModule = typeof import('node:sqlite');

/** `node:sqlite`, or undefined on a runtime that does not have it. */
export function loadSqlite(): SqliteModule | undefined {
    try {
        return require('node:sqlite') as SqliteModule;
    } catch {
        return undefined;
    }
}

export const SCHEMA_VERSION = 1;

/** Lock wait inside SQLite, kept short because it blocks the Extension Host thread. */
const BUSY_TIMEOUT_MS = 200;
/** Asynchronous waits between attempts once SQLite gives up. */
const RETRY_DELAYS_MS = [50, 100, 200, 400, 800];
const POLL_INTERVAL_MS = 1500;

type DocumentKind = 'project' | 'version' | 'template';

interface StoredDocument {
    kind: DocumentKind;
    key: string;
    position: number;
    doc: string;
}

/** Top-level keys held as documents; anything else goes to `meta.extra`. */
const DOCUMENT_KEYS = new Set(['projects', 'versions', 'dbTemplates', 'activeVersion']);

/*
 * The messages end without a full stop: they are shown both on their own and
 * inside "Failed to …: <message>", and VS Code adds one of its own.
 */

export class StoreBusyError extends Error {
    constructor(location: string) {
        super(`The data store ${location} stayed locked by another window; the change was not saved`);
        this.name = 'StoreBusyError';
    }
}

export class StoreReadOnlyError extends Error {
    constructor(location: string, version: number) {
        super(`The data store ${location} is read-only here: a newer Odoo DevTools (schema ${version}) wrote it; the change was not saved`);
        this.name = 'StoreReadOnlyError';
    }
}

function docId(kind: string, key: string): string {
    return `${kind}\u0000${key}`;
}

/** The documents a data object is stored as. */
export function toDocuments(data: DebuggerData): Map<string, StoredDocument> {
    const docs = new Map<string, StoredDocument>();
    (data.projects ?? []).forEach((project, position) => {
        const key = projectKey(project);
        docs.set(docId('project', key), { kind: 'project', key, position, doc: stableStringify(project) });
    });
    Object.entries(data.versions ?? {}).forEach(([key, version], position) => {
        docs.set(docId('version', key), { kind: 'version', key, position, doc: stableStringify(version) });
    });
    (data.dbTemplates ?? []).forEach((template, position) => {
        const key = template.name;
        docs.set(docId('template', key), { kind: 'template', key, position, doc: stableStringify(template) });
    });
    return docs;
}

/** Everything that is not a document, e.g. a legacy `settings` block awaiting migration. */
export function extraOf(data: DebuggerData): string {
    return stableStringify(Object.fromEntries(
        Object.entries(data).filter(([key, value]) => !DOCUMENT_KEYS.has(key) && value !== undefined)));
}

function isBusy(error: unknown): boolean {
    const code = (error as { errcode?: number })?.errcode;
    // SQLITE_BUSY, SQLITE_LOCKED and their extended codes share the low byte.
    if (typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6)) {
        return true;
    }
    return /database is (locked|busy)/i.test(String((error as Error)?.message ?? ''));
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class SqliteMainStore implements MainStore {
    readonly kind = 'sqlite';
    private readonly db: DatabaseSync;
    private ready = false;
    private readOnlyVersion: number | undefined;
    private readonly listeners = new Set<() => void>();
    private pollTimer: NodeJS.Timeout | undefined;
    private lastSeenVersion: number | undefined;

    constructor(readonly location: string, readonly root: string, sqlite: SqliteModule) {
        fs.mkdirSync(path.dirname(location), { recursive: true });
        this.db = new sqlite.DatabaseSync(location);
        this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }

    /** Runs `work`, retrying asynchronously while another window holds the lock. */
    private async withRetry<T>(work: () => T): Promise<T> {
        for (let attempt = 0; ; attempt += 1) {
            try {
                return work();
            } catch (error) {
                if (!isBusy(error)) {
                    throw error;
                }
                if (attempt >= RETRY_DELAYS_MS.length) {
                    throw new StoreBusyError(this.location);
                }
                await sleep(RETRY_DELAYS_MS[attempt]);
            }
        }
    }

    /** Runs `work` in one transaction; rolls back on any failure. */
    private transaction<T>(mode: 'IMMEDIATE' | 'DEFERRED', work: () => T): T {
        this.db.exec(`BEGIN ${mode}`);
        try {
            const result = work();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            try {
                this.db.exec('ROLLBACK');
            } catch {
                // Already rolled back by SQLite; the original error is the one to report.
            }
            throw error;
        }
    }

    private async ensureReady(): Promise<void> {
        if (this.ready) {
            return;
        }
        await this.withRetry(() => {
            this.db.exec('PRAGMA journal_mode = WAL');
            this.transaction('IMMEDIATE', () => {
                this.db.exec(`
                    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                    CREATE TABLE IF NOT EXISTS documents (
                        kind TEXT NOT NULL,
                        key TEXT NOT NULL,
                        position INTEGER NOT NULL,
                        rev INTEGER NOT NULL,
                        doc TEXT NOT NULL,
                        PRIMARY KEY (kind, key)
                    );
                `);
                this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
                    .run('schema_version', String(SCHEMA_VERSION));
            });
        });
        const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
        const version = Number(row?.value ?? SCHEMA_VERSION);
        if (version > SCHEMA_VERSION) {
            // Written by a newer extension: readable, never downgraded.
            this.readOnlyVersion = version;
            logger.warn(`[store] ${this.location} has schema ${version}, newer than ${SCHEMA_VERSION}; opened read-only`);
        }
        this.ready = true;
    }

    /** Changes whenever another connection commits; never for this one's own commits. */
    private dataVersion(): number {
        return Number((this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version);
    }

    async stat(): Promise<number | undefined> {
        await this.ensureReady();
        return this.dataVersion();
    }

    async read(): Promise<StoreRead> {
        await this.ensureReady();
        return this.withRetry(() => this.transaction('DEFERRED', () => {
            const rows = this.db.prepare('SELECT kind, key, rev, doc FROM documents ORDER BY kind, position')
                .all() as Array<{ kind: DocumentKind; key: string; rev: number; doc: string }>;
            const extra = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('extra') as { value: string } | undefined;

            const data: DebuggerData = { ...(extra ? JSON.parse(extra.value) : {}), projects: [], versions: {}, dbTemplates: [] };
            const revs = new Map<string, number>();
            for (const row of rows) {
                const doc = JSON.parse(row.doc);
                revs.set(docId(row.kind, row.key), Number(row.rev));
                if (row.kind === 'project') {
                    data.projects.push(doc);
                } else if (row.kind === 'version') {
                    data.versions![row.key] = doc;
                } else {
                    data.dbTemplates!.push(doc);
                }
            }
            return { data, revs, mtimeMs: this.dataVersion() };
        }));
    }

    async commit(base: StoreRead | undefined, next: DebuggerData): Promise<CommitResult> {
        await this.ensureReady();
        if (this.readOnlyVersion !== undefined) {
            throw new StoreReadOnlyError(this.location, this.readOnlyVersion);
        }

        const baseDocs = base ? toDocuments(base.data) : new Map<string, StoredDocument>();
        const baseRevs = base?.revs ?? new Map<string, number>();
        const nextDocs = toDocuments(next);
        const nextExtra = extraOf(next);
        const extraChanged = !base || extraOf(base.data) !== nextExtra;

        const changed = [...new Set([...baseDocs.keys(), ...nextDocs.keys()])].filter(id => {
            const before = baseDocs.get(id);
            const after = nextDocs.get(id);
            return before?.doc !== after?.doc || before?.position !== after?.position;
        });
        if (changed.length === 0 && !extraChanged) {
            // Nothing to write, and no empty transaction for other windows to notice.
            return { merged: [] };
        }

        return this.withRetry(() => this.transaction('IMMEDIATE', () => {
            const select = this.db.prepare('SELECT rev, doc FROM documents WHERE kind = ? AND key = ?');
            const upsert = this.db.prepare(`
                INSERT INTO documents (kind, key, position, rev, doc) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (kind, key) DO UPDATE SET position = excluded.position, rev = excluded.rev, doc = excluded.doc
            `);
            const remove = this.db.prepare('DELETE FROM documents WHERE kind = ? AND key = ?');
            const merged: string[] = [];

            for (const id of changed) {
                const before = baseDocs.get(id);
                const after = nextDocs.get(id);
                const [kind, key] = id.split('\u0000') as [DocumentKind, string];
                const row = select.get(kind, key) as { rev: number; doc: string } | undefined;
                const expectedRev = baseRevs.get(id);
                const untouchedSinceRead = row ? Number(row.rev) === expectedRev : expectedRev === undefined;

                if (!after) {
                    // Removed here. An edit another window made since outlives it.
                    if (row && untouchedSinceRead) {
                        remove.run(kind, key);
                    } else if (row) {
                        merged.push(`${kind} ${key}`);
                    }
                    continue;
                }

                let doc = after.doc;
                if (!untouchedSinceRead && row) {
                    doc = stableStringify(merge3(
                        before ? JSON.parse(before.doc) : undefined,
                        JSON.parse(after.doc),
                        JSON.parse(row.doc)
                    ));
                    merged.push(`${kind} ${key}`);
                } else if (row && row.doc === after.doc && Number(row.rev) === expectedRev && before?.doc === after.doc) {
                    // Only the position moved.
                    upsert.run(kind, key, after.position, Number(row.rev), doc);
                    continue;
                }
                upsert.run(kind, key, after.position, (row ? Number(row.rev) : 0) + 1, doc);
            }

            if (extraChanged) {
                this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
                    .run('extra', nextExtra);
            }
            return { merged };
        })).then(result => {
            // Outside the transaction: nothing but the write belongs in it.
            if (result.merged.length > 0) {
                logger.info(`[store] merged changes another window made to: ${result.merged.join(', ')}`);
            }
            return result;
        });
    }

    readOnlyReason(): string | undefined {
        return this.readOnlyVersion === undefined
            ? undefined
            : `it was written by a newer Odoo DevTools (schema ${this.readOnlyVersion})`;
    }

    onDidChange(listener: () => void): Disposable {
        this.listeners.add(listener);
        if (!this.pollTimer) {
            this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
            this.pollTimer.unref?.();
        }
        return {
            dispose: () => {
                this.listeners.delete(listener);
                if (this.listeners.size === 0 && this.pollTimer) {
                    clearInterval(this.pollTimer);
                    this.pollTimer = undefined;
                }
            }
        };
    }

    private async poll(): Promise<void> {
        try {
            const version = await this.stat();
            if (this.lastSeenVersion !== undefined && version !== this.lastSeenVersion) {
                this.listeners.forEach(listener => listener());
            }
            this.lastSeenVersion = version;
        } catch (error) {
            logger.debug('[store] change poll failed:', error);
        }
    }

    dispose(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
        this.listeners.clear();
        try {
            this.db.close();
        } catch (error) {
            logger.debug('[store] closing failed:', error);
        }
    }
}
