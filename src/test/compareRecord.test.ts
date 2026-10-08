import * as assert from 'assert';
import { createHash } from 'node:crypto';
import { sqlText } from '../services/views/viewQueries';
import { attachmentsSql, fieldsSql, storedCountSql, tableOf, parseRecordRef, planSides, readRecord, renderRecord, rowSql, xmlidSql } from '../services/compare/recordCompare';

suite('Compare a record', () => {
    test('parses an external id and model with id', () => {
        assert.deepStrictEqual(parseRecordRef('sale.order_1'), { kind: 'xmlid', module: 'sale', name: 'order_1' });
        for (const text of ['res.partner,3', 'res.partner 3', 'res.partner(3)', ' res.partner , 3 ']) {
            assert.deepStrictEqual(parseRecordRef(text), { kind: 'id', model: 'res.partner', id: 3 }, text);
        }
        for (const text of ['', 'junk', "res.partner,3'", 'res.partner,0', "a'b.c", 'res.partner(3', 'res.partner,-1']) {
            assert.strictEqual(parseRecordRef(text), undefined, text);
        }
    });

    test('renders sorted lines, translations, binaries, nulls and ids', () => {
        const sha = createHash('sha1').update(Buffer.from('hello')).digest('hex').slice(0, 12);
        const text = renderRecord(
            [{ name: 'name', ttype: 'char' }, { name: 'a_title', ttype: 'char' }, { name: 'old', ttype: 'char' }, { name: 'img', ttype: 'binary' },
                { name: 'raw', ttype: 'binary' }, { name: 'none', ttype: 'char' }, { name: 'partner_id', ttype: 'many2one' }, { name: 'active', ttype: 'boolean' }],
            { name: { en_US: 'Hello', fr_FR: 'Bonjour' }, a_title: { fr_FR: 'Salut' }, old: 'plain', img: Buffer.from('hello').toString('base64'),
                raw: '\\x' + Buffer.from('hello').toString('hex'), none: null, partner_id: 7, active: true },
            'note'
        );
        assert.strictEqual(text, [
            'a_title: Salut', 'active: True', `img: 5 bytes, sha1 ${sha}`, 'name: Hello', 'none: False', 'old: plain',
            'partner_id: 7', `raw: 5 bytes, sha1 ${sha}`
        ].join('\n') + '\n');
        assert.strictEqual(renderRecord([{ name: 'name', ttype: 'char' }], undefined, '(no such record in db)'), '(no such record in db)\n');
    });

    const fake = (answers: Array<[RegExp, string]>) => async (_db: string, sql: string) => answers.find(([re]) => re.test(sql))?.[1] ?? '';

    test('readRecord explains a missing record and a missing table, and reads a found one', async () => {
        const none = await readRecord('d', { kind: 'xmlid', module: 'sale', name: 'x' }, fake([]));
        assert.deepStrictEqual(none, { error: 'sale.x does not exist in d.', code: 'missing' });
        const noTable = await readRecord('d', { kind: 'id', model: 'ir.qweb', id: 1 }, fake([]));
        assert.deepStrictEqual(noTable, { error: 'ir.qweb has no table in d (an abstract or transient model?).', code: 'no-table' });
        const ok = await readRecord('d', { kind: 'xmlid', module: 'base', name: 'p' }, fake([
            [/FROM ir_model_data/, 'res.partner|3'],
            [/FROM ir_model_fields/, 'name|char\nid|integer'],
            [/row_to_json/, '{"id":3,"name":"Bob"}']
        ]));
        assert.deepStrictEqual(ok, { model: 'res.partner', id: 3, text: 'id: 3\nname: Bob\n' });
        const gone = await readRecord('d', { kind: 'id', model: 'res.partner', id: 9 }, fake([[/FROM ir_model_fields/, 'id|integer']]));
        assert.deepStrictEqual(gone, { error: 'res.partner,9 does not exist in d.', code: 'missing' });
    });

    test('user text reaches SQL only as hex or a quoted identifier', () => {
        const sql = xmlidSql({ kind: 'xmlid', module: "m'; DROP TABLE x;--", name: "n'" });
        assert.ok(!sql.includes("m'") && !sql.includes('DROP'), sql);
        assert.ok(sql.includes(sqlText("m'; DROP TABLE x;--")) && sql.includes(sqlText("n'")), sql);
        assert.ok(fieldsSql("a.b'c").includes(sqlText("a.b'c")) && fieldsSql("a.b'c").includes(sqlText("a_b'c")));
        const fields = fieldsSql("a.b'c");
        assert.ok(!fields.includes("b'c"), fields);
        assert.ok(fields.includes('current_schema()'));
        assert.strictEqual(rowSql('res.partner', 3, ['id', 'na"me']), 'SELECT row_to_json(t) FROM (SELECT "id", "na""me" FROM "res_partner" WHERE id = 3) t;');
        assert.throws(() => rowSql('res.partner', NaN, ['id']));
    });

    test('an object value shows every key unless the field is translatable', () => {
        const text = renderRecord([{ name: 'props', ttype: 'properties' }, { name: 'title', ttype: 'char' }],
            { props: { b: 1, a: { z: 2, y: [3] } }, title: { en_US: 'Hi', fr_FR: 'Salut' } }, '');
        assert.strictEqual(text, 'props: {"a":{"y":[3],"z":2},"b":1}\ntitle: Hi\n');
    });

    test('core action models map to their custom _table; others to the dotted name', () => {
        assert.strictEqual(tableOf('ir.actions.act_window'), 'ir_act_window');
        assert.strictEqual(tableOf('ir.actions.report'), 'ir_act_report_xml');
        assert.strictEqual(tableOf('ir.actions.act_window_close'), 'ir_actions');
        assert.strictEqual(tableOf('res.partner'), 'res_partner');
        assert.ok(fieldsSql('ir.actions.server').includes(sqlText('ir_act_server')));
        assert.ok(rowSql('ir.actions.act_window', 1, ['id']).includes('FROM "ir_act_window"'));
    });

    test('a model with stored fields but no table says so without guessing abstract', async () => {
        const read = await readRecord('d', { kind: 'id', model: 'x.custom', id: 1 }, fake([[/count\(\*\) FROM ir_model_fields/, '4']]));
        assert.deepStrictEqual(read, { error: 'x.custom has stored fields in d, but no table of the expected name (a custom _table?).', code: 'no-table' });
    });

    test('the stored-field count leaves out one2many and many2many, which have no column', () => {
        assert.match(storedCountSql('mail.thread'), /AND store AND ttype NOT IN \('one2many', 'many2many'\);$/);
    });

    test('attachment binaries show size and sha1 beside the columns', async () => {
        const sha = createHash('sha1').update(Buffer.from('img')).digest('hex');
        const read = await readRecord('d', { kind: 'id', model: 'res.partner', id: 3 }, fake([
            [/FROM ir_model_fields/, 'name|char'],
            [/row_to_json/, '{"name":"Bob"}'],
            [/FROM ir_attachment/, `image_1920|3|${sha}\nimage_128|3|${sha}`]
        ]));
        assert.deepStrictEqual(read, { model: 'res.partner', id: 3, text: `image_128: 3 bytes, sha1 ${sha.slice(0, 12)}\nimage_1920: 3 bytes, sha1 ${sha.slice(0, 12)}\nname: Bob\n` });
        const sql = attachmentsSql("a.b'c", 3);
        assert.ok(sql.includes(sqlText("a.b'c")) && sql.includes('res_id = 3') && !sql.includes("b'c'"), sql);
        assert.throws(() => attachmentsSql('a.b', 0));
    });

    test('a company-dependent object shows every key; a translation only its language', () => {
        const text = renderRecord([{ name: 'code', ttype: 'char' }], { code: { '1': '100', '2': '200' } }, '');
        assert.strictEqual(text, 'code: {"1":"100","2":"200"}\n');
    });

    test('a long text value is an indented block, a short one stays on its line', () => {
        const text = renderRecord([{ name: 'arch', ttype: 'html' }, { name: 'name', ttype: 'char' }], { arch: '<a>\n  <b/>\n</a>\n', name: 'x' }, '');
        assert.strictEqual(text, 'arch:\n    <a>\n      <b/>\n    </a>\nname: x\n');
    });

    test('planSides gives a message when the model is missing on one side and the record on the other', () => {
        const missing = { error: 'm.x,1 does not exist in A.', code: 'missing' as const };
        const noTable = { error: 'm.x has no table in B.', code: 'no-table' as const };
        assert.deepStrictEqual(planSides(missing, noTable, 'A', 'B', 'm.x,1'),
            { message: 'm.x,1: the model is not installed in B, and the record does not exist in A.' });
        assert.deepStrictEqual(planSides(noTable, missing, 'B', 'A', 'm.x,1'),
            { message: 'm.x,1: the model is not installed in B, and the record does not exist in A.' });
    });

    test('planSides decides what a diff shows', () => {
        const ok = { model: 'm.x', id: 1, text: 'a: 1\n' };
        const missing = { error: 'm.x,1 does not exist in B.', code: 'missing' as const };
        const noTable = { error: 'm.x has no table in B (an abstract or transient model?).', code: 'no-table' as const };
        assert.deepStrictEqual(planSides(ok, noTable, 'A', 'B', 'm.x,1'), { left: 'a: 1\n', right: '(model not installed in B)\n' });
        assert.deepStrictEqual(planSides(ok, missing, 'A', 'B', 'm.x,1'), { left: 'a: 1\n', right: '(no such record in B)\n' });
        assert.deepStrictEqual(planSides(missing, missing, 'A', 'B', 'sale.order_1'), { message: 'sale.order_1 does not exist in A or in B.' });
        assert.deepStrictEqual(planSides(noTable, noTable, 'A', 'B', 'm.x,1'), { message: noTable.error });
    });
});
