import * as assert from 'assert';
import {
    DEFAULT_HEADER, entryKey, mergeEntries, newScript, newScriptFile, parseScript, renderScript, scriptEntry, type ScriptView
} from '../services/views/upgradeScript';
import { hasPython, runScript } from './helpers/pythonScript';

function view(id: number, overrides: Partial<ScriptView> = {}): ScriptView {
    return {
        id, xmlid: `acme.view_${id}`, model: 'res.partner', type: 'form', name: `Partner form ${id}`,
        listedIn: ['18.0'], dbName: 'shop-18', arch: `<data><field name="f${id}"/></data>`, why: null, ...overrides
    };
}

const AWKWARD_ARCH = '<data>\n  <!-- a\\b """quoted""" and "" "-->\n  <field name="x" string="Prénom ✓ \\n"/>\n</data>"';

suite('Upgrade script', function () {
    suiteSetup(function () {
        if (!hasPython()) {
            this.skip();
        }
    });

    test('is valid Python with the expected shape', () => {
        const source = newScript([view(1), view(2, { arch: null, why: 'noted' })]);
        assert.ok(source.startsWith('from lxml import etree\n\nfrom odoo.upgrade import util\n\n'));
        assert.ok(source.includes(`${DEFAULT_HEADER}\n\nACTIVATE = [\n`));
        assert.ok(source.includes(']\n\nVIEWS = [\n'));
        assert.ok(source.includes(']\n\n\ndef migrate(cr, version):\n'));
        const run = runScript(source, { 'acme.view_2': 42 });
        assert.deepStrictEqual(run.ACTIVATE, ['acme.view_2']);
        assert.strictEqual(run.VIEWS?.length, 1);
    });

    test('the header says what it is for and what it needs', () => {
        assert.match(DEFAULT_HEADER, /View Doctor/);
        assert.match(DEFAULT_HEADER, /upgrade-util/);
        assert.match(DEFAULT_HEADER, /end-/);
        assert.ok(DEFAULT_HEADER.split('\n').every(line => line.startsWith('#')));
    });

    test('each view is labelled for the reviewer, with its database and the upgrades that disabled it', () => {
        const source = newScript([view(1, { listedIn: ['17.0', '18.0'] })]);
        assert.ok(source.includes('# res.partner form — id 1 in shop-18 (disabled by the 17.0 and 18.0 upgrades)\n'));
        assert.ok(source.includes('# Partner form 1\n'));
        const three = newScript([view(1, { listedIn: ['16.0', '17.0', '18.0'] })]);
        assert.ok(three.includes('(disabled by the 16.0, 17.0 and 18.0 upgrades)'));
        assert.ok(!newScript([view(1, { listedIn: [] })]).includes('disabled by'));
    });

    test('replaces the whole arch of every view, by external id or by id, and always activates', () => {
        const run = runScript(newScript([view(1), view(2, { xmlid: null })]));
        assert.deepStrictEqual(run.edits, [
            // The literal ends with the newline before its closing quotes; etree ignores it.
            ['acme.view_1', null, { skip_if_not_noupdate: false, active: true }, '<data><field name="f1"/></data>\n'],
            [null, 2, { skip_if_not_noupdate: false, active: true }, '<data><field name="f2"/></data>\n']
        ]);
    });

    test('a view that cannot be found is skipped and the rest still apply', () => {
        const run = runScript(newScript([view(1), view(2)]), {}, ['acme.view_1']);
        assert.deepStrictEqual(run.edits.map(edit => edit[0]), ['acme.view_2']);
    });

    test('views without an external id say so, and name their database', () => {
        const source = newScript([view(5, { xmlid: null }), view(6, { xmlid: null, arch: null, why: 'not-edited' })]);
        assert.strictEqual(source.split('# NOTE: no xml_id, so this view is addressed by database id — valid in shop-18 only.').length, 3);
        assert.ok(source.includes('"view_id": 5,'));
        assert.ok(source.includes('    6,\n'));
    });

    test('an awkward arch survives the round trip exactly', () => {
        const run = runScript(newScript([view(1, { arch: AWKWARD_ARCH })]));
        assert.strictEqual(run.VIEWS?.[0].arch, `${AWKWARD_ARCH.trim()}\n`);
        assert.strictEqual(run.edits[0][3], `${AWKWARD_ARCH.trim()}\n`);
    });

    test('carriage returns in an arch become plain line ends', () => {
        const run = runScript(newScript([view(1, { arch: '<data>\r\n<a/>\r<b/></data>' })]));
        assert.strictEqual(run.VIEWS?.[0].arch, '<data>\n<a/>\n<b/></data>\n');
    });

    test('an awkward external id survives the round trip exactly', () => {
        const xmlid = 'studio_customization.odoo_studio_"quote"\\é';
        const run = runScript(newScript([view(1, { xmlid }), view(2, { xmlid: `${xmlid}2`, arch: null, why: 'noted' })]), { [`${xmlid}2`]: 2 });
        assert.strictEqual(run.VIEWS?.[0].xmlid, xmlid);
        assert.deepStrictEqual(run.ACTIVATE, [`${xmlid}2`]);
    });

    test('a hostile view name cannot inject code, in either list', () => {
        const name = 'x\nimport os; os.system("boom")\r\u2028y\u0085z';
        const source = newScript([view(1, { name, model: 'a\nb', listedIn: ['18.0\nimport os'] }), view(2, { name, arch: null, why: 'noted' })]);
        const run = runScript(source, { 'acme.view_2': 2 });
        assert.strictEqual(run.edits.length, 1);
        assert.ok(!/^import os/m.test(source));
    });

    test('long names are truncated in the comment', () => {
        const source = newScript([view(1, { name: 'é'.repeat(300) })]);
        assert.ok(source.includes(`# ${'é'.repeat(99)}…\n`));
    });

    test('the output is deterministic', () => {
        const views = [view(1), view(2, { arch: null, why: 'not-edited' })];
        assert.strictEqual(newScript(views), newScript(views));
    });

    test('nothing to write is an error, not an empty script', () => {
        assert.throws(() => newScript([]));
    });

    test('a view with a blank arch is refused', () => {
        assert.throws(() => scriptEntry(view(1, { arch: '  \n ' })), /view 1 has no arch/);
    });

    test('an unedited view is only re-enabled and carries no arch, by external id or by id', () => {
        const source = newScript([view(1, { arch: null, why: 'noted' }), view(2, { xmlid: null, arch: null, why: 'not-edited' })]);
        assert.ok(!source.includes('lxml'));
        assert.ok(!source.includes('VIEWS = ['));
        assert.ok(!source.includes('edit_view'));
        const run = runScript(source, { 'acme.view_1': 11 });
        assert.deepStrictEqual(run.executed, [
            ['UPDATE ir_ui_view SET active = true WHERE id = %s', [11]],
            ['UPDATE ir_ui_view SET active = true WHERE id = %s', [2]]
        ]);
    });

    test('an unedited view missing from the target is skipped quietly', () => {
        const run = runScript(newScript([view(1, { arch: null, why: 'noted' })]), {});
        assert.deepStrictEqual(run.executed, []);
    });

    test('each unedited view says why it needs no arch', () => {
        const source = newScript([view(1, { arch: null, why: 'noted' }), view(2, { arch: null, why: 'not-edited' })]);
        assert.ok(source.includes('# arch unchanged since it was noted — only re-enabled\n'));
        assert.ok(source.includes('# arch never edited in the database — only re-enabled\n'));
    });

    test('a file the extension wrote parses back into the same file', () => {
        const file = mergeEntries(newScriptFile(), [view(1), view(2, { xmlid: null, arch: AWKWARD_ARCH }), view(3, { arch: null, why: 'noted' })].map(scriptEntry));
        const source = renderScript(file);
        assert.deepStrictEqual(parseScript(source), file);
        assert.deepStrictEqual(parseScript(source.replace(/\n/g, '\r\n')), file);
        const viewsOnly = newScript([view(1)]);
        assert.strictEqual(renderScript(parseScript(viewsOnly)!), viewsOnly);
        const activateOnly = newScript([view(1, { arch: null, why: 'noted' })]);
        assert.strictEqual(renderScript(parseScript(activateOnly)!), activateOnly);
    });

    test('a comment edited inside an entry, or in the header, survives a merge', () => {
        const source = newScript([view(1), view(2, { arch: null, why: 'noted' })])
            .replace('# Partner form 1\n', '# Partner form 1\n        # reviewed by Ahmad\n')
            .replace(DEFAULT_HEADER, `${DEFAULT_HEADER}\n# Ticket 1234567`);
        const parsed = parseScript(source);
        assert.ok(parsed);
        const merged = renderScript(mergeEntries(parsed, [scriptEntry(view(3))]));
        assert.ok(merged.includes('# reviewed by Ahmad'));
        assert.ok(merged.includes('# Ticket 1234567'));
    });

    test('anything changed outside the entries makes the file not ours', () => {
        const source = newScript([view(1), view(2, { arch: null, why: 'noted' })]);
        const edits = [
            source.replace('def migrate(cr, version):\n', 'def migrate(cr, version):\n    util.remove_view(cr, "x")\n'),
            source.replace('"xmlid": "acme.view_1",', '"xmlid": \'acme.view_1\','),
            source.replace('    "acme.view_2",\n', '    "acme.view_2",\n    # trailing\n'),
            source.replace('from odoo.upgrade import util\n', 'from odoo.upgrade import util\nimport os\n'),
            `${source}\nprint(1)\n`,
            'def migrate(cr, version):\n    pass\n',
            ''
        ];
        for (const edited of edits) {
            assert.strictEqual(parseScript(edited), undefined, edited);
        }
    });

    test('an arch hiding a fake closing quote is read to its real end', () => {
        const arch = '<data>"""""\n    },\n]\n</data>';
        const source = newScript([view(1, { arch }), view(2)]);
        const parsed = parseScript(source);
        assert.deepStrictEqual(parsed?.views.map(entry => entry.key), ['acme.view_1', 'acme.view_2']);
    });

    test('merging replaces a view already listed instead of duplicating it, and moves it between lists', () => {
        const file = mergeEntries(newScriptFile(), [view(1), view(2, { arch: null, why: 'noted' }), view(3)].map(scriptEntry));
        const merged = mergeEntries(file, [
            scriptEntry(view(1, { arch: '<data>new</data>' })),
            scriptEntry(view(2, { arch: '<data>edited</data>' })),
            scriptEntry(view(3, { arch: null, why: 'not-edited' })),
            scriptEntry(view(4))
        ]);
        assert.deepStrictEqual(merged.views.map(entry => entry.key), ['acme.view_1', 'acme.view_2', 'acme.view_4']);
        assert.deepStrictEqual(merged.activate.map(entry => entry.key), ['acme.view_3']);
        assert.ok(merged.views[0].text.includes('<data>new</data>'));
        const run = runScript(renderScript(merged), { 'acme.view_3': 3 });
        assert.strictEqual(run.edits.length, 3);
        assert.strictEqual(run.executed.length, 1);
    });

    test('entries are keyed by external id, or by id without one', () => {
        assert.strictEqual(entryKey({ id: 4, xmlid: 'a.b' }), 'a.b');
        assert.strictEqual(entryKey({ id: 4, xmlid: null }), 'id:4');
        assert.strictEqual(scriptEntry(view(4, { xmlid: null })).key, 'id:4');
    });
});
