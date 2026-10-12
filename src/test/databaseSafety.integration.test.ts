/**
 * Clone and Create from Template against a real PostgreSQL.
 * Skipped unless ODT_PG_TEST=1. Every database it makes is named odt131_* and
 * dropped afterwards.
 */
import * as assert from 'assert';
import { createDatabase, databaseExists, dropDatabaseIfExists, runSql } from '../services/postgres';
import { cloneDatabaseFromTemplate, postgresDatabaseNames } from '../dbs';

const enabled = process.env.ODT_PG_TEST === '1';

(enabled ? suite : suite.skip)('Database safety on a real PostgreSQL', function () {
    this.timeout(120000);
    const suffix = `${process.pid}_${Date.now().toString(36)}`;
    const source = `odt131_src_${suffix}`;
    const existing = `odt131_mine_${suffix}`;

    suiteSetup(async () => {
        await createDatabase(source);
        await runSql(source, 'CREATE TABLE odt_t (v text); INSERT INTO odt_t VALUES (\'source\');');
        await createDatabase(existing);
        await runSql(existing, 'CREATE TABLE odt_t (v text); INSERT INTO odt_t VALUES (\'mine\');');
    });

    suiteTeardown(async () => {
        for (const name of [source, existing]) {
            await dropDatabaseIfExists(name).catch(() => undefined);
        }
    });

    test('the name prompts see every database in PostgreSQL, linked or not', async () => {
        const names = await postgresDatabaseNames();
        assert.ok(names.has(existing.toLowerCase()));
    });

    test('cloning onto an existing name fails and leaves that database as it was', async () => {
        // It used to drop "existing" first, then copy the source over it.
        await assert.rejects(cloneDatabaseFromTemplate(existing, source));

        assert.strictEqual(await databaseExists(existing), true);
        assert.strictEqual(await runSql(existing, 'SELECT v FROM odt_t;'), 'mine');
    });
});
