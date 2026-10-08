import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface MenuEntry { command: string; when?: string; group?: string }
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
const itemMenus = manifest.contributes.menus['view/item/context'] as MenuEntry[];
const palette = manifest.contributes.menus.commandPalette as MenuEntry[];
const commands = manifest.contributes.commands as Array<{ command: string; title: string }>;

suite('Partner menus', () => {
    const rowIds = ['dbSelector.setComparisonPartner', 'dbSelector.clearComparisonPartner', 'dbSelector.runPartnerAlongside'];

    test('all four commands are contributed with the titles the spec names', () => {
        const titles = new Map(commands.map(c => [c.command, c.title]));
        assert.strictEqual(titles.get('dbSelector.setComparisonPartner'), 'Set Comparison Partner…');
        assert.strictEqual(titles.get('dbSelector.clearComparisonPartner'), 'Clear Comparison Partner');
        assert.strictEqual(titles.get('dbSelector.runPartnerAlongside'), 'Run Partner Alongside');
        assert.ok(titles.has('dbSelector.runPairAlongside'));
    });

    test('on database rows, in the compare group, never inline, never hidden by upgrade mode', () => {
        for (const id of rowIds) {
            const entries = itemMenus.filter(entry => entry.command === id);
            assert.ok(entries.length > 0, `${id} has no row menu entry`);
            for (const entry of entries) {
                assert.ok(/view == dbSelector && viewItem == database\b/.test(entry.when ?? ''), entry.when);
                assert.ok(!(entry.when ?? '').includes('upgrade_enabled'), entry.when);
                assert.ok(entry.group?.startsWith('3_compare'), entry.group);
            }
        }
    });

    test('runPairAlongside is palette-hidden and has no row entry', () => {
        const entries = palette.filter(entry => entry.command === 'dbSelector.runPairAlongside');
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].when, 'false');
        assert.strictEqual(itemMenus.filter(entry => entry.command === 'dbSelector.runPairAlongside').length, 0);
    });
});
