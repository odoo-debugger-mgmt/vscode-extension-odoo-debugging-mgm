import * as assert from 'assert';
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
    missingIds: [99]
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
        assert.strictEqual((upgrade.children[1] as ViewItem).contextValue, 'odooView.active.hasParent');
        assert.strictEqual((other.children[0] as ViewItem).contextValue, 'odooView.inactive.root');
        assert.strictEqual((other.children[0] as ViewItem).description, 'res.partner · #20');
        assert.notStrictEqual(off.id, (upgrade.children[1] as ViewItem).id);
    });

    test('a database with nothing off says so', () => {
        const rows = buildDoctorRows('shop-18', { upgradeDisabled: [], upgradeVersions: [], otherInactive: [], missingIds: [] });
        assert.deepStrictEqual(rows.map(item => item.label), ['No views are turned off in shop-18.']);
    });

    test('children follow the element asked about, so rows never recurse', async () => {
        const provider = new ViewDoctorTreeProvider({ doctorGroups: async () => groups });
        const [upgrade] = buildDoctorRows('shop-18', groups) as ViewGroupItem[];
        assert.strictEqual(await provider.getChildren(upgrade), upgrade.children);
        assert.deepStrictEqual(await provider.getChildren(upgrade.children[0]), []);
        provider.dispose();
    });
});
