import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runningByVersion, type RunningInstance } from '../services/runningState';

interface MenuEntry { command: string; when?: string; group?: string }
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
const itemMenus = manifest.contributes.menus['view/item/context'] as MenuEntry[];
const commands = (manifest.contributes.commands as Array<{ command: string; title: string }>);

suite('Alongside menus', () => {
    const ids = ['dbSelector.runAlongside', 'dbSelector.runAlongsideNoDebug', 'dbSelector.stopServer'];

    test('contributed, with the titles the spec names', () => {
        const titles = new Map(commands.map(c => [c.command, c.title]));
        assert.strictEqual(titles.get('dbSelector.runAlongside'), 'Run Alongside');
        assert.strictEqual(titles.get('dbSelector.runAlongsideNoDebug'), 'Run Alongside Without Debugging');
        assert.strictEqual(titles.get('dbSelector.stopServer'), 'Stop Server');
    });

    test('on database rows, in the run group, never inline, never hidden by upgrade mode', () => {
        for (const id of ids) {
            const entries = itemMenus.filter(entry => entry.command === id);
            assert.ok(entries.length > 0, `${id} has no row menu entry`);
            for (const entry of entries) {
                assert.ok(/viewItem == database\b/.test(entry.when ?? ''), entry.when);
                assert.ok(!(entry.when ?? '').includes('upgrade_enabled'), entry.when);
                assert.ok(entry.group?.startsWith('2_run'), entry.group);
            }
        }
    });

    test('a version row describes its primary run, whatever the order', () => {
        const primary = { versionId: 'v1', dbName: 'a', kind: 'primary' } as RunningInstance;
        const legacy = { versionId: 'v2', dbName: 'c' } as RunningInstance;
        const alongside = { versionId: 'v1', dbName: 'b', kind: 'alongside' } as RunningInstance;
        for (const list of [[primary, alongside, legacy], [alongside, primary, legacy]]) {
            const map = runningByVersion(list);
            assert.strictEqual(map.get('v1'), primary);
            assert.strictEqual(map.get('v2'), legacy);
        }
        assert.strictEqual(runningByVersion([alongside]).get('v1'), alongside);
    });
});
