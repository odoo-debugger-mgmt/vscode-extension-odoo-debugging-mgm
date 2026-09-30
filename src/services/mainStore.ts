/**
 * The main store: where the data every window shares is kept.
 *
 * Two implementations:
 *
 * - `JsonFileMainStore`: the workspace's own `.vscode/odoo-debugger-data.json`
 *   (the default) or a JSON file a workspace pinned. One window's data.
 * - `SqliteMainStore` (sqliteMainStore.ts): a `.db` file several windows
 *   share, written a document at a time with conflicts merged.
 *
 * SettingsStore keeps its cache and debounced writes above this seam; see
 * docs/superpowers/specs/2026-09-28-shared-data-store-design.md.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse } from 'jsonc-parser';
import { SettingsModel } from '../models/settings';
import { getDefaultVersionSettings, type DebuggerData } from '../utils';
import { showError, showInfo } from './notifications';
import { DataLocation, StoreKind, currentDataLocation, workspaceDataLocation } from './dataLocation';
import { SqliteMainStore, loadSqlite, type WorkspaceRow } from './sqliteMainStore';
import { logger } from './logger';

export interface StoreRead {
    data: DebuggerData;
    /** Change stamp, compared by SettingsStore's cache. */
    mtimeMs: number;
    /** Per-document revisions, for stores that detect conflicts. */
    revs?: Map<string, number>;
}

export interface CommitResult {
    /** Documents another window changed meanwhile, merged rather than overwritten. */
    merged: string[];
}

export interface Disposable {
    dispose(): void;
}

export interface MainStore {
    readonly kind: StoreKind;
    /** Where the store lives, as shown to the user and pinned into workspaces. */
    readonly location: string;
    /** The directory relative paths in the data resolve against. */
    readonly root: string;
    /** The current stamp, or undefined when nothing is stored yet. */
    stat(): Promise<number | undefined>;
    /** Reads the store, creating it with its initial content when missing. */
    read(): Promise<StoreRead>;
    /**
     * Writes `next`. `base` is what the caller read: a store shared between
     * windows uses it to tell its own changes from another window's.
     */
    commit(base: StoreRead | undefined, next: DebuggerData): Promise<CommitResult>;
    /** Fires when another process changes the store. */
    onDidChange?(listener: () => void): Disposable;
    /** Why saves to this store will fail, when they will; known once it has been read. */
    readOnlyReason?(): string | undefined;
    /** The workspace registry (design §3): only a shared store has one. */
    listWorkspaces?(): Promise<WorkspaceRow[]>;
    recordWorkspace?(row: WorkspaceRow): Promise<void>;
    forgetWorkspaces?(ids: string[]): Promise<void>;
    dispose(): void;
}

const INITIAL_CONTENT = `{
    // Odoo Debugger Extension Configuration
    // This file stores your project settings and configurations
    "settings": {
        // Add your Odoo settings here
    },
    "projects": [],
    "dbTemplates": []
}`;

export class JsonFileMainStore implements MainStore {
    readonly kind = 'json';

    constructor(readonly location: string, readonly root: string) {}

    async stat(): Promise<number | undefined> {
        const stats = await fs.stat(this.location).catch(() => undefined);
        return stats?.mtimeMs;
    }

    async read(): Promise<StoreRead> {
        const existing = await this.stat();
        if (existing === undefined) {
            void showInfo(`Creating ${path.basename(this.location)} file...`);
            await fs.mkdir(path.dirname(this.location), { recursive: true });
            await fs.writeFile(this.location, INITIAL_CONTENT, 'utf-8');
            // The legacy `settings` block is what VersionsService migrates
            // into the first version, so a new store starts with the
            // configured defaults rather than the empty object on disk.
            return {
                data: {
                    settings: new SettingsModel(getDefaultVersionSettings()),
                    projects: [],
                    dbTemplates: []
                },
                mtimeMs: (await this.stat()) ?? Date.now()
            };
        }

        const raw = await fs.readFile(this.location, 'utf-8');
        const data = parse(raw) as DebuggerData | undefined;
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error(`${this.location} does not contain a JSON object.`);
        }
        return { data, mtimeMs: existing };
    }

    /** One window's file: the whole document is written, as it always was. */
    async commit(_base: StoreRead | undefined, next: DebuggerData): Promise<CommitResult> {
        await fs.mkdir(path.dirname(this.location), { recursive: true });
        await fs.writeFile(this.location, JSON.stringify(next, null, 4), 'utf-8');
        return { merged: [] };
    }

    dispose(): void {
        // Nothing held open.
    }
}

/** One store per location, so a SQLite connection is opened once. */
const openStores = new Map<string, MainStore>();

let warnedMissingSqlite = false;

/** Opens the store a location names, or undefined when its runtime support is missing. */
export function openMainStore(location: DataLocation): MainStore | undefined {
    const key = `${location.kind}:${location.file}`;
    const existing = openStores.get(key);
    if (existing) {
        return existing;
    }

    let store: MainStore;
    if (location.kind === 'sqlite') {
        const sqlite = loadSqlite();
        if (!sqlite) {
            return undefined;
        }
        store = new SqliteMainStore(location.file, location.root, sqlite);
    } else {
        store = new JsonFileMainStore(location.file, location.root);
    }
    openStores.set(key, store);
    return store;
}

/**
 * This window's main store, or undefined when no workspace is open.
 *
 * A shared store on a runtime without `node:sqlite` - an editor built on an
 * older Node than VS Code 1.101's - falls back to the workspace's own file and
 * says so once, rather than starting empty.
 */
export function currentMainStore(): MainStore | undefined {
    const location = currentDataLocation();
    if (!location) {
        return undefined;
    }
    const store = openMainStore(location);
    if (store) {
        return store;
    }

    if (!warnedMissingSqlite) {
        warnedMissingSqlite = true;
        const message = `The shared data store ${location.file} needs node:sqlite, which this editor's runtime `
            + `(Node ${process.versions.node}) does not provide. VS Code 1.101 or later (Node 22.15+) has it. `
            + 'Using this workspace\'s own data file instead.';
        logger.warn(`[store] ${message}`);
        void showError(message);
    }
    const fallback = workspaceDataLocation(location.root);
    return fallback ? openMainStore(fallback) : undefined;
}

/** Closes every store except the one this window now uses. */
export function closeOtherMainStores(): void {
    const current = currentMainStore();
    for (const [key, store] of openStores) {
        if (store !== current) {
            store.dispose();
            openStores.delete(key);
        }
    }
}

export function disposeMainStores(): void {
    for (const store of openStores.values()) {
        store.dispose();
    }
    openStores.clear();
}
