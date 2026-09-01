import * as assert from 'assert';
import { versionFolderEntries, repoFolderEntries, WorkspaceFolderEntry } from '../services/workspaceFolders';
import { RepoModel } from '../models/repo';

const VERSION = {
    name: 'Odoo 17.0',
    settings: {
        odooPath: '/srv/odt/odoo-17.0',
        enterprisePath: '/srv/odt/enterprise-17.0',
        designThemesPath: '/srv/odt/design-themes-17.0'
    }
};

suite('Workspace folders', () => {
    test('contributes the active version core checkouts, named by version', () => {
        assert.deepStrictEqual(versionFolderEntries(VERSION, []), [
            { path: '/srv/odt/odoo-17.0', name: 'odoo (Odoo 17.0)' },
            { path: '/srv/odt/enterprise-17.0', name: 'enterprise (Odoo 17.0)' },
            { path: '/srv/odt/design-themes-17.0', name: 'design-themes (Odoo 17.0)' }
        ]);
    });

    test('skips paths a project repo already contributes', () => {
        const entries = versionFolderEntries(VERSION, ['/srv/odt/enterprise-17.0']);
        assert.deepStrictEqual(entries.map((entry: WorkspaceFolderEntry) => entry.path), [
            '/srv/odt/odoo-17.0',
            '/srv/odt/design-themes-17.0'
        ]);
    });

    test('skips unset paths and returns nothing without an active version', () => {
        assert.deepStrictEqual(
            versionFolderEntries({ name: 'Bare', settings: { odooPath: '/srv/odoo' } }, []),
            [{ path: '/srv/odoo', name: 'odoo (Bare)' }]
        );
        assert.deepStrictEqual(versionFolderEntries({ name: 'Empty', settings: {} }, []), []);
        assert.deepStrictEqual(versionFolderEntries(undefined, []), []);
    });

    test('does not contribute the same path twice', () => {
        // A version whose enterprise path was never re-pointed after cloning
        // must not produce a duplicate workspace folder.
        const entries = versionFolderEntries(
            { name: 'Dup', settings: { odooPath: '/srv/same', enterprisePath: '/srv/same' } },
            []
        );
        assert.deepStrictEqual(entries, [{ path: '/srv/same', name: 'odoo (Dup)' }]);
    });

    test('contributes worktrees, labelled with their branch', () => {
        const resolved = [
            {
                repo: new RepoModel('psae-internal', '/custom/psae-internal', true, undefined, 'worktree'),
                path: '/root/psae-internal@19.0',
                branch: '19.0',
                mode: 'worktree' as const,
                isWorktree: true
            }
        ];
        assert.deepStrictEqual(repoFolderEntries(resolved, []), [
            { path: '/root/psae-internal@19.0', name: 'psae-internal (19.0)' }
        ]);
    });

    test('leaves a checkout-mode repo unlabelled and skips duplicates', () => {
        const resolved = [
            {
                repo: new RepoModel('shared', '/custom/shared'),
                path: '/custom/shared',
                branch: 'main',
                mode: 'checkout' as const,
                isWorktree: false
            }
        ];
        assert.deepStrictEqual(repoFolderEntries(resolved, []), [{ path: '/custom/shared' }]);
        assert.deepStrictEqual(repoFolderEntries(resolved, ['/custom/shared']), []);
    });
});
