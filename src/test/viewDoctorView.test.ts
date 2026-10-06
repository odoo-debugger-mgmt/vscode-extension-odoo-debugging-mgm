import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ViewDoctorTreeProvider, ViewGroupItem, ViewItem, buildDoctorRows, resolveViewDoctorTarget } from '../views/viewDoctorView';
import type { ViewGroups } from '../services/views/viewGroups';
import type { ViewRow } from '../services/views/viewQueries';

function row(id: number, overrides: Partial<ViewRow> = {}): ViewRow {
    return {
        id, name: `view ${id}`, model: 'res.partner', type: 'form', active: false,
        inheritId: 1, xmlid: null, rootId: 1, isReport: false, writeDate: 0, ...overrides
    };
}

const groups: ViewGroups = {
    upgradeDisabled: [
        { ...row(10, { xmlid: 'studio_customization.odoo_studio_partner' }), versions: ['18.0'] },
        { ...row(12, { active: true }), versions: ['17.0', '18.0'] }
    ],
    upgradeVersions: ['17.0', '18.0'],
    otherInactive: [row(20, { inheritId: null, rootId: 20 })],
    missingIds: [99],
    edited: []
};

suite('Views tree', () => {
    test('shows the upgrade side of an active upgrade, else the selected database', () => {
        const dbs = [{ id: 'shop-17', isSelected: true }, { id: 'shop-18' }];
        assert.deepStrictEqual(resolveViewDoctorTarget({ dbs }), { dbName: 'shop-17' });
        assert.deepStrictEqual(resolveViewDoctorTarget({
            dbs,
            upgradeConfig: { isEnabled: true, from: { dbId: 'shop-17', series: '17.0' }, to: { dbId: 'shop-18', series: '18.0' } }
        }), { dbName: 'shop-18', side: 'to' });
        assert.strictEqual(resolveViewDoctorTarget({ dbs: [{ id: 'x' }] }), undefined);
        assert.strictEqual(resolveViewDoctorTarget(undefined), undefined);
    });

    test('groups what the upgrade disabled ahead of the rest', () => {
        const rows = buildDoctorRows('shop-18', groups);
        assert.deepStrictEqual(rows.map(item => item.label), ['Disabled by upgrade', 'Other inactive views']);
        const [upgrade, other] = rows as ViewGroupItem[];
        assert.strictEqual(upgrade.description, '1 off · 1 re-enabled · 17.0, 18.0');
        assert.strictEqual(upgrade.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
        assert.strictEqual(other.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
        assert.deepStrictEqual(upgrade.children.map(item => item.label), ['view 10', 'view 12', '1 listed view no longer exists']);
    });

    test('rows say what they are and open their arch', () => {
        const [upgrade, other] = buildDoctorRows('shop-18', groups) as ViewGroupItem[];
        const off = upgrade.children[0] as ViewItem;
        assert.strictEqual(off.description, 'res.partner · studio_customization.odoo_studio_partner');
        assert.strictEqual(off.contextValue, 'odooView.inactive.hasParent');
        assert.strictEqual(off.command?.command, 'viewDoctor.openArch');
        assert.strictEqual(off.command?.arguments?.[0], off);
        assert.strictEqual((upgrade.children[1] as ViewItem).contextValue, 'odooView.active.hasParent.noXmlid');
        assert.strictEqual((other.children[0] as ViewItem).contextValue, 'odooView.inactive.root.noXmlid');
        assert.strictEqual((other.children[0] as ViewItem).description, 'res.partner · #20');
        assert.notStrictEqual(off.id, (upgrade.children[1] as ViewItem).id);
    });

    test('a row\'s menu offers only what applies to it', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
        const entries = (manifest.contributes.menus['view/item/context'] as Array<{ command: string; when?: string; group?: string }>)
            .filter(entry => entry.command.startsWith('viewDoctor.') && !(entry.group ?? '').startsWith('inline'));
        // The rows' clauses are `view == viewDoctor && viewItem =~ /.../`; VS Code reads the pattern as a RegExp.
        const offered = (contextValue: string) => entries
            .filter(entry => new RegExp(/viewItem =~ \/(.*)\/$/.exec(entry.when ?? '')![1]).test(contextValue))
            .map(entry => entry.command.replace('viewDoctor.', ''));
        assert.deepStrictEqual(offered('odooView.inactive.hasParent'), ['openArch', 'openParent', 'showInheriting', 'compare', 'render', 'checkXpaths', 'activate', 'copyXmlid']);
        assert.deepStrictEqual(offered('odooView.inactive.hasParent.deep'), ['openArch', 'openParent', 'openRoot', 'showInheriting', 'compare', 'render', 'checkXpaths', 'activate', 'copyXmlid']);
        assert.deepStrictEqual(offered('odooView.active.hasParent.deep.noXmlid'), ['openArch', 'openParent', 'openRoot', 'showInheriting', 'compare', 'render', 'checkXpaths', 'addToScript', 'deactivate']);
        assert.deepStrictEqual(offered('odooView.inactive.root.noXmlid'), ['openArch', 'showInheriting', 'compare', 'render', 'activate']);
        assert.deepStrictEqual(offered('odooView.active.root'), ['openArch', 'showInheriting', 'compare', 'render', 'copyXmlid', 'addToScript', 'deactivate']);
    });

    test('a row whose root is not its parent says so, for Open Root', () => {
        const base = { id: 9, name: 'Deep', model: 'res.partner', type: 'form', active: false, xmlid: 'acme.deep', isReport: false, writeDate: 0 };
        assert.strictEqual(new ViewItem('shop', { ...base, inheritId: 5, rootId: 3 }, 'other').contextValue, 'odooView.inactive.hasParent.deep');
        assert.strictEqual(new ViewItem('shop', { ...base, inheritId: 3, rootId: 3 }, 'other').contextValue, 'odooView.inactive.hasParent');
        assert.strictEqual(new ViewItem('shop', { ...base, inheritId: 5, rootId: 3, xmlid: null }, 'other').contextValue, 'odooView.inactive.hasParent.deep.noXmlid');
    });

    test('an arch editor\'s title offers the row actions, only for odoo-view files', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
        const title = (manifest.contributes.menus['editor/title'] as Array<{ command: string; when?: string; group?: string }>)
            .filter(entry => entry.command.startsWith('viewDoctor.'));
        assert.ok(title.every(entry => entry.when === 'resourceScheme == odoo-view'), JSON.stringify(title));
        assert.deepStrictEqual(title.filter(entry => entry.group?.startsWith('navigation')).map(entry => entry.command),
            ['viewDoctor.compare', 'viewDoctor.render', 'viewDoctor.checkXpaths']);
        assert.deepStrictEqual(title.filter(entry => !entry.group?.startsWith('navigation')).map(entry => entry.command),
            ['viewDoctor.openParent', 'viewDoctor.openRoot', 'viewDoctor.showInheriting', 'viewDoctor.addToScript']);
        assert.ok(!title.some(entry => /activate|deactivate|copyXmlid|openArch/.test(entry.command)), 'tree-only actions leaked into the editor title');
    });

    test('checking on save is a setting, on by default', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
        const setting = manifest.contributes.configuration.properties['odooDebugger.views.checkXpathsOnSave'];
        assert.strictEqual(setting?.type, 'boolean');
        assert.strictEqual(setting?.default, true);
    });

    test('every view row has its open and compare actions inline, and no destructive one', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
        const inline = (manifest.contributes.menus['view/item/context'] as Array<{ command: string; group?: string }>)
            .filter(entry => entry.command.startsWith('viewDoctor.') && (entry.group ?? '').startsWith('inline'));
        assert.deepStrictEqual(inline.map(entry => [entry.command, entry.group]), [
            ['viewDoctor.openArch', 'inline@1'],
            ['viewDoctor.compare', 'inline@2'],
            ['viewDoctor.render', 'inline@3']
        ]);
    });

    test('a database with nothing off says so', () => {
        const rows = buildDoctorRows('shop-18', { upgradeDisabled: [], upgradeVersions: [], otherInactive: [], missingIds: [], edited: [] });
        assert.deepStrictEqual(rows.map(item => item.label), ['No views are turned off in shop-18.']);
    });

    test('children follow the element asked about, so rows never recurse', async () => {
        const provider = new ViewDoctorTreeProvider({ doctorGroups: async () => groups });
        const [upgrade] = buildDoctorRows('shop-18', groups) as ViewGroupItem[];
        assert.strictEqual(await provider.getChildren(upgrade), upgrade.children);
        assert.deepStrictEqual(await provider.getChildren(upgrade.children[0]), []);
        provider.dispose();
    });

    test('shows the views changed here between the upgrade group and the other inactive views', () => {
        const edited = { id: 4, name: 'Edited form', model: 'res.partner', type: 'form', active: true, inheritId: null, xmlid: 'acme.f', rootId: 4, isReport: false, writeDate: 0 };
        const rows = buildDoctorRows('shop', { upgradeDisabled: [], upgradeVersions: [], otherInactive: [{ ...edited, id: 5, active: false }], missingIds: [], edited: [edited] });
        assert.deepStrictEqual(rows.map(item => item.label), ['Edited here', 'Other inactive views']);
        const group = rows[0] as ViewGroupItem;
        assert.strictEqual(group.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
        assert.strictEqual(group.description, '1');
        assert.strictEqual(group.children[0].id, 'shop:edited:4:on');
    });
});
