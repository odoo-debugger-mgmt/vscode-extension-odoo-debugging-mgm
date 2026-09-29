/**
 * SettingsStore over real stores, with each "window" given its own
 * workspaceState. These are the behaviours the shared-store test run found
 * wrong in real windows (docs/superpowers/notes/2026-09-29-shared-store-test-report.md).
 */
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { SettingsStore } from '../settingsStore';
import { SqliteMainStore, loadSqlite } from '../services/sqliteMainStore';
import { rememberDbForVersion, dbForVersion } from '../services/dbResolution';
import type { DebuggerData } from '../utils';

const sqlite = loadSqlite();

/** A workspaceState stand-in: one per simulated window. */
function memento(): vscode.Memento {
    const values = new Map<string, unknown>();
    return {
        keys: () => [...values.keys()],
        get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback),
        update: async (key: string, value: unknown) => {
            values.set(key, value);
        }
    } as vscode.Memento;
}

function seed(): DebuggerData {
    return {
        projects: [{
            uid: 'p1', name: 'Acme', repos: [],
            dbs: [
                { id: 'acme-db1', versionId: 'v17', modules: [] },
                { id: 'acme-db2', versionId: 'v17', modules: [] }
            ]
        }] as never,
        versions: { v17: { id: 'v17', odooVersion: '17.0', settings: {} } },
        dbTemplates: []
    };
}

/** What dbs.ts selectDatabase does to the data, minus the UI. */
async function selectDb(dbId: string): Promise<void> {
    const data = await SettingsStore.get();
    const project = data.projects[0];
    project.isSelected = true;
    project.dbs.forEach(db => (db.isSelected = db.id === dbId));
    project.selectedDbByVersion = rememberDbForVersion(project.selectedDbByVersion, 'v17', dbId);
    await SettingsStore.saveWithoutComments(data);
}

async function launchedDb(): Promise<string | undefined> {
    const data = await SettingsStore.get();
    return dbForVersion(data.projects[0], 'v17')?.id;
}

(sqlite ? suite : suite.skip)('SettingsStore over a shared store', function () {
    this.timeout(20000);
    let dir: string;
    let store: SqliteMainStore;

    setup(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'odt-settings-'));
        store = new SqliteMainStore(path.join(dir, 'shared.db'), dir, sqlite!);
        await store.commit(await store.read(), seed());
    });

    teardown(async () => {
        SettingsStore.useForTesting(undefined);
        store.dispose();
        await fs.rm(dir, { recursive: true, force: true });
    });

    test('a window launches the database it selected, not the one another window selected', async () => {
        const windowA = memento();
        const windowB = memento();

        SettingsStore.useForTesting(store, windowA);
        await selectDb('acme-db1');
        SettingsStore.useForTesting(store, windowB);
        await selectDb('acme-db2');

        SettingsStore.useForTesting(store, windowA);
        assert.strictEqual(await launchedDb(), 'acme-db1');
        SettingsStore.useForTesting(store, windowB);
        assert.strictEqual(await launchedDb(), 'acme-db2');
    });

    test('the shared store holds no selection and no remembered database', async () => {
        SettingsStore.useForTesting(store, memento());
        await selectDb('acme-db2');

        const stored = (await store.read()).data.projects[0] as any;
        assert.strictEqual(stored.isSelected, false);
        assert.ok(stored.dbs.every((db: any) => !db.isSelected));
        assert.deepStrictEqual(stored.selectedDbByVersion ?? {}, {});
    });
});
