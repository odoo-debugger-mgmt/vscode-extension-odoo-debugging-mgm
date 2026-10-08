import * as assert from 'assert';
import { createHash } from 'node:crypto';
import { fieldsSql, parseRecordRef, readRecord, renderRecord, rowSql, xmlidSql } from '../services/compare/recordCompare';

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
        assert.deepStrictEqual(none, { error: 'sale.x does not exist in d.' });
        const noTable = await readRecord('d', { kind: 'id', model: 'ir.qweb', id: 1 }, fake([]));
        assert.deepStrictEqual(noTable, { error: 'ir.qweb has no table in d (an abstract or transient model?).' });
        const ok = await readRecord('d', { kind: 'xmlid', module: 'base', name: 'p' }, fake([
            [/FROM ir_model_data/, 'res.partner|3'],
            [/FROM ir_model_fields/, 'name|char\nid|integer'],
            [/row_to_json/, '{"id":3,"name":"Bob"}']
        ]));
        assert.deepStrictEqual(ok, { model: 'res.partner', id: 3, text: 'id: 3\nname: Bob\n' });
        const gone = await readRecord('d', { kind: 'id', model: 'res.partner', id: 9 }, fake([[/FROM ir_model_fields/, 'id|integer']]));
        assert.deepStrictEqual(gone, { error: 'res.partner,9 does not exist in d.' });
    });

    test('user text reaches SQL only as hex or a quoted identifier', () => {
        const sql = xmlidSql({ kind: 'xmlid', module: "m'; DROP TABLE x;--", name: "n'" });
        assert.ok(!sql.includes("m'") && !sql.includes('DROP'), sql);
        const fields = fieldsSql("a.b'c");
        assert.ok(!fields.includes("b'c"), fields);
        assert.ok(fields.includes('current_schema()'));
        assert.strictEqual(rowSql('res.partner', 3, ['id', 'na"me']), 'SELECT row_to_json(t) FROM (SELECT "id", "na""me" FROM "res_partner" WHERE id = 3) t;');
        assert.throws(() => rowSql('res.partner', NaN, ['id']));
    });
});
