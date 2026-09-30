/**
 * Another window on a shared store deleted what this window had selected
 * (design §9): said once, rather than looking like this window lost it.
 */
import * as assert from 'assert';
import { describeGone, selectionFacts } from '../services/goneElsewhere';

suite('Things deleted in another window', () => {
    const before = selectionFacts(
        { uid: 'p1', name: 'acme', dbs: [{ id: 'acme-db1' }, { id: 'acme-db2', isSelected: true }] },
        { id: 'v19', name: 'Odoo 19.0' }
    );

    test('the selected database, once', () => {
        const said = new Set<string>();
        const after = { projectKeys: ['p1'], dbIds: ['acme-db1'], versionIds: ['v19'] };
        assert.deepStrictEqual(describeGone(before, after, said),
            ['"acme-db2" was deleted in another window, so no database is selected here.']);
        assert.deepStrictEqual(describeGone(before, after, said), [], 'said once');
    });

    test('the active version, naming the one this window runs now', () => {
        const messages = describeGone(before,
            { projectKeys: ['p1'], dbIds: ['acme-db1', 'acme-db2'], versionIds: ['v17'], activeVersionName: 'Odoo 17.0' },
            new Set());
        assert.deepStrictEqual(messages, ['"Odoo 19.0" was deleted in another window; this window now runs Odoo 17.0.']);
    });

    test('the whole project: said for the project, not for each database in it', () => {
        const messages = describeGone(before, { projectKeys: [], dbIds: [], versionIds: ['v19'] }, new Set());
        assert.deepStrictEqual(messages, ['Project "acme" was deleted in another window, so no project is selected here.']);
    });

    test('nothing gone, nothing said', () => {
        assert.deepStrictEqual(
            describeGone(before, { projectKeys: ['p1'], dbIds: ['acme-db1', 'acme-db2'], versionIds: ['v19'] }, new Set()),
            []);
    });
});
