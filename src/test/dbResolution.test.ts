import * as assert from 'assert';
import { resolveDbForVersion, rememberDbForVersion, VersionScopedDb } from '../services/dbResolution';

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

    test('falls back to the selected database when nothing else matches', () => {
        // v17 has no memory and the selection belongs to v18: still better
        // than no -d at all, and matches the pre-existing global behaviour.
        const resolved = resolveDbForVersion(DBS, {}, 'v17');
        assert.strictEqual(resolved?.id, 'shop-18');
    });

    test('ignores a remembered database that no longer exists', () => {
        const resolved = resolveDbForVersion(DBS, { v17: 'deleted-db' }, 'v17');
        assert.strictEqual(resolved?.id, 'shop-18');
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
