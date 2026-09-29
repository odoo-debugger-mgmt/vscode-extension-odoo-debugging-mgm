/**
 * Where the data lives, and the JSON store against real files.
 */
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { dataRootFor, resolveDataLocation } from '../services/dataLocation';
import { JsonFileMainStore } from '../services/mainStore';

suite('Data location', () => {
    test('defaults to the first folder\'s .vscode file, rooted at that folder', () => {
        assert.deepStrictEqual(resolveDataLocation({ firstFolder: '/work/v17' }), {
            file: path.join('/work/v17', '.vscode', 'odoo-debugger-data.json'),
            kind: 'json',
            root: '/work/v17',
            pinned: false
        });
    });

    test('a pinned file roots relative paths at its workspace, not the first folder', () => {
        // The generated project workspace: its first folder is a repository.
        const location = resolveDataLocation({
            configured: '/work/v17/.vscode/odoo-debugger-data.json',
            firstFolder: '/addons/acme'
        });

        assert.strictEqual(location?.file, '/work/v17/.vscode/odoo-debugger-data.json');
        assert.strictEqual(location?.root, '/work/v17');
        assert.strictEqual(location?.pinned, true);
    });

    test('a relative pin resolves against the workspace file', () => {
        const location = resolveDataLocation({
            configured: 'data/store.json',
            workspaceFile: '/ws/project.code-workspace',
            firstFolder: '/addons/acme'
        });

        assert.strictEqual(location?.file, path.join('/ws', 'data/store.json'));
        assert.strictEqual(location?.root, path.join('/ws', 'data'));
    });

    test('a shared .db store is honoured at user level, and relative paths stay the window\'s', () => {
        const location = resolveDataLocation(
            { configuredGlobally: '~/odoo-dev/odoo-devtools.db', firstFolder: '/work/v17' }, '/home/me');

        assert.strictEqual(location?.file, '/home/me/odoo-dev/odoo-devtools.db');
        assert.strictEqual(location?.kind, 'sqlite');
        assert.strictEqual(location?.root, '/work/v17');
    });

    test('a workspace value beats the user-level one', () => {
        const location = resolveDataLocation({
            configured: '/clients/other.db',
            configuredGlobally: '/home/me/odoo-dev/odoo-devtools.db',
            firstFolder: '/work/v17'
        });

        assert.strictEqual(location?.file, '/clients/other.db');
    });

    test('a user-level JSON store is ignored: one JSON file cannot be shared safely', () => {
        const location = resolveDataLocation({ configuredGlobally: '/home/me/data.json', firstFolder: '/work/v17' });

        assert.strictEqual(location?.pinned, false);
        assert.strictEqual(location?.kind, 'json');
    });

    test('a relative user-level store is ignored: it has nothing to be relative to', () => {
        assert.strictEqual(resolveDataLocation({ configuredGlobally: 'odoo.db', firstFolder: '/work/v17' })?.pinned, false);
    });

    test('an unknown kind of file is ignored', () => {
        assert.strictEqual(resolveDataLocation({ configured: '/tmp/store.txt', firstFolder: '/work/v17' })?.pinned, false);
    });

    test('no folder and no usable pin means no data location', () => {
        assert.strictEqual(resolveDataLocation({}), undefined);
        assert.strictEqual(resolveDataLocation({ configured: 'relative.json' }), undefined);
    });

    test('the root of a file outside .vscode is its own directory', () => {
        assert.strictEqual(dataRootFor('/home/me/odoo-dev/data.json'), '/home/me/odoo-dev');
    });
});

suite('JSON main store', () => {
    let dir: string;

    setup(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'odt-store-'));
    });

    teardown(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    test('creates the file, with its directory, when it is missing', async () => {
        const file = path.join(dir, '.vscode', 'odoo-debugger-data.json');
        const store = new JsonFileMainStore(file, dir);

        assert.strictEqual(await store.stat(), undefined);
        const read = await store.read();

        assert.deepStrictEqual(read.data.projects, []);
        assert.ok(read.data.settings, 'a new store carries the default settings block');
        assert.ok(await store.stat());
    });

    test('round-trips what it writes, comments in the file included', async () => {
        const file = path.join(dir, 'data.json');
        await fs.writeFile(file, '{\n  // kept by hand\n  "projects": [{ "name": "Acme" }]\n}');
        const store = new JsonFileMainStore(file, dir);

        assert.strictEqual((await store.read()).data.projects[0].name, 'Acme');

        await store.commit(undefined, { projects: [{ name: 'Renamed' }] } as never);
        assert.strictEqual((await store.read()).data.projects[0].name, 'Renamed');
    });

    test('a file that is not an object is an error, not empty data', async () => {
        const file = path.join(dir, 'data.json');
        await fs.writeFile(file, '[]');
        // `parse('[]')` is an array: reading it as data would wipe the store on the next save.
        const read = new JsonFileMainStore(file, dir).read();

        await assert.rejects(read);
    });
});
