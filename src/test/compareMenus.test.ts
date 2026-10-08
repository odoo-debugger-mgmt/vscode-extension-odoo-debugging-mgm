import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface MenuEntry { command: string; when?: string; group?: string }
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
const menu = (name: string, command: string) =>
    ((manifest.contributes.menus[name] ?? []) as MenuEntry[]).filter(entry => entry.command === command);
const titles = new Map((manifest.contributes.commands as Array<{ command: string; title: string }>).map(c => [c.command, c.title]));

suite('Compare menus', () => {
    test('the titles', () => {
        assert.strictEqual(titles.get('odoo.compareFileWithPartner'), 'Compare with Partner');
        assert.strictEqual(titles.get('odoo.compareModuleWithPartner'), 'Compare Module with Partner');
        assert.strictEqual(titles.get('odoo.compareThisWithPartner'), 'Compare This with Partner');
    });

    test('compare this: editor context for .py and .xml, not hidden in upgrade mode', () => {
        const entries = menu('editor/context', 'odoo.compareThisWithPartner');
        assert.strictEqual(entries.length, 1);
        assert.ok((entries[0].when ?? '').includes('odoo-debugger.is_active'));
        assert.ok((entries[0].when ?? '').includes('resourceExtname =~ /^\\.(py|xml)$/'), entries[0].when);
        assert.ok(!(entries[0].when ?? '').includes('upgrade_enabled'));
        assert.strictEqual(entries[0].group, 'odoo@5');
    });

    test('the editor right-click entries honour editorActions.enabled', () => {
        for (const id of ['odoo.compareFileWithPartner', 'odoo.compareThisWithPartner']) {
            assert.ok((menu('editor/context', id)[0].when ?? '').includes('config.odooDebugger.editorActions.enabled'), id);
        }
    });

    test('file compare: editor title (not inline), editor context, explorer files', () => {
        const title = menu('editor/title', 'odoo.compareFileWithPartner');
        assert.strictEqual(title.length, 1);
        assert.ok(!title[0].group?.startsWith('navigation'), title[0].group);
        assert.strictEqual(menu('editor/context', 'odoo.compareFileWithPartner').length, 1);
        const explorer = menu('explorer/context', 'odoo.compareFileWithPartner');
        assert.strictEqual(explorer.length, 1);
        assert.ok((explorer[0].when ?? '').includes('!explorerResourceIsFolder'));
    });

    test('module compare: module rows and explorer folders', () => {
        const rows = menu('view/item/context', 'odoo.compareModuleWithPartner');
        assert.strictEqual(rows.length, 1);
        assert.ok(/view == moduleSelector && viewItem == module\b/.test(rows[0].when ?? ''), rows[0].when);
        const explorer = menu('explorer/context', 'odoo.compareModuleWithPartner');
        assert.strictEqual(explorer.length, 1);
        assert.ok(/(^|[^!])explorerResourceIsFolder/.test(explorer[0].when ?? ''));
    });

    test('neither is hidden in upgrade mode', () => {
        for (const id of ['odoo.compareFileWithPartner', 'odoo.compareModuleWithPartner']) {
            for (const name of ['editor/title', 'editor/context', 'explorer/context', 'view/item/context']) {
                for (const entry of menu(name, id)) {
                    assert.ok(!(entry.when ?? '').includes('upgrade_enabled'), entry.when);
                }
            }
        }
    });
});
