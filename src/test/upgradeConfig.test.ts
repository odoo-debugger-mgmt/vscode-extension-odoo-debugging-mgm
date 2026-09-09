/**
 * Upgrade config normalization.
 *
 * Settings round-trip through JSON, so what comes back is a plain object with
 * no methods, and a setup interrupted halfway can leave half a pair behind.
 * Both must read as "no upgrade" rather than reach a tree provider or a guard.
 */
import * as assert from 'assert';
import { ensureUpgradeConfigModel, UpgradeConfigModel } from '../models/upgrade';

const pair = {
    isEnabled: true,
    from: { versionId: 'v17', dbId: 'crm-17', series: '17.0' },
    to: { versionId: 'v19', dbId: 'crm-19', series: '19.0' },
    repos: [{ repoName: 'acme', repoPath: '/src/acme', fromBranch: '17.0-acme', toBranch: '19.0-acme' }],
    stagedModules: ['sale', 'crm'],
    unavailableModules: []
};

suite('Upgrade config normalization', () => {
    test('a plain object regains its methods', () => {
        const config = ensureUpgradeConfigModel(JSON.parse(JSON.stringify(pair)));
        assert.ok(config instanceof UpgradeConfigModel);
        assert.strictEqual(config.isActive(), true);
        assert.strictEqual(config.sideForVersion('v19'), 'to');
        assert.strictEqual(config.sideForDb('crm-17'), 'from');
        assert.strictEqual(config.involvesRepo('ACME'), true);
    });

    test('an already-converted model is returned untouched', () => {
        const model = new UpgradeConfigModel();
        assert.strictEqual(ensureUpgradeConfigModel(model), model);
    });

    test('undefined and garbage produce a disabled config, not a crash', () => {
        for (const input of [undefined, null, 0, 'nonsense', []]) {
            const config = ensureUpgradeConfigModel(input);
            assert.strictEqual(config.isEnabled, false);
            assert.strictEqual(config.isActive(), false);
            assert.deepStrictEqual(config.repos, []);
        }
    });

    test('half a pair reads as off, whatever the flag says', () => {
        // What an interrupted setup leaves behind: the mode was flagged on
        // before the second side was known.
        const config = ensureUpgradeConfigModel({ ...pair, to: undefined });
        assert.strictEqual(config.isEnabled, false, 'a one-sided upgrade was reported as enabled');
        assert.strictEqual(config.isActive(), false);
    });

    test('a side missing its database or series is dropped', () => {
        assert.strictEqual(ensureUpgradeConfigModel({ ...pair, to: { versionId: 'v19' } }).to, undefined);
        assert.strictEqual(
            ensureUpgradeConfigModel({ ...pair, to: { dbId: 'crm-19', series: '  ' } }).to,
            undefined
        );
    });

    test('a version still being provisioned is a valid side', () => {
        // Setup queues a missing version and finishes; the id arrives later.
        const config = ensureUpgradeConfigModel({
            ...pair,
            to: { dbId: 'crm-19', series: '19.0' }
        });
        assert.strictEqual(config.isActive(), true);
        assert.strictEqual(config.to?.versionId, undefined);
        assert.deepStrictEqual(config.pairedVersionIds(), ['v17'], 'an absent version id was reported as paired');
    });

    test('malformed repo rows are dropped rather than half-read', () => {
        const config = ensureUpgradeConfigModel({
            ...pair,
            repos: [
                { repoName: 'acme', repoPath: '/src/acme', fromBranch: '17.0-acme', toBranch: '19.0-acme' },
                { repoName: 'broken', fromBranch: '17.0-broken' },
                null,
                { repoName: '  ', fromBranch: 'a', toBranch: 'b' }
            ]
        });
        assert.deepStrictEqual(config.repos.map(entry => entry.repoName), ['acme']);
    });

    test('nothing is a side of an upgrade that is off', () => {
        const config = ensureUpgradeConfigModel({ ...pair, isEnabled: false });
        assert.strictEqual(config.sideForVersion('v17'), undefined);
        assert.strictEqual(config.sideForDb('crm-17'), undefined);
        assert.strictEqual(config.involvesRepo('acme'), false);
    });
});
