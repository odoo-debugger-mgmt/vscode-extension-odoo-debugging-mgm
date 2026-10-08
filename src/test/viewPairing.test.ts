import * as assert from 'assert';
import { alsoOffSource, diffArguments, isReadOnlyOriginal, otherDatabaseChoices, upgradePair } from '../views/viewPairing';

const upgrading = {
    dbs: [{ id: 'shop-17', versionId: 'v17' }, { id: 'shop-18', versionId: 'v18', isSelected: true }],
    upgradeConfig: { isEnabled: true, from: { dbId: 'shop-17', versionId: 'v17', series: '17.0' }, to: { dbId: 'shop-18', versionId: 'v18', series: '18.0' } }
};

suite('View pairing', () => {
    test('the pair is the upgrade\'s From and To, read from plain JSON', () => {
        assert.deepStrictEqual(upgradePair(upgrading), {
            original: { dbName: 'shop-17', versionId: 'v17', series: '17.0' },
            upgraded: { dbName: 'shop-18', versionId: 'v18', series: '18.0' }
        });
        assert.strictEqual(upgradePair({ ...upgrading, upgradeConfig: { ...upgrading.upgradeConfig, isEnabled: false } }), undefined);
        assert.strictEqual(upgradePair({ dbs: upgrading.dbs }), undefined);
        assert.strictEqual(upgradePair(undefined), undefined);
    });

    test('only the upgrade\'s original opens read-only, unless the setting allows edits', () => {
        assert.strictEqual(isReadOnlyOriginal(upgrading, 'shop-17', false), true);
        assert.strictEqual(isReadOnlyOriginal(upgrading, 'shop-18', false), false);
        assert.strictEqual(isReadOnlyOriginal(upgrading, 'shop-17', true), false);
        assert.strictEqual(isReadOnlyOriginal({ dbs: upgrading.dbs }, 'shop-17', false), false);
    });
});

suite('Comparing across databases', () => {
    const view = (id: number, name: string, xmlid: string | null) => ({
        id, name, model: 'res.partner', type: 'form', active: true, inheritId: 1, xmlid, rootId: 1, isReport: false, writeDate: 0
    });

    test('offers the project\'s other databases, running ones first', () => {
        const project = { dbs: [{ id: 'a' }, { id: 'b', versionId: 'v' }, { id: 'c' }, { id: 'd' }] };
        assert.deepStrictEqual(otherDatabaseChoices(project, 'a', new Set(['d'])), [
            { dbName: 'd', versionId: undefined, running: true },
            { dbName: 'b', versionId: 'v', running: false },
            { dbName: 'c', versionId: undefined, running: false }
        ]);
        assert.deepStrictEqual(otherDatabaseChoices({ dbs: [{ id: 'a' }] }, 'a', new Set()), []);
        assert.deepStrictEqual(otherDatabaseChoices(undefined, 'a', new Set()), []);
    });

    test('the diff puts the original left and the upgraded right, named after both', () => {
        const [left, right, title] = diffArguments(
            { dbName: 'shop-17', view: view(40, 'partner.custom', 'acme.partner_custom') },
            { dbName: 'shop-18', view: view(41, 'partner.custom', null) });
        assert.strictEqual(left.toString(), 'odoo-view:/shop-17/40/acme.partner_custom.xml');
        assert.strictEqual(right.toString(), 'odoo-view:/shop-18/41/view-41.xml');
        assert.strictEqual(title, 'partner.custom: shop-17 ↔ shop-18');
    });
});

suite('Also off in the partner', () => {
    const cp = { id: 'shop__cp_1', label: 'before', createdAt: '2026-10-01T00:00:00Z' };

    test('the upgraded side reads the original; the original has no "also off"', () => {
        assert.deepStrictEqual(alsoOffSource(upgrading, 'shop-18', upgradePair(upgrading)), { dbName: 'shop-17', checkpoint: false });
        assert.strictEqual(alsoOffSource(upgrading, 'shop-17', upgradePair(upgrading)), undefined);
    });

    test('a stored checkpoint or clone partner is a copy; any other partner is not', () => {
        const project = {
            dbs: [
                { id: 'shop', comparePartner: { dbName: 'shop__cp_1', kind: 'checkpoint' }, checkpoints: [cp] },
                { id: 'shop-clone', clonedFrom: 'shop', comparePartner: { dbName: 'shop', kind: 'database' } },
                { id: 'base', comparePartner: { dbName: 'shop-copy', kind: 'database' } },
                { id: 'shop-copy', clonedFrom: 'base' },
                { id: 'other', comparePartner: { dbName: 'base', kind: 'database' } },
                { id: 'alone' }
            ]
        };
        assert.deepStrictEqual(alsoOffSource(project, 'shop', undefined), { dbName: 'shop__cp_1', checkpoint: true });
        assert.deepStrictEqual(alsoOffSource(project, 'shop-clone', undefined), { dbName: 'shop', checkpoint: false });
        assert.deepStrictEqual(alsoOffSource(project, 'base', undefined), { dbName: 'shop-copy', checkpoint: false });
        assert.strictEqual(alsoOffSource(project, 'other', undefined), undefined);
        assert.strictEqual(alsoOffSource(project, 'alone', undefined), undefined);
        assert.strictEqual(alsoOffSource(undefined, 'shop', undefined), undefined);
    });
});
