import * as assert from 'assert';
import { versionFolderEntries, WorkspaceFolderEntry } from '../services/workspaceFolders';

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
});
