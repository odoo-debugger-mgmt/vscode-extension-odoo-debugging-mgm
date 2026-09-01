import * as assert from 'assert';
import {
    classifySourceConflict,
    describeSourceConflict,
    parsePorcelainStatus
} from '../services/sourceConflict';

suite('Source checkout conflict', () => {
    test('no conflict when the source is on another branch', () => {
        assert.deepStrictEqual(classifySourceConflict('main', '19.0', []), { kind: 'none' });
        assert.deepStrictEqual(classifySourceConflict(null, '19.0', []), { kind: 'none' });
        // Detached already: the branch is free.
        assert.deepStrictEqual(classifySourceConflict(undefined, '19.0', []), { kind: 'none' });
    });

    test('a clean source holding the branch can be moved off it', () => {
        assert.deepStrictEqual(classifySourceConflict('19.0', '19.0', []), {
            kind: 'movable',
            branch: '19.0'
        });
    });

    test('a dirty source holding the branch is refused, naming the files', () => {
        assert.deepStrictEqual(
            classifySourceConflict('19.0', '19.0', ['my_module/models.py', 'README.md']),
            { kind: 'dirty', branch: '19.0', files: ['my_module/models.py', 'README.md'] }
        );
    });

    test('explains why, and what detaching actually costs', () => {
        const movable = describeSourceConflict({ kind: 'movable', branch: '19.0' }, 'psae-internal');
        assert.ok(movable.includes('19.0'));
        assert.ok(movable.includes('psae-internal'));
        // The reason must be stated: users do not know git's one-worktree rule.
        assert.ok(movable.toLowerCase().includes('one place'));
        // Both consequences of detaching, verified by experiment, must appear:
        // the source cannot return to the branch while the worktree exists,
        // and commits made detached belong to no branch.
        assert.ok(movable.toLowerCase().includes('until the worktree is removed'));
        assert.ok(movable.toLowerCase().includes('no branch'));

        const dirty = describeSourceConflict(
            { kind: 'dirty', branch: '19.0', files: ['a.py', 'b.py'] },
            'psae-internal'
        );
        assert.ok(dirty.includes('a.py'));
        assert.ok(dirty.toLowerCase().includes('commit') || dirty.toLowerCase().includes('stash'));

        assert.strictEqual(describeSourceConflict({ kind: 'none' }, 'psae-internal'), '');
    });

    test('parses changed paths out of git status --porcelain', () => {
        assert.deepStrictEqual(
            parsePorcelainStatus(' M my_module/models.py\n?? new_file.py\nA  staged.py\n'),
            ['my_module/models.py', 'new_file.py', 'staged.py']
        );
        assert.deepStrictEqual(parsePorcelainStatus(''), []);
        assert.deepStrictEqual(parsePorcelainStatus('   \n'), []);
        // Renames report "old -> new"; the new path is what matters.
        assert.deepStrictEqual(parsePorcelainStatus('R  old.py -> new.py\n'), ['new.py']);
    });
});
