import * as assert from 'assert';
import * as path from 'node:path';
import { diagnoseVersion, migratable, needsAttention } from '../services/versionMigration';

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

    test('a version running out of the source repository is not merely relocated', () => {
        const diagnosis = diagnoseVersion(
            {
                id: 'v1',
                name: 'Odoo 17.0',
                odooVersion: '17.0',
                odooPath: '/home/dev/src/odoo',
                pythonPath: '/home/dev/src/venv/bin/python'
            },
            ROOT,
            () => true,
            '/home/dev/src/odoo'
        );

        assert.strictEqual(diagnosis.health, 'source-repo');
        assert.ok(diagnosis.detail.includes('source repository'));
    });

    test('the source repo is compared after path resolution', () => {
        const diagnosis = diagnoseVersion(
            {
                id: 'v1',
                name: 'Odoo 17.0',
                odooVersion: '17.0',
                odooPath: '/home/dev/src/odoo/',
                pythonPath: '/home/dev/src/venv/bin/python'
            },
            ROOT,
            () => true,
            '/home/dev/src/./odoo'
        );

        assert.strictEqual(diagnosis.health, 'source-repo');
    });

    test('a working version outside the provisioning root stays relocated', () => {
        const diagnosis = diagnoseVersion(
            {
                id: 'v1',
                name: 'Odoo 17.0',
                odooVersion: '17.0',
                odooPath: '/home/dev/old/odoo-17.0',
                pythonPath: '/home/dev/old/venv/bin/python'
            },
            ROOT,
            () => true,
            '/home/dev/src/odoo'
        );

        assert.strictEqual(diagnosis.health, 'relocated');
    });

    test('migratable returns the unsafe healths worst first, without relocated', () => {
        const entries = migratable([
            { versionId: 'a', name: 'a', health: 'relocated', expectedOdooPath: '', detail: '' },
            { versionId: 'b', name: 'b', health: 'unprovisioned', expectedOdooPath: '', detail: '' },
            { versionId: 'c', name: 'c', health: 'source-repo', expectedOdooPath: '', detail: '' },
            { versionId: 'd', name: 'd', health: 'missing', expectedOdooPath: '', detail: '' },
            { versionId: 'e', name: 'e', health: 'healthy', expectedOdooPath: '', detail: '' }
        ]);

        assert.deepStrictEqual(entries.map(entry => entry.versionId), ['c', 'd', 'b']);
    });

    test('a version running out of the source repository is diagnosed as such even when its interpreter is gone', () => {
        // The legacy 1.2 shape: a hand-built ./odoo that IS the source repo,
        // beside a ./venv that has since been deleted. Checking the interpreter
        // first called this "unprovisioned" and lost the unsafe framing.
        const source = '/home/dev/src/odoo';
        const diagnosis = diagnoseVersion(
            {
                id: 'v17',
                name: 'Odoo 17.0',
                odooVersion: '17.0',
                odooPath: source,
                pythonPath: '/home/dev/src/venv/bin/python'
            },
            ROOT,
            probe(source),
            source
        );
        assert.strictEqual(diagnosis.health, 'source-repo');
        assert.ok(diagnosis.detail.includes('switches that repository'));
    });

    test('source-repo outranks every other unhealthy state', () => {
        const source = '/home/dev/src/odoo';
        const ranked = needsAttention([
            { versionId: 'a', name: 'A', health: 'missing', expectedOdooPath: '', detail: '' },
            { versionId: 'b', name: 'B', health: 'source-repo', expectedOdooPath: '', detail: '' },
            { versionId: 'c', name: 'C', health: 'unprovisioned', expectedOdooPath: '', detail: '' }
        ]);
        assert.strictEqual(ranked[0].versionId, 'b');
        assert.ok(source.length > 0);
    });
});
