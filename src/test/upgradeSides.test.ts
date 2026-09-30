import * as assert from 'assert';
import { UpgradeConfigModel } from '../models/upgrade';
import { otherSide, thisSide } from '../services/upgradeSides';

suite('Which side of an upgrade a window runs', () => {
    const upgrade = new UpgradeConfigModel(
        true,
        { versionId: 'v17', dbId: 'acme-db2', series: '17.0' },
        { versionId: 'v19', dbId: 'acme-db19', series: '19.0' },
        []
    );

    test('the side its bound version is, even while another version is active', () => {
        // The 19.0 workspace briefly on 17.0 still starts 19.0 as its side.
        assert.strictEqual(thisSide(upgrade, 'v19', 'v17'), 'to');
    });

    test('the active version\'s side when the window is not bound, or bound to neither', () => {
        assert.strictEqual(thisSide(upgrade, undefined, 'v17'), 'from');
        assert.strictEqual(thisSide(upgrade, 'v16', 'v19'), 'to');
    });

    test('no side for a window running neither, or with the upgrade off', () => {
        assert.strictEqual(thisSide(upgrade, 'v16', 'v18'), undefined);
        const off = new UpgradeConfigModel(false, upgrade.from, upgrade.to, []);
        assert.strictEqual(thisSide(off, 'v19', 'v19'), undefined);
    });

    test('the other side is the other one', () => {
        assert.strictEqual(otherSide('from'), 'to');
        assert.strictEqual(otherSide('to'), 'from');
    });
});
