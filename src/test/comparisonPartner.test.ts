import * as assert from 'assert';
import {
    comparisonSides, isCopyPartner, partnerChoices, partnerOf, resolveStoredPartner, setPartner, PartnerProject
} from '../services/comparisonPartner';

const cp = (id: string, label: string, at: string) => ({ id, label, createdAt: at, filestore: true });

const project: PartnerProject = {
    dbs: [
        { id: 'shop', versionId: 'v17', comparePartner: { dbName: 'shop-copy', kind: 'database' }, checkpoints: [cp('shop__cp_1', 'before', '2026-10-01T00:00:00Z'), cp('shop__cp_2', 'after', '2026-10-02T00:00:00Z')] },
        { id: 'shop-copy', versionId: 'v17', clonedFrom: 'shop' },
        { id: 'other', versionId: 'v18', comparePartner: { dbName: 'gone', kind: 'database' } },
        { id: 'withcp', versionId: 'v17', comparePartner: { dbName: 'withcp__cp_9', kind: 'checkpoint' }, checkpoints: [] }
    ]
};
const pair = { original: { dbName: 'old17', versionId: 'v17' }, upgraded: { dbName: 'new18', versionId: 'v18' } };

suite('Comparison partner', () => {
    test('partnerOf reads only a well-formed record', () => {
        assert.deepStrictEqual(partnerOf({ comparePartner: { dbName: 'x', kind: 'checkpoint' } }), { dbName: 'x', kind: 'checkpoint' });
        assert.strictEqual(partnerOf({}), undefined);
        assert.strictEqual(partnerOf({ comparePartner: { dbName: '', kind: 'database' } }), undefined);
        assert.strictEqual(partnerOf({ comparePartner: { dbName: 'x', kind: 'nope' } }), undefined);
        const db: { comparePartner?: unknown } = {};
        setPartner(db, { dbName: 'y', kind: 'database' });
        assert.strictEqual(partnerOf(db)?.dbName, 'y');
        setPartner(db, undefined);
        assert.strictEqual(db.comparePartner, undefined);
    });

    test('upgrade mode pairs the two sides, whatever is stored', () => {
        const withPair: PartnerProject = { dbs: [{ id: 'new18', comparePartner: { dbName: 'shop', kind: 'database' } }, { id: 'old17' }, { id: 'shop' }] };
        assert.deepStrictEqual(resolveStoredPartner(withPair, 'new18', pair), { dbName: 'old17', kind: 'database', source: 'upgrade', versionId: 'v17', label: 'old17' });
        assert.strictEqual(resolveStoredPartner(withPair, 'old17', pair)?.dbName, 'new18');
    });

    test('otherwise the stored partner, when it still exists', () => {
        assert.deepStrictEqual(resolveStoredPartner(project, 'shop', undefined), { dbName: 'shop-copy', kind: 'database', source: 'stored', versionId: 'v17', label: 'shop-copy' });
        assert.strictEqual(resolveStoredPartner(project, 'other', undefined), undefined, 'a deleted database is no partner');
        assert.strictEqual(resolveStoredPartner(project, 'withcp', undefined), undefined, 'a deleted checkpoint is no partner');
        assert.strictEqual(resolveStoredPartner(project, 'shop-copy', undefined), undefined, 'none stored');
    });

    test('a checkpoint partner carries its label and its database version', () => {
        const p: PartnerProject = { dbs: [{ id: 'shop', versionId: 'v17', comparePartner: { dbName: 'shop__cp_1', kind: 'checkpoint' }, checkpoints: [cp('shop__cp_1', 'before', '2026-10-01T00:00:00Z')] }] };
        assert.deepStrictEqual(resolveStoredPartner(p, 'shop', undefined), { dbName: 'shop__cp_1', kind: 'checkpoint', source: 'stored', versionId: 'v17', label: 'before' });
    });

    test('left and right', () => {
        const db = (dbName: string, kind: 'database' | 'checkpoint' = 'database', source: 'upgrade' | 'stored' = 'stored') => ({ dbName, kind, source, label: dbName });
        assert.deepStrictEqual(comparisonSides('new18', db('old17', 'database', 'upgrade'), pair), { left: 'old17', right: 'new18', editable: 'right' });
        assert.deepStrictEqual(comparisonSides('old17', db('new18', 'database', 'upgrade'), pair), { left: 'old17', right: 'new18', editable: 'right' });
        assert.deepStrictEqual(comparisonSides('shop', db('shop__cp_1', 'checkpoint')), { left: 'shop__cp_1', right: 'shop', editable: 'right' });
        assert.deepStrictEqual(comparisonSides('shop', db('shop-copy')), { left: 'shop-copy', right: 'shop', editable: 'right' });
    });

    test('only a copy of this database gets the "also off" filter', () => {
        const as = (dbName: string, kind: 'database' | 'checkpoint', source: 'upgrade' | 'stored') => ({ dbName, kind, source, label: dbName });
        assert.strictEqual(isCopyPartner(project, 'shop', as('shop__cp_1', 'checkpoint', 'stored')), true);
        assert.strictEqual(isCopyPartner(project, 'new18', as('old17', 'database', 'upgrade')), true);
        assert.strictEqual(isCopyPartner(project, 'shop', as('shop-copy', 'database', 'stored')), true, 'clone of this one');
        assert.strictEqual(isCopyPartner(project, 'shop-copy', as('shop', 'database', 'stored')), true, 'this one is the clone');
        assert.strictEqual(isCopyPartner(project, 'shop', as('other', 'database', 'stored')), false);
    });

    test('choices: other databases (running first), then this database\'s checkpoints, newest first', () => {
        const choices = partnerChoices(project, 'shop', new Set(['other']));
        assert.deepStrictEqual(choices.map(c => [c.dbName, c.kind, c.running]), [
            ['other', 'database', true],
            ['shop-copy', 'database', false],
            ['withcp', 'database', false],
            ['shop__cp_2', 'checkpoint', false],
            ['shop__cp_1', 'checkpoint', false]
        ]);
        assert.strictEqual(choices[3].label, 'after');
    });
});
