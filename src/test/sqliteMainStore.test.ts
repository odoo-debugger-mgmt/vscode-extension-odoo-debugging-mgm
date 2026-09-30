/**
 * The shared SQLite store, against real files and, for the multi-window case,
 * real separate processes.
 */
import * as assert from 'assert';
import { fork } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteMainStore, StoreReadOnlyError, loadSqlite } from '../services/sqliteMainStore';
import type { DebuggerData } from '../utils';

const sqlite = loadSqlite();

function sampleData(): DebuggerData {
    return {
        settings: { odooPath: './odoo' },
        projects: [
            { uid: 'p1', name: 'Acme', dbs: [{ id: 'a17', counter: 0 }, { id: 'a19', counter: 0 }] },
            { uid: 'p2', name: 'Other', dbs: [] }
        ] as never,
        versions: { v17: { id: 'v17', odooVersion: '17.0' } },
        dbTemplates: [{ name: 'base', templateDbName: 'tpl_base', createdAt: '2026-01-01' }]
    };
}

const counterOf = (data: DebuggerData, dbId: string) =>
    (data.projects[0] as any).dbs.find((db: any) => db.id === dbId).counter;

(sqlite ? suite : suite.skip)('SQLite main store', function () {
    this.timeout(30000);
    let dir: string;
    let file: string;
    const opened: SqliteMainStore[] = [];
    const open = () => {
        const store = new SqliteMainStore(file, dir, sqlite!);
        opened.push(store);
        return store;
    };

    setup(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'odt-sqlite-'));
        file = path.join(dir, 'store.db');
    });

    teardown(async () => {
        opened.splice(0).forEach(store => store.dispose());
        await fs.rm(dir, { recursive: true, force: true });
    });

    test('round-trips projects in order, versions, templates and the legacy settings block', async () => {
        const store = open();
        await store.commit(await store.read(), sampleData());
        const read = await store.read();

        assert.strictEqual(store.readOnlyReason(), undefined);
        assert.deepStrictEqual(read.data.projects.map(project => project.name), ['Acme', 'Other']);
        assert.strictEqual(read.data.versions?.v17.odooVersion, '17.0');
        assert.strictEqual(read.data.dbTemplates?.[0].templateDbName, 'tpl_base');
        assert.deepStrictEqual(read.data.settings, { odooPath: './odoo' });
        assert.strictEqual(read.data.activeVersion, undefined);
    });

    test('another connection sees a commit through the stamp; the writer\'s own stamp does not move', async () => {
        const writer = open();
        const reader = open();
        await writer.commit(await writer.read(), sampleData());
        const readerBefore = await reader.stat();
        const writerBefore = await writer.stat();

        const base = await writer.read();
        const next = structuredClone(base.data);
        next.projects[0].name = 'Acme Corp';
        await writer.commit(base, next);

        assert.notStrictEqual(await reader.stat(), readerBefore);
        assert.strictEqual(await writer.stat(), writerBefore);
    });

    test('a commit that changes nothing writes nothing', async () => {
        const writer = open();
        const reader = open();
        await writer.commit(await writer.read(), sampleData());
        const before = await reader.stat();

        const base = await writer.read();
        await writer.commit(base, structuredClone(base.data));

        assert.strictEqual(await reader.stat(), before);
    });

    test('two windows writing from stale reads: both edits to different databases survive', async () => {
        const first = open();
        const second = open();
        await first.commit(await first.read(), sampleData());

        const firstBase = await first.read();
        const secondBase = await second.read();

        const firstNext = structuredClone(firstBase.data);
        (firstNext.projects[0] as any).dbs[0].counter = 1;
        await first.commit(firstBase, firstNext);

        const secondNext = structuredClone(secondBase.data);
        (secondNext.projects[0] as any).dbs[1].counter = 1;
        const result = await second.commit(secondBase, secondNext);

        const final = (await first.read()).data;
        assert.strictEqual(counterOf(final, 'a17'), 1);
        assert.strictEqual(counterOf(final, 'a19'), 1);
        assert.deepStrictEqual(result.merged, ['project p1']);
    });

    test('deleting a project another window has not touched removes it', async () => {
        const store = open();
        await store.commit(await store.read(), sampleData());
        const base = await store.read();
        const next = structuredClone(base.data);
        next.projects.splice(1, 1);
        await store.commit(base, next);

        assert.deepStrictEqual((await store.read()).data.projects.map(project => project.name), ['Acme']);
    });

    test('a store written by a newer extension is read-only', async () => {
        const store = open();
        await store.commit(await store.read(), sampleData());
        store.dispose();
        opened.splice(opened.indexOf(store), 1);
        const raw = new sqlite!.DatabaseSync(file);
        raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run('99', 'schema_version');
        raw.close();

        const newer = open();
        assert.strictEqual(newer.readOnlyReason(), undefined, 'unknown until the store is read');
        const base = await newer.read();
        assert.strictEqual(base.data.projects.length, 2);
        assert.match(newer.readOnlyReason() ?? '', /schema 99/);
        await assert.rejects(newer.commit(base, { ...base.data, projects: [] }), StoreReadOnlyError);
    });

    test('the workspace registry: recorded, updated, seen by another window, forgotten', async () => {
        const a = open();
        const b = open();
        await a.recordWorkspace({ id: 'w17', name: 'W17', uri: 'file:///W17/acme', versionId: 'v17', lastSeen: 1000 });
        await b.recordWorkspace({ id: 'w19', name: 'W19', uri: 'file:///W19/acme', lastSeen: 2000 });
        // Binding W19 later updates its row in place.
        await b.recordWorkspace({ id: 'w19', name: 'W19', uri: 'file:///W19/acme', versionId: 'v19', lastSeen: 3000 });

        assert.deepStrictEqual(await a.listWorkspaces(), [
            { id: 'w19', name: 'W19', uri: 'file:///W19/acme', versionId: 'v19', lastSeen: 3000 },
            { id: 'w17', name: 'W17', uri: 'file:///W17/acme', versionId: 'v17', lastSeen: 1000 }
        ]);
        // Discovery only: never part of the data every window reads.
        assert.ok(!('workspaces' in (await a.read()).data));

        await a.forgetWorkspaces(['w17']);
        assert.deepStrictEqual((await b.listWorkspaces()).map(row => row.id), ['w19']);
    });

    test('a read-only store records no workspace', async () => {
        const store = open();
        await store.read();
        store.dispose();
        opened.splice(opened.indexOf(store), 1);
        const raw = new sqlite!.DatabaseSync(file);
        raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run('99', 'schema_version');
        raw.close();

        const newer = open();
        await newer.recordWorkspace({ id: 'w', name: 'W', uri: 'file:///w', lastSeen: 1 });
        assert.deepStrictEqual(await newer.listWorkspaces(), []);
    });

    test('two processes committing at once lose no update to their own databases', async () => {
        const store = open();
        await store.commit(await store.read(), sampleData());

        const iterations = 25;
        const helper = path.join(__dirname, 'helpers', 'sqliteWriter.js');
        const run = (dbId: string) => new Promise<{ seenVersions: number; merges: number }>((resolve, reject) => {
            const child = fork(helper, [file, dbId, String(iterations)], {
                // Inside the Extension Host the binary is Electron.
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                stdio: ['ignore', 'ignore', 'pipe', 'ipc']
            });
            let message: any;
            child.on('message', value => (message = value));
            child.on('error', reject);
            child.on('exit', code => (code === 0 && message && !message.error
                ? resolve(message)
                : reject(new Error(`writer ${dbId} failed: ${message?.error ?? `exit ${code}`}`))));
        });

        const [first, second] = await Promise.all([run('a17'), run('a19')]);
        const final = (await store.read()).data;

        assert.strictEqual(counterOf(final, 'a17'), iterations);
        assert.strictEqual(counterOf(final, 'a19'), iterations);
        // Each saw the other's commits come and go.
        assert.ok(first.seenVersions > 1 && second.seenVersions > 1);
    });
});
