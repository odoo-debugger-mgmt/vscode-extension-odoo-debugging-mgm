import * as assert from 'assert';
import { keepLeftDatabase, resolveDbForVersion, rememberDbForVersion, VersionScopedDb } from '../services/dbResolution';

const DBS: VersionScopedDb[] = [
    { id: 'shop-17', versionId: 'v17' },
    { id: 'shop-18', versionId: 'v18', isSelected: true },
    { id: 'orphan' }
];

suite('Per-version database resolution', () => {
    test('prefers the database remembered for that version', () => {
        const resolved = resolveDbForVersion(DBS, { v17: 'shop-17' }, 'v17');
        assert.strictEqual(resolved?.id, 'shop-17');
    });

    test('falls back to the selected database when it belongs to the version', () => {
        const resolved = resolveDbForVersion(DBS, {}, 'v18');
        assert.strictEqual(resolved?.id, 'shop-18');
    });

    test('a database of another version is never used', () => {
        // v17 has no memory and the selection belongs to v18. Running 17.0
        // code against an 18.0 database is worse than asking for one.
        assert.strictEqual(resolveDbForVersion(DBS, {}, 'v17'), undefined);
    });

    test('ignores a remembered database that no longer exists', () => {
        assert.strictEqual(resolveDbForVersion(DBS, { v17: 'deleted-db' }, 'v17'), undefined);
    });

    test('a remembered database moved to another version is not used', () => {
        // shop-17 was remembered for v17, then Change Version moved it to v19:
        // 17.0 code must not run against what is now a 19.0 database.
        const moved: VersionScopedDb[] = [{ id: 'shop-17', versionId: 'v19' }, { id: 'shop-18', versionId: 'v18', isSelected: true }];
        assert.strictEqual(resolveDbForVersion(moved, { v17: 'shop-17' }, 'v17'), undefined);
        assert.strictEqual(resolveDbForVersion([{ id: 'old' }], { v17: 'old' }, 'v17')?.id, 'old', 'a legacy database still resolves');
    });

    test('a selected database that belongs to no version still resolves', () => {
        // Databases from before versions existed carry no versionId.
        const legacy: VersionScopedDb[] = [{ id: 'old', isSelected: true }, { id: 'shop-18', versionId: 'v18' }];
        assert.strictEqual(resolveDbForVersion(legacy, {}, 'v17')?.id, 'old');
    });

    test('resolves the selected database when no version is given', () => {
        assert.strictEqual(resolveDbForVersion(DBS, {}, undefined)?.id, 'shop-18');
    });

    test('returns undefined when there is nothing to resolve', () => {
        assert.strictEqual(resolveDbForVersion([], {}, 'v17'), undefined);
        assert.strictEqual(resolveDbForVersion([{ id: 'a' }], {}, 'v17'), undefined);
    });

    test('remembers a database against a version without touching the others', () => {
        assert.deepStrictEqual(
            rememberDbForVersion({ v17: 'shop-17' }, 'v18', 'shop-18'),
            { v17: 'shop-17', v18: 'shop-18' }
        );
        // No active version: nothing to key the memory on.
        assert.deepStrictEqual(rememberDbForVersion({ v17: 'shop-17' }, undefined, 'x'), { v17: 'shop-17' });
        assert.deepStrictEqual(rememberDbForVersion(undefined, 'v17', 'shop-17'), { v17: 'shop-17' });
    });
});

suite('The version the selection leaves keeps its database', () => {
    type Data = { projects: Array<{ uid: string; name: string; dbs: VersionScopedDb[]; selectedDbByVersion?: Record<string, string> }> };
    function moved(memory?: Record<string, string>, dbs: VersionScopedDb[] = [
        { id: 'acme-db1', versionId: 'v17' },
        { id: 'acme-db19', versionId: 'v19', isSelected: true }
    ]): Data {
        return { projects: [{ uid: 'p1', name: 'Acme', dbs, selectedDbByVersion: memory }] };
    }
    function was(dbId: string): Data {
        return { projects: [{ uid: 'p1', name: 'Acme', dbs: [{ id: dbId, isSelected: true }] }] };
    }

    test('a selection never picked is remembered under its own version when it moves', () => {
        // A 1.2 selection is in no memory, so picking a 19.0 database left
        // 17.0 with none: its launch entry went.
        const data = keepLeftDatabase(moved(), was('acme-db1'));
        assert.deepStrictEqual(data.projects[0].selectedDbByVersion, { v17: 'acme-db1' });
    });

    test('what a version already remembers is not overwritten', () => {
        const data = keepLeftDatabase(moved({ v17: 'acme-db2' }), was('acme-db1'));
        assert.deepStrictEqual(data.projects[0].selectedDbByVersion, { v17: 'acme-db2' });
    });

    test('a selection that did not move changes nothing', () => {
        const data = keepLeftDatabase(moved(), was('acme-db19'));
        assert.strictEqual(data.projects[0].selectedDbByVersion, undefined);
    });

    test('a deleted or versionless database it leaves is ignored', () => {
        assert.strictEqual(keepLeftDatabase(moved(), was('gone')).projects[0].selectedDbByVersion, undefined);
        const legacy = moved(undefined, [{ id: 'old' }, { id: 'acme-db19', versionId: 'v19', isSelected: true }]);
        assert.strictEqual(keepLeftDatabase(legacy, was('old')).projects[0].selectedDbByVersion, undefined);
    });

    test('nothing read before means nothing to keep', () => {
        assert.strictEqual(keepLeftDatabase(moved(), undefined).projects[0].selectedDbByVersion, undefined);
    });
});
