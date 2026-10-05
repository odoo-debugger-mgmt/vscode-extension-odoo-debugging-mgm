import * as assert from 'assert';
import { parseReportMessages, parseViewRows, parseWriteDates, sqlIdList, viewRowsSql, sqlText, viewByXmlidSql, viewsLikeSql } from '../services/views/viewQueries';
import { runSql } from '../services/postgres';

suite('View queries', () => {
    test('embeds only positive integer ids', () => {
        assert.strictEqual(sqlIdList([3, 17, 4096]), '3,17,4096');
        for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
            assert.throws(() => sqlIdList([bad]), /Not a view id/);
        }
    });

    test('bounds the walk to the root so a cycle cannot hang the query', () => {
        const sql = viewRowsSql('v.active = false');
        assert.ok(sql.includes('FROM ir_ui_view v WHERE v.active = false'));
        assert.ok(sql.includes('c.depth < 50'));
        assert.ok(sql.includes("ORDER BY d.module, d.name LIMIT 1"), 'the xmlid Odoo shows');
    });

    test('parses rows, defaulting what the database left null', () => {
        const rows = parseViewRows(JSON.stringify([
            { id: 12, name: 'partner.form.custom', model: 'res.partner', type: 'form', active: false,
                inherit_id: 7, xmlid: 'studio_customization.x', root_id: 7, is_report: false, write_date: 1727000000123 },
            { id: 13, name: 'report_x', model: '', type: 'qweb', active: true,
                inherit_id: null, xmlid: null, root_id: null, is_report: true, write_date: null }
        ]));
        assert.deepStrictEqual(rows[0], {
            id: 12, name: 'partner.form.custom', model: 'res.partner', type: 'form', active: false,
            inheritId: 7, xmlid: 'studio_customization.x', rootId: 7, isReport: false, writeDate: 1727000000123
        });
        assert.strictEqual(rows[1].inheritId, null);
        assert.strictEqual(rows[1].xmlid, null);
        assert.strictEqual(rows[1].rootId, 13, 'a view with no parent is its own root');
        assert.strictEqual(rows[1].writeDate, 0);
        assert.deepStrictEqual(parseViewRows(''), []);
        assert.throws(() => parseViewRows('{"id": 1}'), /Unexpected/);
    });

    test('parses report messages and write dates', () => {
        assert.deepStrictEqual(
            parseReportMessages('[{"id": 4, "date": "2026-10-01", "body": "<h3>Disabled views</h3>"}]'),
            [{ id: 4, body: '<h3>Disabled views</h3>' }]
        );
        assert.deepStrictEqual(parseReportMessages(''), []);
        assert.deepStrictEqual([...parseWriteDates('{"12": 1727000000123, "13": null}')], [[12, 1727000000123], [13, 0]]);
        assert.deepStrictEqual([...parseWriteDates('')], []);
    });
});

suite('View queries over text', () => {
    test('text is hex-encoded, so no quote in it reaches the SQL', () => {
        const evil = "x'); DROP TABLE ir_ui_view; --";
        const sql = viewsLikeSql({ id: 5, model: evil, type: 'form' });
        assert.ok(!sql.includes(evil), sql);
        assert.ok(!sql.includes("x');"), sql);
        assert.ok(sql.includes(`decode('${Buffer.from(evil, 'utf-8').toString('hex')}', 'hex')`));
        assert.ok(sql.includes('v.id = 5 OR'));
        assert.throws(() => viewsLikeSql({ id: -1, model: 'res.partner', type: 'form' }), /Not a view id/);
    });

    test('an external id is split into module and name, and needs both', () => {
        const sql = viewByXmlidSql('studio_customization.odoo_studio_x.y');
        assert.ok(sql?.includes(`d.module = ${sqlText('studio_customization')}`));
        assert.ok(sql?.includes(`d.name = ${sqlText('odoo_studio_x.y')}`));
        assert.strictEqual(viewByXmlidSql('no_dot'), undefined);
        assert.strictEqual(viewByXmlidSql('.name'), undefined);
    });

    test('PostgreSQL reads the text back exactly', async function () {
        const value = "it's — ✓ \\ \"q\"";
        let output: string;
        try {
            output = await runSql('postgres', `SELECT ${sqlText(value)};`);
        } catch {
            this.skip();
            return;
        }
        assert.strictEqual(output, value);
    });
});
