/**
 * Reading a checkpoint partner against a real PostgreSQL. Skipped unless
 * ODT_PG_TEST=1. Every database it makes is named odt_cpr_* and dropped afterwards.
 */
import * as assert from 'assert';
import { createDatabase, runSql } from '../services/postgres';
import { copyDatabase, discardDatabase } from '../services/databaseCopy';
import { realCopyBackend } from '../services/copyRuntime';
import { sqlText, readStoredArch } from '../services/views/viewQueries';
import { checkpointComment } from '../services/checkpoints';
import { closeOpenCheckpointsWith, realCheckpointOpener, withCheckpointOpen } from '../services/checkpointReads';

const enabled = process.env.ODT_PG_TEST === '1';

(enabled ? suite : suite.skip)('Checkpoint partner reads on a real PostgreSQL', function () {
    this.timeout(120000);
    const suffix = `${process.pid}_${Date.now().toString(36)}`;
    const db = `odt_cpr_${suffix}`;
    const checkpoint = `${db}__cp_test`;
    const backend = realCopyBackend();

    const allowsConnections = async (): Promise<string> =>
        runSql('postgres', `SELECT datallowconn::text FROM pg_database WHERE datname = ${sqlText(checkpoint)};`);

    suiteSetup(async () => {
        await createDatabase(db);
        await runSql(db, `CREATE TABLE t (v text); INSERT INTO t VALUES ('arch');
            CREATE TABLE ir_ui_view (id int, arch_db jsonb); INSERT INTO ir_ui_view VALUES (7, '{"en_US": "<form/>"}');`);
        await copyDatabase(backend, db, checkpoint, { protect: { comment: checkpointComment(db) } });
    });

    suiteTeardown(async () => {
        const mine = db.replace(/[\\_%]/g, '\\$&') + '%';
        const names = (await runSql('postgres', `SELECT datname FROM pg_database WHERE datname LIKE ${sqlText(mine)};`)).split('\n').filter(Boolean);
        for (const name of names) {
            await discardDatabase(backend, name).catch(() => undefined);
        }
    });

    test('a protected checkpoint refuses a plain read', async () => {
        await assert.rejects(runSql(checkpoint, 'SELECT 1'));
    });

    test('overlapping reads both see the data and the checkpoint is closed afterwards', async () => {
        const slow = withCheckpointOpen(checkpoint, async () => {
            await new Promise(resolve => setTimeout(resolve, 300));
            return runSql(checkpoint, 'SELECT v FROM t');
        });
        const fast = withCheckpointOpen(checkpoint, () => runSql(checkpoint, 'SELECT v FROM t'));
        assert.deepStrictEqual(await Promise.all([slow, fast]), ['arch', 'arch']);
        assert.strictEqual(await allowsConnections(), 'false');
    });

    test('a read that throws still leaves the checkpoint closed', async () => {
        await assert.rejects(withCheckpointOpen(checkpoint, () => runSql(checkpoint, 'SELECT * FROM no_such_table')));
        assert.strictEqual(await allowsConnections(), 'false');
    });

    test('readStoredArch reads a view through a checkpoint', async () => {
        assert.strictEqual(await withCheckpointOpen(checkpoint, () => readStoredArch(checkpoint, 7)), '<form/>');
        assert.strictEqual(await allowsConnections(), 'false');
    });

    test('the sweep closes a checkpoint left open', async () => {
        await runSql('postgres', `ALTER DATABASE "${checkpoint}" WITH ALLOW_CONNECTIONS true;`);
        assert.strictEqual(await allowsConnections(), 'true');
        const closed = await closeOpenCheckpointsWith({
            recorded: async () => [checkpoint],
            openNow: async names => (await runSql('postgres',
                `SELECT datname FROM pg_database WHERE datistemplate AND datallowconn AND datname IN (${names.map(sqlText).join(', ')});`))
                .split('\n').map(line => line.trim()).filter(Boolean),
            connected: async name => Number((await runSql('postgres', `SELECT count(*) FROM pg_stat_activity WHERE datname = ${sqlText(name)};`)).trim()) > 0,
            opener: realCheckpointOpener
        });
        assert.deepStrictEqual(closed, [checkpoint]);
        assert.strictEqual(await allowsConnections(), 'false');
    });
});
