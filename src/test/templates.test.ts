import * as assert from 'assert';
import { sanitizeDatabaseTemplates, validateTemplateDatabaseName } from '../services/templates';

suite('Database templates', () => {
    test('heals legacy records that only carry a name', () => {
        const templates = sanitizeDatabaseTemplates([
            { name: 'tpl_legacy', createdAt: '2025-01-01T00:00:00.000Z' }
        ]);

        assert.strictEqual(templates.length, 1);
        assert.strictEqual(templates[0].templateDbName, 'tpl_legacy');
        assert.strictEqual(templates[0].name, 'tpl_legacy');
    });

    test('dedupes by PostgreSQL name case-insensitively', () => {
        const templates = sanitizeDatabaseTemplates([
            { name: 'A', templateDbName: 'tpl_base' },
            { name: 'B', templateDbName: 'TPL_BASE' }
        ]);

        assert.strictEqual(templates.length, 1);
        assert.strictEqual(templates[0].name, 'A');
    });

    test('drops entries without any usable name and sorts the rest', () => {
        const templates = sanitizeDatabaseTemplates([
            { sourceDbName: 'x' },
            { templateDbName: 'tpl_zebra' },
            { templateDbName: 'tpl_alpha' },
            'not-an-object',
            null
        ]);

        assert.deepStrictEqual(templates.map(t => t.templateDbName), ['tpl_alpha', 'tpl_zebra']);
    });

    test('validates template database names', () => {
        const existing = new Set(['tpl_taken']);

        assert.strictEqual(validateTemplateDatabaseName('tpl_ok', existing), null);
        assert.ok(validateTemplateDatabaseName('', existing));
        assert.ok(validateTemplateDatabaseName('-leading-dash', existing));
        assert.ok(validateTemplateDatabaseName('has space', existing));
        assert.ok(validateTemplateDatabaseName('postgres', existing));
        assert.ok(validateTemplateDatabaseName('tpl_taken', existing));
        // Renaming a template to its own name is allowed.
        assert.strictEqual(validateTemplateDatabaseName('tpl_taken', existing, 'tpl_taken'), null);
    });
});
