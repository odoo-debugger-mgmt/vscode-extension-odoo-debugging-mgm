import * as assert from 'assert';
import * as vscode from 'vscode';
import { alsoOffSource, diffArguments, isReadOnlyOriginal, partnerFor, pickCounterpart, upgradePair } from '../views/viewPairing';
import type { ViewRow } from '../services/views/viewQueries';
import { viewUri } from '../views/viewFileSystem';

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
    test('the diff is left, then right, titled after the view and both labels', () => {
        const left = { uri: vscode.Uri.parse('odoo-compare:/left/before%20%C2%B7%20acme.partner_custom.xml?n=1'), label: 'before' };
        const right = { uri: viewUri('shop-18', 41, 'view-41'), label: 'shop-18' };
        const [leftUri, rightUri, title] = diffArguments(left, right, 'partner.custom');
        assert.strictEqual(leftUri, left.uri);
        assert.strictEqual(rightUri.toString(), 'odoo-view:/shop-18/41/view-41.xml');
        assert.strictEqual(title, 'partner.custom: before ↔ shop-18');
    });
});

suite('Choosing the counterpart from rows already read', () => {
    const view: ViewRow = { id: 41, name: 'partner.custom', model: 'res.partner', type: 'form', active: true, inheritId: 7, xmlid: 'acme.partner_custom', rootId: 7, isReport: false, writeDate: 0 };

    test('a certain match and no match need no database and no question', async () => {
        const there = { ...view, id: 52 };
        assert.strictEqual(await pickCounterpart(view, 'before', { byXmlid: there, rows: [there] }), there);
        assert.strictEqual(await pickCounterpart(view, 'before', { rows: [] }), 'none');
    });
});

suite('Asking for a partner', () => {
    const lonely = { dbs: [{ id: 'shop' }] };
    const deps = () => {
        const told: string[] = [];
        return { told, deps: { running: async () => new Set<string>(), info: (message: string) => { told.push(message); } } };
    };

    test('with nothing to pick, it says so, unless asked to stay quiet', async () => {
        const loud = deps();
        assert.strictEqual(await partnerFor(lonely, 'shop', { ask: true }, loud.deps), undefined);
        assert.deepStrictEqual(loud.told, ['The project has no other database or checkpoint to compare shop with.']);
        const quiet = deps();
        assert.strictEqual(await partnerFor(lonely, 'shop', { ask: true, quiet: true }, quiet.deps), undefined);
        assert.deepStrictEqual(quiet.told, []);
    });

    test('a stored or upgrade partner is used without asking', async () => {
        const silent = deps();
        silent.deps.running = async () => { throw new Error('asked'); };
        assert.strictEqual((await partnerFor(upgrading, 'shop-18', { ask: true }, silent.deps))?.dbName, 'shop-17');
        assert.deepStrictEqual(silent.told, []);
    });
});

suite('Also off in the partner', () => {
    const cp = { id: 'shop__cp_1', label: 'before', createdAt: '2026-10-01T00:00:00Z' };

    test('the upgraded side reads the original; the original has no "also off"', () => {
        assert.deepStrictEqual(alsoOffSource(upgrading, 'shop-18', upgradePair(upgrading)), { dbName: 'shop-17', checkpoint: false, label: 'shop-17' });
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
        assert.deepStrictEqual(alsoOffSource(project, 'shop', undefined), { dbName: 'shop__cp_1', checkpoint: true, label: 'before' });
        assert.deepStrictEqual(alsoOffSource(project, 'shop-clone', undefined), { dbName: 'shop', checkpoint: false, label: 'shop' });
        assert.deepStrictEqual(alsoOffSource(project, 'base', undefined), { dbName: 'shop-copy', checkpoint: false, label: 'shop-copy' });
        assert.strictEqual(alsoOffSource(project, 'other', undefined), undefined);
        assert.strictEqual(alsoOffSource(project, 'alone', undefined), undefined);
        assert.strictEqual(alsoOffSource(undefined, 'shop', undefined), undefined);
    });
});
