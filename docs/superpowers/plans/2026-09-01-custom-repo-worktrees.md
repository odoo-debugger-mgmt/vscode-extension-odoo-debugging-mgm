# Per-Version Custom Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project repository be opted into `worktree` mode so two Odoo versions can run against their own branch of the custom code at once, and clean up the branch model and switch UX that surround it.

**Architecture:** A repository gains a `branchMode` (`checkout`, the default and today's behaviour, or `worktree`). A pure resolver maps `(repo, branch)` to the directory that repo's code lives in; every consumer that reads `repo.path` routes through it. In `worktree` mode the original checkout becomes a source only — never in the addons path — and per-branch worktrees are created under the provisioning root. Because developers commit to custom code, those worktrees check out the *real* branch, never a managed `odt/` alias, which makes freeing the branch from the source checkout an explicit, user-confirmed step.

**Tech Stack:** TypeScript, VS Code extension API (TreeDataProvider, `workspace.onDidOpenTextDocument`, `RelativePattern` file watchers, `globalState`), Mocha `suite`/`test` with node `assert` under `@vscode/test-cli`, `git worktree`.

**Spec:** `docs/superpowers/specs/2026-09-01-custom-repo-worktrees-design.md`

## Global Constraints

- **Never spawn a shell.** All process execution goes through `runCommand`/`tryRunCommand` in `src/services/process.ts`, or `execFile` with an argument array.
- **All user-facing messages** go through `src/services/notifications.ts` (`showInfo`, `showWarning`, `showError`, `showModalWarning`); all logging through `src/services/logger.ts`.
- **Pure logic is separated from I/O and tested.** Resolution, naming, classification and identification take plain data and return plain data; `vscode` and `fs` live in thin wrappers. Follow `src/services/pythonToolchain.ts` (pure `rankInterpreters`, impure `discoverInterpreters`).
- **Custom-repo worktrees check out the real branch, never `odt/<branch>`.** The `odt/` alias is correct for Odoo core, where nobody commits; using it for custom code would put the developer's commits on a branch nobody else sees.
- **The source checkout is never modified without explicit confirmation.** Never detach silently, never stash on the user's behalf.
- **`checkout` is the default mode.** A repo that has not opted in must resolve to `repo.path` and behave exactly as it does today.
- **Worktree directory naming:** `<repo-slug>@<branch-slug>` under `odooDebugger.provisioning.root`, keyed by branch so two versions on one branch share a worktree.
- **Verification gate for every task:** `npm run compile-tests` (grep the output for `error TS` — a stale `out/` lets tests pass against old code), `npm run lint`, `npm run compile`, `npm test`. All four clean before committing. The suite is at **149 passing** at the start of this plan.
- **Commit style:** `[ADD]`, `[FIX]`, `[IMP]`, `[REF]`, `[DOC]` prefix, imperative sentence.

---

### Task 1: Repository branch mode

Adds the opt-in flag. Nothing reads it yet; this task exists so later tasks have a stable field and so the default is proven not to change behaviour.

**Files:**
- Modify: `src/models/repo.ts`
- Test: `src/test/repoMode.test.ts`

**Interfaces:**
- Produces: `type RepoBranchMode = 'checkout' | 'worktree'`; `RepoModel.branchMode: RepoBranchMode`; `function normalizeBranchMode(value: unknown): RepoBranchMode`.

- [ ] **Step 1: Write the failing test**

Create `src/test/repoMode.test.ts`:

```ts
import * as assert from 'assert';
import { RepoModel, normalizeBranchMode } from '../models/repo';

suite('Repository branch mode', () => {
    test('defaults to checkout, which is the pre-existing behaviour', () => {
        const repo = new RepoModel('psae-internal', '/custom/psae-internal');
        assert.strictEqual(repo.branchMode, 'checkout');
    });

    test('accepts an explicit worktree mode', () => {
        const repo = new RepoModel('psae-internal', '/custom/psae-internal', false, undefined, 'worktree');
        assert.strictEqual(repo.branchMode, 'worktree');
    });

    test('normalizes anything unrecognized back to checkout', () => {
        // Stored data predates this field, so undefined is the common case.
        assert.strictEqual(normalizeBranchMode(undefined), 'checkout');
        assert.strictEqual(normalizeBranchMode(''), 'checkout');
        assert.strictEqual(normalizeBranchMode('nonsense'), 'checkout');
        assert.strictEqual(normalizeBranchMode('worktree'), 'worktree');
        assert.strictEqual(normalizeBranchMode('checkout'), 'checkout');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run compile-tests`
Expected: FAIL with `error TS2305: Module '"../models/repo"' has no exported member 'normalizeBranchMode'`.

- [ ] **Step 3: Write the implementation**

Replace `src/models/repo.ts` entirely:

```ts
/**
 * Repository model: a git repo belonging to a project.
 */

/**
 * How a repository satisfies a database's branch assignment.
 *
 * `checkout` runs `git checkout` in the one working copy - the original
 * behaviour, and right for ordinary development where a feature branch simply
 * follows staging and prod.
 *
 * `worktree` gives each branch its own directory so two versions can run
 * against their own custom code at once. Opted into per repository, because it
 * is a per-repository situation: usually one repo is mid-upgrade and the rest
 * are not.
 */
export type RepoBranchMode = 'checkout' | 'worktree';

export function normalizeBranchMode(value: unknown): RepoBranchMode {
    return value === 'worktree' ? 'worktree' : 'checkout';
}

export class RepoModel {
    name: string;
    path: string;
    isSelected: boolean = false;
    addedAt?: string;
    branchMode: RepoBranchMode;
    constructor(
        name: string,
        path: string,
        isSelected: boolean = false,
        addedAt?: string,
        branchMode: RepoBranchMode = 'checkout'
    ) {
        this.name = name;
        this.path = path;
        this.isSelected = isSelected;
        this.addedAt = addedAt ?? new Date().toISOString();
        this.branchMode = normalizeBranchMode(branchMode);
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 152 passing (149 + 3), no `error TS`, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/models/repo.ts src/test/repoMode.test.ts
git commit -m "[ADD] Per-repository branch mode, defaulting to checkout"
```

---

### Task 2: Path resolution

The mechanism the whole design rests on: one pure function mapping `(repo, branch)` to the directory that repo's code lives in. Every consumer routes through it in Tasks 5-6.

**Files:**
- Create: `src/services/repoPaths.ts`
- Test: `src/test/repoPaths.test.ts`

**Interfaces:**
- Consumes: `RepoModel`, `RepoBranchMode` (Task 1); `ProjectRepoBranchAssignment` from `src/models/db.ts`.
- Produces:
  - `interface ResolvedRepo { repo: RepoModel; path: string; branch?: string; mode: RepoBranchMode; isWorktree: boolean }`
  - `function worktreeDirName(repoName: string, branch: string): string`
  - `function resolveRepoPath(repo: RepoModel, branch: string | undefined, root: string): ResolvedRepo`
  - `function resolveProjectRepos(repos: RepoModel[], assignments: ProjectRepoBranchAssignment[], root: string): ResolvedRepo[]`
  - `function toDiscoveryRepos(resolved: ResolvedRepo[]): RepoModel[]`
  - `function identifyWorktreeOwner(filePath: string, resolved: ResolvedRepo[]): { repo: RepoModel; branch: string } | undefined`

- [ ] **Step 1: Write the failing tests**

Create `src/test/repoPaths.test.ts`:

```ts
import * as assert from 'assert';
import * as path from 'node:path';
import { RepoModel } from '../models/repo';
import {
    worktreeDirName,
    resolveRepoPath,
    resolveProjectRepos,
    toDiscoveryRepos,
    identifyWorktreeOwner
} from '../services/repoPaths';

const ROOT = '/home/dev/odoo-dev';

function repo(name: string, repoPath: string, mode: 'checkout' | 'worktree' = 'checkout'): RepoModel {
    return new RepoModel(name, repoPath, true, undefined, mode);
}

suite('Repository path resolution', () => {
    test('builds a worktree directory name from repo and branch', () => {
        assert.strictEqual(worktreeDirName('psae-internal', '19.0'), 'psae-internal@19.0');
        // Slashes and anything else illegal in a directory name are replaced.
        assert.strictEqual(worktreeDirName('psae-internal', '19.0-bunka-abc'), 'psae-internal@19.0-bunka-abc');
        assert.strictEqual(worktreeDirName('psae internal', 'feature/x'), 'psae-internal@feature-x');
    });

    test('a checkout-mode repo always resolves to its own path', () => {
        const model = repo('psae-internal', '/custom/psae-internal');
        const resolved = resolveRepoPath(model, '19.0', ROOT);
        assert.strictEqual(resolved.path, '/custom/psae-internal');
        assert.strictEqual(resolved.isWorktree, false);
        assert.strictEqual(resolved.mode, 'checkout');
        assert.strictEqual(resolved.branch, '19.0');
    });

    test('a worktree-mode repo resolves to a per-branch directory under the root', () => {
        const model = repo('psae-internal', '/custom/psae-internal', 'worktree');
        const resolved = resolveRepoPath(model, '19.0', ROOT);
        assert.strictEqual(resolved.path, path.join(ROOT, 'psae-internal@19.0'));
        assert.strictEqual(resolved.isWorktree, true);
        assert.strictEqual(resolved.branch, '19.0');
    });

    test('a worktree-mode repo with no branch assigned falls back to its source', () => {
        // Nothing to key a worktree on; the source is read-only in this state
        // and the caller reports it (spec: failure modes table).
        const model = repo('psae-internal', '/custom/psae-internal', 'worktree');
        const resolved = resolveRepoPath(model, undefined, ROOT);
        assert.strictEqual(resolved.path, '/custom/psae-internal');
        assert.strictEqual(resolved.isWorktree, false);
        assert.strictEqual(resolved.branch, undefined);
    });

    test('resolves a whole project against its branch assignments', () => {
        const repos = [
            repo('psae-internal', '/custom/psae-internal', 'worktree'),
            repo('shared-lib', '/custom/shared-lib')
        ];
        const assignments = [
            { repoName: 'psae-internal', repoPath: '/custom/psae-internal', branch: '19.0' },
            { repoName: 'shared-lib', repoPath: '/custom/shared-lib', branch: 'main' }
        ];

        const resolved = resolveProjectRepos(repos, assignments, ROOT);
        assert.deepStrictEqual(resolved.map(entry => entry.path), [
            path.join(ROOT, 'psae-internal@19.0'),
            '/custom/shared-lib'
        ]);
    });

    test('matches assignments by path first, then by name', () => {
        const repos = [repo('psae-internal', '/custom/psae-internal', 'worktree')];
        // A renamed repo still matches on path.
        const byPath = resolveProjectRepos(
            repos,
            [{ repoName: 'renamed', repoPath: '/custom/psae-internal', branch: '17.0' }],
            ROOT
        );
        assert.strictEqual(byPath[0].branch, '17.0');

        // A moved repo still matches on name.
        const byName = resolveProjectRepos(
            repos,
            [{ repoName: 'psae-internal', repoPath: '/somewhere/else', branch: '18.0' }],
            ROOT
        );
        assert.strictEqual(byName[0].branch, '18.0');
    });

    test('adapts resolved repos for module discovery', () => {
        const repos = [repo('psae-internal', '/custom/psae-internal', 'worktree')];
        const resolved = resolveProjectRepos(
            repos,
            [{ repoName: 'psae-internal', repoPath: '/custom/psae-internal', branch: '19.0' }],
            ROOT
        );

        const discovery = toDiscoveryRepos(resolved);
        // Discovery must see the worktree, not the source checkout.
        assert.strictEqual(discovery[0].path, path.join(ROOT, 'psae-internal@19.0'));
        assert.strictEqual(discovery[0].name, 'psae-internal');
    });

    test('identifies which repo and branch a file belongs to', () => {
        const repos = [repo('psae-internal', '/custom/psae-internal', 'worktree')];
        const resolved = resolveProjectRepos(
            repos,
            [{ repoName: 'psae-internal', repoPath: '/custom/psae-internal', branch: '19.0' }],
            ROOT
        );

        const owner = identifyWorktreeOwner(
            path.join(ROOT, 'psae-internal@19.0', 'my_module', 'models.py'),
            resolved
        );
        assert.strictEqual(owner?.repo.name, 'psae-internal');
        assert.strictEqual(owner?.branch, '19.0');

        // A file outside every worktree belongs to nobody.
        assert.strictEqual(identifyWorktreeOwner('/etc/passwd', resolved), undefined);
        // A sibling directory whose name merely starts the same must not match.
        assert.strictEqual(
            identifyWorktreeOwner(path.join(ROOT, 'psae-internal@19.0-other', 'x.py'), resolved),
            undefined
        );
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run compile-tests`
Expected: FAIL with `error TS2307: Cannot find module '../services/repoPaths'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/repoPaths.ts`:

```ts
/**
 * Where a repository's code actually lives for a given branch.
 *
 * In `checkout` mode that is always the repository itself - the behaviour that
 * predates this module. In `worktree` mode each branch gets its own directory
 * under the provisioning root, so two versions can run against their own
 * custom code at once, and the original checkout becomes a source only.
 *
 * Pure: mapping is decided here, creating directories is not.
 */
import * as path from 'node:path';
import { RepoModel, RepoBranchMode, normalizeBranchMode } from '../models/repo';
import type { ProjectRepoBranchAssignment } from '../models/db';
import { normalizePath } from '../utils';

export interface ResolvedRepo {
    repo: RepoModel;
    /** Directory to use: the source checkout, or a worktree for the branch. */
    path: string;
    /** The branch this path is on, when one is assigned. */
    branch?: string;
    mode: RepoBranchMode;
    /** True when `path` is a worktree rather than the source checkout. */
    isWorktree: boolean;
}

/** Anything illegal or confusing in a directory name becomes a dash. */
function slug(value: string): string {
    return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function worktreeDirName(repoName: string, branch: string): string {
    return `${slug(repoName)}@${slug(branch)}`;
}

export function resolveRepoPath(repo: RepoModel, branch: string | undefined, root: string): ResolvedRepo {
    const mode = normalizeBranchMode(repo.branchMode);
    const trimmedBranch = branch?.trim() || undefined;

    // No branch to key a worktree on: the source is all there is.
    if (mode !== 'worktree' || !trimmedBranch) {
        return {
            repo,
            path: normalizePath(repo.path),
            branch: trimmedBranch,
            mode,
            isWorktree: false
        };
    }

    return {
        repo,
        path: path.join(root, worktreeDirName(repo.name, trimmedBranch)),
        branch: trimmedBranch,
        mode,
        isWorktree: true
    };
}

export function resolveProjectRepos(
    repos: RepoModel[],
    assignments: ProjectRepoBranchAssignment[],
    root: string
): ResolvedRepo[] {
    const byPath = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const assignment of assignments) {
        if (!assignment.branch) {
            continue;
        }
        if (assignment.repoPath) {
            byPath.set(normalizePath(assignment.repoPath), assignment.branch);
        }
        if (assignment.repoName) {
            byName.set(assignment.repoName.toLowerCase(), assignment.branch);
        }
    }

    return repos.map(repo => {
        // Path first: a renamed repo still matches. Name second: a moved one does.
        const branch = byPath.get(normalizePath(repo.path)) ?? byName.get(repo.name.toLowerCase());
        return resolveRepoPath(repo, branch, root);
    });
}

/**
 * Resolved repos in the shape `discoverModulesInRepos` expects, so module
 * discovery and the addons path see worktrees rather than source checkouts
 * without every downstream signature changing.
 */
export function toDiscoveryRepos(resolved: ResolvedRepo[]): RepoModel[] {
    return resolved.map(entry => new RepoModel(
        entry.repo.name,
        entry.path,
        entry.repo.isSelected,
        entry.repo.addedAt,
        entry.mode
    ));
}

/** Whether `child` is `parent` itself or sits inside it. */
function isInside(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Which repo and branch a file on disk belongs to, for the wrong-copy warning.
 * Only worktrees are considered: a file in a source checkout is not "the wrong
 * copy", it is simply not part of what any version runs.
 */
export function identifyWorktreeOwner(
    filePath: string,
    resolved: ResolvedRepo[]
): { repo: RepoModel; branch: string } | undefined {
    const target = path.resolve(filePath);
    for (const entry of resolved) {
        if (entry.isWorktree && entry.branch && isInside(target, path.resolve(entry.path))) {
            return { repo: entry.repo, branch: entry.branch };
        }
    }
    return undefined;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 160 passing (152 + 8), no `error TS`, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/repoPaths.ts src/test/repoPaths.test.ts
git commit -m "[ADD] Resolve a repository's directory from its branch and mode"
```

---

### Task 3: Freeing the branch from the source checkout

Custom worktrees check out the real branch, so the source checkout must not be holding it. This task decides — purely and testably — what to do about that, before anything acts on it.

**Files:**
- Create: `src/services/sourceConflict.ts`
- Test: `src/test/sourceConflict.test.ts`

**Interfaces:**
- Produces:
  - `type SourceConflict = { kind: 'none' } | { kind: 'detachable'; branch: string } | { kind: 'dirty'; branch: string; files: string[] }`
  - `function classifySourceConflict(sourceBranch: string | null | undefined, targetBranch: string, dirtyFiles: string[]): SourceConflict`
  - `function describeSourceConflict(conflict: SourceConflict, repoName: string): string`
  - `function parsePorcelainStatus(stdout: string): string[]`

- [ ] **Step 1: Write the failing tests**

Create `src/test/sourceConflict.test.ts`:

```ts
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

    test('a clean source holding the branch can be detached', () => {
        assert.deepStrictEqual(classifySourceConflict('19.0', '19.0', []), {
            kind: 'detachable',
            branch: '19.0'
        });
    });

    test('a dirty source holding the branch is refused, naming the files', () => {
        assert.deepStrictEqual(
            classifySourceConflict('19.0', '19.0', ['my_module/models.py', 'README.md']),
            { kind: 'dirty', branch: '19.0', files: ['my_module/models.py', 'README.md'] }
        );
    });

    test('explains why, not just what', () => {
        const detachable = describeSourceConflict({ kind: 'detachable', branch: '19.0' }, 'psae-internal');
        assert.ok(detachable.includes('19.0'));
        assert.ok(detachable.includes('psae-internal'));
        // The reason must be stated: users do not know git's one-worktree rule.
        assert.ok(detachable.toLowerCase().includes('one place'));

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run compile-tests`
Expected: FAIL with `error TS2307: Cannot find module '../services/sourceConflict'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/sourceConflict.ts`:

```ts
/**
 * git will not check one branch out in two places. Odoo core worktrees dodge
 * this with a managed `odt/<branch>` alias, but custom code is committed and
 * pushed, so its worktrees must hold the real branch - which means the source
 * checkout has to let go of it first.
 *
 * Deciding that is pure and lives here; doing it is the caller's job, and only
 * ever with the user's explicit confirmation.
 */

export type SourceConflict =
    | { kind: 'none' }
    | { kind: 'detachable'; branch: string }
    | { kind: 'dirty'; branch: string; files: string[] };

export function classifySourceConflict(
    sourceBranch: string | null | undefined,
    targetBranch: string,
    dirtyFiles: string[]
): SourceConflict {
    if (!sourceBranch || sourceBranch !== targetBranch) {
        return { kind: 'none' };
    }
    return dirtyFiles.length > 0
        ? { kind: 'dirty', branch: targetBranch, files: dirtyFiles }
        : { kind: 'detachable', branch: targetBranch };
}

export function describeSourceConflict(conflict: SourceConflict, repoName: string): string {
    if (conflict.kind === 'none') {
        return '';
    }

    const why = `git can only check a branch out in one place, and this version needs "${conflict.branch}" in its own worktree.`;

    if (conflict.kind === 'detachable') {
        return `Your checkout of "${repoName}" is on "${conflict.branch}". ${why} `
            + `Detaching it leaves the same commit and the same files, and one "git switch ${conflict.branch}" puts it back.`;
    }

    const shown = conflict.files.slice(0, 5).join(', ');
    const more = conflict.files.length > 5 ? `, and ${conflict.files.length - 5} more` : '';
    return `Your checkout of "${repoName}" is on "${conflict.branch}" with uncommitted changes (${shown}${more}). `
        + `${why} Commit or stash them first - which of the two is your call, not the extension's.`;
}

/** Changed paths from `git status --porcelain`, staged and unstaged alike. */
export function parsePorcelainStatus(stdout: string): string[] {
    const paths: string[] = [];
    for (const rawLine of stdout.split('\n')) {
        // Status codes occupy the first two columns; the path follows a space.
        const line = rawLine.slice(3).trim();
        if (!line) {
            continue;
        }
        // Renames and copies report "old -> new"; the new path is the live one.
        const arrow = line.indexOf(' -> ');
        paths.push(arrow >= 0 ? line.slice(arrow + 4).trim() : line);
    }
    return paths;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 165 passing (160 + 5), no `error TS`, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/sourceConflict.ts src/test/sourceConflict.test.ts
git commit -m "[ADD] Classify a source checkout holding a branch a worktree needs"
```

---

### Task 4: Creating custom-repo worktrees

Wires Tasks 2 and 3 into an impure operation that creates a worktree on the real branch, resolving the source conflict with the user rather than around them.

**Files:**
- Create: `src/services/customWorktree.ts`
- Modify: `src/services/worktree.ts` (export a real-branch variant)
- Test: `src/test/worktree.test.ts` (extend)

**Interfaces:**
- Consumes: `ensureWorktree`, `classifyBranchConflict`, `parseWorktreeList`, `removeWorktree` from `src/services/worktree.ts`; `classifySourceConflict`, `describeSourceConflict`, `parsePorcelainStatus` (Task 3); `ResolvedRepo` (Task 2).
- Produces:
  - `function ensureRealBranchWorktree(repoPath: string, branch: string, destPath: string, token?: vscode.CancellationToken): Promise<WorktreeResult>` in `src/services/worktree.ts`
  - `async function ensureCustomWorktrees(resolved: ResolvedRepo[], token?: vscode.CancellationToken): Promise<{ ready: ResolvedRepo[]; problems: string[] }>` in `src/services/customWorktree.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/test/worktree.test.ts`, inside the existing `suite`:

```ts
    test('managed branch names are not used for real-branch worktrees', () => {
        // Odoo core parks on odt/19.0 because nobody commits there. Custom code
        // is committed and pushed, so its worktree must hold the real branch or
        // the developer's work lands on a branch nobody else sees.
        assert.strictEqual(managedBranchName('19.0'), 'odt/19.0');
        assert.strictEqual(branchSatisfiesTarget('19.0', '19.0'), true);
        assert.strictEqual(branchSatisfiesTarget('odt/19.0', '19.0'), true);
    });
```

- [ ] **Step 2: Run the test to verify it compiles and passes**

Run: `npm run compile-tests && npm test`
Expected: PASS — this test pins existing behaviour that Task 4 must not change. If `managedBranchName` or `branchSatisfiesTarget` are not already imported in that file, add them to the existing import from `../services/worktree`.

- [ ] **Step 3: Add a real-branch worktree creator**

In `src/services/worktree.ts`, add after `ensureWorktree`:

```ts
/**
 * A worktree checked out on `branch` itself, not on a managed `odt/` alias.
 *
 * Custom repositories are committed to and pushed from, so their worktrees
 * must hold the real branch. The caller is responsible for having freed the
 * branch from the source checkout first (see sourceConflict.ts); this function
 * surfaces git's refusal rather than working around it.
 */
export async function ensureRealBranchWorktree(
    repoPath: string,
    branch: string,
    destPath: string,
    token?: vscode.CancellationToken
): Promise<WorktreeResult> {
    const existing = await listWorktrees(repoPath);

    const atDestination = existing.find(entry => samePath(entry.path, destPath));
    if (atDestination) {
        logger.info(`[worktree] reusing existing worktree at ${destPath}`);
        return { path: destPath, created: false, adopted: true, branch: atDestination.branch ?? branch };
    }

    const conflict = classifyBranchConflict(existing, branch, destPath, fs.existsSync);
    if (conflict.kind === 'stale') {
        logger.info(`[worktree] pruning the stale record for ${conflict.path}`);
        await runCommand('git', ['worktree', 'prune'], { cwd: repoPath, token });
    } else if (conflict.kind === 'live') {
        logger.warn(`[worktree] ${branch} is already checked out at ${conflict.path}; reusing it`);
        return { path: conflict.path, created: false, adopted: true, branch };
    }

    if (fs.existsSync(destPath)) {
        throw new Error(`Cannot create a worktree at ${destPath}: the path already exists and is not a worktree of ${repoPath}.`);
    }

    if (await hasRef(repoPath, `refs/heads/${branch}`)) {
        await runCommand('git', ['worktree', 'add', destPath, branch], { cwd: repoPath, token });
        return { path: destPath, created: true, adopted: false, branch };
    }

    const remote = `refs/remotes/origin/${branch}`;
    if (!(await hasRef(repoPath, remote))) {
        throw new Error(`Branch "${branch}" was not found locally or on origin in ${repoPath}.`);
    }
    // Branching from the remote-tracking ref sets upstream, so push and pull
    // work inside the worktree without further setup.
    await runCommand('git', ['worktree', 'add', '-b', branch, destPath, remote], { cwd: repoPath, token });
    return { path: destPath, created: true, adopted: false, branch };
}
```

- [ ] **Step 4: Write the orchestration**

Create `src/services/customWorktree.ts`:

```ts
/**
 * Creates the worktrees a set of resolved repositories needs, resolving the
 * "source checkout holds this branch" conflict with the user rather than
 * around them. Never detaches silently and never stashes.
 */
import * as vscode from 'vscode';
import { runCommand, tryRunCommand } from './process';
import { logger, errorMessage } from './logger';
import { showModalWarning, showWarning } from './notifications';
import { getRepoBranch } from './branches';
import { ensureRealBranchWorktree } from './worktree';
import { classifySourceConflict, describeSourceConflict, parsePorcelainStatus } from './sourceConflict';
import type { ResolvedRepo } from './repoPaths';

async function dirtyFiles(repoPath: string): Promise<string[]> {
    const stdout = await tryRunCommand('git', ['status', '--porcelain'], { cwd: repoPath });
    return stdout === undefined ? [] : parsePorcelainStatus(stdout);
}

/**
 * Frees `branch` from the source checkout, asking first. Returns true when the
 * branch is available afterwards.
 */
async function freeBranch(sourcePath: string, repoName: string, branch: string): Promise<boolean> {
    const conflict = classifySourceConflict(
        await getRepoBranch(sourcePath),
        branch,
        await dirtyFiles(sourcePath)
    );

    if (conflict.kind === 'none') {
        return true;
    }

    const message = describeSourceConflict(conflict, repoName);
    if (conflict.kind === 'dirty') {
        void showWarning(message);
        return false;
    }

    const choice = await showModalWarning(message, 'Detach the source checkout');
    if (choice !== 'Detach the source checkout') {
        return false;
    }

    await runCommand('git', ['checkout', '--detach'], { cwd: sourcePath });
    logger.info(`[worktree] detached ${sourcePath} to free ${branch}`);
    return true;
}

/**
 * Ensures every worktree-mode entry has its directory. Entries that cannot be
 * satisfied are reported and fall back to their source checkout, so one
 * problem repo never blocks the rest of the project.
 */
export async function ensureCustomWorktrees(
    resolved: ResolvedRepo[],
    token?: vscode.CancellationToken
): Promise<{ ready: ResolvedRepo[]; problems: string[] }> {
    const ready: ResolvedRepo[] = [];
    const problems: string[] = [];

    for (const entry of resolved) {
        if (!entry.isWorktree || !entry.branch) {
            ready.push(entry);
            continue;
        }

        const sourcePath = entry.repo.path;
        try {
            if (!(await freeBranch(sourcePath, entry.repo.name, entry.branch))) {
                problems.push(`${entry.repo.name}: could not free "${entry.branch}" from its source checkout`);
                ready.push({ ...entry, path: sourcePath, isWorktree: false });
                continue;
            }

            const result = await ensureRealBranchWorktree(sourcePath, entry.branch, entry.path, token);
            ready.push({ ...entry, path: result.path });
        } catch (error) {
            logger.error(`[worktree] ${entry.repo.name}:`, error);
            problems.push(`${entry.repo.name}: ${errorMessage(error)}`);
            ready.push({ ...entry, path: sourcePath, isWorktree: false });
        }
    }

    return { ready, problems };
}
```

- [ ] **Step 5: Verify the whole gate**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 166 passing (165 + 1), no `error TS`, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "[ADD] Create custom-repo worktrees on the real branch"
```

---

### Task 5: The addons path and module discovery follow the resolver

The functional payoff: a version's addons path points at its own worktrees, so two versions run against their own custom code.

**Files:**
- Modify: `src/services/psaeInternal.ts:25-28` (`collectModuleDiscovery`)
- Modify: `src/debugger.ts` (`prepareArgs`)
- Test: `src/test/repoPaths.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveProjectRepos`, `toDiscoveryRepos` (Task 2); `readSetupState` from `src/services/setupState.ts` for the provisioning root.
- Produces: `collectModuleDiscovery(project: ProjectModel, resolved?: ResolvedRepo[])` — passing `resolved` makes discovery see worktrees; omitting it preserves today's behaviour.

- [ ] **Step 1: Write the failing test**

Append to `src/test/repoPaths.test.ts`, inside the `suite`:

```ts
    test('two versions on different branches resolve to different directories', () => {
        // The whole point of the feature: v17 and v19 must not share a copy.
        const repos = [repo('psae-internal', '/custom/psae-internal', 'worktree')];
        const v17 = resolveProjectRepos(
            repos,
            [{ repoName: 'psae-internal', repoPath: '/custom/psae-internal', branch: '17.0' }],
            ROOT
        );
        const v19 = resolveProjectRepos(
            repos,
            [{ repoName: 'psae-internal', repoPath: '/custom/psae-internal', branch: '19.0' }],
            ROOT
        );

        assert.notStrictEqual(v17[0].path, v19[0].path);
        assert.strictEqual(v17[0].path, path.join(ROOT, 'psae-internal@17.0'));
        assert.strictEqual(v19[0].path, path.join(ROOT, 'psae-internal@19.0'));
    });

    test('two versions on the same branch share one worktree', () => {
        // Keyed by branch, not by version: no duplicate trees.
        const repos = [repo('shared', '/custom/shared', 'worktree')];
        const a = resolveProjectRepos(repos, [{ repoName: 'shared', repoPath: '/custom/shared', branch: 'main' }], ROOT);
        const b = resolveProjectRepos(repos, [{ repoName: 'shared', repoPath: '/custom/shared', branch: 'main' }], ROOT);
        assert.strictEqual(a[0].path, b[0].path);
    });
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `npm run compile-tests && npm test`
Expected: 168 passing (166 + 2). These pass against Task 2's implementation; they pin the behaviour Steps 3-4 must preserve while threading it through.

- [ ] **Step 3: Let module discovery accept resolved repos**

In `src/services/psaeInternal.ts`, replace `collectModuleDiscovery`:

```ts
export function collectModuleDiscovery(project: ProjectModel, resolved?: ResolvedRepo[]): ModuleDiscoveryResult {
    const manualIncludes = (project.includedPsaeInternalPaths ?? []).filter(entry => !entry.startsWith('!'));
    // Resolved repos point at the active version's worktrees; without them
    // discovery falls back to the source checkouts, which is correct for
    // checkout-mode projects and for callers that have no version in hand.
    const repos = resolved ? toDiscoveryRepos(resolved) : project.repos;
    return discoverModulesInRepos(repos, { manualIncludePaths: manualIncludes });
}
```

Add to that file's imports:

```ts
import { toDiscoveryRepos, ResolvedRepo } from './repoPaths';
```

- [ ] **Step 4: Resolve repos in `prepareArgs`**

In `src/debugger.ts`, add to the imports:

```ts
import { resolveProjectRepos } from './services/repoPaths';
import { ensureCustomWorktrees } from './services/customWorktree';
import { readSetupState } from './services/setupState';
import { resolveProjectRepoBranchAssignments } from './services/environment';
```

In `prepareArgs`, replace this line:

```ts
    const discovery = collectModuleDiscovery(project);
```

with:

```ts
    // Resolve every project repo to the directory this version runs from, so
    // two versions on different branches never share one copy of the code.
    const resolvedRepos = resolveProjectRepos(
        project.repos ?? [],
        resolveProjectRepoBranchAssignments(db, project.repos ?? []),
        readSetupState().provisioningRoot
    );
    const discovery = collectModuleDiscovery(project, resolvedRepos);
```

This must come **after** the `const db = resolveDbForVersion(...)` line, because the assignments come from the resolved database. Move the `discovery` declaration below the database lookup if it is not already there.

- [ ] **Step 5: Create the worktrees before launching**

In `src/debugger.ts`, in `setupDebugger`, immediately before the `for (const version of targets)` loop, add:

```ts
    // Worktrees are created once per sync rather than per launch entry: the
    // same branch is often shared by several versions.
    const setupRoot = readSetupState().provisioningRoot;
    const worktreeProblems = new Set<string>();
```

and inside the loop, immediately before `args = await prepareArgs(...)`, add:

```ts
        const db = resolveDbForVersion(project.dbs, project.selectedDbByVersion, version.id);
        if (db) {
            const { problems } = await ensureCustomWorktrees(resolveProjectRepos(
                project.repos ?? [],
                resolveProjectRepoBranchAssignments(db, project.repos ?? []),
                setupRoot
            ));
            problems.forEach(problem => worktreeProblems.add(problem));
        }
```

After the loop, before `await selectPythonInterpreter(...)`, add:

```ts
    if (worktreeProblems.size > 0) {
        void showWarning(`Some repositories fell back to their source checkout — ${Array.from(worktreeProblems).join('; ')}`);
    }
```

Add `showWarning` to the existing `./utils` import in `src/debugger.ts`.

- [ ] **Step 6: Scaffold into the resolved repository**

`src/module.ts:583` scaffolds a new module into `normalizePath(targetRepo.path)` — the source checkout, which in worktree mode is not what any version runs. Replace:

```ts
    const destinationPath = normalizePath(targetRepo.path);
```

with:

```ts
    // Scaffold into the copy this version actually runs, not the source.
    const destinationPath = resolveRepoPath(
        targetRepo,
        resolveProjectRepoBranchAssignments(
            targetProject.dbs?.find(entry => entry.isSelected),
            targetProject.repos ?? []
        ).find(entry => entry.repoName === targetRepo.name)?.branch,
        readSetupState().provisioningRoot
    ).path;
```

and add to `src/module.ts` imports:

```ts
import { resolveRepoPath } from './services/repoPaths';
import { resolveProjectRepoBranchAssignments } from './services/environment';
import { readSetupState } from './services/setupState';
```

The destination picker at `src/module.ts:558` shows `repo.path`; change its `description` to the resolved path so the user picks a directory that matches where the file lands.

- [ ] **Step 7: Verify the whole gate**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 168 passing, no `error TS`, no lint errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "[IMP] Point the addons path at each version's own repo worktrees"
```

---

### Task 6: Views follow the active version

Scoping, the first half of the wrong-copy defence: the UI never offers a copy belonging to another version.

**Files:**
- Modify: `src/projectReposExplorer.ts:150-220`
- Modify: `src/services/workspaceFolders.ts`
- Test: `src/test/workspaceFolders.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveProjectRepos`, `ResolvedRepo` (Task 2).
- Produces: `function repoFolderEntries(resolved: ResolvedRepo[], existingPaths: string[]): WorkspaceFolderEntry[]` in `src/services/workspaceFolders.ts`.

**Two notes before starting.**

*Reveal in Explorer, Copy Path and Open in Terminal need no separate work.* They resolve their target through `extractUri`, which reads the tree item's `uri`. Building explorer rows from resolved paths in Step 4 therefore makes all of them act on the resolved path automatically — the spec's §3 requirement is satisfied here, not in its own task.

*The Repos view (`repoSelector`) deliberately keeps source paths.* The spec lists `RepoTreeProvider` as a consumer, but reading it shows it does not iterate `project.repos` at all: it scans `customAddonsPath` for repositories on disk so the user can pick which belong to the project. That is a discovery picker over *source* repositories, and resolving it to worktrees would be wrong — you cannot add a worktree to a project. Leave it alone.

- [ ] **Step 1: Write the failing test**

Append to `src/test/workspaceFolders.test.ts`, inside the `suite`:

```ts
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
```

Add to that file's imports:

```ts
import { versionFolderEntries, repoFolderEntries, WorkspaceFolderEntry } from '../services/workspaceFolders';
import { RepoModel } from '../models/repo';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run compile-tests`
Expected: FAIL with `error TS2305: Module '"../services/workspaceFolders"' has no exported member 'repoFolderEntries'`.

- [ ] **Step 3: Write the implementation**

In `src/services/workspaceFolders.ts`, add:

```ts
import type { ResolvedRepo } from './repoPaths';

/**
 * Project repositories as workspace folders, resolved to the active version's
 * worktrees. A worktree is labelled with its branch so two open copies of the
 * same repository are told apart at a glance.
 */
export function repoFolderEntries(resolved: ResolvedRepo[], existingPaths: string[]): WorkspaceFolderEntry[] {
    const seen = new Set(existingPaths.map(entry => normalizePath(entry)));
    const entries: WorkspaceFolderEntry[] = [];

    for (const entry of resolved) {
        const resolvedPath = normalizePath(entry.path);
        if (seen.has(resolvedPath)) {
            continue;
        }
        seen.add(resolvedPath);
        entries.push(entry.isWorktree && entry.branch
            ? { path: resolvedPath, name: `${entry.repo.name} (${entry.branch})` }
            : { path: resolvedPath });
    }

    return entries;
}
```

- [ ] **Step 4: Scope the Project Repos explorer**

In `src/projectReposExplorer.ts`, find where it maps `project.repos` to tree entries (around line 156, `const repoPath = normalizePath(repo.path);`) and the watcher registration (around line 203-214, `.map(repo => repo.path)` and `new vscode.RelativePattern(repo.path, '**/*')`).

Replace both reads of `repo.path` with the resolved path by computing the resolution once per refresh:

```ts
    // Resolved once per refresh: the explorer must show the active version's
    // worktrees, so a file opened from it belongs to the version being run.
    private resolveRepos(project: ProjectModel): ResolvedRepo[] {
        const db = project.dbs?.find(entry => entry.isSelected);
        return resolveProjectRepos(
            project.repos ?? [],
            db ? resolveProjectRepoBranchAssignments(db, project.repos ?? []) : [],
            readSetupState().provisioningRoot
        );
    }
```

Add to that file's imports:

```ts
import { resolveProjectRepos, ResolvedRepo } from './services/repoPaths';
import { resolveProjectRepoBranchAssignments } from './services/environment';
import { readSetupState } from './services/setupState';
```

Use `this.resolveRepos(project)` in both the tree-building and the watcher-registration paths, reading `entry.path` instead of `repo.path`, and show `entry.branch` in the row description when `entry.isWorktree`.

- [ ] **Step 5: Add the repos to the generated workspace**

In `src/projectWorkspace.ts`, in `buildWorkspaceFile`, after the `versionFolderEntries` block added by the previous plan, add:

```ts
    // Project repos resolved to the active version's worktrees, so opening a
    // file from this workspace cannot land in another version's copy.
    const selectedDb = project.dbs?.find(entry => entry.isSelected);
    folders.push(...repoFolderEntries(
        resolveProjectRepos(
            project.repos ?? [],
            selectedDb ? resolveProjectRepoBranchAssignments(selectedDb, project.repos ?? []) : [],
            readSetupState().provisioningRoot
        ),
        folders.map(folder => folder.path)
    ));
```

Add the matching imports (`repoFolderEntries`, `resolveProjectRepos`, `resolveProjectRepoBranchAssignments`, `readSetupState`).

- [ ] **Step 6: Verify the whole gate**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 170 passing (168 + 2), no `error TS`, no lint errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "[IMP] Scope repo views and the workspace to the active version"
```

---

### Task 7: The wrong-copy warning

The second half of the defence: scoping does not help a file reached through search history, a bookmark, or an external tool.

**Files:**
- Create: `src/services/wrongCopyGuard.ts`
- Modify: `src/extension.ts`
- Test: `src/test/repoPaths.test.ts` (already covers `identifyWorktreeOwner`)

**Interfaces:**
- Consumes: `identifyWorktreeOwner`, `resolveProjectRepos` (Task 2).
- Produces: `function registerWrongCopyGuard(context: vscode.ExtensionContext): void`.

- [ ] **Step 1: Write the failing test**

Append to `src/test/repoPaths.test.ts`, inside the `suite`:

```ts
    test('identifies a file in another version worktree of the same repo', () => {
        const repos = [repo('psae-internal', '/custom/psae-internal', 'worktree')];
        const active = resolveProjectRepos(
            repos,
            [{ repoName: 'psae-internal', repoPath: '/custom/psae-internal', branch: '19.0' }],
            ROOT
        );

        // Active version is 19.0; the file opened belongs to the 17.0 worktree,
        // which is not in `active`, so it must not be claimed as owned.
        assert.strictEqual(
            identifyWorktreeOwner(path.join(ROOT, 'psae-internal@17.0', 'models.py'), active),
            undefined
        );
        // The same file under the active worktree is owned.
        assert.strictEqual(
            identifyWorktreeOwner(path.join(ROOT, 'psae-internal@19.0', 'models.py'), active)?.branch,
            '19.0'
        );
    });
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npm run compile-tests && npm test`
Expected: 171 passing (170 + 1). This pins the semantics the guard relies on.

- [ ] **Step 3: Write the guard**

Create `src/services/wrongCopyGuard.ts`:

```ts
/**
 * Warns when a file being opened belongs to a version other than the active
 * one. Scoping the views (see repoPaths.ts consumers) removes the wrong copy
 * from the UI, but not from search history, bookmarks or external tools - and
 * two directories with identical file trees is the hazard this design
 * introduces, so it gets a second line of defence.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SettingsStore } from '../settingsStore';
import { logger } from './logger';
import { showWarning } from './notifications';
import { readSetupState } from './setupState';
import { resolveProjectRepos, worktreeDirName } from './repoPaths';
import { resolveProjectRepoBranchAssignments } from './environment';

const SUPPRESSED_KEY = 'odooDevtools.wrongCopyWarningSuppressed';

/**
 * The repo and branch a path under the provisioning root belongs to, derived
 * from the `<repo>@<branch>` directory name rather than from configuration -
 * the file may belong to a version that is not currently resolvable.
 */
export function parseWorktreeDirName(dirName: string): { repo: string; branch: string } | undefined {
    const at = dirName.lastIndexOf('@');
    if (at <= 0 || at === dirName.length - 1) {
        return undefined;
    }
    return { repo: dirName.slice(0, at), branch: dirName.slice(at + 1) };
}

export function registerWrongCopyGuard(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(async document => {
        if (document.uri.scheme !== 'file') {
            return;
        }
        if (context.globalState.get<boolean>(SUPPRESSED_KEY)) {
            return;
        }

        try {
            const root = readSetupState().provisioningRoot;
            const relative = path.relative(root, document.uri.fsPath);
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
                return;
            }

            const owner = parseWorktreeDirName(relative.split(path.sep)[0]);
            if (!owner) {
                return;
            }

            const result = await SettingsStore.get('odoo-debugger-data.json').catch(() => undefined);
            const project = result?.projects?.find(entry => entry.isSelected);
            if (!project) {
                return;
            }
            const db = project.dbs?.find(entry => entry.isSelected);
            const active = resolveProjectRepos(
                project.repos ?? [],
                db ? resolveProjectRepoBranchAssignments(db, project.repos ?? []) : [],
                root
            );

            const activeEntry = active.find(entry => entry.repo.name === owner.repo && entry.isWorktree);
            if (!activeEntry || !activeEntry.branch || activeEntry.branch === owner.branch) {
                return;
            }

            const choice = await showWarning(
                `${path.basename(document.uri.fsPath)} belongs to "${owner.branch}", but "${activeEntry.branch}" is active.`,
                `Open the ${activeEntry.branch} copy`,
                'Stay here',
                "Don't warn again"
            );

            if (choice === `Open the ${activeEntry.branch} copy`) {
                const withinWorktree = path.relative(
                    path.join(root, worktreeDirName(owner.repo, owner.branch)),
                    document.uri.fsPath
                );
                const target = vscode.Uri.file(path.join(activeEntry.path, withinWorktree));
                await vscode.window.showTextDocument(target, { preview: false });
            } else if (choice === "Don't warn again") {
                // A developer deliberately comparing two versions must not be nagged.
                await context.globalState.update(SUPPRESSED_KEY, true);
            }
        } catch (error) {
            logger.debug('Wrong-copy guard failed:', error);
        }
    }));
}
```

- [ ] **Step 4: Register it**

In `src/extension.ts`, add to the imports:

```ts
import { registerWrongCopyGuard } from './services/wrongCopyGuard';
```

and after `registerAllCommands({ ... });`, add:

```ts
    registerWrongCopyGuard(context);
```

- [ ] **Step 5: Verify the whole gate**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 171 passing, no `error TS`, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "[ADD] Warn when opening a file from another version's worktree"
```

---

### Task 8: Turning the mode on and off

The command that makes the feature reachable, including the modal that names the directory — the spec's answer to "the location is surfaced, not assumed".

**Files:**
- Modify: `src/commands/reposExplorerCommands.ts`
- Modify: `package.json`
- Test: `src/test/repoMode.test.ts` (extend)

**Interfaces:**
- Consumes: `worktreeDirName`, `resolveRepoPath` (Task 2); `removeWorktree` from `src/services/worktree.ts`; `parsePorcelainStatus` (Task 3).
- Produces: command `odt.repo.toggleBranchMode`; `function describeModeChange(repoName: string, mode: RepoBranchMode, root: string, branches: string[]): string`.

- [ ] **Step 1: Write the failing test**

Append to `src/test/repoMode.test.ts`, inside the `suite`:

```ts
    test('names the exact directories before creating them', () => {
        const message = describeModeChange('psae-internal', 'worktree', '/home/dev/odoo-dev', ['17.0', '19.0']);
        // The user chose the provisioning root without picking it per repo, so
        // the confirmation has to say where their code will now live.
        assert.ok(message.includes('/home/dev/odoo-dev/psae-internal@17.0'));
        assert.ok(message.includes('/home/dev/odoo-dev/psae-internal@19.0'));
        assert.ok(message.toLowerCase().includes('edit'));
    });

    test('describes turning the mode back off', () => {
        const message = describeModeChange('psae-internal', 'checkout', '/home/dev/odoo-dev', ['19.0']);
        assert.ok(message.toLowerCase().includes('remove'));
        assert.ok(message.includes('psae-internal'));
    });
```

Add to that file's imports:

```ts
import { describeModeChange } from '../services/repoPaths';
```

`describeModeChange` lives in `repoPaths.ts`, not in the command module: it is pure string-building over the same naming rules as `worktreeDirName`, and a test should not import a command module.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run compile-tests`
Expected: FAIL with `has no exported member 'describeModeChange'`.

- [ ] **Step 3: Write the description helper**

In `src/services/repoPaths.ts`, add:

```ts
/** The confirmation shown before a repository changes branch mode. */
export function describeModeChange(
    repoName: string,
    mode: RepoBranchMode,
    root: string,
    branches: string[]
): string {
    if (mode === 'checkout') {
        return `Switch "${repoName}" back to a single checkout?\n\n`
            + `The worktrees the extension created for it will be removed. `
            + `Any with uncommitted changes are kept and reported.`;
    }

    const dirs = branches.map(branch => `  ${path.join(root, worktreeDirName(repoName, branch))}`).join('\n');
    return `Give "${repoName}" one working copy per branch?\n\n`
        + `These directories will be created, and this is where you will edit that branch's code:\n\n${dirs}\n\n`
        + `The original checkout at ${repoName} becomes a source only: it stays yours to switch freely, `
        + `and nothing that happens to it changes what a version runs.`;
}
```

Add `RepoBranchMode` to the existing `../models/repo` import in that file.

- [ ] **Step 4: Register the command**

In `package.json`, add to `contributes.commands`:

```json
{
  "command": "odt.repo.toggleBranchMode",
  "title": "Use One Copy Per Branch",
  "category": "Odoo DevTools",
  "icon": "$(repo-forked)"
}
```

and to `contributes.menus.view/item/context`:

```json
{
  "command": "odt.repo.toggleBranchMode",
  "when": "view == odt.projectReposExplorer && viewItem == projectRepoRoot",
  "group": "1_repo@1"
}
```

`projectRepoRoot` is the context value `src/projectReposExplorer.ts:113` sets for a repository row. A missing repo uses `projectRepoRootMissing` and is deliberately excluded — relocate it first.

- [ ] **Step 5: Implement the handler**

In `src/commands/reposExplorerCommands.ts`, add:

```ts
    context.subscriptions.push(vscode.commands.registerCommand('odt.repo.toggleBranchMode', async (event?: unknown) => {
        try {
            const result = await SettingsStore.getSelectedProject();
            if (!result) {
                return;
            }
            const { data, project } = result;
            const repoPath = extractUri(event)?.fsPath;
            const repo = (project.repos ?? []).find(entry => normalizePath(entry.path) === normalizePath(repoPath ?? ''));
            if (!repo) {
                void showError('Could not identify the repository.');
                return;
            }

            const root = readSetupState().provisioningRoot;
            const nextMode: RepoBranchMode = normalizeBranchMode(repo.branchMode) === 'worktree' ? 'checkout' : 'worktree';
            const branches = Array.from(new Set(
                (project.dbs ?? []).flatMap(db =>
                    sanitizeProjectRepoBranchAssignments(db.projectRepoBranches)
                        .filter(entry => entry.repoName === repo.name || normalizePath(entry.repoPath) === normalizePath(repo.path))
                        .map(entry => entry.branch))
            ));

            const confirm = await showModalWarning(
                describeModeChange(repo.name, nextMode, root, branches),
                nextMode === 'worktree' ? 'Create Worktrees' : 'Remove Worktrees'
            );
            if (!confirm) {
                return;
            }

            if (nextMode === 'checkout') {
                for (const branch of branches) {
                    const dest = resolveRepoPath({ ...repo, branchMode: 'worktree' } as RepoModel, branch, root).path;
                    if (!fs.existsSync(dest)) {
                        continue;
                    }
                    const status = await tryRunCommand('git', ['status', '--porcelain'], { cwd: dest });
                    if (status !== undefined && parsePorcelainStatus(status).length > 0) {
                        void showWarning(`Kept ${dest}: it has uncommitted changes.`);
                        continue;
                    }
                    await removeWorktree(repo.path, dest).catch(error =>
                        logger.warn(`[worktree] could not remove ${dest}:`, error));
                }
            }

            repo.branchMode = nextMode;
            await SettingsStore.saveWithoutComments(stripSettings(data));
            void showInfo(`"${repo.name}" now uses ${nextMode === 'worktree' ? 'one copy per branch' : 'a single checkout'}.`);
            await refreshAll();
        } catch (error) {
            void showError(`Could not change the repository mode: ${errorMessage(error)}`);
        }
    }));
```

Add the imports this needs to that file: `fs`, `normalizePath`, `stripSettings`, `SettingsStore`, `showError`, `showInfo`, `showWarning`, `showModalWarning`, `errorMessage`, `logger`, `tryRunCommand`, `removeWorktree`, `readSetupState`, `describeModeChange`, `resolveRepoPath`, `parsePorcelainStatus`, `normalizeBranchMode`, `RepoBranchMode`, `RepoModel`, `sanitizeProjectRepoBranchAssignments`, `extractUri`.

- [ ] **Step 6: Verify the whole gate**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 173 passing (171 + 2), no `error TS`, no lint errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "[ADD] Toggle a repository between checkout and worktree mode"
```

---

### Task 9: One meaning of "branch"

Deletes `db.branchName`, the field that duplicated the version's branch and drifted out of sync.

**Files:**
- Modify: `src/services/dataMigration.ts`
- Modify: `src/models/db.ts`
- Modify: `src/views/dbsView.ts`
- Modify: `src/dbs.ts`
- Test: `src/test/branchNameMigration.test.ts`

**Interfaces:**
- Produces: `function applyBranchNameMigration(data: DebuggerData): { changed: boolean; preserved: number }`.

- [ ] **Step 1: Write the failing test**

Create `src/test/branchNameMigration.test.ts`:

```ts
import * as assert from 'assert';
import { applyBranchNameMigration } from '../services/dataMigration';

function buildData(dbs: any[]) {
    return { projects: [{ name: 'p', dbs }], versions: {} } as any;
}

suite('branchName migration', () => {
    test('drops branchName when the database has a version', () => {
        // The version is authoritative; the copy is what drifted.
        const data = buildData([{ id: 'shop-19', versionId: 'v19', branchName: '17.0' }]);
        const result = applyBranchNameMigration(data);
        assert.strictEqual(result.changed, true);
        assert.strictEqual('branchName' in data.projects[0].dbs[0], false);
        assert.strictEqual(result.preserved, 0);
    });

    test('folds branchName into odooVersion when there is no version', () => {
        // Unmigrated data still needs a series from somewhere.
        const data = buildData([{ id: 'legacy', branchName: '16.0' }]);
        const result = applyBranchNameMigration(data);
        assert.strictEqual(data.projects[0].dbs[0].odooVersion, '16.0');
        assert.strictEqual('branchName' in data.projects[0].dbs[0], false);
        assert.strictEqual(result.preserved, 1);
    });

    test('does not overwrite an existing odooVersion', () => {
        const data = buildData([{ id: 'legacy', branchName: '16.0', odooVersion: '15.0' }]);
        applyBranchNameMigration(data);
        assert.strictEqual(data.projects[0].dbs[0].odooVersion, '15.0');
    });

    test('reports no change for already-migrated data', () => {
        const data = buildData([{ id: 'shop-19', versionId: 'v19' }]);
        assert.strictEqual(applyBranchNameMigration(data).changed, false);
    });

    test('handles a project with no databases', () => {
        assert.strictEqual(applyBranchNameMigration({ projects: [{ name: 'p' }] } as any).changed, false);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run compile-tests`
Expected: FAIL with `has no exported member 'applyBranchNameMigration'`.

- [ ] **Step 3: Write the migration**

In `src/services/dataMigration.ts`, add:

```ts
/**
 * Removes `branchName`, which duplicated the database's version branch and
 * drifted out of sync - changing a database's version left the row reading
 * "17.0 • Odoo 19.0". A database with no version keeps the value as its legacy
 * `odooVersion`, which unmigrated data already uses.
 */
export function applyBranchNameMigration(data: DebuggerData): { changed: boolean; preserved: number } {
    let changed = false;
    let preserved = 0;

    for (const project of data.projects ?? []) {
        for (const db of (project as any).dbs ?? []) {
            if (!('branchName' in db)) {
                continue;
            }
            const branchName = typeof db.branchName === 'string' ? db.branchName.trim() : '';
            if (!db.versionId && branchName && !db.odooVersion) {
                db.odooVersion = branchName;
                preserved += 1;
            }
            delete db.branchName;
            changed = true;
        }
    }

    return { changed, preserved };
}
```

Call it from `migrateDebuggerData` alongside the existing migrations, saving when `changed` is true, and log `preserved`.

- [ ] **Step 4: Remove the field from the model and the views**

In `src/models/db.ts`: delete `branchName` from `DatabaseOptions` and from the class (field declaration and constructor assignment).

In `src/views/dbsView.ts`: in `buildDescription`, delete the `db.branchName` branches so the version alone supplies the series; in `buildTooltip`, delete the `**Branch:**` line; in `getBranchValue`, return `getEffectiveOdooVersion(db)` only.

In `src/dbs.ts`: delete every write to `branchName`, including the one added by the previous fix in `changeDatabaseVersion` and the `branchLabel` plumbing in `resolveVersionForNewDatabase` if it exists only to populate it.

- [ ] **Step 5: Verify the whole gate**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 178 passing (173 + 5), no `error TS`, no lint errors. The compiler will name every remaining reader of `branchName`; fix each rather than casting around it.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "[REF] Delete db.branchName; the version is the only core branch"
```

---

### Task 10: Database creation stops capturing silently

**Files:**
- Modify: `src/dbs.ts` (`createDb`)
- Test: `src/test/dbCreationSummary.test.ts`

**Interfaces:**
- Produces: `function describeCreationSummary(input: { versionName?: string; repoCount: number; captured: boolean }): string`.

- [ ] **Step 1: Write the failing test**

Create `src/test/dbCreationSummary.test.ts`:

```ts
import * as assert from 'assert';
import { describeCreationSummary } from '../dbs';

suite('Database creation summary', () => {
    test('says that repo branches were captured, and from how many repos', () => {
        const summary = describeCreationSummary({ versionName: 'Odoo 19.0', repoCount: 3, captured: true });
        assert.ok(summary.includes('Odoo 19.0'));
        assert.ok(summary.includes('3'));
        // The capture used to be invisible; the point of this line is that it is not.
        assert.ok(summary.toLowerCase().includes('captured'));
    });

    test('says so when nothing is captured', () => {
        const summary = describeCreationSummary({ versionName: 'Odoo 19.0', repoCount: 0, captured: false });
        assert.ok(summary.toLowerCase().includes('no repo'));
    });

    test('handles a database with no version', () => {
        const summary = describeCreationSummary({ repoCount: 1, captured: true });
        assert.ok(summary.toLowerCase().includes('no version'));
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run compile-tests`
Expected: FAIL with `has no exported member 'describeCreationSummary'`.

- [ ] **Step 3: Write the helper and use it**

In `src/dbs.ts`, add:

```ts
/** The one line that makes the branch capture visible at creation time. */
export function describeCreationSummary(input: { versionName?: string; repoCount: number; captured: boolean }): string {
    const version = input.versionName ? `Version: ${input.versionName}` : 'Version: no version';
    const repos = input.captured && input.repoCount > 0
        ? `Repo branches: captured from ${input.repoCount} current checkout(s)`
        : 'Repo branches: no repo branches recorded';
    return `${version}  •  ${repos}`;
}
```

In `createDb`, after `captureCurrentRepoBranches` produces `projectRepoBranches`, show a confirmation before returning the database:

```ts
    const summaryChoice = await vscode.window.showQuickPick(
        [
            { label: '$(check) Create', detail: describeCreationSummary({
                versionName, repoCount: projectRepoBranches.length, captured: projectRepoBranches.length > 0
            }), change: false },
            { label: '$(edit) Change repo branches…', detail: 'Pick a branch per repository instead', change: true }
        ],
        { title: 'Create database', placeHolder: 'Confirm what will be recorded', ignoreFocusOut: true }
    );
    if (!summaryChoice) {
        return undefined;
    }
    if (summaryChoice.change) {
        const edited = await promptProjectRepoBranchAssignments(repos, projectRepoBranches, 'edit');
        if (!edited) {
            return undefined;
        }
        projectRepoBranches = edited;
    }
```

Declare `projectRepoBranches` with `let` rather than `const`, and resolve `versionName` from the version chosen by `resolveVersionForNewDatabase`.

- [ ] **Step 4: Verify the whole gate**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 181 passing (178 + 3), no `error TS`, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "[IMP] Show what a new database records instead of capturing silently"
```

---

### Task 11: The mapping is visible, and the switch prompt is supersedable

**Files:**
- Modify: `src/views/dbsView.ts`
- Modify: `src/services/environment.ts`
- Modify: `package.json`
- Test: `src/test/switchSummary.test.ts` (extend)

**Interfaces:**
- Produces: `function supersedePendingSwitch(): void` in `src/services/environment.ts`.

- [ ] **Step 1: Write the failing test**

Append to `src/test/switchSummary.test.ts`, inside the `suite`:

```ts
    test('only the newest switch token stays current', () => {
        // Two fast database selections must not leave two contradictory
        // notifications standing: the older answer is discarded.
        const first = claimSwitchToken();
        assert.strictEqual(isCurrentSwitch(first), true);

        const second = claimSwitchToken();
        assert.strictEqual(isCurrentSwitch(second), true);
        assert.strictEqual(isCurrentSwitch(first), false);

        supersedePendingSwitch();
        assert.strictEqual(isCurrentSwitch(second), false);
    });
```

Add to that file's import from `../services/environment`:

```ts
import { describeSwitch, claimSwitchToken, isCurrentSwitch, supersedePendingSwitch } from '../services/environment';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run compile-tests`
Expected: FAIL with `has no exported member 'supersedePendingSwitch'`.

- [ ] **Step 3: Make the prompt supersedable**

In `src/services/environment.ts`, add above `alignEnvironment`:

```ts
/**
 * Token for the pending `ask` notification. A newer switch invalidates the
 * older one, so an answer that arrives after the workspace has moved on is
 * discarded rather than applied to a workspace it was never about.
 */
let pendingSwitchToken = 0;

/** Claims the pending slot for a new prompt, invalidating any older one. */
export function claimSwitchToken(): number {
    pendingSwitchToken += 1;
    return pendingSwitchToken;
}

export function isCurrentSwitch(token: number): boolean {
    return token === pendingSwitchToken;
}

/** Invalidates the pending prompt without claiming the slot for a new one. */
export function supersedePendingSwitch(): void {
    pendingSwitchToken += 1;
}
```

In the `behavior === 'ask'` branch, capture and check the token:

```ts
        const token = claimSwitchToken();
        void showInfo(
            `${options.label} targets ${diff.descriptions.join(', ')}. Align your workspace?`,
            'Switch',
            'Keep Current'
        ).then(async choice => {
            if (choice !== 'Switch' || !isCurrentSwitch(token)) {
                return;
            }
```

- [ ] **Step 4: Show the mapping on the row**

In `src/views/dbsView.ts`, in `buildDescription`, after the running marker, add:

```ts
        const repoBranches = sanitizeProjectRepoBranchAssignments(db.projectRepoBranches);
        if (repoBranches.length > 0) {
            parts.push(`${repoBranches.length} repo${repoBranches.length === 1 ? '' : 's'}`);
        }
```

In `package.json`, change the `dbSelector.configureRepoBranches` context-menu entry's `group` from `3_config@2` to `inline@2` so it is one click from the row.

- [ ] **Step 5: Verify the whole gate**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 182 passing (181 + 1), no `error TS`, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "[IMP] Surface the repo mapping and supersede stale switch prompts"
```

---

### Task 12: Documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/notes/2026-09-01-onboarding-rework.md`

- [ ] **Step 1: Document in the README**

Add to the Repos section:

```markdown
### One copy per branch (upgrades)

During an upgrade you need two versions running against **their own** custom
code. Right-click a repository in Project Repos and choose **Use One Copy Per
Branch**: each branch that repository is mapped to gets its own working
directory under your environments folder, so 17.0 and 19.0 stop competing for
one checkout.

This is opt-in per repository, and off by default — ordinary development, where
a feature branch simply follows staging and prod, does not need it.

The confirmation names the exact directories that will be created, because that
is where you will edit that branch's code from then on. Your original checkout
becomes a **source**: never in the addons path, never run, and yours to switch
freely without changing what any version runs. Commits and pushes from a
worktree go to the real branch — it is the same repository, one object store,
so nothing needs syncing back.

Two safeguards keep you out of the wrong copy: the repo views, Modules view and
generated workspace show only the active version's copies, and opening a file
belonging to another version offers to reopen the same file in the active one.

Turning the mode back off removes the worktrees the extension created, keeping
any with uncommitted changes and telling you which.
```

- [ ] **Step 2: Document in the CHANGELOG**

Add under the unreleased heading:

```markdown
- **Custom code can now differ per version.** A project repository can be switched to **one copy per branch** (`Use One Copy Per Branch`), giving each mapped branch its own worktree under the environments folder so two versions run against their own custom addons at once. Opt-in per repository; `checkout` remains the default. Unlike Odoo core worktrees, these check out the **real** branch, so commits and pushes go where you expect.
- Freeing a branch from the source checkout is explicit: a clean checkout can be detached on confirmation, a dirty one is refused with its changed files named. Nothing is detached or stashed silently.
- The repo views, Modules view and generated workspace follow the active version's copies, and opening a file from another version's copy offers to reopen the active one.
- `db.branchName` is removed. It duplicated the database's version branch and drifted out of sync — changing a version left the row reading `17.0 • Odoo 19.0`. Databases with no version keep the value as their legacy `odooVersion`.
- Database creation shows what it will record, including the repo branches it captures, instead of capturing them silently.
- The Databases view shows the repo-branch count on the row, and `Configure Project Repo Branches` is an inline action.
- A newer environment switch supersedes an unanswered older prompt, so two rapid database selections cannot leave contradictory notifications standing.
```

- [ ] **Step 3: Name what the provisioning root holds**

Spec §3 asks for the Setup summary to say what the environments directory is for, now that it also holds copies of custom code. In `src/services/setupFlow.ts`, in `describe`, change the `Environments:` row to:

```ts
        `Environments: ${proposal.provisioningRoot}${fs.existsSync(proposal.provisioningRoot) ? '' : ' (will be created)'} — worktrees, virtualenvs and per-branch copies of custom repos`
```

and in `package.json`, change the `odooDebugger.provisioning.root` description to:

```
"Directory holding per-version worktrees, virtualenvs, and per-branch copies of custom repositories. Empty means `~/odoo-dev`."
```

- [ ] **Step 4: Close out the notes**

In `docs/superpowers/notes/2026-09-01-onboarding-rework.md`, update the status line to record that the branch-model observations are now implemented, leaving observations 4 (walkthrough) and 9 (`updateActiveSettings` dead code) open.

- [ ] **Step 5: Verify the whole gate one final time**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: 182 passing, no `error TS`, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "[DOC] Document per-version custom code and the branch-model cleanup"
```

---

## Manual verification

Only a running Extension Development Host can confirm these. Use a project with
one repository mapped to two branches across two databases.

1. **Opt in.** Right-click the repo → *Use One Copy Per Branch*. The modal names both directories under the environments folder. Accept; both are created and check out the real branches (`git -C <dir> branch --show-current` prints `17.0`, not `odt/17.0`).
2. **Source conflict, clean.** Put the source checkout on `19.0` and re-run. The offer to detach appears and explains why; accepting leaves the source detached at the same commit with its files intact.
3. **Source conflict, dirty.** Repeat with an uncommitted change. It is refused and the changed file is named. Nothing is detached or stashed.
4. **Two versions at once.** Select the 17.0 database, run; select the 19.0 database, run. Each server loads its own copy of the custom module — edit a module's `__manifest__.py` version string in one worktree and confirm only that server reports it.
5. **Commits reach the branch.** Commit inside a worktree; `git log <branch>` in the source repo shows it.
6. **Scoping.** With 19.0 active, the Project Repos explorer and generated workspace show only the 19.0 copy.
7. **Wrong-copy warning.** Open the 17.0 copy of a file while 19.0 is active. The warning names both; *Open the 19.0 copy* opens the same relative path. *Don't warn again* silences it for good.
8. **Opt out.** Turn the mode off with one worktree dirty. The clean one is removed, the dirty one is kept and reported.
9. **branchName migration.** A database created before this change no longer shows a stale branch beside its version.
10. **Supersede.** With `databaseSwitchBehavior: ask`, select two databases quickly. Only the newer prompt applies anything.
