/**
 * Two windows creating versions within a second of each other lost one
 * (thirteenth run, finding 18): each window saved its own map of versions,
 * and the store deleted what that map did not have. And an unreadable store
 * was written to (a Default Version every window then saw).
 */
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { SettingsStore, StoreReadError, StoreUnreadableError, noneOnStoreRead } from '../settingsStore';
import { SqliteMainStore, loadSqlite } from '../services/sqliteMainStore';
import { VersionsService, findSameEnvironment } from '../versionsService';
import type { MainStore } from '../services/mainStore';

const sqlite = loadSqlite();

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

suite('The same environment is one version', () => {
    const versions = [{ odooVersion: '9.0', settings: { odooPath: '/dev/odoo-9.0' } }, { odooVersion: '17.0', settings: { odooPath: './odoo' } }];

    test('a build into a directory a version already runs from is that version', () => {
        assert.strictEqual(findSameEnvironment(versions, '9.0', '/dev/odoo-9.0/'), versions[0]);
    });

    test('another series, another directory, or a relative default path is not', () => {
        assert.strictEqual(findSameEnvironment(versions, '10.0', '/dev/odoo-9.0'), undefined);
        assert.strictEqual(findSameEnvironment(versions, '9.0', '/dev/elsewhere'), undefined);
        assert.strictEqual(findSameEnvironment(versions, '17.0', './odoo'), undefined);
    });
});

(sqlite ? suite : suite.skip)('Versions created in two windows at once', function () {
    this.timeout(20000);
    let dir: string;
    let store: SqliteMainStore;

    setup(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'odt-versions-'));
        store = new SqliteMainStore(path.join(dir, 'shared.db'), dir, sqlite!);
        await store.commit(await store.read(), {
            projects: [],
            versions: { v17: { id: 'v17', name: 'Odoo 17.0', odooVersion: '17.0', settings: { portNumber: 8069 }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } },
            dbTemplates: []
        } as never);
        SettingsStore.useForTesting(store, memento());
        await VersionsService.getInstance().refresh();
    });

    teardown(async () => {
        SettingsStore.useForTesting(undefined);
        store.dispose();
        await fs.rm(dir, { recursive: true, force: true });
    });

    test('a version another window created is kept when this window saves', async () => {
        // The other window: its own connection, straight into the store,
        // unknown to this window's map of versions.
        await SettingsStore.get();
        const other = new SqliteMainStore(path.join(dir, 'shared.db'), dir, sqlite!);
        try {
            const read = await other.read();
            const versions = { ...(read.data.versions as object), v6: { id: 'v6', name: 'Odoo 6.0', odooVersion: '6.0', settings: { portNumber: 8060 }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } };
            await other.commit(read, { ...read.data, versions } as never);
        } finally {
            other.dispose();
        }

        // This window's map has not caught up - the race in the report: its
        // store cache holds the other window's version, its map does not.
        // Any save from that map, not only a creation, deleted it.
        const service = VersionsService.getInstance() as unknown as {
            versions: Map<string, unknown>;
            saveVersions(): Promise<void>;
        };
        service.versions.delete('v6');
        await service.saveVersions();

        const stored = Object.values((await store.read()).data.versions ?? {}).map((version: any) => version.odooVersion).sort();
        assert.deepStrictEqual(stored, ['17.0', '6.0']);
    });

    test('a version this window deleted stays deleted', async () => {
        const service = VersionsService.getInstance();
        const extra = await service.createVersion('Odoo 7.0', '7.0');
        assert.strictEqual(await service.deleteVersion(extra.id), true);

        const stored = Object.values((await store.read()).data.versions ?? {}).map((version: any) => version.odooVersion);
        assert.deepStrictEqual(stored, ['17.0']);
    });
});

suite('An unreadable store is not written to', () => {
    test('a save after a failed read is refused, and nothing is committed', async () => {
        let commits = 0;
        const broken: MainStore = {
            kind: 'sqlite',
            location: '/tmp/broken.db',
            root: '/tmp',
            stat: async () => 1,
            read: async () => {
                throw new Error('file is not a database');
            },
            commit: async () => {
                commits += 1;
                return { rev: 1, merged: [] } as never;
            },
            dispose: () => undefined
        };
        SettingsStore.useForTesting(broken, memento());
        try {
            await assert.rejects(SettingsStore.get());
            await assert.rejects(SettingsStore.saveWithoutComments({ projects: [], versions: {} } as never), StoreUnreadableError);
            assert.strictEqual(commits, 0);
        } finally {
            SettingsStore.useForTesting(undefined);
        }
    });
});

(sqlite ? suite : suite.skip)('A window opened on an unreadable store', function () {
    this.timeout(20000);

    test('loading versions does not fail, saves nothing, and reads again once it can', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'odt-unreadable-'));
        const real = new SqliteMainStore(path.join(dir, 'shared.db'), dir, sqlite!);
        await real.commit(await real.read(), {
            projects: [],
            versions: { v19: { id: 'v19', name: 'Odoo 19.0', odooVersion: '19.0', settings: { portNumber: 8079 }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } },
            activeVersion: 'v19',
            dbTemplates: []
        } as never);
        let readable = false;
        let commits = 0;
        let stat = 0;
        const flaky: MainStore = {
            kind: 'sqlite',
            location: real.location,
            root: dir,
            stat: async () => ++stat,
            read: async () => {
                if (!readable) {
                    throw new Error('file is not a database');
                }
                return real.read();
            },
            commit: async (base, next) => {
                commits += 1;
                return real.commit(base, next);
            },
            dispose: () => undefined
        };
        SettingsStore.useForTesting(flaky, memento());
        const service = VersionsService.getInstance();
        (service as unknown as { initialized: boolean }).initialized = false;
        try {
            // Fourteenth run: the refused save escaped initialize() and ended activation.
            await service.initialize();
            assert.strictEqual(commits, 0);
            // Sixteenth run: load() hid the failure, so the stand-in was
            // taken for stored versions and offered for migration.
            assert.strictEqual(service.loadedFromStore(), false);

            readable = true;
            await service.initialize();
            assert.deepStrictEqual(service.getVersions().map(version => version.odooVersion), ['19.0']);
        } finally {
            SettingsStore.useForTesting(undefined);
            real.dispose();
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    test('the stand-in is not taken for stored versions while it reads again', async () => {
        // Seventeenth run, finding 33: a second load cleared the flag on
        // entry, and the Migrate offer, checking during it, offered the
        // stand-in.
        let release: () => void = () => undefined;
        let stat = 0;
        const slow: MainStore = {
            kind: 'sqlite',
            location: '/tmp/slow.db',
            root: '/tmp',
            stat: async () => ++stat,
            read: () => new Promise((_resolve, reject) => {
                release = () => reject(new Error('file is not a database'));
            }),
            commit: async () => ({ rev: 1, merged: [] }) as never,
            dispose: () => undefined
        };
        SettingsStore.useForTesting(slow, memento());
        const service = VersionsService.getInstance();
        (service as unknown as { initialized: boolean; readFailed: boolean }).initialized = false;
        (service as unknown as { readFailed: boolean }).readFailed = true;
        try {
            const again = service.initialize();
            await new Promise(resolve => setTimeout(resolve, 10));
            assert.strictEqual(service.loadedFromStore(), false);
            release();
            await again;
            assert.strictEqual(service.loadedFromStore(), false);
        } finally {
            SettingsStore.useForTesting(undefined);
        }
    });
});

suite('A view reading an unreadable store', () => {
    test('shows nothing rather than an error VS Code would repeat', async () => {
        assert.strictEqual(await Promise.reject(new StoreReadError('/s.db', 'bad')).catch(noneOnStoreRead), null);
        await assert.rejects(Promise.reject(new Error('other')).catch(noneOnStoreRead), /other/);
    });
});

(sqlite ? suite : suite.skip)('A window that switched data stores', function () {
    this.timeout(20000);

    test('judges nothing from the old store\'s versions until it reads the new one', async () => {
        // Seventeenth run, finding 32: back on the shared store, the binding
        // check ran before the versions were read again, found 17.0 missing
        // from the own file's versions, and cleared the binding.
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'odt-switch-'));
        const own = new SqliteMainStore(path.join(dir, 'own.db'), dir, sqlite!);
        const shared = new SqliteMainStore(path.join(dir, 'shared.db'), dir, sqlite!);
        await shared.commit(await shared.read(), {
            projects: [],
            versions: { v17: { id: 'v17', name: 'Odoo 17.0', odooVersion: '17.0', settings: { portNumber: 8069 }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } },
            activeVersion: 'v17',
            dbTemplates: []
        } as never);
        const service = VersionsService.getInstance();
        try {
            SettingsStore.useForTesting(own, memento());
            await service.refresh();
            assert.strictEqual(service.loadedFromStore(), true);
            assert.strictEqual(service.getVersion('v17'), undefined);

            SettingsStore.useForTesting(shared, memento());
            assert.strictEqual(service.loadedFromStore(), false, 'the own file\'s versions say nothing about the shared store');

            await service.refresh();
            assert.strictEqual(service.loadedFromStore(), true);
            assert.ok(service.getVersion('v17'));
        } finally {
            SettingsStore.useForTesting(undefined);
            own.dispose();
            shared.dispose();
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});
