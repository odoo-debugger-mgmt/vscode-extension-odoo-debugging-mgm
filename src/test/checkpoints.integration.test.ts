/**
 * Checkpoints against a real PostgreSQL. Skipped unless ODT_PG_TEST=1.
 * ODT_PG_TEST_ODOO=<odoo checkout>[,<odoo checkout>...] reads list_dbs's
 * query from each checkout's odoo/service/db.py. Every database it makes is
 * named odt_cp_* and dropped afterwards.
 */
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { createDatabase, databaseExists, runSql } from '../services/postgres';
import { copyDatabase, discardDatabase, stageRestore, swapInRestored } from '../services/databaseCopy';
import { releaseForCopy, ReleaseUi, DbConnection } from '../services/connectionRelease';
import { realCopyBackend, realReleaseHost } from '../services/copyRuntime';
import { sqlText } from '../services/views/viewQueries';
import { checkpointComment, checkpointSizeSql, parseCheckpointComments, parseSizes } from '../services/checkpoints';

const enabled = process.env.ODT_PG_TEST === '1';
const LIST_DBS_17 = "select datname from pg_database where datdba=(select usesysid from pg_user where usename=current_user) and not datistemplate and datallowconn and datname not in %s order by datname";

function listDbsQueries(): string[] {
    const trees = (process.env.ODT_PG_TEST_ODOO ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
    if (trees.length === 0) {
        return [LIST_DBS_17];
    }
    return trees.map(tree => {
        const source = fsSync.readFileSync(path.join(tree, 'odoo', 'service', 'db.py'), 'utf8');
        const match = /cr\.execute\("(select datname from pg_database where datdba[^"]+)"/.exec(source);
        assert.ok(match, `no list_dbs query in ${tree}`);
        return match[1];
    });
}

(enabled ? suite : suite.skip)('Checkpoints on a real PostgreSQL', function () {
    this.timeout(120000);
    const suffix = `${process.pid}_${Date.now().toString(36)}`;
    const db = `odt_cp_${suffix}`;
    const checkpoint = `${db}__cp_test`;
    let root: string;
    let holder: ChildProcess | undefined;
    const backend = realCopyBackend();

    suiteSetup(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'odt-cp-fs-'));
        await createDatabase(db);
        await runSql(db, 'CREATE TABLE odt_t (v int); INSERT INTO odt_t VALUES (1);');
        await fs.mkdir(path.join(root, db, 'ab'), { recursive: true });
        await fs.writeFile(path.join(root, db, 'ab', 'first'), 'one');
    });

    suiteTeardown(async () => {
        holder?.kill();
        const mine = db.replace(/[\\_%]/g, '\\$&') + '%';
        const names = (await runSql('postgres', `SELECT datname FROM pg_database WHERE datname LIKE ${sqlText(mine)};`)).split('\n').filter(Boolean);
        for (const name of names) {
            await discardDatabase(backend, name).catch(() => undefined);
        }
        await fs.rm(root, { recursive: true, force: true });
    });

    test('a session on the database is ended only after the prompt says yes', async () => {
        holder = spawn('psql', ['--no-psqlrc', '-d', db], { env: { ...process.env, PGAPPNAME: 'odt-test-holder' }, stdio: ['pipe', 'ignore', 'ignore'] });
        for (let i = 0; i < 40; i++) {
            const seen = await runSql('postgres', `SELECT count(*) FROM pg_stat_activity WHERE datname = '${db}' AND application_name = 'odt-test-holder';`);
            if (seen === '1') {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        const asked: DbConnection[][] = [];
        const ui: ReleaseUi = { confirmStop: async () => false, confirmEnd: async (_db, list) => { asked.push(list); return true; } };
        const release = await releaseForCopy(db, realReleaseHost(), ui);
        assert.ok(release);
        assert.strictEqual(asked.length, 1);
        assert.deepStrictEqual(asked[0].map(c => c.application), ['odt-test-holder']);
    });

    test('a checkpoint is a protected copy that Odoo does not list, and its size reads', async () => {
        const result = await copyDatabase(backend, db, checkpoint, { filestoreRoot: root, protect: { comment: checkpointComment(db) } });
        assert.deepStrictEqual(result, { filestore: true, copiedFiles: 0 });
        assert.strictEqual(
            await runSql('postgres', `SELECT datallowconn::text || ',' || datistemplate::text FROM pg_database WHERE datname = '${checkpoint}';`),
            'false,true'
        );
        for (const query of listDbsQueries()) {
            const listed = (await runSql('postgres', query.replace('%s', "('postgres','template0','template1')"))).split('\n');
            assert.ok(listed.includes(db), 'the source is listed');
            assert.ok(!listed.includes(checkpoint), 'the checkpoint is not');
        }
        const [a, b] = await Promise.all([fs.stat(path.join(root, db, 'ab', 'first')), fs.stat(path.join(root, checkpoint, 'ab', 'first'))]);
        assert.strictEqual(a.ino, b.ino);
        const sizes = parseSizes(await runSql('postgres', checkpointSizeSql([checkpoint])));
        assert.ok((sizes.get(checkpoint) ?? 0) > 0);
        const comments = parseCheckpointComments(await runSql('postgres', "SELECT datname, coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datistemplate;"));
        assert.ok(comments.some(row => row.name === checkpoint && row.source === db));
    });

    test('restore brings the data and the filestore back', async () => {
        await runSql(db, 'INSERT INTO odt_t VALUES (2);');
        await fs.writeFile(path.join(root, db, 'ab', 'second'), 'two');
        await fs.rm(path.join(root, db, 'ab', 'first'));

        const staged = await stageRestore(backend, db, checkpoint, root);
        await swapInRestored(backend, db, staged, root);

        assert.strictEqual(await runSql(db, 'SELECT string_agg(v::text, \',\' ORDER BY v) FROM odt_t;'), '1');
        assert.deepStrictEqual((await fs.readdir(path.join(root, db, 'ab'))).sort(), ['first']);
        assert.strictEqual(await databaseExists(staged), false);
        assert.strictEqual(await databaseExists(`${db}__replaced`), false);
        assert.strictEqual(await databaseExists(checkpoint), true, 'the checkpoint is kept');
    });

    test('a checkpoint is deleted with its filestore', async () => {
        await discardDatabase(backend, checkpoint, root);
        assert.strictEqual(await databaseExists(checkpoint), false);
        await assert.rejects(fs.stat(path.join(root, checkpoint)));
    });
});
