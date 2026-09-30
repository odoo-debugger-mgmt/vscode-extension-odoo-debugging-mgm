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
import { SqliteMainStore, StoreReadOnlyError, loadSqlite } from '../services/sqliteMainStore';
import { JsonFileMainStore } from '../services/mainStore';
import { readSelection } from '../services/workspaceSelection';
import { rememberDbForVersion, dbForVersion } from '../services/dbResolution';
import type { DebuggerData } from '../utils';
import { UpgradeConfigModel } from '../models/upgrade';
import { healUpgradeSelection } from '../upgrade';

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

    test('picking another version\'s database leaves the first version its own', async () => {
        // Finding 14, on 1.3-shaped data: acme-db1 selected but never picked,
        // so nothing remembered it for 17.0.
        const seeded = seed();
        seeded.projects[0].isSelected = true;
        seeded.projects[0].dbs[0].isSelected = true;
        (seeded.projects[0].dbs as any[]).push({ id: 'acme-db19', versionId: 'v19', modules: [] });
        (seeded.versions as any).v19 = { id: 'v19', odooVersion: '19.0', settings: {} };
        await store.commit(await store.read(), seeded);
        SettingsStore.useForTesting(store, memento());

        // What selectDatabase does for acme-db19.
        const data = await SettingsStore.get();
        const project = data.projects[0];
        project.dbs.forEach(db => (db.isSelected = db.id === 'acme-db19'));
        project.selectedDbByVersion = rememberDbForVersion(project.selectedDbByVersion, 'v19', 'acme-db19');
        await SettingsStore.saveWithoutComments(data);

        const after = (await SettingsStore.get()).projects[0];
        assert.strictEqual(dbForVersion(after, 'v17')?.id, 'acme-db1');
        assert.strictEqual(dbForVersion(after, 'v19')?.id, 'acme-db19');
    });

    test('after another window turns an upgrade on and off, a window launches what it shows', async () => {
        const windowA = memento();
        const windowB = memento();
        const setUpgrade = async (on: boolean) => {
            const data = await SettingsStore.get();
            data.projects[0].upgradeConfig = new UpgradeConfigModel(
                on,
                { versionId: 'v17', dbId: 'acme-db2', series: '17.0' },
                { dbId: 'acme-db19', series: '19.0' },
                []
            );
            await SettingsStore.saveWithoutComments(data);
        };
        const shownDb = async () => (await SettingsStore.get()).projects[0].dbs.find(db => db.isSelected)?.id;

        SettingsStore.useForTesting(store, windowA);
        await selectDb('acme-db1');

        SettingsStore.useForTesting(store, windowB);
        await setUpgrade(true);

        // What initializeUpgradeContext does in A on the refresh that follows.
        SettingsStore.useForTesting(store, windowA);
        const healed = await SettingsStore.get();
        assert.strictEqual(healUpgradeSelection(healed.projects[0]), true);
        await SettingsStore.saveWithoutComments(healed);

        SettingsStore.useForTesting(store, windowB);
        await setUpgrade(false);

        SettingsStore.useForTesting(store, windowA);
        assert.strictEqual(await shownDb(), 'acme-db2');
        assert.strictEqual(await launchedDb(), await shownDb());
    });

    test('the shared store holds no selection and no remembered database', async () => {
        SettingsStore.useForTesting(store, memento());
        await selectDb('acme-db2');

        const stored = (await store.read()).data.projects[0] as any;
        assert.ok(!('isSelected' in stored));
        assert.ok(stored.dbs.every((db: any) => !('isSelected' in db)));
        assert.ok(!('selectedDbByVersion' in stored));
    });

    test('on a read-only store, selecting still works: it changes nothing shared', async () => {
        const raw = new sqlite!.DatabaseSync(path.join(dir, 'shared.db'));
        raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run('99', 'schema_version');
        raw.close();
        const readOnly = new SqliteMainStore(path.join(dir, 'shared.db'), dir, sqlite!);
        try {
            SettingsStore.useForTesting(readOnly, memento());
            await selectDb('acme-db2');

            assert.strictEqual(await launchedDb(), 'acme-db2');
        } finally {
            readOnly.dispose();
        }
    });

    test('a save the store refuses leaves the selection as it was', async () => {
        const window = memento();
        SettingsStore.useForTesting(store, window);
        await selectDb('acme-db1');

        const raw = new sqlite!.DatabaseSync(path.join(dir, 'shared.db'));
        raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run('99', 'schema_version');
        raw.close();
        const readOnly = new SqliteMainStore(path.join(dir, 'shared.db'), dir, sqlite!);
        try {
            SettingsStore.useForTesting(readOnly, window);
            // A real change to shared data, together with a new selection.
            const data = await SettingsStore.get();
            data.projects[0].name = 'Renamed';
            data.projects[0].dbs.forEach(db => (db.isSelected = db.id === 'acme-db2'));
            await assert.rejects(SettingsStore.saveWithoutComments(data), StoreReadOnlyError);

            assert.strictEqual(readSelection(window)?.selectedDbByProject.p1, 'acme-db1');
        } finally {
            readOnly.dispose();
        }
    });
});

suite('SettingsStore over the workspace\'s own file', function () {
    this.timeout(20000);
    let dir: string;

    setup(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'odt-settings-json-'));
    });

    teardown(async () => {
        SettingsStore.useForTesting(undefined);
        await fs.rm(dir, { recursive: true, force: true });
    });

    test('keeps a copy of the selection in the file, for another profile or editor to start from', async () => {
        const file = path.join(dir, '.vscode', 'odoo-debugger-data.json');
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(seed()));
        const store = new JsonFileMainStore(file, dir);

        SettingsStore.useForTesting(store, memento());
        await selectDb('acme-db2');
        const onDisk = JSON.parse(await fs.readFile(file, 'utf-8'));
        assert.strictEqual(onDisk.projects[0].isSelected, true);
        assert.strictEqual(onDisk.projects[0].dbs[1].isSelected, true);

        // A fresh profile: nothing in its workspaceState, so it starts from the file.
        SettingsStore.useForTesting(store, memento());
        const seen = await SettingsStore.get();
        assert.strictEqual(seen.projects[0].isSelected, true);
        assert.strictEqual(await launchedDb(), 'acme-db2');
    });
});
