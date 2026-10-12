import * as assert from 'assert';
import { generateDatabaseIdentifiers, newDatabaseNameProblem } from '../services/dbNaming';

suite('Database naming', () => {
    test('generates slugified identifiers within length limits', () => {
        const timestamp = new Date(Date.UTC(2025, 9, 14));
        const result = generateDatabaseIdentifiers({
            projectName: 'My Fancy Project',
            kind: 'dev',
            timestamp,
            deterministicSeed: 'unit-test-seed'
        });

        assert.match(result.internalName, /^my_fancy_project_dev_14102025_[a-f0-9]{6}$/);
        assert.ok(result.internalName.length <= 63, 'identifier exceeds Postgres limits');
    });

    test('deterministic seed produces stable identifiers and resolves collisions', () => {
        const timestamp = new Date(Date.UTC(2025, 4, 5));

        const first = generateDatabaseIdentifiers({
            projectName: 'Project',
            kind: 'dump',
            timestamp,
            deterministicSeed: 'dump-seed'
        });

        const collisionSet = new Set<string>([first.internalName.toLowerCase()]);
        const second = generateDatabaseIdentifiers({
            projectName: 'Project',
            kind: 'dump',
            timestamp,
            deterministicSeed: 'dump-seed',
            existingInternalNames: collisionSet
        });

        assert.notStrictEqual(first.internalName, second.internalName, 'collision should produce a new identifier');
        assert.match(first.internalName, /^project_dump_05052025_[a-f0-9]{6}$/);
        assert.match(second.internalName, /^project_dump_05052025_[a-f0-9]{6}$/);
    });

    test('display name includes project, kind, readable date, and hash suffix', () => {
        const timestamp = new Date(Date.UTC(2024, 0, 2));
        const result = generateDatabaseIdentifiers({
            projectName: 'Ops',
            kind: 'dump',
            timestamp,
            deterministicSeed: 'display-test'
        });

        assert.ok(result.displayName.includes('Ops'));
        assert.ok(result.displayName.includes('Dump'));
        assert.ok(result.displayName.includes('2024'));
        assert.ok(result.displayName.includes('#'));
    });
});

suite('Names a new database may take', () => {
    const linked = new Set(['acme-db1']);
    const inPostgres = new Set(['acme-db1', 'someone-elses']);

    test('a name that exists in PostgreSQL is refused, linked to a project or not', () => {
        // Clone and Create from Template used to drop it and copy over it.
        assert.strictEqual(
            newDatabaseNameProblem('someone-elses', linked, inPostgres),
            'A database with this name already exists in PostgreSQL.'
        );
        assert.strictEqual(newDatabaseNameProblem('Someone-Elses', linked, inPostgres), 'A database with this name already exists in PostgreSQL.');
        assert.strictEqual(newDatabaseNameProblem('acme-db1', linked, inPostgres), 'A database with this name is already linked to a project.');
    });

    test('a free, well-formed name is accepted', () => {
        assert.strictEqual(newDatabaseNameProblem(' acme-db2 ', linked, inPostgres), undefined);
    });

    test('empty, malformed and reserved names are refused as before', () => {
        assert.strictEqual(newDatabaseNameProblem('  ', linked, inPostgres), 'Database name cannot be empty.');
        assert.match(newDatabaseNameProblem('-x', linked, inPostgres) ?? '', /letters, numbers/);
        assert.match(newDatabaseNameProblem('template1', linked, inPostgres) ?? '', /reserved/);
    });
});
