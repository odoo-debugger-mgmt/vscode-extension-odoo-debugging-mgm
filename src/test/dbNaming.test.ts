import * as assert from 'assert';
import { generateDatabaseIdentifiers } from '../services/dbNaming';

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
