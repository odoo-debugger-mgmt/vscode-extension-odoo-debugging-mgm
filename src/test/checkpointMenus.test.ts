import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface MenuEntry { command: string; when?: string; group?: string }

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
const itemMenus = manifest.contributes.menus['view/item/context'] as MenuEntry[];
const palette = manifest.contributes.menus.commandPalette as MenuEntry[];
const commands = (manifest.contributes.commands as Array<{ command: string }>).map(entry => entry.command);

suite('Checkpoint menus', () => {
    const ids = ['dbSelector.createCheckpoint', 'dbSelector.restoreCheckpoint', 'dbSelector.renameCheckpoint', 'dbSelector.deleteCheckpoint'];

    test('every checkpoint command is contributed', () => {
        for (const id of ids) {
            assert.ok(commands.includes(id), `${id} is not in contributes.commands`);
        }
    });

    test('Create is on database rows, inline and in the menu', () => {
        const entries = itemMenus.filter(entry => entry.command === 'dbSelector.createCheckpoint');
        assert.ok(entries.some(entry => entry.group?.startsWith('inline')));
        assert.ok(entries.some(entry => !entry.group?.startsWith('inline')));
        for (const entry of entries) {
            assert.ok(/viewItem == database\b/.test(entry.when ?? ''), entry.when);
        }
    });

    test('Restore, Rename and Delete are on checkpoint rows only, never inline, never in the palette', () => {
        for (const id of ids.slice(1)) {
            const entries = itemMenus.filter(entry => entry.command === id);
            assert.ok(entries.length > 0, `${id} has no row menu entry`);
            for (const entry of entries) {
                assert.ok(/viewItem == checkpoint\b/.test(entry.when ?? ''), `${id}: ${entry.when}`);
                assert.ok(!entry.group?.startsWith('inline'), `${id} must not be inline`);
            }
            assert.ok(palette.some(entry => entry.command === id && entry.when === 'false'), `${id} must be hidden from the palette`);
        }
    });

    test('Delete Checkpoint is in the danger group', () => {
        const entry = itemMenus.find(item => item.command === 'dbSelector.deleteCheckpoint');
        assert.ok(entry?.group?.startsWith('9_danger'));
    });
});
