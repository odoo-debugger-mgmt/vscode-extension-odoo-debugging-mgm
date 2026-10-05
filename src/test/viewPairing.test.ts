import * as assert from 'assert';
import { isReadOnlyOriginal, upgradePair } from '../views/viewPairing';

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
