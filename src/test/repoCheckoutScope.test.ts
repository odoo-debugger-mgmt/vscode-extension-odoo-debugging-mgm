/**
 * A worktree-mode repository must never be checked out in its source.
 *
 * The upgrade flow marks a repository `worktree` and maps each database to its
 * own branch. The switch pipeline read those assignments and ran `git checkout`
 * in the source repository regardless of the mode, which dragged the source
 * onto the branch a worktree needs, took that branch away from the worktree,
 * and re-armed the "using the source checkout" modal after every switch.
 *
 * The same assignments also tell the debugger and module discovery *where* a
 * repository's code lives, and those must keep seeing worktree-mode repos - so
 * the narrowing belongs to the checkout pipeline alone, not to the resolver.
 */
import * as assert from 'assert';
import {
    buildDatabaseEnvironmentTarget,
    resolveProjectRepoBranchAssignments,
    resolveProjectRepoCheckouts
} from '../services/environment';
import { RepoModel } from '../models/repo';

const database = {
    projectRepoBranches: [
        { repoName: 'acme', repoPath: '/src/acme', branch: '17.0-acme' },
        { repoName: 'other', repoPath: '/src/other', branch: '17.0-other' }
    ]
};

function repos(acmeMode: 'checkout' | 'worktree'): RepoModel[] {
    return [
        new RepoModel('acme', '/src/acme', true, undefined, acmeMode),
        new RepoModel('other', '/src/other', true, undefined, 'checkout')
    ];
}

suite('Which repositories a branch switch may touch', () => {
    test('a worktree-mode repository is left out of the checkouts', () => {
        assert.deepStrictEqual(
            resolveProjectRepoCheckouts(database, repos('worktree')).map(entry => entry.repoName),
            ['other'],
            'the source checkout of a worktree-mode repo was about to be switched'
        );
    });

    test('a checkout-mode repository is still checked out', () => {
        assert.deepStrictEqual(
            resolveProjectRepoCheckouts(database, repos('checkout')).map(entry => entry.repoName),
            ['acme', 'other']
        );
    });

    test('locating code still sees every repository, whatever its mode', () => {
        // resolveProjectRepoBranchAssignments feeds addons paths, module
        // discovery and the repos explorer: dropping worktree-mode repos there
        // would lose the very directory those features need to find.
        assert.deepStrictEqual(
            resolveProjectRepoBranchAssignments(database, repos('worktree')).map(entry => entry.repoName),
            ['acme', 'other']
        );
    });

    test('the switch pipeline is handed only the repos it may check out', () => {
        // Closes the loop: buildDatabaseEnvironmentTarget is what alignEnvironment
        // consumes, and repoAssignments is the only list it checks out. A
        // worktree-mode repo reaching this list is the bug - selecting a
        // database then ran `git checkout` in the source, took the branch away
        // from the copy that needed it, and re-armed the source-conflict modal
        // on every switch from then on.
        const target = buildDatabaseEnvironmentTarget(database, repos('worktree'));

        assert.deepStrictEqual(
            (target.repoAssignments ?? []).map(entry => entry.repoName),
            ['other'],
            'a worktree-mode repo reached the checkout pipeline'
        );
    });

    test('an unrecognised mode falls back to being checked out', () => {
        // Data written by an older version has no branchMode at all, and the
        // safe reading of "unknown" is the original single-checkout behaviour.
        const legacy = [
            { name: 'acme', path: '/src/acme', isSelected: true } as unknown as RepoModel,
            new RepoModel('other', '/src/other', true, undefined, 'checkout')
        ];
        assert.deepStrictEqual(
            resolveProjectRepoCheckouts(database, legacy).map(entry => entry.repoName),
            ['acme', 'other']
        );
    });
});
