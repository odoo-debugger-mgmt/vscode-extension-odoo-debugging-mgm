import * as assert from 'assert';
import * as path from 'node:path';
import { diagnoseVersion } from '../services/versionMigration';

const ROOT = '/home/dev/odoo-dev';

function probe(...present: string[]) {
    const set = new Set(present);
    return (candidate: string) => set.has(candidate);
}

suite('Version migration diagnosis', () => {
    test('a version under the current root with a working interpreter is healthy', () => {
        const odooPath = path.join(ROOT, 'odoo-19.0');
        const pythonPath = path.join(ROOT, 'venv-19.0', 'bin', 'python');
        const diagnosis = diagnoseVersion(
            { id: 'v19', name: 'Odoo 19.0', odooVersion: '19.0', odooPath, pythonPath },
            ROOT,
            probe(odooPath, pythonPath)
        );
        assert.strictEqual(diagnosis.health, 'healthy');
    });

    test('a version whose directories are gone is missing', () => {
        // The case that produced the shipped worktree failure.
        const diagnosis = diagnoseVersion(
            {
                id: 'v19',
                name: 'Odoo 19.0',
                odooVersion: '19.0',
                odooPath: '/old/root/odoo-19.0',
                pythonPath: '/old/root/venv-19.0/bin/python'
            },
            ROOT,
            probe()
        );
        assert.strictEqual(diagnosis.health, 'missing');
        assert.strictEqual(diagnosis.expectedOdooPath, path.join(ROOT, 'odoo-19.0'));
    });

    test('a version that still exists but sits outside the current root is relocated', () => {
        const odooPath = '/old/root/odoo-19.0';
        const pythonPath = '/old/root/venv-19.0/bin/python';
        const diagnosis = diagnoseVersion(
            { id: 'v19', name: 'Odoo 19.0', odooVersion: '19.0', odooPath, pythonPath },
            ROOT,
            probe(odooPath, pythonPath)
        );
        // Still usable, so it is not "missing" - but the provisioning root moved
        // and re-provisioning would collide with it.
        assert.strictEqual(diagnosis.health, 'relocated');
    });

    test('a version with no interpreter is unprovisioned', () => {
        const odooPath = path.join(ROOT, 'odoo-19.0');
        const diagnosis = diagnoseVersion(
            { id: 'v19', name: 'Odoo 19.0', odooVersion: '19.0', odooPath, pythonPath: '' },
            ROOT,
            probe(odooPath)
        );
        assert.strictEqual(diagnosis.health, 'unprovisioned');
    });

    test('a version with no paths at all is unprovisioned', () => {
        const diagnosis = diagnoseVersion(
            { id: 'v', name: 'Bare', odooVersion: '17.0' },
            ROOT,
            probe()
        );
        assert.strictEqual(diagnosis.health, 'unprovisioned');
        assert.ok(diagnosis.detail.length > 0);
    });
});
