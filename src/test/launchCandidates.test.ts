import * as assert from 'assert';
import { launchCandidates } from '../services/launchCandidates';
import { sessionOwner } from '../services/versionIdentity';

function version(id: string, createdAt: string, provisioned: boolean) {
    return {
        id,
        odooVersion: '17.0',
        createdAt,
        settings: { debuggerName: 'Odoo', pythonPath: provisioned ? process.execPath : '/nowhere/bin/python' }
    };
}

suite('Which versions own a launch entry', () => {
    const unprovisioned = version('a', '2026-01-01', false);
    const provisioned = version('b', '2026-02-01', true);
    const active = version('c', '2026-03-01', false);

    test('provisioned versions and the active one, nothing else', () => {
        assert.deepStrictEqual(launchCandidates([unprovisioned, provisioned, active], active).map((entry: { id: string }) => entry.id), ['b', 'c']);
        assert.deepStrictEqual(launchCandidates([unprovisioned, provisioned], undefined).map((entry: { id: string }) => entry.id), ['b']);
    });

    test('a shared name belongs to the version its entry is written for', () => {
        // "Odoo" shared by an unprovisioned oldest version and a provisioned
        // one, with a third active: the entry is written for the provisioned
        // one, so its session is that version's, not the oldest's.
        const other = { ...active, settings: { ...active.settings, debuggerName: 'odoo:17.0' } };
        const candidates = launchCandidates([unprovisioned, provisioned, other], other);
        assert.strictEqual(sessionOwner(candidates, 'Odoo', other.id)?.id, 'b');
    });
});
