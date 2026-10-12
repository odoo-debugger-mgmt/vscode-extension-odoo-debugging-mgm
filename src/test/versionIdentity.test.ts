import * as assert from 'assert';
import {
    parseSeriesMajor,
    deriveIdentity,
    collectTaken,
    healIdentities,
    isDerivedSetting,
    candidatePortsFor,
    identityConflicts,
    sessionOwner,
    automaticPart,
    IdentityCandidate
} from '../services/versionIdentity';

const EMPTY = { names: new Set<string>(), ports: new Set<number>() };

function candidate(
    id: string,
    odooVersion: string,
    createdAt: string,
    settings: IdentityCandidate['settings'] = {}
): IdentityCandidate {
    return { id, odooVersion, createdAt, settings };
}

suite('Version identity', () => {
    test('parses the major series number from a branch name', () => {
        assert.strictEqual(parseSeriesMajor('17.0'), 17);
        assert.strictEqual(parseSeriesMajor('19.0'), 19);
        assert.strictEqual(parseSeriesMajor('saas-17.4'), 17);
        assert.strictEqual(parseSeriesMajor('saas~17.4'), 17);
        // Dev branches keep their series prefix, so they share the series port.
        assert.strictEqual(parseSeriesMajor('17.0-my-fix-abc'), 17);
        assert.strictEqual(parseSeriesMajor('master'), undefined);
        assert.strictEqual(parseSeriesMajor(''), undefined);
    });

    test('derives name and ports from the branch', () => {
        assert.deepStrictEqual(deriveIdentity('17.0', 'odoo', EMPTY), {
            debuggerName: 'odoo:17.0',
            portNumber: 8017,
            shellPortNumber: 5017
        });
        assert.deepStrictEqual(deriveIdentity('saas-17.4', 'odoo', EMPTY), {
            debuggerName: 'odoo:saas-17.4',
            portNumber: 8017,
            shellPortNumber: 5017
        });
    });

    test('falls back to the base ports for a non-numeric branch', () => {
        assert.deepStrictEqual(deriveIdentity('master', 'odoo', EMPTY), {
            debuggerName: 'odoo:master',
            portNumber: 8000,
            shellPortNumber: 5000
        });
    });

    test('steps past taken ports and names', () => {
        const taken = {
            names: new Set(['odoo:17.0']),
            ports: new Set([8017, 5017, 8018])
        };
        assert.deepStrictEqual(deriveIdentity('17.0', 'odoo', taken), {
            debuggerName: 'odoo:17.0 (2)',
            portNumber: 8019,
            shellPortNumber: 5018
        });
    });

    test('collects taken values, optionally excluding one version', () => {
        const candidates = [
            candidate('a', '17.0', '2026-01-01', { debuggerName: 'odoo:17.0', portNumber: 8017, shellPortNumber: 5017 }),
            candidate('b', '18.0', '2026-01-02', { debuggerName: 'odoo:18.0', portNumber: 8018, shellPortNumber: 5018 })
        ];

        const all = collectTaken(candidates);
        assert.deepStrictEqual([...all.names].sort(), ['odoo:17.0', 'odoo:18.0']);
        assert.deepStrictEqual([...all.ports].sort(), [5017, 5018, 8017, 8018]);

        const withoutA = collectTaken(candidates, 'a');
        assert.deepStrictEqual([...withoutA.names], ['odoo:18.0']);
    });

    test('heals only the newer side of a collision and leaves the rest alone', () => {
        // Both inherited the same global default; the older one keeps it.
        const candidates = [
            candidate('old', '17.0', '2026-01-01', { debuggerName: 'odoo:19.0', portNumber: 8019, shellPortNumber: 5019 }),
            candidate('new', '18.0', '2026-02-01', { debuggerName: 'odoo:19.0', portNumber: 8019, shellPortNumber: 5019 }),
            candidate('fine', 'master', '2026-03-01', { debuggerName: 'odoo:master', portNumber: 8000, shellPortNumber: 5000 })
        ];

        const patches = healIdentities(candidates, 'odoo');
        assert.strictEqual(patches.length, 1);
        assert.strictEqual(patches[0].id, 'new');
        assert.deepStrictEqual(patches[0].identity, {
            debuggerName: 'odoo:18.0',
            portNumber: 8018,
            shellPortNumber: 5018
        });
    });

    test('heals a version that carries no identity at all', () => {
        const patches = healIdentities([candidate('bare', '17.0', '2026-01-01')], 'odoo');
        assert.deepStrictEqual(patches, [
            { id: 'bare', identity: { debuggerName: 'odoo:17.0', portNumber: 8017, shellPortNumber: 5017 } }
        ]);
    });

    test('treats the blank model baseline as needing derivation', () => {
        // VersionModel/SettingsModel now default to ''/0/0 rather than a
        // plausible odoo:19.0, so a 17.0 version cannot silently keep it.
        const patches = healIdentities(
            [candidate('fresh', '17.0', '2026-01-01', { debuggerName: '', portNumber: 0, shellPortNumber: 0 })],
            'odoo'
        );
        assert.deepStrictEqual(patches, [
            { id: 'fresh', identity: { debuggerName: 'odoo:17.0', portNumber: 8017, shellPortNumber: 5017 } }
        ]);
    });

    test('lists the candidate ports a new version might claim', () => {
        // The window a live-socket probe has to check before deriving.
        assert.deepStrictEqual(candidatePortsFor('17.0', 3), [8017, 8018, 8019, 5017, 5018, 5019]);
        assert.deepStrictEqual(candidatePortsFor('master', 2), [8000, 8001, 5000, 5001]);
    });

    test('identifies the derived setting keys', () => {
        assert.strictEqual(isDerivedSetting('debuggerName'), true);
        assert.strictEqual(isDerivedSetting('portNumber'), true);
        assert.strictEqual(isDerivedSetting('shellPortNumber'), true);
        // debuggerVersion stays user-editable.
        assert.strictEqual(isDerivedSetting('debuggerVersion'), false);
        assert.strictEqual(isDerivedSetting('odooPath'), false);
    });

    test('keeps values set by hand even when they collide', () => {
        // Two versions deliberately sharing one launch entry and one port.
        const candidates = [
            candidate('a', '17.0', '2026-01-01', {
                debuggerName: 'Odoo', portNumber: 8069, shellPortNumber: 5017,
                customIdentity: ['debuggerName', 'portNumber']
            }),
            candidate('b', '18.0', '2026-01-02', {
                debuggerName: 'Odoo', portNumber: 8069, shellPortNumber: 5018,
                customIdentity: ['debuggerName', 'portNumber']
            })
        ];
        assert.deepStrictEqual(healIdentities(candidates, 'odoo'), []);
    });

    test('moves an automatic value off one set by hand, patching only automatic keys', () => {
        // The older version holds 8018 automatically; a newer one claimed it by hand.
        const candidates = [
            candidate('auto', '18.0', '2026-01-01', { debuggerName: 'odoo:18.0', portNumber: 8018, shellPortNumber: 5018 }),
            candidate('mine', '17.0', '2026-02-01', {
                debuggerName: 'mine', portNumber: 8018, shellPortNumber: 5017,
                customIdentity: ['debuggerName', 'portNumber']
            })
        ];
        assert.deepStrictEqual(healIdentities(candidates, 'odoo'), [
            { id: 'auto', identity: { debuggerName: 'odoo:18.0', portNumber: 8019, shellPortNumber: 5018 } }
        ]);
    });

    test('never patches a key set by hand when the rest needs deriving', () => {
        const patches = healIdentities([
            candidate('half', '17.0', '2026-01-01', {
                debuggerName: 'Odoo', portNumber: 0, shellPortNumber: 0, customIdentity: ['debuggerName']
            })
        ], 'odoo');
        assert.deepStrictEqual(patches, [{ id: 'half', identity: { portNumber: 8017, shellPortNumber: 5017 } }]);
    });

    test('keeps only the automatic part of a derived identity', () => {
        assert.deepStrictEqual(
            automaticPart({ debuggerName: 'odoo:17.0', portNumber: 8017, shellPortNumber: 5017 }, ['portNumber']),
            { debuggerName: 'odoo:17.0', shellPortNumber: 5017 }
        );
        assert.deepStrictEqual(
            automaticPart({ debuggerName: 'odoo:17.0', portNumber: 8017, shellPortNumber: 5017 }, undefined),
            { debuggerName: 'odoo:17.0', portNumber: 8017, shellPortNumber: 5017 }
        );
    });

    test('names the other versions a version shares a name or port with', () => {
        const candidates = [
            candidate('a', '17.0', '2026-01-01', { debuggerName: 'Odoo', portNumber: 8069, shellPortNumber: 5017 }),
            candidate('b', '18.0', '2026-01-02', { debuggerName: 'Odoo', portNumber: 8018, shellPortNumber: 8069 }),
            candidate('c', '19.0', '2026-01-03', { debuggerName: 'odoo:19.0', portNumber: 8019, shellPortNumber: 5019 })
        ];
        assert.deepStrictEqual(identityConflicts(candidates, 'a'), [
            { key: 'debuggerName', value: 'Odoo', otherIds: ['b'] },
            { key: 'portNumber', value: 8069, otherIds: ['b'] }
        ]);
        assert.deepStrictEqual(identityConflicts(candidates, 'c'), []);
    });

    test('a shared launch entry belongs to the active version, else the oldest', () => {
        const candidates = [
            candidate('new', '18.0', '2026-02-01', { debuggerName: 'Odoo' }),
            candidate('old', '17.0', '2026-01-01', { debuggerName: 'Odoo' }),
            candidate('other', '19.0', '2026-01-01', { debuggerName: 'odoo:19.0' })
        ];
        assert.strictEqual(sessionOwner(candidates, 'Odoo', 'new')?.id, 'new');
        assert.strictEqual(sessionOwner(candidates, 'Odoo', 'other')?.id, 'old');
        assert.strictEqual(sessionOwner(candidates, 'Odoo', undefined)?.id, 'old');
        assert.strictEqual(sessionOwner(candidates, 'nobody', 'new'), undefined);
    });
});
