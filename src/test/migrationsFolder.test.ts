import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    bumpVersion, compareVersions, isVersionFolder, manifestVersion, needsManifestBump, seriesOf, setManifestVersion, withSeries, writeScriptToFolder
} from '../services/views/migrationsFolder';
import { parseScript, type ScriptView } from '../services/views/upgradeScript';

function view(id: number, arch: string | null = `<data id="${id}"/>`): ScriptView {
    return { id, xmlid: `acme.v${id}`, model: 'res.partner', type: 'form', name: `v${id}`, listedIn: [], dbName: 'shop', arch, why: arch === null ? 'noted' : null };
}

suite('Migrations folder', () => {
    let dir: string;
    setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-migrations-')); });
    teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('reads and bumps the manifest version', () => {
        assert.strictEqual(manifestVersion("{\n    'name': 'Acme',\n    'version': '17.0.1.0.3',\n}"), '17.0.1.0.3');
        assert.strictEqual(manifestVersion('{"version": "1.2"}'), '1.2');
        assert.strictEqual(manifestVersion("{'name': 'Acme'}"), undefined);
        assert.strictEqual(bumpVersion('17.0.1.0.3'), '17.0.1.0.4');
        assert.strictEqual(bumpVersion('17.0.1.0.9'), '17.0.1.0.10');
        assert.strictEqual(bumpVersion(undefined), '1.1');
        assert.strictEqual(bumpVersion('1'), '1.1');
        assert.strictEqual(bumpVersion('17.0.1.0.0-beta'), undefined);
    });

    test('accepts only plain version folders', () => {
        for (const ok of ['1.1', '18.0.1.0.1', '1.0.0']) {
            assert.ok(isVersionFolder(ok), ok);
        }
        for (const bad of ['', '1', '../1.0', '1.0/..', '1.0 ', 'saas~17.2.1', '1..0', '1.0.0.0.0.0.0']) {
            assert.ok(!isVersionFolder(bad), bad);
        }
    });

    test('compares versions the way Odoo decides whether a migration runs', () => {
        assert.strictEqual(seriesOf('17.0'), '17.0');
        assert.strictEqual(seriesOf('saas-17.4'), 'saas~17.4');
        assert.strictEqual(seriesOf('master'), undefined);
        assert.strictEqual(withSeries('1.1', '18.0'), '18.0.1.1');
        assert.strictEqual(withSeries('18.0.1.0.1', '18.0'), '18.0.1.0.1');
        assert.strictEqual(compareVersions('18.0.1.0', '18.0.1.0.0'), 0);
        assert.ok(compareVersions('18.0.1.0.10', '18.0.1.0.9') > 0);
        assert.ok(needsManifestBump('18.0.1.0.1', '18.0.1.0.0', '18.0'));
        assert.ok(needsManifestBump('1.1', undefined, '18.0'));
        assert.ok(needsManifestBump('18.0.1.0.1', '1.0', '18.0'));
        assert.ok(!needsManifestBump('18.0.1.0.1', '18.0.1.0.1', '18.0'));
        assert.ok(!needsManifestBump('1.0.1', '1.0.2', undefined));
    });

    test('sets the manifest version, keeping its quotes, or adds one', () => {
        assert.strictEqual(setManifestVersion("{\n    'version': '1.0',\n}", '1.1'), "{\n    'version': '1.1',\n}");
        assert.strictEqual(setManifestVersion('{"version" : "1.0"}', '1.1'), '{"version" : "1.1"}');
        assert.strictEqual(setManifestVersion("# -*- coding -*-\n{\n    'name': 'Acme',\n}", '1.1'), "# -*- coding -*-\n{\n    'version': '1.1',\n    'name': 'Acme',\n}");
        assert.throws(() => setManifestVersion('nothing here', '1.1'));
    });

    test('writes a new end-update_views.py, creating the folder', async () => {
        const folder = path.join(dir, 'migrations', '18.0.1.0.1');
        const written = await writeScriptToFolder(folder, [view(1)]);
        assert.deepStrictEqual(written, { path: path.join(folder, 'end-update_views.py'), merged: false });
        assert.ok(parseScript(fs.readFileSync(written.path, 'utf-8')));
    });

    test('merges into the script already there, replacing a view it lists', async () => {
        await writeScriptToFolder(dir, [view(1), view(2, null)]);
        const written = await writeScriptToFolder(dir, [view(1, '<data>new</data>'), view(3)]);
        assert.deepStrictEqual(written, { path: path.join(dir, 'end-update_views.py'), merged: true });
        const parsed = parseScript(fs.readFileSync(written.path, 'utf-8'))!;
        assert.deepStrictEqual(parsed.views.map(entry => entry.key), ['acme.v1', 'acme.v3']);
        assert.ok(parsed.views[0].text.includes('<data>new</data>'));
        assert.deepStrictEqual(parsed.activate.map(entry => entry.key), ['acme.v2']);
    });

    test('never overwrites a file it cannot parse back: the first parseable or free sibling is used', async () => {
        const own = path.join(dir, 'end-update_views.py');
        fs.writeFileSync(own, 'def migrate(cr, version):\n    pass\n');
        const second = await writeScriptToFolder(dir, [view(1)]);
        assert.deepStrictEqual(second, { path: path.join(dir, 'end-update_views_2.py'), merged: false });
        assert.strictEqual(fs.readFileSync(own, 'utf-8'), 'def migrate(cr, version):\n    pass\n');
        const third = await writeScriptToFolder(dir, [view(2)]);
        assert.deepStrictEqual(third, { path: path.join(dir, 'end-update_views_2.py'), merged: true });
    });

    test('a file saved with Windows line ends is still merged', async () => {
        const first = await writeScriptToFolder(dir, [view(1)]);
        fs.writeFileSync(first.path, fs.readFileSync(first.path, 'utf-8').replace(/\n/g, '\r\n'));
        const again = await writeScriptToFolder(dir, [view(2)]);
        assert.deepStrictEqual(again, { path: first.path, merged: true });
    });

    test('refuses to write nothing', async () => {
        await assert.rejects(writeScriptToFolder(dir, []));
    });
});
