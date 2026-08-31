# Native Version Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Odoo version its own git worktree, its own correctly-versioned Python interpreter and its own virtualenv, provisioned through one awaited flow, so versions stop competing for a single checkout.

**Architecture:** Five new services under `src/services/`, each with one responsibility and a pure-logic core that is unit tested. Provisioning is a reconciler: probe the filesystem, plan only the missing steps, execute those — the same compute-diff-then-apply shape as the existing `alignEnvironment` and `reconcile`. Provisioned-ness is never stored; it is derived by probing.

**Tech Stack:** TypeScript (strict, Node16 modules), VS Code extension API, mocha `suite`/`test` with node `assert` run under `@vscode/test-cli`, webpack bundle, `git worktree`, `uv`.

**Spec:** `docs/superpowers/specs/2026-08-27-native-version-provisioning-design.md`

**Scope:** This plan implements spec sections §1–§10 plus the model and configuration changes they require. Spec §11–§13 (derived debugger identity, per-version database resolution, running-state indicators) are a separate plan and are explicitly **not** in scope here.

**Deferred from the spec:** §3 describes `ensureUv()` downloading a pinned uv release into `context.globalStorageUri` and verifying its published SHA-256, gated by `odooDebugger.provisioning.autoDownloadUv`. That is not implemented here — it needs a verified platform-asset matrix and checksum source, and guessing those in a plan would be a placeholder in disguise. Task 4 implements `resolveUv()`, which finds an installed uv and otherwise falls back to the standard library `venv` and `pip` with the degradation reported in the summary. The `autoDownloadUv` setting is therefore **not** added yet; it ships with the download itself so no dead configuration exists in the meantime.

## Global Constraints

- **No shell.** Every child process goes through `runCommand` / `tryRunCommand` from `src/services/process.ts` with arguments as arrays. Never `shell: true`, never string interpolation into a command line.
- **All user-facing messaging** goes through `showInfo` / `showError` / `showWarning` / `showAutoInfo` from `src/utils.ts`, and all diagnostics through `logger` from `src/services/logger.ts`. Never call `vscode.window.show*Message` directly.
- **Fallback Python floor is `(3, 10)`** when a checkout declares nothing parseable.
- **Distribution-to-Python table** is exactly: Ubuntu 20.04 → 3.8, Ubuntu 22.04 → 3.10, Ubuntu 24.04 → 3.12, Debian 11 → 3.9, Debian 12 → 3.11, Debian 13 → 3.13.
- **TypeScript is strict** with `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`. Unused imports and parameters are compile errors.
- **Windows paths** use `Scripts\python.exe` and `Scripts\pip.exe`; POSIX uses `bin/python` and `bin/pip`.
- **Nothing escalates privileges.** The system dependency doctor reports and suggests; it never executes an installer.
- **Commit message prefixes** follow the repository convention: `[ADD]`, `[FIX]`, `[REF]`, `[DOC]`.
- **Verification for every task:** `npm run compile-tests` must succeed, `npm run lint` must be clean, and the task's own test file must pass via `npx vscode-test --run out/test/<file>.test.js`.

---

### Task 1: Odoo Python requirements reader

Reads a checkout and reports which Python it needs. Pure parsing — no subprocesses, no VS Code API.

**Files:**
- Create: `src/services/odooRequirements.ts`
- Test: `src/test/odooRequirements.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface OdooPythonWindow { series?: string; minPython: [number, number]; preferredPython?: [number, number]; source: 'setup.py' | 'release.py' | 'fallback' }`
  - `const FALLBACK_MIN_PYTHON: [number, number]`
  - `parseMinPythonFromSetupPy(content: string): [number, number] | undefined`
  - `parseMinPythonFromReleasePy(content: string): [number, number] | undefined`
  - `parseSeriesFromReleasePy(content: string): string | undefined`
  - `parsePreferredPythonFromRequirements(content: string): [number, number] | undefined`
  - `readOdooPythonWindow(odooPath: string): Promise<OdooPythonWindow>`

- [ ] **Step 1: Write the failing test**

Create `src/test/odooRequirements.test.ts`:

```ts
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
    parseMinPythonFromSetupPy,
    parseMinPythonFromReleasePy,
    parseSeriesFromReleasePy,
    parsePreferredPythonFromRequirements,
    readOdooPythonWindow
} from '../services/odooRequirements';

const REQUIREMENTS_17 = `# The officially supported versions of the following packages are their
# python3-* equivalent distributed in Ubuntu 22.04 and Debian 11
Babel==2.9.1 ; python_version < '3.11'
`;

const REQUIREMENTS_19 = `# The officially supported versions of the following packages are their
# python3-* equivalent distributed in Ubuntu 24.04 and Debian 12
asn1crypto==1.4.0 ; python_version < '3.11'
`;

async function writeCheckout(files: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'odoo-req-test-'));
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(dir, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf-8');
    }
    return dir;
}

suite('Odoo requirements derivation', () => {
    test('reads the literal python_requires from setup.py', () => {
        assert.deepStrictEqual(
            parseMinPythonFromSetupPy(`    python_requires='>=3.10',`),
            [3, 10]
        );
    });

    test('ignores the computed python_requires form', () => {
        assert.strictEqual(
            parseMinPythonFromSetupPy(`    python_requires='>=' + ".".join(map(str, MIN_PY_VERSION)),`),
            undefined
        );
    });

    test('reads MIN_PY_VERSION from release.py', () => {
        assert.deepStrictEqual(parseMinPythonFromReleasePy('MIN_PY_VERSION = (3, 10)\n'), [3, 10]);
    });

    test('reads the series from release.py version_info', () => {
        assert.strictEqual(
            parseSeriesFromReleasePy(`version_info = (19, 0, 0, FINAL, 0, '')\n`),
            '19.0'
        );
    });

    test('derives preferred python from the requirements header', () => {
        assert.deepStrictEqual(parsePreferredPythonFromRequirements(REQUIREMENTS_17), [3, 10]);
        assert.deepStrictEqual(parsePreferredPythonFromRequirements(REQUIREMENTS_19), [3, 12]);
    });

    test('ignores distribution names that appear after the header', () => {
        const content = `# unrelated header\npkg==1.0\n# Ubuntu 24.04 mentioned in a later comment\n`;
        assert.strictEqual(parsePreferredPythonFromRequirements(content), undefined);
    });

    test('returns no preferred python for an unrecognized header', () => {
        assert.strictEqual(
            parsePreferredPythonFromRequirements('# built for Fedora 40\npkg==1.0\n'),
            undefined
        );
    });

    test('prefers setup.py over release.py and reports the source', async () => {
        const dir = await writeCheckout({
            'setup.py': `    python_requires='>=3.10',`,
            'odoo/release.py': 'MIN_PY_VERSION = (3, 8)\n',
            'requirements.txt': REQUIREMENTS_17
        });
        const window = await readOdooPythonWindow(dir);
        assert.deepStrictEqual(window.minPython, [3, 10]);
        assert.deepStrictEqual(window.preferredPython, [3, 10]);
        assert.strictEqual(window.source, 'setup.py');
    });

    test('falls back to release.py when setup.py has the computed form', async () => {
        const dir = await writeCheckout({
            'setup.py': `    python_requires='>=' + ".".join(map(str, MIN_PY_VERSION)),`,
            'odoo/release.py': `MIN_PY_VERSION = (3, 10)\nversion_info = (19, 0, 0, FINAL, 0, '')\n`,
            'requirements.txt': REQUIREMENTS_19
        });
        const window = await readOdooPythonWindow(dir);
        assert.deepStrictEqual(window.minPython, [3, 10]);
        assert.deepStrictEqual(window.preferredPython, [3, 12]);
        assert.strictEqual(window.series, '19.0');
        assert.strictEqual(window.source, 'release.py');
    });

    test('falls back to 3.10 when nothing is parseable', async () => {
        const dir = await writeCheckout({ 'README.md': 'not an odoo checkout' });
        const window = await readOdooPythonWindow(dir);
        assert.deepStrictEqual(window.minPython, [3, 10]);
        assert.strictEqual(window.preferredPython, undefined);
        assert.strictEqual(window.source, 'fallback');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run compile-tests
```

Expected: FAIL — `Cannot find module '../services/odooRequirements'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/odooRequirements.ts`:

```ts
/**
 * Reads what Python an Odoo checkout needs, straight from the files the
 * branch itself ships. The floor comes from setup.py's literal
 * `python_requires` (present in 17.0/18.0) or release.py's MIN_PY_VERSION
 * (present in 19.0). The preferred interpreter comes from the distributions
 * named in requirements.txt's header comment.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface OdooPythonWindow {
    /** Series read from release.py, e.g. "19.0". Informational — the branch name wins. */
    series?: string;
    minPython: [number, number];
    preferredPython?: [number, number];
    source: 'setup.py' | 'release.py' | 'fallback';
}

export const FALLBACK_MIN_PYTHON: [number, number] = [3, 10];

/**
 * Default `python3` of each distribution Odoo names in its requirements
 * header. Describes distributions, not Odoo, so it only changes when a new
 * release ships.
 */
const DISTRIBUTION_PYTHON: Array<{ match: string; python: [number, number] }> = [
    { match: 'ubuntu 20.04', python: [3, 8] },
    { match: 'ubuntu 22.04', python: [3, 10] },
    { match: 'ubuntu 24.04', python: [3, 12] },
    { match: 'debian 11', python: [3, 9] },
    { match: 'debian 12', python: [3, 11] },
    { match: 'debian 13', python: [3, 13] }
];

export function parseMinPythonFromSetupPy(content: string): [number, number] | undefined {
    const match = /python_requires\s*=\s*['"]>=\s*(\d+)\.(\d+)/.exec(content);
    return match ? [Number(match[1]), Number(match[2])] : undefined;
}

export function parseMinPythonFromReleasePy(content: string): [number, number] | undefined {
    const match = /^MIN_PY_VERSION\s*=\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/m.exec(content);
    return match ? [Number(match[1]), Number(match[2])] : undefined;
}

export function parseSeriesFromReleasePy(content: string): string | undefined {
    const match = /^version_info\s*=\s*\(\s*(\d+)\s*,\s*(\d+)/m.exec(content);
    return match ? `${match[1]}.${match[2]}` : undefined;
}

/** Leading comment block only — later comments are not the header. */
function readHeaderComment(content: string): string {
    const header: string[] = [];
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') {
            continue;
        }
        if (!trimmed.startsWith('#')) {
            break;
        }
        header.push(trimmed);
    }
    return header.join(' ').toLowerCase();
}

export function parsePreferredPythonFromRequirements(content: string): [number, number] | undefined {
    const header = readHeaderComment(content);
    let best: [number, number] | undefined;
    for (const entry of DISTRIBUTION_PYTHON) {
        if (!header.includes(entry.match)) {
            continue;
        }
        if (!best || entry.python[0] > best[0] || (entry.python[0] === best[0] && entry.python[1] > best[1])) {
            best = entry.python;
        }
    }
    return best;
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
    return fs.readFile(filePath, 'utf-8').catch(() => undefined);
}

export async function readOdooPythonWindow(odooPath: string): Promise<OdooPythonWindow> {
    const [setupPy, releasePy, requirements] = await Promise.all([
        readIfPresent(path.join(odooPath, 'setup.py')),
        readIfPresent(path.join(odooPath, 'odoo', 'release.py')),
        readIfPresent(path.join(odooPath, 'requirements.txt'))
    ]);

    const fromSetup = setupPy ? parseMinPythonFromSetupPy(setupPy) : undefined;
    const fromRelease = releasePy ? parseMinPythonFromReleasePy(releasePy) : undefined;

    let minPython = FALLBACK_MIN_PYTHON;
    let source: OdooPythonWindow['source'] = 'fallback';
    if (fromSetup) {
        minPython = fromSetup;
        source = 'setup.py';
    } else if (fromRelease) {
        minPython = fromRelease;
        source = 'release.py';
    }

    return {
        series: releasePy ? parseSeriesFromReleasePy(releasePy) : undefined,
        minPython,
        preferredPython: requirements ? parsePreferredPythonFromRequirements(requirements) : undefined,
        source
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run compile-tests && npx vscode-test --run out/test/odooRequirements.test.js
```

Expected: PASS, 10 passing.

- [ ] **Step 5: Commit**

```bash
git add src/services/odooRequirements.ts src/test/odooRequirements.test.ts
git commit -m "[ADD] Derive the Python window from an Odoo checkout"
```

---

### Task 2: Git worktree service

> **Amended after execution.** As written, this task adopted any worktree already holding the branch — including the source repo itself, which left one version per repo pointing at a user-controlled directory that could later be switched to another branch. The shipped implementation always creates its own worktree on an `odt/<branch>` local branch and adopts only the destination path. See spec §2 for the corrected design.

`git worktree` operations, with the parsing separated out so it can be tested without a repository.

**Files:**
- Create: `src/services/worktree.ts`
- Test: `src/test/worktree.test.ts`

**Interfaces:**
- Consumes: `runCommand`, `CommandError` from `src/services/process.ts`; `logger` from `src/services/logger.ts`.
- Produces:
  - `interface WorktreeEntry { path: string; branch?: string }`
  - `parseWorktreeList(output: string): WorktreeEntry[]`
  - `findWorktreeForBranch(entries: WorktreeEntry[], branch: string): WorktreeEntry | undefined`
  - `interface WorktreeResult { path: string; created: boolean; adopted: boolean }`
  - `ensureWorktree(repoPath: string, branch: string, destPath: string, token?: vscode.CancellationToken): Promise<WorktreeResult>`
  - `removeWorktree(repoPath: string, worktreePath: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/test/worktree.test.ts`:

```ts
import * as assert from 'assert';
import { parseWorktreeList, findWorktreeForBranch } from '../services/worktree';

const PORCELAIN = `worktree /home/dev/odoo
HEAD bbe85efc259f1f2c9c3f0f5f9c1d2e3f4a5b6c7d
branch refs/heads/19.0

worktree /home/dev/versions/odoo-17.0
HEAD 1122334455667788990011223344556677889900
branch refs/heads/17.0

worktree /home/dev/versions/odoo-detached
HEAD aabbccddeeff00112233445566778899aabbccdd
detached

`;

suite('Worktree listing', () => {
    test('parses paths and branches from porcelain output', () => {
        assert.deepStrictEqual(parseWorktreeList(PORCELAIN), [
            { path: '/home/dev/odoo', branch: '19.0' },
            { path: '/home/dev/versions/odoo-17.0', branch: '17.0' },
            { path: '/home/dev/versions/odoo-detached', branch: undefined }
        ]);
    });

    test('returns an empty list for empty output', () => {
        assert.deepStrictEqual(parseWorktreeList(''), []);
    });

    test('finds the worktree holding a branch', () => {
        const entries = parseWorktreeList(PORCELAIN);
        assert.strictEqual(findWorktreeForBranch(entries, '17.0')?.path, '/home/dev/versions/odoo-17.0');
        assert.strictEqual(findWorktreeForBranch(entries, '19.0')?.path, '/home/dev/odoo');
    });

    test('returns undefined when no worktree holds the branch', () => {
        assert.strictEqual(findWorktreeForBranch(parseWorktreeList(PORCELAIN), '18.0'), undefined);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run compile-tests
```

Expected: FAIL — `Cannot find module '../services/worktree'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/worktree.ts`:

```ts
/**
 * git worktree operations. Each version gets its own worktree of the core
 * repositories, so versions never compete for one checkout. Worktrees share
 * the repository object store, so an extra version costs one working tree
 * rather than a full clone.
 */
import * as fs from 'node:fs';
import type * as vscode from 'vscode';
import { runCommand } from './process';
import { logger } from './logger';

export interface WorktreeEntry {
    path: string;
    branch?: string;
}

export interface WorktreeResult {
    path: string;
    /** A new worktree was added. */
    created: boolean;
    /** An existing worktree or the main checkout was reused. */
    adopted: boolean;
}

export function parseWorktreeList(output: string): WorktreeEntry[] {
    const entries: WorktreeEntry[] = [];
    let current: WorktreeEntry | undefined;

    for (const rawLine of output.split('\n')) {
        const line = rawLine.trim();
        if (line.startsWith('worktree ')) {
            current = { path: line.slice('worktree '.length), branch: undefined };
            entries.push(current);
            continue;
        }
        if (current && line.startsWith('branch ')) {
            current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
        }
    }

    return entries;
}

export function findWorktreeForBranch(entries: WorktreeEntry[], branch: string): WorktreeEntry | undefined {
    return entries.find(entry => entry.branch === branch);
}

async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
    const { stdout } = await runCommand('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
    return parseWorktreeList(stdout);
}

async function hasLocalBranch(repoPath: string, branch: string): Promise<boolean> {
    try {
        await runCommand('git', ['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: repoPath });
        return true;
    } catch {
        return false;
    }
}

/**
 * Ensures `branch` is checked out at `destPath` as a worktree of `repoPath`.
 *
 * Three cases are handled explicitly: the branch may be missing from a
 * shallow clone (fetch it first — valid and cheap on a shallow clone), it may
 * already be checked out somewhere (git refuses duplicates, so reuse that
 * path), or the destination may already be the worktree we want (adopt it).
 */
export async function ensureWorktree(
    repoPath: string,
    branch: string,
    destPath: string,
    token?: vscode.CancellationToken
): Promise<WorktreeResult> {
    const existing = await listWorktrees(repoPath);

    const holding = findWorktreeForBranch(existing, branch);
    if (holding) {
        logger.info(`[worktree] ${branch} already checked out at ${holding.path}`);
        return { path: holding.path, created: false, adopted: true };
    }

    if (fs.existsSync(destPath)) {
        throw new Error(`Cannot create a worktree at ${destPath}: the path already exists and is not a worktree for ${branch}.`);
    }

    if (!(await hasLocalBranch(repoPath, branch))) {
        logger.info(`[worktree] fetching ${branch} into ${repoPath}`);
        await runCommand('git', ['fetch', '--depth', '1', 'origin', `${branch}:${branch}`], { cwd: repoPath, token });
    }

    await runCommand('git', ['worktree', 'add', destPath, branch], { cwd: repoPath, token });
    return { path: destPath, created: true, adopted: false };
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    await runCommand('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoPath });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run compile-tests && npx vscode-test --run out/test/worktree.test.js
```

Expected: PASS, 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/services/worktree.ts src/test/worktree.test.ts
git commit -m "[ADD] git worktree service for per-version checkouts"
```

---

### Task 3: Interpreter discovery and ranking

Finds Python interpreters on the machine and ranks them against a version's window. Ranking is pure and carries the tests; discovery shells out and stays thin.

**Files:**
- Create: `src/services/pythonToolchain.ts`
- Test: `src/test/pythonToolchain.test.ts`

**Interfaces:**
- Consumes: `OdooPythonWindow` from Task 1; `tryRunCommand` from `src/services/process.ts`.
- Produces:
  - `interface InterpreterInfo { path: string; version: [number, number] }`
  - `parsePythonVersion(output: string): [number, number] | undefined`
  - `rankInterpreters(found: InterpreterInfo[], window: OdooPythonWindow): InterpreterInfo[]`
  - `isAbovePreferred(interpreter: InterpreterInfo, window: OdooPythonWindow): boolean`
  - `venvPythonPath(venvPath: string): string`
  - `discoverInterpreters(): Promise<InterpreterInfo[]>`

- [ ] **Step 1: Write the failing test**

Create `src/test/pythonToolchain.test.ts`:

```ts
import * as assert from 'assert';
import * as path from 'node:path';
import {
    parsePythonVersion,
    rankInterpreters,
    isAbovePreferred,
    venvPythonPath,
    InterpreterInfo
} from '../services/pythonToolchain';
import { OdooPythonWindow } from '../services/odooRequirements';

const WINDOW_17: OdooPythonWindow = {
    minPython: [3, 10],
    preferredPython: [3, 10],
    source: 'setup.py'
};

const WINDOW_NO_PREFERENCE: OdooPythonWindow = {
    minPython: [3, 10],
    source: 'fallback'
};

function interpreter(version: [number, number]): InterpreterInfo {
    return { path: `/usr/bin/python${version[0]}.${version[1]}`, version };
}

suite('Python toolchain', () => {
    test('parses the version from python --version output', () => {
        assert.deepStrictEqual(parsePythonVersion('Python 3.12.3\n'), [3, 12]);
        assert.deepStrictEqual(parsePythonVersion('Python 3.9.18'), [3, 9]);
        assert.strictEqual(parsePythonVersion('not python'), undefined);
    });

    test('ranks an exact preferred match first', () => {
        const ranked = rankInterpreters(
            [interpreter([3, 12]), interpreter([3, 10]), interpreter([3, 11])],
            WINDOW_17
        );
        assert.deepStrictEqual(ranked[0].version, [3, 10]);
    });

    test('prefers the newest at or below preferred over anything above it', () => {
        const ranked = rankInterpreters(
            [interpreter([3, 14]), interpreter([3, 10])],
            { minPython: [3, 8], preferredPython: [3, 12], source: 'setup.py' }
        );
        assert.deepStrictEqual(ranked[0].version, [3, 10]);
        assert.deepStrictEqual(ranked[1].version, [3, 14]);
    });

    test('excludes interpreters below the floor', () => {
        const ranked = rankInterpreters([interpreter([3, 8]), interpreter([3, 9])], WINDOW_17);
        assert.deepStrictEqual(ranked, []);
    });

    test('takes the newest at or above the floor when there is no preference', () => {
        const ranked = rankInterpreters(
            [interpreter([3, 10]), interpreter([3, 14]), interpreter([3, 12])],
            WINDOW_NO_PREFERENCE
        );
        assert.deepStrictEqual(ranked[0].version, [3, 14]);
    });

    test('flags an interpreter above the preferred version', () => {
        assert.strictEqual(isAbovePreferred(interpreter([3, 14]), WINDOW_17), true);
        assert.strictEqual(isAbovePreferred(interpreter([3, 10]), WINDOW_17), false);
        assert.strictEqual(isAbovePreferred(interpreter([3, 14]), WINDOW_NO_PREFERENCE), false);
    });

    test('builds the platform-correct venv interpreter path', () => {
        const expected = process.platform === 'win32'
            ? path.join('/venv', 'Scripts', 'python.exe')
            : path.join('/venv', 'bin', 'python');
        assert.strictEqual(venvPythonPath('/venv'), expected);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run compile-tests
```

Expected: FAIL — `Cannot find module '../services/pythonToolchain'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/pythonToolchain.ts`:

```ts
/**
 * Locating and ranking Python interpreters for a version, and building that
 * version's virtualenv. Ranking is the part with judgement in it, so it is
 * pure and tested; discovery and venv creation shell out through runCommand.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tryRunCommand } from './process';
import { OdooPythonWindow } from './odooRequirements';

export interface InterpreterInfo {
    path: string;
    version: [number, number];
}

/** Minor versions probed on PATH as `python3.<minor>`. */
const PROBED_MINORS = [8, 9, 10, 11, 12, 13, 14];

export function parsePythonVersion(output: string): [number, number] | undefined {
    const match = /Python\s+(\d+)\.(\d+)/.exec(output);
    return match ? [Number(match[1]), Number(match[2])] : undefined;
}

function compare(a: [number, number], b: [number, number]): number {
    return a[0] - b[0] || a[1] - b[1];
}

export function isAbovePreferred(interpreter: InterpreterInfo, window: OdooPythonWindow): boolean {
    return !!window.preferredPython && compare(interpreter.version, window.preferredPython) > 0;
}

/**
 * Orders interpreters best-first for the given window. Anything below the
 * floor is unusable and is excluded entirely, so the first entry is always
 * safe to use — or the list is empty and one must be installed.
 */
export function rankInterpreters(found: InterpreterInfo[], window: OdooPythonWindow): InterpreterInfo[] {
    const usable = found.filter(entry => compare(entry.version, window.minPython) >= 0);

    const tier = (entry: InterpreterInfo): number => {
        if (!window.preferredPython) {
            return 0;
        }
        if (compare(entry.version, window.preferredPython) === 0) {
            return 0;
        }
        return compare(entry.version, window.preferredPython) < 0 ? 1 : 2;
    };

    return [...usable].sort((a, b) => {
        const tierDelta = tier(a) - tier(b);
        if (tierDelta !== 0) {
            return tierDelta;
        }
        // Within a tier, newest wins.
        return compare(b.version, a.version);
    });
}

export function venvPythonPath(venvPath: string): string {
    return process.platform === 'win32'
        ? path.join(venvPath, 'Scripts', 'python.exe')
        : path.join(venvPath, 'bin', 'python');
}

async function probeInterpreter(candidate: string): Promise<InterpreterInfo | undefined> {
    const result = await tryRunCommand(candidate, ['--version']);
    if (!result) {
        return undefined;
    }
    const version = parsePythonVersion(`${result.stdout}${result.stderr}`);
    return version ? { path: candidate, version } : undefined;
}

/** Candidate interpreters: PATH entries plus any pyenv-managed builds. */
function candidatePaths(): string[] {
    const candidates = PROBED_MINORS.map(minor => `python3.${minor}`);
    candidates.push('python3');

    const pyenvVersions = path.join(os.homedir(), '.pyenv', 'versions');
    if (fs.existsSync(pyenvVersions)) {
        for (const entry of fs.readdirSync(pyenvVersions)) {
            candidates.push(path.join(pyenvVersions, entry, 'bin', 'python'));
        }
    }

    return candidates;
}

export async function discoverInterpreters(): Promise<InterpreterInfo[]> {
    const probed = await Promise.all(candidatePaths().map(probeInterpreter));

    const seen = new Set<string>();
    const found: InterpreterInfo[] = [];
    for (const entry of probed) {
        if (!entry) {
            continue;
        }
        const key = `${entry.version[0]}.${entry.version[1]}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        found.push(entry);
    }
    return found;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run compile-tests && npx vscode-test --run out/test/pythonToolchain.test.js
```

Expected: PASS, 7 passing.

- [ ] **Step 5: Commit**

```bash
git add src/services/pythonToolchain.ts src/test/pythonToolchain.test.ts
git commit -m "[ADD] Python interpreter discovery and ranking"
```

---

### Task 4: uv resolution, virtualenv and requirements install

Adds the environment-building half of the toolchain. Subprocess-bound, so it stays thin and is verified by compiling plus the existing suite.

**Files:**
- Modify: `src/services/pythonToolchain.ts` (append)
- Modify: `package.json` (configuration properties)

**Interfaces:**
- Consumes: `discoverInterpreters`, `rankInterpreters`, `venvPythonPath` from Task 3; `runCommand` from `src/services/process.ts`.
- Produces:
  - `resolveUv(): Promise<string | undefined>`
  - `ensureInterpreter(window: OdooPythonWindow, token?: vscode.CancellationToken): Promise<{ path: string; version: [number, number]; warning?: string }>`
  - `ensureVenv(pythonPath: string, venvPath: string, uvPath: string | undefined, token?: vscode.CancellationToken): Promise<string>`
  - `installRequirements(venvPath: string, requirementsPath: string, uvPath: string | undefined, onLine: (line: string) => void, token?: vscode.CancellationToken): Promise<void>`

- [ ] **Step 1: Add the configuration properties**

In `package.json`, inside `contributes.configuration.properties`, add:

```json
"odooDebugger.provisioning.root": {
    "type": "string",
    "default": "",
    "description": "Directory holding per-version worktrees and virtualenvs. Empty means the parent directory of the configured default odooPath."
},
"odooDebugger.provisioning.uvPath": {
    "type": "string",
    "default": "",
    "description": "Path to an existing uv binary. Empty means look on PATH. When uv is not found, provisioning falls back to the standard library venv and pip."
}
```

- [ ] **Step 2: Append the implementation**

Append to `src/services/pythonToolchain.ts`:

```ts
import * as vscode from 'vscode';
import { runCommand } from './process';
import { logger } from './logger';

/**
 * Locates uv: the configured path, then PATH. Downloading is handled by the
 * caller's fallback path rather than here, so that a missing uv degrades to
 * the standard library venv and pip instead of failing.
 */
export async function resolveUv(): Promise<string | undefined> {
    const configured = vscode.workspace
        .getConfiguration('odooDebugger.provisioning')
        .get<string>('uvPath', '')
        .trim();

    const candidates = configured ? [configured, 'uv'] : ['uv'];
    for (const candidate of candidates) {
        if (await tryRunCommand(candidate, ['--version'])) {
            return candidate;
        }
    }
    return undefined;
}

export async function ensureInterpreter(
    window: OdooPythonWindow,
    token?: vscode.CancellationToken
): Promise<{ path: string; version: [number, number]; warning?: string }> {
    const ranked = rankInterpreters(await discoverInterpreters(), window);

    if (ranked.length > 0) {
        const best = ranked[0];
        const warning = isAbovePreferred(best, window) && window.preferredPython
            ? `This branch targets Python ${window.preferredPython.join('.')}; using ${best.version.join('.')}.`
            : undefined;
        return { path: best.path, version: best.version, warning };
    }

    const wanted = window.preferredPython ?? window.minPython;
    const uv = await resolveUv();
    if (!uv) {
        throw new Error(
            `No installed Python satisfies this branch (needs ${window.minPython.join('.')} or newer). ` +
            `Install Python ${wanted.join('.')}, or install uv so it can be provisioned automatically.`
        );
    }

    const target = wanted.join('.');
    logger.info(`[provisioning] installing Python ${target} via uv`);
    await runCommand(uv, ['python', 'install', target], { token });

    const rankedAfter = rankInterpreters(await discoverInterpreters(), window);
    if (rankedAfter.length > 0) {
        return { path: rankedAfter[0].path, version: rankedAfter[0].version };
    }

    const { stdout } = await runCommand(uv, ['python', 'find', target], { token });
    const found = stdout.trim();
    if (!found) {
        throw new Error(`uv installed Python ${target} but the interpreter could not be located.`);
    }
    return { path: found, version: wanted };
}

export async function ensureVenv(
    pythonPath: string,
    venvPath: string,
    uvPath: string | undefined,
    token?: vscode.CancellationToken
): Promise<string> {
    const interpreter = venvPythonPath(venvPath);
    if (fs.existsSync(interpreter)) {
        return interpreter;
    }

    if (uvPath) {
        await runCommand(uvPath, ['venv', '--python', pythonPath, venvPath], { token });
    } else {
        await runCommand(pythonPath, ['-m', 'venv', venvPath], { token });
    }
    return interpreter;
}

export async function installRequirements(
    venvPath: string,
    requirementsPath: string,
    uvPath: string | undefined,
    onLine: (line: string) => void,
    token?: vscode.CancellationToken
): Promise<void> {
    const interpreter = venvPythonPath(venvPath);

    if (uvPath) {
        await runCommand(uvPath, ['pip', 'install', '--python', interpreter, '-r', requirementsPath], {
            token,
            onStdoutLine: onLine,
            onStderrLine: onLine
        });
        return;
    }

    await runCommand(interpreter, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'], {
        token,
        onStdoutLine: onLine,
        onStderrLine: onLine
    });
    await runCommand(interpreter, ['-m', 'pip', 'install', '-r', requirementsPath], {
        token,
        onStdoutLine: onLine,
        onStderrLine: onLine
    });
}
```

Move the `import * as vscode from 'vscode';`, `runCommand` and `logger` imports to the top of the file with the existing imports — TypeScript requires imports at module scope, and `noUnusedLocals` will flag duplicates.

- [ ] **Step 3: Verify it compiles and existing tests still pass**

```bash
npm run compile-tests && npm run lint && npx vscode-test --run out/test/pythonToolchain.test.js
```

Expected: clean compile, clean lint, 7 passing.

- [ ] **Step 4: Commit**

```bash
git add src/services/pythonToolchain.ts package.json
git commit -m "[ADD] uv-backed virtualenv and requirements provisioning"
```

---

### Task 5: System dependency doctor

Detects the non-Python dependencies and explains what breaks without each. Never installs, never escalates.

**Files:**
- Create: `src/services/systemDeps.ts`
- Test: `src/test/systemDeps.test.ts`

**Interfaces:**
- Consumes: `tryRunCommand` from `src/services/process.ts`; `venvPythonPath` from Task 3.
- Produces:
  - `type PlatformId = 'apt' | 'dnf' | 'brew' | 'windows' | 'unknown'`
  - `interface SystemDepReport { id: string; label: string; present: boolean; impact: string; installHint?: string }`
  - `detectPlatform(): PlatformId`
  - `installHintFor(id: string, platform: PlatformId): string | undefined`
  - `summarizeMissing(reports: SystemDepReport[]): string | undefined`
  - `checkSystemDeps(venvPath?: string): Promise<SystemDepReport[]>`

- [ ] **Step 1: Write the failing test**

Create `src/test/systemDeps.test.ts`:

```ts
import * as assert from 'assert';
import { installHintFor, summarizeMissing, SystemDepReport } from '../services/systemDeps';

function report(id: string, present: boolean): SystemDepReport {
    return { id, label: id, present, impact: `${id} impact` };
}

suite('System dependency doctor', () => {
    test('gives a platform-specific install hint', () => {
        assert.ok(installHintFor('wkhtmltopdf', 'apt')?.includes('apt'));
        assert.ok(installHintFor('wkhtmltopdf', 'brew')?.includes('brew'));
        assert.ok(installHintFor('wkhtmltopdf', 'dnf')?.includes('dnf'));
    });

    test('returns no hint for an unknown platform or unknown dependency', () => {
        assert.strictEqual(installHintFor('wkhtmltopdf', 'unknown'), undefined);
        assert.strictEqual(installHintFor('nonexistent-tool', 'apt'), undefined);
    });

    test('summarizes only the missing dependencies', () => {
        const summary = summarizeMissing([
            report('wkhtmltopdf', false),
            report('psql', true),
            report('rtlcss', false)
        ]);
        assert.ok(summary);
        assert.ok(summary.includes('wkhtmltopdf'));
        assert.ok(summary.includes('rtlcss'));
        assert.ok(!summary.includes('psql'));
    });

    test('returns undefined when nothing is missing', () => {
        assert.strictEqual(summarizeMissing([report('psql', true)]), undefined);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run compile-tests
```

Expected: FAIL — `Cannot find module '../services/systemDeps'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/systemDeps.ts`:

```ts
/**
 * Detects the non-Python dependencies an Odoo server needs and reports what
 * breaks without each. Reports and suggests only: nothing here executes an
 * installer or escalates privileges.
 */
import * as fs from 'node:fs';
import { tryRunCommand } from './process';
import { venvPythonPath } from './pythonToolchain';

export type PlatformId = 'apt' | 'dnf' | 'brew' | 'windows' | 'unknown';

export interface SystemDepReport {
    id: string;
    label: string;
    present: boolean;
    impact: string;
    installHint?: string;
}

const INSTALL_HINTS: Record<string, Partial<Record<PlatformId, string>>> = {
    wkhtmltopdf: {
        apt: 'sudo apt install wkhtmltopdf',
        dnf: 'sudo dnf install wkhtmltopdf',
        brew: 'brew install --cask wkhtmltopdf'
    },
    psql: {
        apt: 'sudo apt install postgresql-client',
        dnf: 'sudo dnf install postgresql',
        brew: 'brew install libpq'
    },
    rtlcss: {
        apt: 'sudo npm install -g rtlcss',
        dnf: 'sudo npm install -g rtlcss',
        brew: 'npm install -g rtlcss'
    },
    buildDeps: {
        apt: 'sudo apt install libxml2-dev libxslt1-dev libldap2-dev libsasl2-dev libssl-dev python3-dev',
        dnf: 'sudo dnf install libxml2-devel libxslt-devel openldap-devel cyrus-sasl-devel openssl-devel python3-devel',
        brew: 'brew install libxmlsec1 openldap'
    }
};

export function detectPlatform(): PlatformId {
    if (process.platform === 'win32') {
        return 'windows';
    }
    if (process.platform === 'darwin') {
        return 'brew';
    }
    if (fs.existsSync('/usr/bin/apt') || fs.existsSync('/usr/bin/apt-get')) {
        return 'apt';
    }
    if (fs.existsSync('/usr/bin/dnf')) {
        return 'dnf';
    }
    return 'unknown';
}

export function installHintFor(id: string, platform: PlatformId): string | undefined {
    return INSTALL_HINTS[id]?.[platform];
}

export function summarizeMissing(reports: SystemDepReport[]): string | undefined {
    const missing = reports.filter(entry => !entry.present);
    if (missing.length === 0) {
        return undefined;
    }
    return missing.map(entry => `${entry.label}: ${entry.impact}`).join('; ');
}

async function onPath(command: string, args: string[] = ['--version']): Promise<boolean> {
    return (await tryRunCommand(command, args)) !== undefined;
}

async function canImport(venvPath: string, moduleName: string): Promise<boolean> {
    const interpreter = venvPythonPath(venvPath);
    if (!fs.existsSync(interpreter)) {
        return false;
    }
    return (await tryRunCommand(interpreter, ['-c', `import ${moduleName}`])) !== undefined;
}

export async function checkSystemDeps(venvPath?: string): Promise<SystemDepReport[]> {
    const platform = detectPlatform();
    const reports: SystemDepReport[] = [];

    const add = (id: string, label: string, present: boolean, impact: string) => {
        reports.push({ id, label, present, impact, installHint: present ? undefined : installHintFor(id, platform) });
    };

    add('wkhtmltopdf', 'wkhtmltopdf', await onPath('wkhtmltopdf'), 'PDF reports will fail; everything else works');
    add('psql', 'PostgreSQL client tools', await onPath('psql'), 'Database features are unavailable');
    add('rtlcss', 'rtlcss', await onPath('rtlcss'), 'Right-to-left stylesheets are not generated');

    if (venvPath) {
        const missingModules: string[] = [];
        for (const moduleName of ['lxml', 'psycopg2', 'ldap']) {
            if (!(await canImport(venvPath, moduleName))) {
                missingModules.push(moduleName);
            }
        }
        add(
            'buildDeps',
            `Python modules (${missingModules.join(', ') || 'all present'})`,
            missingModules.length === 0,
            'The server will not start; build headers are probably missing'
        );
    }

    return reports;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run compile-tests && npx vscode-test --run out/test/systemDeps.test.js
```

Expected: PASS, 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/services/systemDeps.ts src/test/systemDeps.test.ts
git commit -m "[ADD] System dependency doctor"
```

---

### Task 6: Provisioning orchestrator

Composes Tasks 1–5 into probe, plan and execute. Plan construction is pure and carries the tests.

**Files:**
- Create: `src/services/provisioning.ts`
- Test: `src/test/provisioning.test.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 1–5; `normalizePath` from `src/utils.ts`.
- Produces:
  - `interface ProvisionSpec { branch: string; sourceRepoPath: string; enterpriseRepoPath?: string; designThemesRepoPath?: string; root: string }`
  - `interface ProvisionProbe { odooWorktree: boolean; enterpriseWorktree: boolean; designThemesWorktree: boolean; venv: boolean; requirements: boolean }`
  - `interface ProvisionStep { id: string; label: string; status: 'satisfied' | 'needed' }`
  - `interface ProvisionPaths { odooPath: string; enterprisePath?: string; designThemesPath?: string; venvPath: string }`
  - `slugifyBranch(branch: string): string`
  - `resolveProvisionPaths(spec: ProvisionSpec): ProvisionPaths`
  - `buildPlan(spec: ProvisionSpec, probe: ProvisionProbe): ProvisionStep[]`
  - `isFullySatisfied(plan: ProvisionStep[]): boolean`
  - `probeProvision(spec: ProvisionSpec): Promise<ProvisionProbe>`
  - `interface ProvisionResult { paths: ProvisionPaths; managedPaths: string[]; pythonVersion: string; warnings: string[]; deps: SystemDepReport[] }`
  - `executeProvision(spec, progress, token): Promise<ProvisionResult>`

- [ ] **Step 1: Write the failing test**

Create `src/test/provisioning.test.ts`:

```ts
import * as assert from 'assert';
import * as path from 'node:path';
import {
    slugifyBranch,
    resolveProvisionPaths,
    buildPlan,
    isFullySatisfied,
    ProvisionSpec,
    ProvisionProbe
} from '../services/provisioning';

const SPEC: ProvisionSpec = {
    branch: '17.0',
    sourceRepoPath: '/dev/odoo',
    enterpriseRepoPath: '/dev/enterprise',
    root: '/dev/versions'
};

const NOTHING_PRESENT: ProvisionProbe = {
    odooWorktree: false,
    enterpriseWorktree: false,
    designThemesWorktree: false,
    venv: false,
    requirements: false
};

const ALL_PRESENT: ProvisionProbe = {
    odooWorktree: true,
    enterpriseWorktree: true,
    designThemesWorktree: true,
    venv: true,
    requirements: true
};

suite('Provisioning plan', () => {
    test('leaves ordinary branch names untouched', () => {
        assert.strictEqual(slugifyBranch('19.0'), '19.0');
        assert.strictEqual(slugifyBranch('saas-19.2'), 'saas-19.2');
        assert.strictEqual(slugifyBranch('master'), 'master');
    });

    test('replaces path separators and unsafe characters', () => {
        assert.strictEqual(slugifyBranch('feature/upgrade-17'), 'feature-upgrade-17');
        assert.strictEqual(slugifyBranch('fix\\weird:name'), 'fix-weird-name');
    });

    test('resolves per-version paths under the root', () => {
        const paths = resolveProvisionPaths(SPEC);
        assert.strictEqual(paths.odooPath, path.join('/dev/versions', 'odoo-17.0'));
        assert.strictEqual(paths.enterprisePath, path.join('/dev/versions', 'enterprise-17.0'));
        assert.strictEqual(paths.venvPath, path.join('/dev/versions', 'venv-17.0'));
        assert.strictEqual(paths.designThemesPath, undefined);
    });

    test('marks every step needed when nothing exists', () => {
        const plan = buildPlan(SPEC, NOTHING_PRESENT);
        assert.ok(plan.every(step => step.status === 'needed'));
        assert.strictEqual(isFullySatisfied(plan), false);
    });

    test('omits steps for repositories that were not requested', () => {
        const plan = buildPlan(SPEC, NOTHING_PRESENT);
        assert.ok(plan.some(step => step.id === 'worktree:enterprise'));
        assert.ok(!plan.some(step => step.id === 'worktree:design-themes'));
    });

    test('marks everything satisfied when it all exists', () => {
        const plan = buildPlan(SPEC, ALL_PRESENT);
        assert.ok(plan.every(step => step.status === 'satisfied'));
        assert.strictEqual(isFullySatisfied(plan), true);
    });

    test('marks only the missing steps needed', () => {
        const plan = buildPlan(SPEC, { ...ALL_PRESENT, requirements: false });
        const needed = plan.filter(step => step.status === 'needed').map(step => step.id);
        assert.deepStrictEqual(needed, ['requirements']);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run compile-tests
```

Expected: FAIL — `Cannot find module '../services/provisioning'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/provisioning.ts`:

```ts
/**
 * Provisioning orchestrator. Probes what already exists on disk, plans only
 * the missing steps, and executes those — so a failed run resumes where it
 * stopped and an environment built by hand is adopted rather than rebuilt.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { readOdooPythonWindow } from './odooRequirements';
import { ensureWorktree } from './worktree';
import { ensureInterpreter, ensureVenv, installRequirements, resolveUv, venvPythonPath } from './pythonToolchain';
import { checkSystemDeps, SystemDepReport } from './systemDeps';
import { logger } from './logger';

export interface ProvisionSpec {
    branch: string;
    sourceRepoPath: string;
    enterpriseRepoPath?: string;
    designThemesRepoPath?: string;
    root: string;
}

export interface ProvisionProbe {
    odooWorktree: boolean;
    enterpriseWorktree: boolean;
    designThemesWorktree: boolean;
    venv: boolean;
    requirements: boolean;
}

export interface ProvisionStep {
    id: string;
    label: string;
    status: 'satisfied' | 'needed';
}

export interface ProvisionPaths {
    odooPath: string;
    enterprisePath?: string;
    designThemesPath?: string;
    venvPath: string;
}

export interface ProvisionResult {
    paths: ProvisionPaths;
    managedPaths: string[];
    pythonVersion: string;
    warnings: string[];
    deps: SystemDepReport[];
}

export function slugifyBranch(branch: string): string {
    return branch.replace(/[^A-Za-z0-9._-]+/g, '-');
}

export function resolveProvisionPaths(spec: ProvisionSpec): ProvisionPaths {
    const slug = slugifyBranch(spec.branch);
    return {
        odooPath: path.join(spec.root, `odoo-${slug}`),
        enterprisePath: spec.enterpriseRepoPath ? path.join(spec.root, `enterprise-${slug}`) : undefined,
        designThemesPath: spec.designThemesRepoPath ? path.join(spec.root, `design-themes-${slug}`) : undefined,
        venvPath: path.join(spec.root, `venv-${slug}`)
    };
}

export function buildPlan(spec: ProvisionSpec, probe: ProvisionProbe): ProvisionStep[] {
    const mark = (satisfied: boolean): ProvisionStep['status'] => (satisfied ? 'satisfied' : 'needed');
    const steps: ProvisionStep[] = [
        { id: 'worktree:odoo', label: `Worktree for odoo (${spec.branch})`, status: mark(probe.odooWorktree) }
    ];

    if (spec.enterpriseRepoPath) {
        steps.push({
            id: 'worktree:enterprise',
            label: `Worktree for enterprise (${spec.branch})`,
            status: mark(probe.enterpriseWorktree)
        });
    }
    if (spec.designThemesRepoPath) {
        steps.push({
            id: 'worktree:design-themes',
            label: `Worktree for design-themes (${spec.branch})`,
            status: mark(probe.designThemesWorktree)
        });
    }

    steps.push({ id: 'venv', label: 'Virtualenv', status: mark(probe.venv) });
    steps.push({ id: 'requirements', label: 'Python requirements', status: mark(probe.requirements) });
    return steps;
}

export function isFullySatisfied(plan: ProvisionStep[]): boolean {
    return plan.every(step => step.status === 'satisfied');
}

export async function probeProvision(spec: ProvisionSpec): Promise<ProvisionProbe> {
    const paths = resolveProvisionPaths(spec);
    const venvExists = fs.existsSync(venvPythonPath(paths.venvPath));

    // Requirements count as installed when the venv can import the two
    // packages Odoo cannot start without.
    let requirements = false;
    if (venvExists) {
        const deps = await checkSystemDeps(paths.venvPath);
        requirements = deps.find(entry => entry.id === 'buildDeps')?.present ?? false;
    }

    return {
        odooWorktree: fs.existsSync(path.join(paths.odooPath, 'odoo-bin')),
        enterpriseWorktree: !paths.enterprisePath || fs.existsSync(paths.enterprisePath),
        designThemesWorktree: !paths.designThemesPath || fs.existsSync(paths.designThemesPath),
        venv: venvExists,
        requirements
    };
}

export async function executeProvision(
    spec: ProvisionSpec,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token?: vscode.CancellationToken
): Promise<ProvisionResult> {
    const paths = resolveProvisionPaths(spec);
    const managedPaths: string[] = [];
    const warnings: string[] = [];

    fs.mkdirSync(spec.root, { recursive: true });

    progress.report({ message: `Worktree for odoo (${spec.branch})` });
    const odooTree = await ensureWorktree(spec.sourceRepoPath, spec.branch, paths.odooPath, token);
    paths.odooPath = odooTree.path;
    if (odooTree.created) {
        managedPaths.push(odooTree.path);
    }

    if (spec.enterpriseRepoPath && paths.enterprisePath) {
        progress.report({ message: `Worktree for enterprise (${spec.branch})` });
        try {
            const tree = await ensureWorktree(spec.enterpriseRepoPath, spec.branch, paths.enterprisePath, token);
            paths.enterprisePath = tree.path;
            if (tree.created) {
                managedPaths.push(tree.path);
            }
        } catch (error) {
            warnings.push(`enterprise: ${error instanceof Error ? error.message : String(error)}`);
            paths.enterprisePath = undefined;
        }
    }

    if (spec.designThemesRepoPath && paths.designThemesPath) {
        progress.report({ message: `Worktree for design-themes (${spec.branch})` });
        try {
            const tree = await ensureWorktree(spec.designThemesRepoPath, spec.branch, paths.designThemesPath, token);
            paths.designThemesPath = tree.path;
            if (tree.created) {
                managedPaths.push(tree.path);
            }
        } catch (error) {
            warnings.push(`design-themes: ${error instanceof Error ? error.message : String(error)}`);
            paths.designThemesPath = undefined;
        }
    }

    progress.report({ message: 'Resolving Python interpreter' });
    const window = await readOdooPythonWindow(paths.odooPath);
    if (window.source === 'fallback') {
        warnings.push(`Could not read this branch's Python requirement; assuming ${window.minPython.join('.')}.`);
    }
    const interpreter = await ensureInterpreter(window, token);
    if (interpreter.warning) {
        warnings.push(interpreter.warning);
    }

    const uv = await resolveUv();
    if (!uv) {
        warnings.push('uv is not available; using the standard library venv and pip.');
    }

    progress.report({ message: 'Creating virtualenv' });
    await ensureVenv(interpreter.path, paths.venvPath, uv, token);
    if (!managedPaths.includes(paths.venvPath)) {
        managedPaths.push(paths.venvPath);
    }

    progress.report({ message: 'Installing requirements (this takes a few minutes)' });
    await installRequirements(
        paths.venvPath,
        path.join(paths.odooPath, 'requirements.txt'),
        uv,
        line => {
            const trimmed = line.trim();
            if (trimmed) {
                progress.report({ message: trimmed.slice(0, 120) });
            }
        },
        token
    );

    progress.report({ message: 'Checking system dependencies' });
    const deps = await checkSystemDeps(paths.venvPath);

    logger.info(`[provisioning] ${spec.branch} provisioned at ${paths.odooPath}`);
    return {
        paths,
        managedPaths,
        pythonVersion: interpreter.version.join('.'),
        warnings,
        deps
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run compile-tests && npx vscode-test --run out/test/provisioning.test.js
```

Expected: PASS, 7 passing.

- [ ] **Step 5: Commit**

```bash
git add src/services/provisioning.ts src/test/provisioning.test.ts
git commit -m "[ADD] Provisioning orchestrator"
```

---

### Task 7: Version model managed paths

Records which paths the extension created, so Delete Version can offer to remove them and never offers to remove a hand-made checkout.

**Files:**
- Modify: `src/models/version.ts`
- Modify: `src/models/settings.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `VersionSettings.managedPaths: string[]` and `SettingsModel.managedPaths: string[]`, both defaulting to `[]`.

- [ ] **Step 1: Add the field to the version settings interface**

In `src/models/version.ts`, add to `interface VersionSettings` after `postCheckoutCommands`:

```ts
    /** Absolute paths this extension created while provisioning. */
    managedPaths: string[];
```

In the `VersionModel` constructor's baseline settings object, add after `postCheckoutCommands: []`:

```ts
            managedPaths: [],
```

And after the existing array normalization lines, add:

```ts
        this.settings.managedPaths = Array.isArray(this.settings.managedPaths) ? this.settings.managedPaths : [];
```

- [ ] **Step 2: Add the matching field to SettingsModel**

In `src/models/settings.ts`, add after `postCheckoutCommands`:

```ts
    managedPaths: string[] = [];
```

And in the constructor, after the existing normalization lines:

```ts
        this.managedPaths = Array.isArray(this.managedPaths) ? this.managedPaths : [];
```

- [ ] **Step 3: Verify the full suite still passes**

```bash
npm run compile-tests && npm run lint && npm test
```

Expected: clean compile, clean lint, all existing tests pass. Stored versions without the field load unchanged because the constructor merges partials.

- [ ] **Step 4: Commit**

```bash
git add src/models/version.ts src/models/settings.ts
git commit -m "[ADD] Track extension-managed paths on a version"
```

---

### Task 8: Collapse the checkout hooks into one post-switch list

Replaces `preCheckoutCommands` and `postCheckoutCommands` with a single `postSwitchCommands`, read from the version first and the global default second — which also fixes the fact that the per-version fields have never been read.

**Files:**
- Modify: `src/services/checkout.ts:195-285`
- Modify: `src/models/version.ts`
- Modify: `src/models/settings.ts`
- Modify: `src/utils.ts` (`getDefaultVersionSettings`)
- Modify: `package.json` (configuration properties)

**Interfaces:**
- Consumes: `SettingsModel` from `src/models/settings.ts`.
- Produces: `alignCoreRepos(settings: SettingsModel, branch: string, needsCheckout: boolean): Promise<RepoCheckoutResult[]>`, replacing the exported `checkoutCoreRepos`.

- [ ] **Step 1: Rename the model fields**

In `src/models/version.ts`, replace the two hook entries in `VersionSettings` with:

```ts
    postSwitchCommands: string[];
```

Replace both baseline entries in the constructor with `postSwitchCommands: [],` and replace the two normalization lines with:

```ts
        this.settings.postSwitchCommands = Array.isArray(this.settings.postSwitchCommands) ? this.settings.postSwitchCommands : [];
```

Apply the equivalent change in `src/models/settings.ts`: replace the two fields with `postSwitchCommands: string[] = [];` and the two normalization lines with the single equivalent.

- [ ] **Step 2: Replace the configuration properties**

In `package.json`, delete `odooDebugger.defaultVersion.preCheckoutCommands` and `odooDebugger.defaultVersion.postCheckoutCommands`, and add:

```json
"odooDebugger.defaultVersion.postSwitchCommands": {
    "type": "array",
    "items": { "type": "string" },
    "default": [],
    "description": "Commands to run after this version's environment is aligned. Each entry runs in a shell with the repository folder as the working directory, once per core repository. Used when the version itself defines none."
}
```

In `src/utils.ts`, update `getDefaultVersionSettings` to read `postSwitchCommands` instead of the two removed keys.

- [ ] **Step 3: Rewrite the hook resolution and rename the entry point**

In `src/services/checkout.ts`, replace the export signature and the hook reads:

```ts
/**
 * Aligns the core Odoo repositories to `branch`, running the version's
 * post-switch commands per repository. When `needsCheckout` is false the
 * repositories are already on the right branch (each version owns its
 * worktree) and only the hooks run.
 */
export async function alignCoreRepos(
    settings: SettingsModel,
    branch: string,
    needsCheckout: boolean
): Promise<RepoCheckoutResult[]> {
    const repos = [
        { name: 'Odoo', path: settings.odooPath },
        { name: 'Enterprise', path: settings.enterprisePath },
        { name: 'Design Themes', path: settings.designThemesPath }
    ]
        .filter(repo => repo.path && repo.path.trim() !== '')
        .map(repo => ({ name: repo.name, path: normalizePath(repo.path) }));

    if (repos.length === 0) {
        return [{ name: 'Odoo', success: false, message: 'No core repository paths are configured' }];
    }

    // The version's own commands win; the global default is the fallback, so
    // a version that defines none still behaves as configured.
    const configured = vscode.workspace
        .getConfiguration('odooDebugger.defaultVersion')
        .get<string[]>('postSwitchCommands', []);
    const postSwitchCommands = settings.postSwitchCommands.length > 0 ? settings.postSwitchCommands : configured;
```

Inside `processRepository`, delete the pre-checkout block entirely and make the checkout conditional:

```ts
            if (needsCheckout) {
                checkoutHooksOutput.appendLine(`[checkout] ${repo.name}: checkout start t+${elapsed()}`);
                const checkoutResult = await checkoutRepoBranch(repo.path, branch);
                if (!checkoutResult.ok) {
                    checkoutHooksOutput.appendLine(`[checkout] ${repo.name}: pipeline failed during checkout t+${elapsed()}`);
                    return {
                        name: repo.name,
                        success: false,
                        message: checkoutResult.message || 'Failed to checkout branch'
                    };
                }
            }

            const postOk = await runCheckoutHookCommands(postSwitchCommands, 'post-switch', repo.path, repo.name, progress);
            return {
                name: repo.name,
                success: postOk,
                message: postOk ? 'Aligned' : 'Post-switch hook(s) failed'
            };
```

Update the `withProgress` title to `needsCheckout ? \`Switching to branch: ${branch}\` : \`Aligning ${branch}\``.

- [ ] **Step 4: Update the caller**

In `src/services/environment.ts`, change the import of `checkoutCoreRepos` to `alignCoreRepos` and the call in `applyEnvironmentDiff` to `await alignCoreRepos(diff.settings, diff.coreBranch, true)`. Task 10 replaces this call properly; passing `true` here preserves today's behavior in the meantime.

- [ ] **Step 5: Verify**

```bash
npm run compile-tests && npm run lint && npm test
```

Expected: clean compile, clean lint, all existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/checkout.ts src/services/environment.ts src/models/version.ts src/models/settings.ts src/utils.ts package.json
git commit -m "[REF] Collapse checkout hooks into one post-switch list"
```

---

### Task 9: Hook migration

Migrates stored versions and global settings onto `postSwitchCommands`, telling the user plainly when commands changed when they run.

**Files:**
- Modify: `src/services/dataMigration.ts`
- Test: `src/test/hookMigration.test.ts`

**Interfaces:**
- Consumes: `DebuggerData` from `src/utils.ts`.
- Produces:
  - `applyHookMigration(data: DebuggerData): { changed: boolean; prependedVersionNames: string[] }`
  - Called from the existing `migrateDebuggerData()`.

- [ ] **Step 1: Write the failing test**

Create `src/test/hookMigration.test.ts`:

```ts
import * as assert from 'assert';
import { applyHookMigration } from '../services/dataMigration';

function buildData(versions: Record<string, any>) {
    return { projects: [], versions } as any;
}

suite('Hook migration', () => {
    test('renames postCheckoutCommands and preserves the values', () => {
        const data = buildData({
            v1: { id: 'v1', name: '17.0', settings: { postCheckoutCommands: ['npm install'] } }
        });

        const result = applyHookMigration(data);
        assert.strictEqual(result.changed, true);
        const settings = data.versions.v1.settings;
        assert.deepStrictEqual(settings.postSwitchCommands, ['npm install']);
        assert.strictEqual('postCheckoutCommands' in settings, false);
    });

    test('prepends pre-checkout commands and reports the version', () => {
        const data = buildData({
            v1: {
                id: 'v1',
                name: '17.0',
                settings: { preCheckoutCommands: ['git stash'], postCheckoutCommands: ['npm install'] }
            }
        });

        const result = applyHookMigration(data);
        assert.deepStrictEqual(data.versions.v1.settings.postSwitchCommands, ['git stash', 'npm install']);
        assert.strictEqual('preCheckoutCommands' in data.versions.v1.settings, false);
        assert.deepStrictEqual(result.prependedVersionNames, ['17.0']);
    });

    test('drops empty legacy arrays without reporting a prepend', () => {
        const data = buildData({
            v1: { id: 'v1', name: '17.0', settings: { preCheckoutCommands: [], postCheckoutCommands: [] } }
        });

        const result = applyHookMigration(data);
        assert.strictEqual(result.changed, true);
        assert.deepStrictEqual(data.versions.v1.settings.postSwitchCommands, []);
        assert.deepStrictEqual(result.prependedVersionNames, []);
    });

    test('reports no change for already-migrated data', () => {
        const data = buildData({
            v1: { id: 'v1', name: '17.0', settings: { postSwitchCommands: ['npm install'] } }
        });

        assert.strictEqual(applyHookMigration(data).changed, false);
    });

    test('handles a version with no settings object', () => {
        const data = buildData({ v1: { id: 'v1', name: '17.0' } });
        assert.strictEqual(applyHookMigration(data).changed, false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run compile-tests
```

Expected: FAIL — `applyHookMigration` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/services/dataMigration.ts`:

```ts
/**
 * Migrates the two legacy hook arrays onto `postSwitchCommands`. Pre-checkout
 * commands are prepended rather than dropped, but they now run *after* the
 * switch — the caller surfaces that, because a `git stash` guard changes
 * meaning.
 */
export function applyHookMigration(data: DebuggerData): { changed: boolean; prependedVersionNames: string[] } {
    let changed = false;
    const prependedVersionNames: string[] = [];

    for (const version of Object.values(data.versions ?? {})) {
        const settings = (version as any)?.settings;
        if (!settings || typeof settings !== 'object') {
            continue;
        }

        const hasPre = 'preCheckoutCommands' in settings;
        const hasPost = 'postCheckoutCommands' in settings;
        if (!hasPre && !hasPost) {
            continue;
        }

        const pre: string[] = Array.isArray(settings.preCheckoutCommands) ? settings.preCheckoutCommands : [];
        const post: string[] = Array.isArray(settings.postCheckoutCommands) ? settings.postCheckoutCommands : [];
        const existing: string[] = Array.isArray(settings.postSwitchCommands) ? settings.postSwitchCommands : [];

        settings.postSwitchCommands = [...pre, ...post, ...existing];
        delete settings.preCheckoutCommands;
        delete settings.postCheckoutCommands;
        changed = true;

        if (pre.length > 0) {
            prependedVersionNames.push((version as any).name ?? (version as any).id ?? 'unnamed version');
        }
    }

    return { changed, prependedVersionNames };
}
```

Then call it from the existing `migrateDebuggerData()`, alongside the database field migration, and surface the notice:

```ts
    const hookResult = applyHookMigration(data);
    if (hookResult.prependedVersionNames.length > 0) {
        void showWarning(
            `Pre-checkout commands were merged into postSwitchCommands for: ${hookResult.prependedVersionNames.join(', ')}. ` +
            'They now run after the branch switch rather than before.'
        );
    }
```

Include `hookResult.changed` in whatever condition already decides that `migrateDebuggerData` must save, and import `showWarning` from `../utils`.

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run compile-tests && npx vscode-test --run out/test/hookMigration.test.js
```

Expected: PASS, 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/services/dataMigration.ts src/test/hookMigration.test.ts
git commit -m "[ADD] Migrate checkout hooks onto postSwitchCommands"
```

---

### Task 10: Core repo pipeline in the environment diff

Makes a version change — not only a branch change — a reason to run the core repo pipeline, so hooks keep firing once provisioned versions stop checking out.

**Files:**
- Modify: `src/services/environment.ts:160-275`

**Interfaces:**
- Consumes: `alignCoreRepos` from Task 8.
- Produces: `EnvironmentDiff.coreRepoPipeline?: { branch: string; needsCheckout: boolean }`, replacing `EnvironmentDiff.coreBranch`.

- [ ] **Step 1: Replace the diff field**

In `src/services/environment.ts`, change `interface EnvironmentDiff`:

```ts
interface EnvironmentDiff {
    versionToActivate?: VersionModel;
    settings: SettingsModel;
    /**
     * Present when the version changed or a branch differs. `needsCheckout`
     * is false for a provisioned version, whose worktree is already correct —
     * the pipeline then runs post-switch hooks only.
     */
    coreRepoPipeline?: { branch: string; needsCheckout: boolean };
    repoCheckouts: ProjectRepoBranchAssignment[];
    descriptions: string[];
}
```

- [ ] **Step 2: Compute it**

Replace the `coreBranch` computation in `computeEnvironmentDiff` with:

```ts
    const coreBranchTarget = target.coreBranch?.trim() || targetVersion?.odooVersion?.trim() || undefined;
    let coreRepoPipeline: { branch: string; needsCheckout: boolean } | undefined;
    if (coreBranchTarget) {
        const configuredPaths = [settings.odooPath, settings.enterprisePath, settings.designThemesPath]
            .filter(entry => entry && entry.trim() !== '')
            .map(entry => normalizePath(entry));
        const existingPaths = configuredPaths.filter(entry => fs.existsSync(entry));

        let needsCheckout = existingPaths.length === 0;
        for (const repoPath of existingPaths) {
            if (await getRepoBranch(repoPath) !== coreBranchTarget) {
                needsCheckout = true;
                break;
            }
        }

        // A version change alone is enough: post-switch hooks must run even
        // when every worktree is already on the right branch.
        if (needsCheckout || versionToActivate) {
            coreRepoPipeline = { branch: coreBranchTarget, needsCheckout };
        }
    }
```

Update the descriptions block to push `branch "${coreRepoPipeline.branch}"` only when `coreRepoPipeline.needsCheckout` is true, and return `coreRepoPipeline` in place of `coreBranch`.

- [ ] **Step 3: Apply it**

In `isEmptyDiff`, replace `!diff.coreBranch` with `!diff.coreRepoPipeline`. In `applyEnvironmentDiff`, replace the `diff.coreBranch` block with:

```ts
    if (diff.coreRepoPipeline) {
        const { branch, needsCheckout } = diff.coreRepoPipeline;
        const results = await alignCoreRepos(diff.settings, branch, needsCheckout);
        const failed = results.filter(result => !result.success);
        if (failed.length === 0) {
            if (needsCheckout) {
                applied.push(`branch "${branch}"`);
            }
        } else {
            if (failed.length < results.length && needsCheckout) {
                applied.push(`branch "${branch}" (partially)`);
            }
            failures.push(...failed.map(result => `${result.name}: ${result.message}`));
        }
    }
```

Guard the success toast so a hooks-only run with nothing else applied stays silent:

```ts
    if (failures.length === 0) {
        if (applied.length > 0) {
            showAutoInfo(`${label}: switched ${applied.join(', ')}`, 3000);
        }
    } else {
```

- [ ] **Step 4: Verify**

```bash
npm run compile-tests && npm run lint && npm test
```

Expected: clean compile, clean lint, all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/environment.ts
git commit -m "[FIX] Run post-switch hooks when the version changes"
```

---

### Task 11: Provisioning command flow

Turns `Create Version` into the provisioning flow and `Setup Odoo` into its first-run path, awaiting the work instead of firing it into a terminal.

**Files:**
- Modify: `src/odooInstaller.ts:196-240` and `:325-367`
- Modify: `src/commands/versionCommands.ts`

**Interfaces:**
- Consumes: `probeProvision`, `buildPlan`, `isFullySatisfied`, `executeProvision`, `resolveProvisionPaths` from Task 6; `summarizeMissing` from Task 5; `VersionsService.createVersion`.
- Produces: `provisionAndCreateVersion(branch: string, name: string): Promise<VersionModel | undefined>` exported from `src/odooInstaller.ts`.

- [ ] **Step 1: Delete the fire-and-forget environment setup**

In `src/odooInstaller.ts`, delete `setupPythonEnvironment` entirely — it writes commands into a terminal and returns before they run, which is why `createVersionForClone`'s `fs.existsSync(venvPython)` check almost always fails and versions come out with no `pythonPath`.

- [ ] **Step 2: Add the awaited provisioning flow**

Add to `src/odooInstaller.ts`:

```ts
import { probeProvision, buildPlan, isFullySatisfied, executeProvision, ProvisionSpec } from './services/provisioning';
import { summarizeMissing } from './services/systemDeps';

/** Provisioning root: the configured setting, else the parent of the default odooPath. */
function resolveProvisioningRoot(): string {
    const configured = vscode.workspace
        .getConfiguration('odooDebugger.provisioning')
        .get<string>('root', '')
        .trim();
    if (configured) {
        return normalizePath(configured);
    }
    const defaults = getDefaultVersionSettings();
    return path.dirname(normalizePath(defaults.odooPath));
}

/**
 * Provisions the environment for `branch` and creates the matching version
 * profile pointing at it. Returns undefined when the user cancels.
 */
export async function provisionAndCreateVersion(branch: string, name: string): Promise<VersionModel | undefined> {
    const defaults = getDefaultVersionSettings();
    const spec: ProvisionSpec = {
        branch,
        sourceRepoPath: normalizePath(defaults.odooPath),
        enterpriseRepoPath: defaults.enterprisePath ? normalizePath(defaults.enterprisePath) : undefined,
        designThemesRepoPath: defaults.designThemesPath ? normalizePath(defaults.designThemesPath) : undefined,
        root: resolveProvisioningRoot()
    };

    if (!fs.existsSync(spec.sourceRepoPath)) {
        void showError(`No Odoo repository at ${spec.sourceRepoPath}. Run "Setup Odoo" first.`);
        return undefined;
    }

    const plan = buildPlan(spec, await probeProvision(spec));
    const summary = plan
        .map(step => `${step.status === 'satisfied' ? '$(check)' : '$(add)'} ${step.label}`)
        .join('\n');

    const choice = await vscode.window.showQuickPick(
        [
            {
                label: isFullySatisfied(plan) ? 'Create profile (already provisioned)' : 'Provision',
                detail: summary,
                provision: true
            },
            { label: 'Profile only', detail: 'Create the version without building an environment', provision: false }
        ],
        { placeHolder: `Provision Odoo ${branch}?`, ignoreFocusOut: true }
    );
    if (!choice) {
        return undefined;
    }

    if (!choice.provision) {
        return VersionsService.getInstance().createVersion(name, branch);
    }

    const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Provisioning Odoo ${branch}`,
        cancellable: true
    }, async (progress, token) => {
        try {
            return await executeProvision(spec, progress, token);
        } catch (error) {
            if (token.isCancellationRequested) {
                void showInfo('Provisioning cancelled. Run it again to resume where it stopped.');
            } else {
                logger.error('Provisioning failed:', error);
                void showError(`Provisioning failed: ${errorMessage(error)}`);
            }
            return undefined;
        }
    });

    if (!result) {
        return undefined;
    }

    const version = await VersionsService.getInstance().createVersion(name, branch, {
        odooPath: result.paths.odooPath,
        enterprisePath: result.paths.enterprisePath ?? '',
        designThemesPath: result.paths.designThemesPath ?? '',
        pythonPath: venvPythonPath(result.paths.venvPath),
        managedPaths: result.managedPaths
    });

    const notes = [...result.warnings];
    const missing = summarizeMissing(result.deps);
    if (missing) {
        notes.push(`Missing: ${missing}`);
    }
    if (notes.length > 0) {
        void showWarning(`Provisioned ${branch} on Python ${result.pythonVersion}. ${notes.join(' ')}`);
    } else {
        void showInfo(`Provisioned ${branch} on Python ${result.pythonVersion}.`);
    }

    return version;
}
```

Add the imports this needs at the top of the file: `normalizePath`, `getDefaultVersionSettings`, `showWarning` from `./utils`, `venvPythonPath` from `./services/pythonToolchain`, and `VersionModel` from `./models/version`.

- [ ] **Step 3: Route Create Version through it**

In `src/commands/versionCommands.ts`, in the `odoo.createVersion` handler, replace the `versionsService.createVersion(...)` call with `await provisionAndCreateVersion(branch, name)` and return early when it resolves to `undefined`. Import it from `../odooInstaller`.

- [ ] **Step 4: Route Setup Odoo's follow-up through it**

In `setupOdooBranch`, replace both `setupPythonEnvironment(...)` plus `createVersionForClone(...)` pairs with a single `await provisionAndCreateVersion(branch, branch)`, and delete `createVersionForClone`.

- [ ] **Step 5: Verify**

```bash
npm run compile-tests && npm run lint && npm test
```

Expected: clean compile, clean lint, all existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/odooInstaller.ts src/commands/versionCommands.ts
git commit -m "[ADD] Awaited provisioning flow for Create Version and Setup Odoo"
```

---

### Task 12: Versions tree state and Delete Version cleanup

Shows whether a version is provisioned, and offers to remove what the extension created when a version is deleted.

**Files:**
- Modify: `src/versionsTreeProvider.ts`
- Modify: `src/commands/versionCommands.ts` (the `odoo.deleteVersion` handler)

**Interfaces:**
- Consumes: `venvPythonPath` from Task 3; `removeWorktree` from Task 2; `VersionSettings.managedPaths` from Task 7.
- Produces: no new exports.

- [ ] **Step 1: Show provisioned state in the tree**

In `src/versionsTreeProvider.ts`, where a version's tree item description is built, append a provisioning marker:

```ts
import * as fs from 'node:fs';
import { venvPythonPath } from './services/pythonToolchain';

/** "provisioned" when the version's own venv interpreter exists on disk. */
function provisioningLabel(version: VersionModel): string {
    const venvRoot = path.dirname(path.dirname(normalizePath(version.settings.pythonPath)));
    return fs.existsSync(venvPythonPath(venvRoot)) ? 'provisioned' : 'not provisioned';
}
```

Append its result to the existing description parts for a version row. Read the file first and add only the imports it does not already have — `path` and `normalizePath` are likely present, `fs` and `venvPythonPath` are not.

- [ ] **Step 2: Offer cleanup on delete**

In the `odoo.deleteVersion` handler in `src/commands/versionCommands.ts`, after the existing confirmation and before `versionsService.deleteVersion(id)`:

```ts
    const managedPaths = version.settings.managedPaths ?? [];
    if (managedPaths.length > 0) {
        const removeChoice = await showModalWarning(
            `Also delete the ${managedPaths.length} folder(s) this extension created for "${version.name}"?\n\n${managedPaths.join('\n')}`,
            'Delete Folders',
            'Keep Folders'
        );
        if (removeChoice === 'Delete Folders') {
            for (const managedPath of managedPaths) {
                // Worktrees must be removed through git so the parent repo's
                // administrative entry goes with them; anything git refuses
                // (a venv, a stale directory) is a plain recursive delete.
                try {
                    await removeWorktree(normalizePath(version.settings.odooPath), managedPath);
                } catch {
                    try {
                        await fs.promises.rm(managedPath, { recursive: true, force: true });
                    } catch (error) {
                        logger.warn(`Failed to remove ${managedPath}:`, error);
                    }
                }
            }
        }
    }
```

Import `removeWorktree` from `../services/worktree`, `showModalWarning` from `../services/notifications`, and `fs` from `node:fs`.

- [ ] **Step 3: Verify**

```bash
npm run compile-tests && npm run lint && npm test
```

Expected: clean compile, clean lint, all existing tests pass.

- [ ] **Step 4: Update the documentation**

In `README.md`, update the **Versions** section to describe provisioning (worktree, interpreter, venv), replace the **Branch Checkout Hooks** section with post-switch hooks, and document the three `odooDebugger.provisioning.*` settings in the Settings Reference. Add a `## [Unreleased]` entry to `CHANGELOG.md` covering: per-version worktrees and virtualenvs, interpreter selection derived from the branch, the system dependency doctor, the hook collapse and its migration, and the removal of the fire-and-forget environment setup.

- [ ] **Step 5: Commit**

```bash
git add src/versionsTreeProvider.ts src/commands/versionCommands.ts README.md CHANGELOG.md
git commit -m "[ADD] Provisioned state in the Versions tree and cleanup on delete"
```

---

## Verification

After Task 12, run the full gate:

```bash
npm run compile-tests && npm run lint && npm run compile && npm test
```

All four must succeed. Then confirm by hand in the Extension Development Host:

1. **Create Version** on a branch with no environment → the plan preview lists every step as needed → provisioning runs with visible progress → the new version's `pythonPath` points into its own venv and `odooPath` into its own worktree.
2. **Create Version** on the same branch again → every step reports satisfied → no work is done.
3. **Cancel** mid-install → re-run → the completed steps report satisfied and only the remainder runs.
4. Provision a **second** version on a different branch → both worktrees exist at once and both venvs have different Python versions where the branches call for it.
5. **Delete Version** → the cleanup prompt lists the managed folders and removing them leaves no stray worktree (`git worktree list` is clean).
