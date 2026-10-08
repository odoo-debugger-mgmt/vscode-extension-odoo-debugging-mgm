/**
 * Compare Record on a real Odoo. Skipped unless ODT_COMPARE_TEST_PYTHON (a venv
 * python) and ODT_COMPARE_TEST_ODOO (an Odoo checkout) are set. Every database
 * it makes is named odt_cr_<run>_* and dropped afterwards.
 */
import * as assert from 'assert';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { runSql } from '../services/postgres';
import { copyDatabase, discardDatabase } from '../services/databaseCopy';
import { realCopyBackend } from '../services/copyRuntime';
import { withCheckpointOpen } from '../services/checkpointReads';
import { checkpointComment } from '../services/checkpoints';
import { sqlText } from '../services/views/viewQueries';
import { readRecord, type RecordRef } from '../services/compare/recordCompare';

const python = process.env.ODT_COMPARE_TEST_PYTHON;
const odoo = process.env.ODT_COMPARE_TEST_ODOO;
const enabled = Boolean(python && odoo);

(enabled ? suite : suite.skip)('Compare Record on a real Odoo', function () {
    this.timeout(400000);
    const prefix = `odt_cr_${process.pid}_${Date.now().toString(36)}`;
    const a = `${prefix}_a`;
    const b = `${prefix}_b`;
    const cp = `${prefix}_a__cp_test`;
    const backend = realCopyBackend();
    const main: RecordRef = { kind: 'xmlid', module: 'base', name: 'main_partner' };

    const text = async (db: string, ref: RecordRef): Promise<string> => {
        const read = await readRecord(db, ref, runSql);
        assert.ok(!('error' in read), 'error' in read ? read.error : '');
        return read.text;
    };

    suiteSetup(async () => {
        const build = spawn(python!, [path.join(odoo!, 'odoo-bin'), '-d', a, '-i', 'base', '--stop-after-init',
            '--addons-path', `${odoo}/odoo/addons,${odoo}/addons`, '--without-demo=all', '--max-cron-threads', '0'],
            { env: { ...process.env, PGAPPNAME: 'odt-compare-record-test' }, stdio: 'ignore' });
        const code = await new Promise<number | null>((resolve, reject) => {
            build.once('error', reject);
            build.once('exit', resolve);
        });
        assert.strictEqual(code, 0, 'installing base');
        await copyDatabase(backend, a, b, {});
        await runSql(b, "UPDATE res_partner SET name = 'Changed', comment = 'A note' WHERE id = (SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'main_partner');");
    });

    suiteTeardown(async () => {
        const mine = prefix.replace(/[\\_%]/g, '\\$&') + '%';
        const names = (await runSql('postgres', `SELECT datname FROM pg_database WHERE datname LIKE ${sqlText(mine)};`)).split('\n').filter(Boolean);
        for (const name of names) {
            await discardDatabase(backend, name).catch(error => console.error(`could not drop ${name}:`, error));
        }
    });

    test('an external id differs exactly in the changed fields', async () => {
        const left = (await text(a, main)).split('\n');
        const right = (await text(b, main)).split('\n');
        assert.strictEqual(left.length, right.length);
        const changed = left.map((line, i) => line === right[i] ? '' : line.split(':')[0]).filter(Boolean);
        assert.deepStrictEqual(changed, ['comment', 'name']);
        assert.ok(right.includes('name: Changed'));
    });

    test('a model and an id reads', async () => {
        const read = await text(a, { kind: 'id', model: 'res.partner', id: 1 });
        assert.match(read, /^name: /m);
    });

    test('a checkpoint reads like its source and is closed afterwards', async () => {
        await copyDatabase(backend, a, cp, { protect: { comment: checkpointComment(a) } });
        const viaCheckpoint = await withCheckpointOpen(cp, () => text(cp, main));
        assert.strictEqual(viaCheckpoint, await text(a, main));
        assert.strictEqual(await runSql('postgres', `SELECT datallowconn::text FROM pg_database WHERE datname = ${sqlText(cp)};`), 'false');
    });

    test('a window action is read through its custom table', async () => {
        const read = await text(a, { kind: 'xmlid', module: 'base', name: 'action_partner_form' });
        assert.match(read, /^res_model: res\.partner$/m);
        assert.match(read, /^view_mode: /m);
    });

    test('an attachment binary shows its size and hash', async () => {
        await runSql(a, `INSERT INTO ir_attachment (name, res_model, res_field, res_id, type, file_size, checksum, store_fname)
            SELECT 'res.partner image_1920', 'res.partner', 'image_1920', res_id, 'binary', 7, repeat('ab', 20), 'ab/abab'
            FROM ir_model_data WHERE module = 'base' AND name = 'main_partner';`);
        assert.match(await text(a, main), /^image_1920: 7 bytes, sha1 abababababab$/m);
    });

    test('a model without a table is explained', async () => {
        assert.deepStrictEqual(await readRecord(a, { kind: 'id', model: 'ir.qweb', id: 1 }, runSql),
            { error: `ir.qweb has no table in ${a} (an abstract or transient model?).`, code: 'no-table' });
        assert.deepStrictEqual(await readRecord(a, { kind: 'xmlid', module: 'base', name: "nope'" }, runSql),
            { error: `base.nope' does not exist in ${a}.`, code: 'missing' });
    });
});
