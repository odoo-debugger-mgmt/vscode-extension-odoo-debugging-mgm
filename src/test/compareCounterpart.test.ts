import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { sideRolesFor } from '../services/compare/sides';
import { counterpartModuleDir, resolveCounterpart, rootOf, realFsProbe, SideRoots } from '../services/compare/counterpart';

async function touch(file: string, text = 'x') {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
}

suite('Compare: counterpart files', () => {
    let tmp: string;
    let s17: SideRoots;
    let s18: SideRoots;

    setup(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'odt-cmp-'));
        const side = (v: string): SideRoots => ({
            label: `odoo${v}`,
            roots: [
                { role: 'odoo', path: path.join(tmp, v, 'odoo') },
                { role: 'core:odoo/odoo/addons', path: path.join(tmp, v, 'odoo', 'odoo', 'addons') },
                { role: 'core:odoo/addons', path: path.join(tmp, v, 'odoo', 'addons') },
                { role: 'core:enterprise', path: path.join(tmp, v, 'enterprise') },
                { role: 'repo:acme', path: path.join(tmp, v, 'acme') }
            ]
        });
        s17 = side('17');
        s18 = side('18');
        await touch(path.join(tmp, '17/odoo/addons/sale/models/sale_order.py'));
        await touch(path.join(tmp, '18/odoo/addons/sale/models/sale_order.py'));
        await touch(path.join(tmp, '17/odoo/odoo/models.py'));
        await touch(path.join(tmp, '18/odoo/odoo/models.py'));
        await touch(path.join(tmp, '17/acme/acme_sale/views/sale.xml'));
        await touch(path.join(tmp, '18/acme/acme_sale/views/sale_views.xml'));
        // moved between files inside the module
        await touch(path.join(tmp, '17/odoo/addons/stock/models/stock_move_line.py'));
        await touch(path.join(tmp, '18/odoo/addons/stock/models/stock_move_line.py'));
        // a module moved from enterprise to community
        await touch(path.join(tmp, '17/enterprise/web_studio_lite/models/a.py'));
        await touch(path.join(tmp, '18/odoo/addons/web_studio_lite/models/a.py'));
        // renamed module: the same file name exists in two other modules
        await touch(path.join(tmp, '17/odoo/addons/account_edi/models/edi_format.py'));
        await touch(path.join(tmp, '18/odoo/addons/account_edi_ubl/models/edi_format.py'));
        await touch(path.join(tmp, '18/enterprise/account_edi_x/models/edi_format.py'));
    });

    teardown(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

    test('the longest matching root wins', () => {
        const hit = rootOf(path.join(tmp, '17/odoo/addons/sale/models/sale_order.py'), s17);
        assert.strictEqual(hit?.root.role, 'core:odoo/addons');
        assert.strictEqual(hit?.rel, 'sale/models/sale_order.py');
        assert.strictEqual(rootOf(path.join(tmp, '17/odoo/odoo/models.py'), s17)?.root.role, 'odoo');
        assert.strictEqual(rootOf('/elsewhere/x.py', s17), undefined);
    });

    test('same root, same path', async () => {
        const r = await resolveCounterpart(path.join(tmp, '17/odoo/addons/sale/models/sale_order.py'), s17, s18, realFsProbe);
        assert.deepStrictEqual(r, { kind: 'found', path: path.join(tmp, '18/odoo/addons/sale/models/sale_order.py') });
        const core = await resolveCounterpart(path.join(tmp, '17/odoo/odoo/models.py'), s17, s18, realFsProbe);
        assert.deepStrictEqual(core, { kind: 'found', path: path.join(tmp, '18/odoo/odoo/models.py') });
    });

    test('the same file name in another folder of the counterpart module is offered, not opened', async () => {
        await touch(path.join(tmp, '18/acme/acme_sale/data/sale.xml'));
        const r = await resolveCounterpart(path.join(tmp, '17/acme/acme_sale/views/sale.xml'), s17, s18, realFsProbe);
        assert.deepStrictEqual(r, { kind: 'pick', candidates: [path.join(tmp, '18/acme/acme_sale/data/sale.xml')] });
    });

    test('a removed module gets no counterpart for its manifest or __init__, however many modules exist', async () => {
        for (let i = 0; i < 60; i++) {
            await touch(path.join(tmp, `18/enterprise/m${i}/__manifest__.py`));
            await touch(path.join(tmp, `18/enterprise/m${i}/__init__.py`));
            await touch(path.join(tmp, `18/enterprise/m${i}/models/__init__.py`));
        }
        await touch(path.join(tmp, '17/odoo/addons/account_audit_trail/__manifest__.py'));
        await touch(path.join(tmp, '17/odoo/addons/account_audit_trail/models/__init__.py'));
        for (const rel of ['__manifest__.py', '__init__.py', 'models/__init__.py']) {
            assert.deepStrictEqual(await resolveCounterpart(path.join(tmp, '17/odoo/addons/account_audit_trail', rel), s17, s18, realFsProbe), { kind: 'none' }, rel);
        }
        assert.strictEqual(await counterpartModuleDir(path.join(tmp, '17/odoo/addons/account_audit_trail/__manifest__.py'), s17, s18, realFsProbe), undefined);
    });

    test('a module below a container folder is the module, not the container', async () => {
        await touch(path.join(tmp, '17/acme/addons/acme_x/__manifest__.py'));
        await touch(path.join(tmp, '17/acme/addons/acme_x/models/a.py'));
        await touch(path.join(tmp, '18/acme/addons/acme_x/__manifest__.py'));
        await touch(path.join(tmp, '18/acme/addons/acme_x/data/a.py'));
        // a sibling module with the same file name must not be offered
        await touch(path.join(tmp, '18/acme/addons/acme_y/__manifest__.py'));
        await touch(path.join(tmp, '18/acme/addons/acme_y/models/a.py'));
        const file = path.join(tmp, '17/acme/addons/acme_x/models/a.py');
        assert.deepStrictEqual(await resolveCounterpart(file, s17, s18, realFsProbe),
            { kind: 'pick', candidates: [path.join(tmp, '18/acme/addons/acme_x/data/a.py')] });
        assert.strictEqual(await counterpartModuleDir(file, s17, s18, realFsProbe), path.join(tmp, '18/acme/addons/acme_x'));
    });

    test('a module moved to another root keeps its path inside', async () => {
        const r = await resolveCounterpart(path.join(tmp, '17/enterprise/web_studio_lite/models/a.py'), s17, s18, realFsProbe);
        assert.deepStrictEqual(r, { kind: 'found', path: path.join(tmp, '18/odoo/addons/web_studio_lite/models/a.py') });
    });

    test('a renamed module: same-name files are offered', async () => {
        const r = await resolveCounterpart(path.join(tmp, '17/odoo/addons/account_edi/models/edi_format.py'), s17, s18, realFsProbe);
        assert.strictEqual(r.kind, 'pick');
        assert.deepStrictEqual((r as { candidates: string[] }).candidates.sort(), [
            path.join(tmp, '18/enterprise/account_edi_x/models/edi_format.py'),
            path.join(tmp, '18/odoo/addons/account_edi_ubl/models/edi_format.py')
        ].sort());
    });

    test('a file outside both sides has no counterpart', async () => {
        assert.deepStrictEqual(await resolveCounterpart('/nowhere/x.py', s17, s18, realFsProbe), { kind: 'none' });
    });

    test('the pick list stops at 50', async () => {
        for (let i = 0; i < 60; i++) {
            await touch(path.join(tmp, `18/acme/m${i}/hooks.py`));
        }
        await touch(path.join(tmp, '17/acme/gone/hooks.py'));
        const r = await resolveCounterpart(path.join(tmp, '17/acme/gone/hooks.py'), s17, s18, realFsProbe);
        assert.strictEqual(r.kind, 'pick');
        assert.strictEqual((r as { candidates: string[] }).candidates.length, 50);
    });

    test('rootOf does not match a sibling that shares a prefix', () => {
        const side: SideRoots = { label: 'x', roots: [{ role: 'odoo', path: '/a/odoo' }] };
        assert.strictEqual(rootOf('/a/odoo2/x.py', side), undefined);
    });

    test('a framework file without a same-path counterpart has none', async () => {
        await touch(path.join(tmp, '17/odoo/odoo/only17.py'));
        await touch(path.join(tmp, '18/odoo/addons/sale/only17.py'));
        assert.deepStrictEqual(await resolveCounterpart(path.join(tmp, '17/odoo/odoo/only17.py'), s17, s18, realFsProbe), { kind: 'none' });
    });

    test('same-name files under __pycache__ and dot-folders are not offered', async () => {
        await touch(path.join(tmp, '17/acme/gone/hooks.py'));
        await touch(path.join(tmp, '18/acme/m/__pycache__/hooks.py'));
        await touch(path.join(tmp, '18/acme/m/.git/hooks.py'));
        assert.deepStrictEqual(await resolveCounterpart(path.join(tmp, '17/acme/gone/hooks.py'), s17, s18, realFsProbe), { kind: 'none' });
    });

    test('sideRolesFor maps roots by position and adds repos', () => {
        const roots = sideRolesFor(
            { odooPath: '/w/odoo', enterprisePath: '/w/enterprise', designThemesPath: '/w/themes' },
            [{ repo: { name: 'acme' }, path: '/w/acme' }]
        );
        assert.deepStrictEqual(roots, [
            { role: 'odoo', path: '/w/odoo' },
            { role: 'core:enterprise', path: '/w/enterprise' },
            { role: 'core:themes', path: '/w/themes' },
            { role: 'core:odoo/odoo/addons', path: path.join('/w/odoo', 'odoo', 'addons') },
            { role: 'core:odoo/addons', path: path.join('/w/odoo', 'addons') },
            { role: 'repo:acme', path: '/w/acme' }
        ]);
    });

    test('counterpartModuleDir: the same module, the same root first, then the other roots', async () => {
        assert.strictEqual(await counterpartModuleDir(path.join(tmp, '17/acme/acme_sale/views/sale.xml'), s17, s18, realFsProbe),
            path.join(tmp, '18/acme/acme_sale'));
        assert.strictEqual(await counterpartModuleDir(path.join(tmp, '17/enterprise/web_studio_lite/models/a.py'), s17, s18, realFsProbe),
            path.join(tmp, '18/odoo/addons/web_studio_lite'));
        await touch(path.join(tmp, '18/enterprise/sale/models/x.py'));
        assert.strictEqual(await counterpartModuleDir(path.join(tmp, '17/odoo/addons/sale/models/sale_order.py'), s17, s18, realFsProbe),
            path.join(tmp, '18/odoo/addons/sale'), 'the same root wins');
    });

    test('counterpartModuleDir: none for a renamed module, a framework file or a file outside the roots', async () => {
        assert.strictEqual(await counterpartModuleDir(path.join(tmp, '17/odoo/addons/account_edi/models/edi_format.py'), s17, s18, realFsProbe), undefined);
        assert.strictEqual(await counterpartModuleDir(path.join(tmp, '17/odoo/odoo/models.py'), s17, s18, realFsProbe), undefined);
        assert.strictEqual(await counterpartModuleDir(path.join(tmp, 'elsewhere/m/a.py'), s17, s18, realFsProbe), undefined);
    });
});
