/**
 * Which version a workspace runs (design §6): proposed from what the
 * workspace holds, asked once, and only where workspaces per version are the
 * point - a shared store.
 */
import * as assert from 'assert';
import { bindingIsOrphaned, leavesBoundVersion, normalizeBinding, proposeWorkspaceVersion, shouldOfferBinding } from '../services/workspaceBinding';

const versions = [
    { id: 'v17', name: 'Odoo 17.0', odooVersion: '17.0' },
    { id: 'v19', name: 'Odoo 19.0', odooVersion: '19.0' }
];

const project = {
    repos: [{ name: 'acme', path: '/v17/acme' }],
    dbs: [
        { id: 'acme-db1', versionId: 'v17', projectRepoBranches: [{ repoName: 'acme', branch: 'staging' }] },
        { id: 'acme-db19', versionId: 'v19', projectRepoBranches: [{ repoName: 'acme', branch: 'main' }] }
    ]
};

suite('Proposing the version a workspace runs', () => {
    test('through the data: the branch a folder is on, and the database that runs it', () => {
        // "main" says nothing about its series; the database mapping does.
        const proposal = proposeWorkspaceVersion(
            [{ path: '/v19/acme', name: 'acme', branch: 'main' }], [project], versions);
        assert.deepStrictEqual(proposal, { versionId: 'v19', reason: 'data', because: 'acme here is on main, which acme-db19 runs' });
    });

    test('a folder under another name is still recognised by its remote', () => {
        const proposal = proposeWorkspaceVersion(
            [{ path: '/v19/acme-19', name: 'acme-19', branch: 'main', remote: 'github.com/org/acme' }],
            [project], versions,
            repo => (repo.name === 'acme' ? 'github.com/org/acme' : undefined));
        assert.strictEqual(proposal?.versionId, 'v19');
    });

    test('through a branch named after a series, when no database says', () => {
        const proposal = proposeWorkspaceVersion(
            [{ path: '/work/other', name: 'other', branch: '19.0-dev' }], [project], versions);
        assert.deepStrictEqual(proposal, { versionId: 'v19', reason: 'branch', because: 'other here is on 19.0-dev' });
    });

    test('folders pointing at two versions propose nothing', () => {
        const proposal = proposeWorkspaceVersion([
            { path: '/v19/acme', name: 'acme', branch: 'main' },
            { path: '/v17/acme', name: 'acme', branch: 'staging' }
        ], [project], versions);
        assert.strictEqual(proposal, undefined);
    });

    test('a workspace holding no project checkout and no series branch proposes nothing', () => {
        assert.strictEqual(proposeWorkspaceVersion([{ path: '/notes', name: 'notes' }], [project], versions), undefined);
        assert.strictEqual(proposeWorkspaceVersion([{ path: '/x', name: 'x', branch: 'feature' }], [project], versions), undefined);
    });

    test('a database of a version that no longer exists is not proposed', () => {
        const orphaned = { ...project, dbs: [{ id: 'old', versionId: 'gone', projectRepoBranches: [{ repoName: 'acme', branch: 'main' }] }] };
        assert.strictEqual(proposeWorkspaceVersion([{ path: '/a', name: 'acme', branch: 'main' }], [orphaned], versions), undefined);
    });
});

suite('When a workspace is asked', () => {
    test('only on a shared store, with more than one version, and once', () => {
        assert.strictEqual(shouldOfferBinding('sqlite', 2, { asked: false }), true);
        assert.strictEqual(shouldOfferBinding('json', 2, { asked: false }), false, 'a workspace on its own file notices nothing');
        assert.strictEqual(shouldOfferBinding('sqlite', 1, { asked: false }), false);
        assert.strictEqual(shouldOfferBinding('sqlite', 2, { asked: true }), false);
        assert.strictEqual(shouldOfferBinding(undefined, 2, { asked: false }), false);
    });

    test('a stored binding is read back, and anything else is no binding', () => {
        assert.deepStrictEqual(normalizeBinding({ versionId: 'v19', asked: true }), { versionId: 'v19', asked: true });
        assert.deepStrictEqual(normalizeBinding({ versionId: '', asked: 'yes' }), { versionId: undefined, asked: false });
        assert.deepStrictEqual(normalizeBinding(undefined), { versionId: undefined, asked: false });
    });
});

suite('Leaving the version a workspace is bound to', () => {
    test('switching to another version\'s database, or to the version itself, does, and is said first', () => {
        assert.strictEqual(leavesBoundVersion('v19', 'v17', 'v19', false), true);
    });

    test('its own version, no binding, no version, already switched, or an upgrade: it does not', () => {
        assert.strictEqual(leavesBoundVersion('v19', 'v19', 'v19', false), false);
        assert.strictEqual(leavesBoundVersion(undefined, 'v17', 'v19', false), false);
        assert.strictEqual(leavesBoundVersion('v19', undefined, 'v19', false), false);
        // Thirteenth run: already on 17.0, it still said "switches this window to 17.0".
        assert.strictEqual(leavesBoundVersion('v19', 'v17', 'v17', false), false);
        assert.strictEqual(leavesBoundVersion('v19', 'v17', 'v19', true), false, 'selecting a side of an upgrade switches nothing');
    });
});

suite('A binding to a version that is gone', () => {
    const exists = (id: string) => id === 'v17';

    test('is dropped once the versions were read and it is not among them', () => {
        assert.strictEqual(bindingIsOrphaned('v19', true, exists), true);
        assert.strictEqual(bindingIsOrphaned('v17', true, exists), false);
        assert.strictEqual(bindingIsOrphaned(undefined, true, exists), false);
    });

    test('is kept when the store could not be read', () => {
        // Fifteenth run: one bad read and the window had to be bound again.
        assert.strictEqual(bindingIsOrphaned('v17', false, () => false), false);
    });
});
