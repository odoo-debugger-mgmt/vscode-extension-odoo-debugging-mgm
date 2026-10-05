import * as assert from 'assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    destinationItems, destinationKey, normalizeDestination, ownerCounts, versionPrefill, withoutCoreModules, type ModuleChoice
} from '../views/scriptDestination';

function mod(name: string, repoName = 'acme-repo', root = '/repos/acme'): ModuleChoice {
    return { name, path: path.join(root, name), repoName };
}

suite('Upgrade script destination', () => {
    test('remembers per project, and reads back only a well-formed destination', () => {
        assert.strictEqual(destinationKey('uid-1'), 'viewDoctor.scriptDestination:uid-1');
        assert.deepStrictEqual(normalizeDestination({ kind: 'module', module: 'acme', version: '1.1' }), { kind: 'module', module: 'acme', version: '1.1' });
        assert.deepStrictEqual(normalizeDestination({ kind: 'untitled', extra: 1 }), { kind: 'untitled' });
        for (const bad of [undefined, null, 'x', { kind: 'module', module: 'acme' }, { kind: 'module', module: 'acme', version: '../x' }, { kind: 'other' }]) {
            assert.strictEqual(normalizeDestination(bad), undefined);
        }
    });

    test('counts the views each module owns, never Studio or exports', () => {
        const owners = ownerCounts([{ xmlid: 'acme.a' }, { xmlid: 'acme.b' }, { xmlid: 'sale.c' }, { xmlid: 'studio_customization.d' }, { xmlid: '__export__.e' }, { xmlid: null }]);
        assert.deepStrictEqual([...owners], [['acme', 2], ['sale', 1]]);
    });

    test('never offers a module under the core or enterprise checkout', () => {
        const modules = [mod('acme'), mod('sale', 'odoo', '/src/odoo/addons'), mod('web_studio', 'enterprise', '/src/enterprise')];
        assert.deepStrictEqual(withoutCoreModules(modules, ['/src/odoo', '/src/enterprise']).map(m => m.name), ['acme']);
    });

    test('orders the picker: last used, then owning modules, then the rest by name, then an untitled editor', () => {
        const modules = [mod('zeta'), mod('acme'), mod('beta'), mod('owner2'), mod('owner1')];
        const owners = new Map([['owner1', 1], ['owner2', 3], ['sale', 5]]);
        const items = destinationItems(modules, owners, 4, { kind: 'module', module: 'zeta', version: '1.2' });
        assert.deepStrictEqual(items.map(item => item.kind === vscode.QuickPickItemKind.Separator ? '--' : item.label), [
            'zeta', 'owner2', 'owner1', '--', 'acme', 'beta', '--', '$(new-file) Untitled Python Editor'
        ]);
        assert.match(items[0].description ?? '', /last used · migrations\/1\.2/);
        assert.strictEqual(items[1].description, 'owns 3 of the 4 views');
        const single = destinationItems([mod('owner1')], new Map([['owner1', 1]]), 1, undefined);
        assert.strictEqual(single[0].description, 'owns the view');
        const untitled = destinationItems([mod('acme')], new Map(), 1, { kind: 'untitled' });
        assert.deepStrictEqual(untitled.map(item => item.label), ['$(new-file) Untitled Python Editor', 'Modules', 'acme']);
    });

    test('a remembered module that is gone is not offered as last used', () => {
        const items = destinationItems([mod('acme')], new Map(), 1, { kind: 'module', module: 'gone', version: '1.1' });
        assert.ok(!items.some(item => (item.description ?? '').includes('last used')));
    });

    test('prefills the version folder: the remembered one while it exists, else the manifest bumped, in full', () => {
        const acme = mod('acme');
        const remembered = { kind: 'module' as const, module: 'acme', version: '17.0.1.0.4' };
        const manifest = "{'version': '17.0.1.0.4'}";
        assert.strictEqual(versionPrefill(acme, remembered, manifest, () => true, '17.0'), '17.0.1.0.4');
        assert.strictEqual(versionPrefill(acme, remembered, manifest, () => false, '17.0'), '17.0.1.0.5');
        // A 17.0 manifest on an 18.0 database gives no valid bump: empty, the user types it.
        assert.strictEqual(versionPrefill(acme, remembered, manifest, () => true, '18.0'), '');
        assert.strictEqual(versionPrefill(mod('other'), remembered, manifest, () => true, '17.0'), '17.0.1.0.5');
        assert.strictEqual(versionPrefill(acme, undefined, "{'version': '1.0'}", () => false, '18.0'), '18.0.1.1');
        assert.strictEqual(versionPrefill(acme, undefined, undefined, () => false, '18.0'), '18.0.1.1');
        assert.strictEqual(versionPrefill(acme, undefined, undefined, () => false, undefined), '1.1');
        assert.strictEqual(versionPrefill(acme, undefined, "{'version': 'x'}", () => false, '18.0'), '');
    });
});

suite('Upgrade script commands', () => {
    test('are contributed: on the Views title, and on active rows only, in a safe group', () => {
        const manifest = vscode.extensions.all.find(extension => extension.packageJSON?.contributes?.commands?.some((c: { command: string }) => c.command === 'viewDoctor.createScript'))?.packageJSON;
        assert.ok(manifest, 'the extension contributes viewDoctor.createScript');
        const title = manifest.contributes.menus['view/title'].find((m: { command: string }) => m.command === 'viewDoctor.createScript');
        assert.strictEqual(title.when, 'view == viewDoctor');
        const row = manifest.contributes.menus['view/item/context'].find((m: { command: string }) => m.command === 'viewDoctor.addToScript');
        assert.strictEqual(row.when, 'view == viewDoctor && viewItem =~ /^odooView\\.active/');
        assert.ok(!row.group.startsWith('inline') && !row.group.startsWith('9_danger'));
    });
});
