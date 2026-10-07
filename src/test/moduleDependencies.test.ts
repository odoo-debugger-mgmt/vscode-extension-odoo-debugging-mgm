import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ModuleLocator, dependencyExpansion } from '../services/moduleDependencies';

async function addModule(addonsDir: string, name: string, depends: string[] = []): Promise<string> {
    const dir = path.join(addonsDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
        path.join(dir, '__manifest__.py'),
        `{'name': '${name}', 'depends': [${depends.map(dep => `'${dep}'`).join(', ')}]}`,
        'utf-8'
    );
    return dir;
}

suite('Module dependency locator', () => {
    let root: string;
    let core: string;
    let enterprise: string;

    setup(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'odoo-deps-test-'));
        core = path.join(root, 'odoo', 'addons');
        enterprise = path.join(root, 'enterprise');
        await fs.mkdir(core, { recursive: true });
        await fs.mkdir(enterprise, { recursive: true });
    });

    teardown(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    test('finds a project module by name', async () => {
        const own = await addModule(path.join(root, 'project'), 'my_sale');
        const locator = new ModuleLocator(new Map([['my_sale', own]]), [core]);
        assert.deepStrictEqual(await locator.locate('my_sale'), { name: 'my_sale', path: own, source: 'project' });
    });

    test('finds a core module in the addons folders, in addons-path order', async () => {
        const inEnterprise = await addModule(enterprise, 'account_reports');
        await addModule(core, 'account_reports');
        const locator = new ModuleLocator(new Map(), [enterprise, core]);
        assert.deepStrictEqual(
            await locator.locate('account_reports'),
            { name: 'account_reports', path: inEnterprise, source: 'core' }
        );
    });

    test('a core folder wins over a project module of the same name, as at launch', async () => {
        const inCore = await addModule(core, 'sale');
        const own = await addModule(path.join(root, 'project'), 'sale');
        const locator = new ModuleLocator(new Map([['sale', own]]), [core]);
        assert.strictEqual((await locator.locate('sale')).path, inCore);
    });

    test('a folder without a manifest is not a module', async () => {
        await fs.mkdir(path.join(core, 'not_a_module'), { recursive: true });
        const locator = new ModuleLocator(new Map(), [core]);
        assert.deepStrictEqual(await locator.locate('not_a_module'), { name: 'not_a_module', source: 'missing' });
    });

    test('a module found nowhere is missing, and a missing addons folder is skipped', async () => {
        const locator = new ModuleLocator(new Map(), [path.join(root, 'gone'), core]);
        assert.deepStrictEqual(await locator.locate('nowhere'), { name: 'nowhere', source: 'missing' });
    });

    test('a name that is not a plain folder name never leaves the addons folders', async () => {
        await addModule(root, 'outside');
        const locator = new ModuleLocator(new Map(), [core]);
        assert.strictEqual((await locator.locate('../../outside')).source, 'missing');
    });

    test('answers from its cache after the first lookup', async () => {
        const inCore = await addModule(core, 'web');
        const locator = new ModuleLocator(new Map(), [core]);
        await locator.locate('web');
        await fs.rm(inCore, { recursive: true });
        assert.strictEqual((await locator.locate('web')).path, inCore);
    });
});

suite('Module dependency expansion', () => {
    test('a located dependency not yet on its branch expands', () => {
        assert.strictEqual(
            dependencyExpansion({ name: 'sale', path: '/a/sale', source: 'core' }, ['my_module', 'sale_stock']),
            'expandable'
        );
    });

    test('a dependency already on its own branch is a cycle', () => {
        assert.strictEqual(
            dependencyExpansion({ name: 'my_module', path: '/a/my_module', source: 'project' }, ['my_module', 'other']),
            'cycle'
        );
    });

    test('a missing dependency is a leaf', () => {
        assert.strictEqual(dependencyExpansion({ name: 'gone', source: 'missing' }, ['my_module']), 'missing');
    });
});
