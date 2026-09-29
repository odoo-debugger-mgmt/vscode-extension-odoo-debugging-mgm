/**
 * The main store: where the data every window shares is kept.
 *
 * Only the JSON file exists so far - the workspace's own
 * `.vscode/odoo-debugger-data.json`, or the file a workspace pinned with
 * `odooDebugger.dataStore.path`. The interface is the seam the SQLite store
 * plugs into (see docs/superpowers/specs/2026-09-28-shared-data-store-design.md);
 * SettingsStore keeps its cache and debounced writes above it.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse } from 'jsonc-parser';
import { SettingsModel } from '../models/settings';
import { getDefaultVersionSettings, type DebuggerData } from '../utils';
import { showInfo } from './notifications';
import { currentDataLocation } from './dataLocation';

export interface StoreRead {
    raw: string;
    data: DebuggerData;
    /** Modification stamp, compared by SettingsStore's cache. */
    mtimeMs: number;
}

export interface MainStore {
    /** Where the store lives, as shown to the user and pinned into workspaces. */
    readonly location: string;
    /** The directory relative paths in the data resolve against. */
    readonly root: string;
    /** The current stamp, or undefined when nothing is stored yet. */
    stat(): Promise<number | undefined>;
    /** Reads the store, creating it with its initial content when missing. */
    read(): Promise<StoreRead>;
    /** Replaces the stored content and returns the new stamp. */
    write(raw: string): Promise<number>;
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
                raw: INITIAL_CONTENT,
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
        return { raw, data, mtimeMs: existing };
    }

    async write(raw: string): Promise<number> {
        await fs.mkdir(path.dirname(this.location), { recursive: true });
        await fs.writeFile(this.location, raw, 'utf-8');
        return (await this.stat()) ?? Date.now();
    }
}

/** This window's main store, or undefined when no workspace is open. */
export function currentMainStore(): MainStore | undefined {
    const location = currentDataLocation();
    return location ? new JsonFileMainStore(location.file, location.root) : undefined;
}
