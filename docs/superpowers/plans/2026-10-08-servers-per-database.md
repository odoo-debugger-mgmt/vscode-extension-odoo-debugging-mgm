# Servers per Database (Compare spec, Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A run is a (version, database, port). Right-click any database → **Run Alongside** starts a server for it next to whatever already runs, on the first free port from 8100. It is never written to launch.json. **Stop Server** on a database row stops that database's run.

**Architecture:**
- **Run records.** Every debug session gets a record `{ name, versionId, dbId, port, kind }`, taken from its launch configuration. A primary session's record comes from its own `-d`/`-p` args. An alongside session carries an `odooDevtools` marker.
- **Running state.** `RunningInstance` is derived from these records, not from each version's current selection. The tree, Open in Browser, Render and checkpoints all read it.
- **Pure helpers.** `alongside.ts` holds them: name, port pick, realtime port, arg rewrite, checkout conflicts.
- **Runtime.** `runAlongside` in `debugger.ts` builds the configuration the way the primary entry is built.

**Tech Stack:** TypeScript (VS Code extension API, debugpy launch configs), mocha TDD in the Extension Host, real Odoo 17 for the gated test.

**Spec:** `docs/superpowers/specs/2026-10-07-compare-and-multi-server-design.md`, Part A (A1–A6). The user said "go ahead" on 2026-10-08. Also read §5's rulings, and ruling P1 of `docs/superpowers/plans/2026-10-08-database-checkpoints.md`: a free `--gevent-port` for runs with workers.

## Global Constraints

- Branch `v-1.5` only. **Never merge, push, or offer to.** The extension never runs `git commit` for the user. Leave `.vscode/launch.json`, `.vscode/tasks.json` and the untracked root dotfiles alone; add files by name.
- Commits: `[ADD]`/`[IMP]`/`[FIX]`/`[REF]`/`[DOC]`, a short body, and a `Co-Authored-By:` trailer naming the model that wrote the commit. dist/ only in the last task.
- Alongside runs are **never written to launch.json**. Each is passed to `vscode.debug.startDebugging` as a configuration object.
- Alongside name: `<debuggerName> · <db>` (U+00B7 MIDDLE DOT, with spaces).
- Alongside port: the first port from **8100** upwards that is not open (live probe) and not taken. Taken means any version's `portNumber` or `shellPortNumber`, any recorded run's port, or a port reserved by a start in flight. Search up to **8199**, then fail with a message.
- With `--workers` > 0 in the version's extra params, an alongside run also gets a free realtime port from the same range: `--gevent-port` on 16.0 and later, `--longpolling-port` before.
- The primary F5 entry is unchanged: one per version, restart semantics.
- If the database already has a run in this window, Run Alongside never starts a second one. It says where the run is, with an Open in Browser button.
- Run Alongside never switches a branch. A repository whose single checkout (or source-checkout fallback) is on a different branch than the database needs makes it refuse. The message names the repository, the current branch and the needed branch. For checkout mode it offers **Use One Copy Per Branch** (`odt.repo.toggleBranchMode` with the repo's `vscode.Uri.file(path)`); for a worktree fallback it offers **Resolve** (`odt.repo.resolveWorktrees`).
- A run in another window is detected (pg_stat_activity, port probe) and never stopped from here.
- Projects from `SettingsStore` are plain JSON; never trust a new field without a normalizer.
- Additive commands stay available in upgrade mode (no `!odoo-debugger.upgrade_enabled` guard). Database-row menus stay keyed to `viewItem == database`.
- Verification:
  - `npx tsc -p . --noEmit` and `npm run lint` (0 errors; 117 warnings is the baseline).
  - Tests run outside the sandbox: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "<suite>"`, full suite `npm test`. Baseline: 939 passing, 30 pending, 0 failing.

## Review Focus

1. **The primary F5 entry after the selection changed.** Start the primary on X, then select Y. The tree still says X is running and Y is not, because the record comes from the session's own `-d`. (Task 1 test.)
2. **Two Run Alongside commands started back to back** must not pick the same port: the second start happens before the first session is recorded. A start reserves its port until its session is recorded, or for 30 s. (Task 2 test on the picker with a reserved set; Task 3 holds the reservation.)
3. **An extra param that sets the port itself** (`--http-port=9000`, `-p 9000` in extraParams) is removed from an alongside run's args, so the run listens where it says. (Task 2 test.)
4. **A database with no version, or an unprovisioned version.** Run Alongside says which and offers what Start Server offers; it does not hand VS Code a broken configuration. (Task 3.)
5. **Checkpoint, Restore or Clone of a database that runs alongside.** The release stops that alongside run and restarts it alongside, on a fresh port and in the same debug mode, never as the version's primary. (Task 3, `copyRuntime.ts`.)

## Rulings made while planning

- **A1.** Run records are built from each session's own configuration: the `-d`/`-p` args for primary, the `odooDevtools` marker for alongside. They are not built from `dbForVersion` — cost if wrong: none; the args are what Odoo runs with.
- **A2.** Run Alongside refuses on any branch mismatch in a single checkout, even when nothing else is running — never switching branches is simpler and safe. The spec only says "when they cannot both be right" — cost if wrong: one extra click to select the database instead.
- **A3.** Starting a version's primary entry on a database that already runs alongside in this window stops that alongside run first. F5 means "run the current database", and the user asked for that — cost if wrong: an alongside run stops without asking.
- **A4.** The realtime port flag follows the version's series: `--longpolling-port` before 16.0, `--gevent-port` from 16.0 — cost if wrong: an alongside run with workers on 15.0 fails to bind.
- **A5.** Stop Server on a database row stops this window's run of that database. A run in another window gets a message, never a stop — spec A5.
- **A6.** Run Alongside from the palette asks which database, listing the project's databases. Its quick pick shows each database's running state — cost if wrong: none.

## File structure

| File | Responsibility |
|---|---|
| `src/services/runRecords.ts` (new) | `RunDetails`, `describeSession()`: a launch configuration → its run details. Pure |
| `src/services/debugSessions.ts` | the session registry now keeps run records; `runRecords()`, `runForDatabase()` |
| `src/services/server.ts` | tracking uses `describeSession`; open-browser uses the run's own port and database |
| `src/services/runningState.ts` | `RunningInstance` from run records (+ `kind`) |
| `src/services/alongside.ts` (new) | name, port pick with reservations, workers/realtime port, arg rewrite, checkout conflicts. Pure |
| `src/debugger.ts` | `prepareArgs` takes a database override; `runAlongside()`; primary start stops an alongside run of the same database |
| `src/services/copyRuntime.ts` | `ownRun` from run records; restart an alongside run as alongside |
| `src/commands/alongsideCommands.ts` (new), `src/commands/index.ts`, `package.json` | Run Alongside, Run Alongside Without Debugging, Stop Server (database row + palette) |
| `src/test/*` | unit tests per task; `alongside.integration.test.ts` gated by `ODT_ALONGSIDE_TEST_PYTHON` + `ODT_ALONGSIDE_TEST_ODOO` |
| `README.md`, `CHANGELOG.md`, `dist/` | last task |

---

### Task 1: Run records and running state from them

**Files:**
- Create: `src/services/runRecords.ts`
- Modify: `src/services/debugSessions.ts`, `src/services/server.ts` (`registerServerLifecycle`, `versionForSession`), `src/services/runningState.ts`
- Test: `src/test/runRecords.test.ts` (new), and update `src/test/debugSessions.test.ts` and `src/test/runningState.test.ts`

**Interfaces:**
- Produces:
  - `interface RunDetails { versionId: string; dbId?: string; port?: number; kind: 'primary' | 'alongside' }` and `interface RunRecord extends RunDetails { name: string }` (in runRecords.ts).
  - `ALONGSIDE_MARKER = 'odooDevtools'`. An alongside configuration carries `odooDevtools: { versionId, dbId, port, kind: 'alongside' }`.
  - `describeSession(config: { name?: unknown; args?: unknown; odooDevtools?: unknown } | undefined, versions: Array<{ id: string; createdAt?: unknown; settings: { debuggerName?: string; portNumber?: number | string } }>, activeVersionId: string | undefined): RunDetails | undefined`
  - `argValue(args: string[], flag: string): string | undefined`, the token after the first occurrence of `flag`.
  - debugSessions.ts:
    - `trackSession(session, details?: RunDetails)`;
    - `runRecords(): RunRecord[]`, live sessions only;
    - `runForDatabase(dbId: string): RunRecord | undefined`;
    - `versionIdOfSession(name)` and `runningDebuggerNames()`, both kept.
  - runningState.ts: `RunningInstance` gains `kind?: 'primary' | 'alongside'`. `instancesFromRuns(records: RunRecord[]): RunningInstance[]` is pure and exported.

- [ ] **Step 1: Write the failing tests** `src/test/runRecords.test.ts`

```ts
import * as assert from 'assert';
import { argValue, describeSession, ALONGSIDE_MARKER } from '../services/runRecords';
import { instancesFromRuns } from '../services/runningState';

const versions = [
    { id: 'v17', createdAt: '2026-01-01', settings: { debuggerName: 'odoo:17.0', portNumber: 8017 } },
    { id: 'v18', createdAt: '2026-02-01', settings: { debuggerName: 'Odoo', portNumber: 8018 } },
    { id: 'v18b', createdAt: '2026-03-01', settings: { debuggerName: 'Odoo', portNumber: 8028 } }
];

suite('Run records', () => {
    test('argValue reads the token after the first flag', () => {
        assert.strictEqual(argValue(['-p', '8017', '-d', 'shop', '-d', 'later'], '-d'), 'shop');
        assert.strictEqual(argValue(['-p'], '-p'), undefined);
        assert.strictEqual(argValue([], '-d'), undefined);
    });

    test('a primary entry is its version, database and port from its own args', () => {
        const details = describeSession(
            { name: 'odoo:17.0', args: ['-p', '8017', '--addons-path', 'x', '-d', 'shop'] },
            versions, 'v18'
        );
        assert.deepStrictEqual(details, { versionId: 'v17', dbId: 'shop', port: 8017, kind: 'primary' });
    });

    test('a shared name belongs to the active version among those sharing it', () => {
        assert.strictEqual(describeSession({ name: 'Odoo', args: ['-d', 'a'] }, versions, 'v18b')?.versionId, 'v18b');
        assert.strictEqual(describeSession({ name: 'Odoo', args: ['-d', 'a'] }, versions, 'v17')?.versionId, 'v18');
    });

    test('a primary entry without -p falls back to its version port', () => {
        assert.strictEqual(describeSession({ name: 'odoo:17.0', args: ['-d', 'shop'] }, versions, undefined)?.port, 8017);
    });

    test('an alongside run is read from its marker, whatever its name', () => {
        const details = describeSession({
            name: 'odoo:17.0 · demo',
            args: ['-p', '8100', '-d', 'demo'],
            [ALONGSIDE_MARKER]: { versionId: 'v17', dbId: 'demo', port: 8100, kind: 'alongside' }
        }, versions, undefined);
        assert.deepStrictEqual(details, { versionId: 'v17', dbId: 'demo', port: 8100, kind: 'alongside' });
    });

    test('an unknown name or a malformed config is not ours', () => {
        assert.strictEqual(describeSession({ name: 'Python: Current File' }, versions, 'v17'), undefined);
        assert.strictEqual(describeSession(undefined, versions, 'v17'), undefined);
        assert.strictEqual(describeSession({ name: 'x', [ALONGSIDE_MARKER]: { dbId: 'no version' } }, versions, 'v17'), undefined);
    });

    test('running instances come from the records, one per database run', () => {
        const instances = instancesFromRuns([
            { name: 'odoo:17.0', versionId: 'v17', dbId: 'shop', port: 8017, kind: 'primary' },
            { name: 'odoo:17.0 · demo', versionId: 'v17', dbId: 'demo', port: 8100, kind: 'alongside' },
            { name: 'stray', versionId: 'v17', kind: 'primary' }
        ]);
        assert.deepStrictEqual(instances.map(i => [i.dbName, i.port, i.kind, i.origin, i.debuggerName]), [
            ['shop', 8017, 'primary', 'managed', 'odoo:17.0'],
            ['demo', 8100, 'alongside', 'managed', 'odoo:17.0 · demo']
        ]);
    });
});
```

Update `src/test/debugSessions.test.ts`: every `trackSession(x, 'v17')` becomes `trackSession(x, { versionId: 'v17', kind: 'primary' })`, and calls with no second argument stay as they are. Add one test:

```ts
    test('records are kept per session and found by database', () => {
        clearSessions();
        trackSession(fakeSession('odoo:17.0'), { versionId: 'v17', dbId: 'shop', port: 8017, kind: 'primary' });
        trackSession(fakeSession('odoo:17.0 · demo'), { versionId: 'v17', dbId: 'demo', port: 8100, kind: 'alongside' });
        assert.strictEqual(runForDatabase('demo')?.name, 'odoo:17.0 · demo');
        assert.strictEqual(runRecords().length, 2);
        untrackSession(fakeSession('odoo:17.0 · demo'));
        assert.strictEqual(runForDatabase('demo'), undefined);
        assert.strictEqual(versionIdOfSession('odoo:17.0'), 'v17');
    });
```

Import `runForDatabase` and `runRecords` in it.

- [ ] **Step 2: Run them to see them fail.** Run `npm run compile-tests`. Expected: TS errors.

- [ ] **Step 3: Implement `src/services/runRecords.ts`**

```ts
/**
 * What a debug session runs: its version, database and port, read from its own
 * launch configuration. A version's primary entry says it in its args (-d,
 * -p); an alongside run (alongside.ts) carries a marker, because its name
 * belongs to no version. Reading the session itself, not the version's current
 * selection, keeps the answer right after the user selects another database.
 * Pure.
 */
import { sessionOwner } from './versionIdentity';

export const ALONGSIDE_MARKER = 'odooDevtools';

export interface RunDetails {
    versionId: string;
    dbId?: string;
    port?: number;
    kind: 'primary' | 'alongside';
}

export interface RunRecord extends RunDetails {
    name: string;
}

export function argValue(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function validPort(value: unknown): number | undefined {
    const port = Number(value);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

export function describeSession(
    config: { name?: unknown; args?: unknown; [ALONGSIDE_MARKER]?: unknown } | undefined,
    versions: Array<{ id: string; createdAt?: unknown; settings: { debuggerName?: string; portNumber?: number | string } }>,
    activeVersionId: string | undefined
): RunDetails | undefined {
    if (!config) {
        return undefined;
    }
    const marker = config[ALONGSIDE_MARKER];
    if (marker && typeof marker === 'object') {
        const m = marker as Record<string, unknown>;
        if (typeof m.versionId !== 'string' || !m.versionId) {
            return undefined;
        }
        return {
            versionId: m.versionId,
            dbId: typeof m.dbId === 'string' && m.dbId ? m.dbId : undefined,
            port: validPort(m.port),
            kind: 'alongside'
        };
    }
    if (typeof config.name !== 'string' || !config.name) {
        return undefined;
    }
    const owner = sessionOwner(versions as never[], config.name, activeVersionId) as typeof versions[number] | undefined;
    if (!owner) {
        return undefined;
    }
    const args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : [];
    return {
        versionId: owner.id,
        dbId: argValue(args, '-d'),
        port: validPort(argValue(args, '-p')) ?? validPort(owner.settings.portNumber),
        kind: 'primary'
    };
}
```

Check `sessionOwner`'s generic constraint (`IdentityCandidate`) in `src/services/versionIdentity.ts`. If `versions` already satisfies it, drop the `as never[]` cast and type the parameter as `IdentityCandidate[]`. Keep whatever compiles without `any`.

- [ ] **Step 4: Rework `src/services/debugSessions.ts`**

Keep the `sessions` map. Replace `sessionVersions` with `runs = new Map<string, RunRecord>()`. Then:
- `trackSession(session, details?)` sets `runs` to `{ name, ...details }` when details are given, and deletes it otherwise.
- `untrackSession` deletes both entries.
- `versionIdOfSession(name)` returns `sessions.has(name) ? runs.get(name)?.versionId : undefined`.
- `runRecords()` returns `[...runs.values()].filter(r => sessions.has(r.name))`.
- `runForDatabase(dbId)` returns `runRecords().find(r => r.dbId === dbId)`.
- `clearSessions` clears both.

Update the file's doc comment: sessions now record what they run.

- [ ] **Step 5: `src/services/server.ts`**

In `registerServerLifecycle`'s `onDidStartDebugSession`:
1. Replace `versionForSession(session)` with `describeSession(session.configuration, service.getVersions(), service.getActiveVersion()?.id)`, after `const service = VersionsService.getInstance(); await service.initialize();` inside a try. If it returns undefined, return.
2. `trackSession(session, details)`.
3. The open-browser branch waits for `details.port ?? DEFAULT_ODOO_PORT`, and opens `buildServerUrl(port, details.dbId ?? await hooks.getSelectedDbName())`.
4. Delete `versionForSession` if nothing else uses it.

- [ ] **Step 6: `src/services/runningState.ts`**

Add `kind?: 'primary' | 'alongside'` to `RunningInstance`. Add:

```ts
/** One instance per recorded run that names its database. */
export function instancesFromRuns(records: RunRecord[]): RunningInstance[] {
    return records
        .filter(record => !!record.dbId)
        .map(record => ({
            versionId: record.versionId,
            debuggerName: record.name,
            dbName: record.dbId as string,
            port: record.port,
            origin: 'managed' as const,
            kind: record.kind
        }));
}
```

Then make `collectManaged()` return `instancesFromRuns(runRecords())`. Remove its SettingsStore/VersionsService/`sessionOwner`/`dbForVersion` code and the imports that are no longer used. Update the module comment.

- [ ] **Step 7: Run the tests to see them pass.** Run `--grep "Run records|Debug sessions|Running state"`. Use the suite names those files declare; check them with `grep -n "^suite(" src/test/debugSessions.test.ts src/test/runningState.test.ts`. Then run the full suite once. Every caller of `versionIdOfSession` and `runningDebuggerNames` must still compile and pass: debugger.ts, upgradeSideCommands.ts, copyRuntime.ts.

- [ ] **Step 8: Lint, then commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist 2>/dev/null; git add src/services/runRecords.ts src/services/debugSessions.ts src/services/server.ts src/services/runningState.ts src/test/runRecords.test.ts src/test/debugSessions.test.ts src/test/runningState.test.ts
git commit -m "[REF] Know what each server runs from its own launch configuration

A session records its version, database and port from its own -d and -p
(or an alongside marker), not from the version's current selection, so
the Databases tree stays right after another database is selected.

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 2: Alongside helpers (pure)

**Files:**
- Create: `src/services/alongside.ts`
- Test: `src/test/alongside.test.ts`

**Interfaces:**
- Consumes: `extraParamValue` from `src/services/odooDataDir.ts` (Task 1 of the checkpoint plan).
- Produces:
  - `ALONGSIDE_FIRST_PORT = 8100`, `ALONGSIDE_LAST_PORT = 8199`
  - `alongsideName(debuggerName: string, dbId: string): string`
  - `pickFreePort(isOpen: (port: number) => Promise<boolean>, taken: Set<number>, first?: number, last?: number): Promise<number>`
  - `reservePort(port: number, ttlMs?: number): () => void` and `reservedPorts(): Set<number>`. A module-level reservation set; the returned function releases it.
  - `workersOf(extraParams: string): number`
  - `realtimePortFlag(odooVersion: string | undefined): '--gevent-port' | '--longpolling-port'`
  - `alongsideArgs(baseArgs: string[], port: number, realtime?: { flag: string; port: number }): string[]`
  - `interface CheckoutConflict { repo: string; path: string; current: string; needed: string; mode: 'checkout' | 'worktree' }`
  - `checkoutConflicts(resolved: Array<{ repo: { name: string }; path: string; branch?: string; mode: string; isWorktree: boolean }>, currentBranches: Map<string, string | null>): CheckoutConflict[]`

- [ ] **Step 1: Write the failing test** `src/test/alongside.test.ts`

```ts
import * as assert from 'assert';
import {
    alongsideArgs, alongsideName, checkoutConflicts, pickFreePort, realtimePortFlag, reservePort, reservedPorts, workersOf
} from '../services/alongside';

suite('Alongside helpers', () => {
    test('the name is the debugger name and the database', () => {
        assert.strictEqual(alongsideName('odoo:17.0', 'demo'), 'odoo:17.0 · demo');
    });

    test('the first port from 8100 that is neither open nor taken', async () => {
        const open = new Set([8100, 8102]);
        const port = await pickFreePort(async p => open.has(p), new Set([8101]));
        assert.strictEqual(port, 8103);
    });

    test('no free port in the range is an error that says so', async () => {
        await assert.rejects(pickFreePort(async () => true, new Set(), 8100, 8102), /8100.*8102/);
    });

    test('a reserved port is taken until released', () => {
        const release = reservePort(8105, 60000);
        assert.ok(reservedPorts().has(8105));
        release();
        assert.ok(!reservedPorts().has(8105));
    });

    test('a reservation expires on its own', async () => {
        reservePort(8106, 10);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.ok(!reservedPorts().has(8106));
    });

    test('workers from the extra params', () => {
        assert.strictEqual(workersOf('--log-handler,odoo:WARNING'), 0);
        assert.strictEqual(workersOf('--workers=4'), 4);
        assert.strictEqual(workersOf('--workers,2'), 2);
        assert.strictEqual(workersOf('--workers 3'), 3);
        assert.strictEqual(workersOf('--workers=junk'), 0);
    });

    test('the realtime port flag follows the series', () => {
        assert.strictEqual(realtimePortFlag('15.0'), '--longpolling-port');
        assert.strictEqual(realtimePortFlag('16.0'), '--gevent-port');
        assert.strictEqual(realtimePortFlag('saas-17.4'), '--gevent-port');
        assert.strictEqual(realtimePortFlag('master'), '--gevent-port');
        assert.strictEqual(realtimePortFlag(undefined), '--gevent-port');
    });

    test('the args listen on the alongside port, and nothing in them overrides it', () => {
        const base = ['-p', '8017', '--addons-path', 'a,b', '-d', 'demo', '--http-port=9000', '--gevent-port', '8072', '--dev=all'];
        assert.deepStrictEqual(alongsideArgs(base, 8100), ['-p', '8100', '--addons-path', 'a,b', '-d', 'demo', '--dev=all']);
        assert.deepStrictEqual(
            alongsideArgs(['-d', 'demo'], 8101, { flag: '--gevent-port', port: 8102 }),
            ['-p', '8101', '-d', 'demo', '--gevent-port', '8102']
        );
        assert.deepStrictEqual(alongsideArgs(['-p', '8017', '-p', '9999', '-d', 'x'], 8100), ['-p', '8100', '-d', 'x'], 'a second -p from extra params goes');
        assert.ok(!alongsideArgs(['--longpolling-port=8072', '-d', 'x'], 8100).some(a => a.includes('8072')));
    });

    test('a single checkout on another branch is a conflict; a copy per branch is not', () => {
        const resolved = [
            { repo: { name: 'acme' }, path: '/r/acme', branch: '17.0-fix', mode: 'checkout', isWorktree: false },
            { repo: { name: 'tools' }, path: '/r/tools', branch: '17.0', mode: 'checkout', isWorktree: false },
            { repo: { name: 'wt' }, path: '/root/wt@feature', branch: 'feature', mode: 'worktree', isWorktree: true },
            { repo: { name: 'fallback' }, path: '/r/fallback', branch: 'other', mode: 'worktree', isWorktree: false },
            { repo: { name: 'nobranch' }, path: '/r/nobranch', mode: 'checkout', isWorktree: false }
        ];
        const current = new Map<string, string | null>([
            ['/r/acme', '17.0'], ['/r/tools', '17.0'], ['/root/wt@feature', 'feature'], ['/r/fallback', 'main'], ['/r/nobranch', 'x']
        ]);
        assert.deepStrictEqual(checkoutConflicts(resolved, current), [
            { repo: 'acme', path: '/r/acme', current: '17.0', needed: '17.0-fix', mode: 'checkout' },
            { repo: 'fallback', path: '/r/fallback', current: 'main', needed: 'other', mode: 'worktree' }
        ]);
    });

    test('an unreadable current branch is not reported as a conflict', () => {
        const resolved = [{ repo: { name: 'acme' }, path: '/r/acme', branch: 'x', mode: 'checkout', isWorktree: false }];
        assert.deepStrictEqual(checkoutConflicts(resolved, new Map([['/r/acme', null]])), []);
    });
});
```

- [ ] **Step 2: Run to see it fail.** Run `npm run compile-tests`.

- [ ] **Step 3: Implement `src/services/alongside.ts`**

```ts
/**
 * Running a database next to whatever already runs: its name, its port and
 * the args that make it listen there. Pure; debugger.ts runs it. An alongside
 * run is never written to launch.json - F5 stays one entry per version.
 */
import { extraParamValue } from './odooDataDir';

export const ALONGSIDE_FIRST_PORT = 8100;
export const ALONGSIDE_LAST_PORT = 8199;

export function alongsideName(debuggerName: string, dbId: string): string {
    return `${debuggerName} · ${dbId}`;
}

const reservations = new Map<number, ReturnType<typeof setTimeout>>();

/** Holds a port for a start that has not been recorded yet. */
export function reservePort(port: number, ttlMs = 30000): () => void {
    const release = () => {
        const timer = reservations.get(port);
        if (timer) {
            clearTimeout(timer);
        }
        reservations.delete(port);
    };
    release();
    reservations.set(port, setTimeout(release, ttlMs));
    return release;
}

export function reservedPorts(): Set<number> {
    return new Set(reservations.keys());
}

export async function pickFreePort(
    isOpen: (port: number) => Promise<boolean>,
    taken: Set<number>,
    first = ALONGSIDE_FIRST_PORT,
    last = ALONGSIDE_LAST_PORT
): Promise<number> {
    for (let port = first; port <= last; port++) {
        if (taken.has(port)) {
            continue;
        }
        if (!await isOpen(port)) {
            return port;
        }
    }
    throw new Error(`No free port between ${first} and ${last}.`);
}

export function workersOf(extraParams: string): number {
    const tokens = extraParams.split(',').map(token => token.trim()).filter(Boolean);
    // --workers has no short form; pass it as both so extraParamValue's
    // short-option branch matches nothing else.
    const value = extraParamValue(tokens, '--workers', '--workers');
    const workers = Number.parseInt(value ?? '', 10);
    return Number.isFinite(workers) && workers > 0 ? workers : 0;
}

export function realtimePortFlag(odooVersion: string | undefined): '--gevent-port' | '--longpolling-port' {
    const match = /(\d+)\.\d+/.exec(odooVersion ?? '');
    const major = match ? Number(match[1]) : undefined;
    return major !== undefined && major < 16 ? '--longpolling-port' : '--gevent-port';
}

const PORT_FLAGS = ['-p', '--http-port', '--xmlrpc-port', '--gevent-port', '--longpolling-port'];

/** `baseArgs` without any port of their own, listening on `port`. */
export function alongsideArgs(baseArgs: string[], port: number, realtime?: { flag: string; port: number }): string[] {
    const out: string[] = [];
    for (let i = 0; i < baseArgs.length; i++) {
        const arg = baseArgs[i];
        if (PORT_FLAGS.includes(arg)) {
            i++;
            continue;
        }
        if (PORT_FLAGS.some(flag => flag.startsWith('--') && arg.startsWith(`${flag}=`))) {
            continue;
        }
        out.push(arg);
    }
    const args = ['-p', String(port), ...out];
    if (realtime) {
        args.push(realtime.flag, String(realtime.port));
    }
    return args;
}

export interface CheckoutConflict {
    repo: string;
    path: string;
    current: string;
    needed: string;
    mode: 'checkout' | 'worktree';
}

/**
 * Repositories this database would run from a shared checkout that is on
 * another branch. Run Alongside never switches a branch under servers that
 * are running, so each of these refuses it.
 */
export function checkoutConflicts(
    resolved: Array<{ repo: { name: string }; path: string; branch?: string; mode: string; isWorktree: boolean }>,
    currentBranches: Map<string, string | null>
): CheckoutConflict[] {
    const conflicts: CheckoutConflict[] = [];
    for (const entry of resolved) {
        if (entry.isWorktree || !entry.branch) {
            continue;
        }
        const current = currentBranches.get(entry.path);
        if (current && current !== entry.branch) {
            conflicts.push({
                repo: entry.repo.name,
                path: entry.path,
                current,
                needed: entry.branch,
                mode: entry.mode === 'worktree' ? 'worktree' : 'checkout'
            });
        }
    }
    return conflicts;
}
```

Note: `alongsideArgs` always places `-p` first, so the order in the test (`'-p', '8100', '--addons-path', …`) holds.

- [ ] **Step 4: Run to see it pass.** Run `--grep "Alongside helpers"`.

- [ ] **Step 5: Lint, then commit**

```bash
npx tsc -p . --noEmit && npm run lint
git add src/services/alongside.ts src/test/alongside.test.ts
git commit -m "[ADD] Name, port and args for a server run alongside the others

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 3: Run Alongside, and the primary and checkpoints living with it

**Files:**
- Modify: `src/debugger.ts`:
  - `prepareArgs` gets a database override;
  - new export `runAlongside`;
  - `startServerForVersion` stops an alongside run of the database it is about to start.
- Modify: `src/services/copyRuntime.ts`: `ownRun` reads run records, and `start` restarts an alongside run as alongside.
- Modify: `src/services/connectionRelease.ts`: `ManagedRun.kind`.
- Test: `src/test/connectionRelease.test.ts` (fixture update only).

**Interfaces:**
- Consumes:
  - Task 1: `runRecords`, `runForDatabase`, `ALONGSIDE_MARKER`, `RunDetails`.
  - Task 2: `alongsideName`, `pickFreePort`, `reservePort`, `reservedPorts`, `workersOf`, `realtimePortFlag`, `alongsideArgs`, `checkoutConflicts`.
  - Existing: `getRepoBranch` (src/services/branches.ts), `ensureCustomWorktrees`, `resolveReposForDatabase`, `readSetupState`, `isPortOpen`, `buildServerUrl`.
- Produces:
  - `runAlongside(dbId: string, options?: { noDebug?: boolean; quiet?: boolean }): Promise<{ ok: boolean; message?: string; port?: number }>`
  - `prepareArgs(project, settings, options: { isShell?: boolean; versionId?: string; db?: DatabaseModel })`
  - `ManagedRun` gains `kind: 'primary' | 'alongside'`.

- [ ] **Step 1: `prepareArgs` database override.** Change `const db = dbForVersion(project, options.versionId);` to `const db = options.db ?? dbForVersion(project, options.versionId);` and add `db?: DatabaseModel` to its options type. Nothing else changes, so the existing callers behave identically.

- [ ] **Step 2: `runAlongside` in src/debugger.ts.** Export it next to `startServerForVersion`, and import the Task 1/2 names.

```ts
/**
 * Runs `dbId` next to whatever already runs: its own version's code, on the
 * first free port from 8100, never written to launch.json (alongside.ts). A
 * database already running in this window is not started twice.
 */
export async function runAlongside(
    dbId: string,
    options: { noDebug?: boolean; quiet?: boolean } = {}
): Promise<{ ok: boolean; message?: string; port?: number }> {
    const fail = (message: string, ...actions: string[]): { ok: false; message: string } => {
        if (!options.quiet) {
            void showError(message, ...actions).then(choice => handleAlongsideAction(choice, dbId));
        }
        return { ok: false, message };
    };

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspacePath = workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolders || !workspacePath) {
        return fail('Open a workspace to use this command.');
    }
    const result = await SettingsStore.getSelectedProject();
    const db = (result?.project.dbs as DatabaseModel[] | undefined)?.find(entry => entry.id === dbId);
    if (!result || !db) {
        return fail(`"${dbId}" is not a database of the selected project.`);
    }
    const project = result.project;

    const existing = runForDatabase(db.id);
    if (existing) {
        const where = existing.port ? ` on port ${existing.port}` : '';
        if (!options.quiet) {
            void showInfo(`"${db.id}" is already running in this window${where}.`, 'Open in Browser').then(choice => {
                if (choice === 'Open in Browser' && existing.port) {
                    void vscode.env.openExternal(buildServerUrl(existing.port, db.id));
                }
            });
        }
        return { ok: true, port: existing.port };
    }

    const versionsService = VersionsService.getInstance();
    await versionsService.initialize();
    const version = db.versionId ? versionsService.getVersion(db.versionId) : undefined;
    if (!version) {
        return fail(`"${db.id}" has no version to run it with.`, 'Change Version');
    }
    const settings = new SettingsModel(version.settings);
    if (!isVersionProvisioned(resolveOptionalPath(settings.pythonPath))) {
        return fail(`"${version.name}" has no environment to run.`, 'Provision');
    }

    // The database's own branches, in their own copies where there are any.
    const setupRoot = readSetupState().provisioningRoot;
    const resolved = await resolveReposForDatabase(project, db, { version, root: setupRoot });
    await ensureCustomWorktrees(resolved, undefined, { interactive: false });
    const after = await resolveReposForDatabase(project, db, { version, root: setupRoot });
    const current = new Map<string, string | null>();
    for (const entry of after) {
        current.set(entry.path, await getRepoBranch(entry.path));
    }
    const conflicts = checkoutConflicts(after, current);
    if (conflicts.length > 0) {
        const first = conflicts[0];
        const list = conflicts.map(c => `"${c.repo}" is on ${c.current}, and "${db.id}" needs ${c.needed}`).join('; ');
        pendingConflictRepo.set(dbId, first.path);
        return fail(
            `Cannot run "${db.id}" alongside: ${list}. Running servers share that checkout, so it is not switched.`,
            first.mode === 'checkout' ? 'Use One Copy Per Branch' : 'Resolve'
        );
    }

    let baseArgs: string[];
    try {
        baseArgs = await prepareArgs(project, settings, { versionId: version.id, db });
    } catch (error) {
        return fail(`Could not prepare "${db.id}": ${errorMessage(error)}`);
    }

    const taken = new Set<number>([
        ...versionsService.getVersions().flatMap(v => [Number(v.settings.portNumber), Number(v.settings.shellPortNumber)]),
        ...runRecords().map(r => r.port ?? 0),
        ...reservedPorts()
    ].filter(port => port > 0));
    let port: number;
    let realtime: { flag: string; port: number } | undefined;
    try {
        port = await pickFreePort(isPortOpen, taken);
        if (workersOf(settings.extraParams) > 0) {
            realtime = { flag: realtimePortFlag(version.odooVersion), port: await pickFreePort(isPortOpen, new Set([...taken, port])) };
        }
    } catch (error) {
        return fail(errorMessage(error));
    }
    const releases = [reservePort(port), ...(realtime ? [reservePort(realtime.port)] : [])];

    const name = alongsideName(settings.debuggerName, db.id);
    const config: vscode.DebugConfiguration = {
        name,
        type: 'debugpy',
        request: 'launch',
        cwd: runDirectory(workspacePath),
        program: `${normalizePath(settings.odooPath)}/odoo-bin`,
        python: normalizePath(settings.pythonPath),
        console: 'integratedTerminal',
        args: alongsideArgs(baseArgs, port, realtime),
        [ALONGSIDE_MARKER]: { versionId: version.id, dbId: db.id, port, kind: 'alongside' } satisfies RunDetails
    };
    const started = await vscode.debug.startDebugging(workspaceFolders[0], config, { noDebug: options.noDebug === true });
    if (!started) {
        releases.forEach(release => release());
        return fail(`Could not start "${name}".`);
    }
    // The session is recorded on start (server.ts); the reservation can go.
    releases.forEach(release => release());
    return { ok: true, port };
}

/** The repository a refused Run Alongside named, for its button. */
const pendingConflictRepo = new Map<string, string>();

async function handleAlongsideAction(choice: string | undefined, dbId: string): Promise<void> {
    if (choice === 'Use One Copy Per Branch') {
        const repoPath = pendingConflictRepo.get(dbId);
        if (repoPath) {
            await vscode.commands.executeCommand('odt.repo.toggleBranchMode', vscode.Uri.file(repoPath));
        }
    } else if (choice === 'Resolve') {
        await vscode.commands.executeCommand('odt.repo.resolveWorktrees');
    } else if (choice === 'Provision' || choice === 'Change Version') {
        const result = await SettingsStore.getSelectedProject();
        const db = (result?.project.dbs as DatabaseModel[] | undefined)?.find(entry => entry.id === dbId);
        if (choice === 'Provision' && db?.versionId) {
            await provisionExistingVersion(db.versionId);
        } else if (choice === 'Change Version' && db) {
            await vscode.commands.executeCommand('dbSelector.changeVersion', db);
        }
    }
}
```

Adapt it to the real code:
- `showInfo`, `showError`, `normalizePath`, `resolveOptionalPath`, `isVersionProvisioned`, `provisionExistingVersion`, `ensureCustomWorktrees`, `resolveReposForDatabase`, `readSetupState`, `isPortOpen` and `buildServerUrl` are already imported in debugger.ts. Add only what is missing: `getRepoBranch` and the Task 1/2 imports.
- `showError` may resolve the chosen button; check its signature in src/services/notifications.ts or src/utils.ts, whichever debugger.ts uses.
- Check whether `dbSelector.changeVersion` takes a database object: `extractDatabaseFromEvent` accepts one.
- If `satisfies` is not supported by the repo's TypeScript version, drop it.

- [ ] **Step 3: The primary stops an alongside run of its database.** In `startServerForVersion`, right after `db` is resolved (before the launch target lookup), add:

```ts
    // F5 runs the current database. An alongside run of it in this window
    // would otherwise share its database with the primary.
    const alongside = runForDatabase(db.id);
    if (alongside?.kind === 'alongside') {
        const session = getSessionByName(alongside.name);
        if (session) {
            await vscode.debug.stopDebugging(session);
        }
    }
```

- [ ] **Step 4: Checkpoints release an alongside run correctly**

1. In `src/services/connectionRelease.ts`, add `kind: 'primary' | 'alongside'` to `ManagedRun`. In `src/test/connectionRelease.test.ts`, add `kind: 'primary'` to the `RUN` fixture.
2. In `src/services/copyRuntime.ts`, `realReleaseHost().ownRun(db)`: replace the session-args scan with the run records:

```ts
        ownRun: async db => {
            const record = runForDatabase(db);
            if (!record) {
                return undefined;
            }
            const session = getSessionByName(record.name);
            return {
                versionId: record.versionId,
                debuggerName: record.name,
                noDebug: session?.configuration?.noDebug === true,
                dbName: db,
                kind: record.kind
            };
        },
```

3. In `start(run)`, when `run.kind === 'alongside'`, call `runAlongside(run.dbName, { noDebug: run.noDebug, quiet: true })` (lazy `await import('../debugger')` if that is how copyRuntime already imports debugger.ts). If the result is not ok, throw its message. Keep the existing primary path, including its "version now runs another database" check.

- [ ] **Step 5: Compile and run the affected suites.** Run tsc, then `--grep "Releasing a database|Run records|Alongside helpers"`, then the full suite once.

- [ ] **Step 6: Commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist 2>/dev/null; git add src/debugger.ts src/services/copyRuntime.ts src/services/connectionRelease.ts src/test/connectionRelease.test.ts
git commit -m "[ADD] Run a database alongside the servers already running

Its own version's code on the first free port from 8100, passed to
startDebugging and never written to launch.json. A single checkout on
another branch refuses it with the repository and branches named.
Checkpoints restart an alongside run alongside.

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 4: Commands and menus

**Files:**
- Create: `src/commands/alongsideCommands.ts`
- Modify: `src/commands/index.ts`, `package.json`, `src/test/upgradeGuards.test.ts`
- Test: `src/test/alongsideMenus.test.ts`

**Interfaces:**
- Consumes:
  - `runAlongside` (Task 3);
  - `runForDatabase` (Task 1);
  - `getRunningInstances`, `runningDescriptionPart` (runningState.ts);
  - `extractDatabaseFromEvent` (dbs.ts);
  - `getDatabaseLabel` (utils).
- Produces: the commands `dbSelector.runAlongside`, `dbSelector.runAlongsideNoDebug` and `dbSelector.stopServer`.

- [ ] **Step 1: Write the failing menu test** `src/test/alongsideMenus.test.ts`

```ts
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface MenuEntry { command: string; when?: string; group?: string }
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
const itemMenus = manifest.contributes.menus['view/item/context'] as MenuEntry[];
const commands = (manifest.contributes.commands as Array<{ command: string; title: string }>);

suite('Alongside menus', () => {
    const ids = ['dbSelector.runAlongside', 'dbSelector.runAlongsideNoDebug', 'dbSelector.stopServer'];

    test('contributed, with the titles the spec names', () => {
        const titles = new Map(commands.map(c => [c.command, c.title]));
        assert.strictEqual(titles.get('dbSelector.runAlongside'), 'Run Alongside');
        assert.strictEqual(titles.get('dbSelector.runAlongsideNoDebug'), 'Run Alongside Without Debugging');
        assert.strictEqual(titles.get('dbSelector.stopServer'), 'Stop Server');
    });

    test('on database rows, in the run group, never inline, never hidden by upgrade mode', () => {
        for (const id of ids) {
            const entries = itemMenus.filter(entry => entry.command === id);
            assert.ok(entries.length > 0, `${id} has no row menu entry`);
            for (const entry of entries) {
                assert.ok(/viewItem == database\b/.test(entry.when ?? ''), entry.when);
                assert.ok(!(entry.when ?? '').includes('upgrade_enabled'), entry.when);
                assert.ok(entry.group?.startsWith('2_run'), entry.group);
            }
        }
    });
});
```

- [ ] **Step 2: Run to see it fail.** Run `--grep "Alongside menus"`.

- [ ] **Step 3: package.json.** Add to `contributes.commands`, next to `dbSelector.createCheckpoint`:

```json
      {
        "command": "dbSelector.runAlongside",
        "title": "Run Alongside",
        "category": "Odoo DevTools"
      },
      {
        "command": "dbSelector.runAlongsideNoDebug",
        "title": "Run Alongside Without Debugging",
        "category": "Odoo DevTools"
      },
      {
        "command": "dbSelector.stopServer",
        "title": "Stop Server",
        "category": "Odoo DevTools"
      },
```

Add to `menus.view/item/context`, next to the `dbSelector.openInBrowser` entry:

```json
        { "command": "dbSelector.runAlongside", "when": "view == dbSelector && viewItem == database", "group": "2_run@1" },
        { "command": "dbSelector.runAlongsideNoDebug", "when": "view == dbSelector && viewItem == database", "group": "2_run@2" },
        { "command": "dbSelector.stopServer", "when": "view == dbSelector && viewItem == database", "group": "2_run@3" },
```

Format them like the surrounding entries, one key per line. All three stay in the palette. Add the three ids to `MUST_STAY` in `src/test/upgradeGuards.test.ts`.

- [ ] **Step 4: `src/commands/alongsideCommands.ts`**

```ts
/**
 * Several servers at once: run a database next to the others, and stop one
 * database's server. See services/alongside.ts.
 */
import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { registerCommand } from './registerCommand';
import { SettingsStore } from '../settingsStore';
import type { DatabaseModel } from '../models/db';
import { extractDatabaseFromEvent } from '../dbs';
import { getDatabaseLabel } from '../utils';
import { runAlongside } from '../debugger';
import { runForDatabase, getSessionByName } from '../services/debugSessions';
import { getRunningInstances, runningDescriptionPart } from '../services/runningState';
import { showInfo } from '../services/notifications';

/** The row's database, or one picked from the project's when run from the palette. */
async function databaseFor(event: unknown, title: string): Promise<DatabaseModel | undefined> {
    const fromRow = extractDatabaseFromEvent(event);
    if (fromRow) {
        return fromRow;
    }
    const result = await SettingsStore.getSelectedProject();
    const dbs = (result?.project.dbs as DatabaseModel[] | undefined) ?? [];
    if (dbs.length === 0) {
        return undefined;
    }
    const running = new Map((await getRunningInstances()).map(instance => [instance.dbName, instance]));
    const picked = await vscode.window.showQuickPick(
        dbs.map(db => ({ label: getDatabaseLabel(db), description: runningDescriptionPart(running.get(db.id)) ?? '', db })),
        { title, placeHolder: 'Which database?' }
    );
    return picked?.db;
}

export function registerAlongsideCommands(deps: CommandDeps): void {
    const { context, refreshAll } = deps;

    for (const [id, noDebug] of [['dbSelector.runAlongside', false], ['dbSelector.runAlongsideNoDebug', true]] as const) {
        context.subscriptions.push(registerCommand(id, async (event?: unknown) => {
            const db = await databaseFor(event, noDebug ? 'Run Alongside Without Debugging' : 'Run Alongside');
            if (!db) {
                return;
            }
            await runAlongside(db.id, { noDebug });
            await refreshAll({ reason: 'ui', debounceMs: 1500 });
        }));
    }

    context.subscriptions.push(registerCommand('dbSelector.stopServer', async (event?: unknown) => {
        const db = await databaseFor(event, 'Stop Server');
        if (!db) {
            return;
        }
        const run = runForDatabase(db.id);
        const session = run ? getSessionByName(run.name) : undefined;
        if (session) {
            await vscode.debug.stopDebugging(session);
            await refreshAll({ reason: 'ui', debounceMs: 1000 });
            return;
        }
        const external = (await getRunningInstances()).find(instance => instance.dbName === db.id);
        void showInfo(external
            ? `"${getDatabaseLabel(db)}" is running outside this window. Stop it there.`
            : `"${getDatabaseLabel(db)}" is not running.`);
    }));
}
```

Check that `refreshAll` accepts `debounceMs` (CommandDeps declares it). Register `registerAlongsideCommands(deps)` in `src/commands/index.ts` after `registerCheckpointCommands`.

- [ ] **Step 5: Run the tests.** Run `--grep "Alongside menus|What upgrade mode hides|Extension Test Suite"`, then the full suite once.

- [ ] **Step 6: Commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist 2>/dev/null; git add src/commands/alongsideCommands.ts src/commands/index.ts package.json src/test/alongsideMenus.test.ts src/test/upgradeGuards.test.ts
git commit -m "[ADD] Run Alongside and Stop Server on a database's row

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 5: Gated real-Odoo test: two databases of one version at once

**Files:**
- Create: `src/test/alongside.integration.test.ts`

The suite is skipped unless both `ODT_ALONGSIDE_TEST_PYTHON` (a venv python for that Odoo) and `ODT_ALONGSIDE_TEST_ODOO` (an Odoo checkout) are set. `ODT_ALONGSIDE_TEST_DB` may name a database with base installed. Without it, the test creates `odt_al_<run>_a` with `-i base --stop-after-init` (about a minute). It then copies that database to `_b` with the checkpoint plan's `copyDatabase` (`realCopyBackend()`, no filestore root). Every database it creates is named `odt_al_<run>…` and dropped afterwards, matched only by this run's prefix with LIKE's `_` and `%` escaped.

- [ ] **Step 1: Write the test.** It must:
  1. Build the base args `['--addons-path', '<odoo>/odoo/addons,<odoo>/addons', '-d', <db>, '--max-cron-threads', '0']`.
  2. Pick port A with `pickFreePort(isPortOpen, new Set())`, then spawn `<python> <odoo>/odoo-bin ...alongsideArgs(base(a), A)` and wait up to 120 s for `waitForPort(A)`.
  3. Pick port B with `pickFreePort(isPortOpen, new Set())` again. It must differ from A, because A is now open. Spawn the second server and wait for it.
  4. GET `http://127.0.0.1:<port>/web/login?db=<db>` on both and expect status 200. Each response names its own database: the login page for that db.
  5. Kill server A (SIGTERM, then SIGKILL after 10 s). Check that A's port closes and that B still answers 200.
  6. In `suiteTeardown`, kill both servers and drop the databases.

  Use `node:http` for the GET, as `viewWorker.integration.test.ts` does. Spawn with `stdio: 'ignore'` and `env: { ...process.env, PGAPPNAME: 'odt-alongside-test' }`.

- [ ] **Step 2: Run it for real**, outside the sandbox:

```
npm run compile-tests && ODT_ALONGSIDE_TEST_PYTHON=/home/odoo/odoo-dev/venv-17.0/bin/python ODT_ALONGSIDE_TEST_ODOO=/home/odoo/odoo-dev/odoo-17.0 env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Alongside on a real Odoo"
```

Expected: all tests passing. Afterwards, `psql -d postgres -tAc "SELECT datname FROM pg_database WHERE datname LIKE 'odt\_al\_%'"` returns nothing. Without the env vars, the suite is pending.

- [ ] **Step 3: Commit**

```bash
git add src/test/alongside.integration.test.ts
git commit -m "[ADD] Test two databases of one version running at once on a real Odoo

Co-Authored-By: <your model> <noreply@anthropic.com>"
```

---

### Task 6: Docs, the full suite, and the build

**Files:** `README.md`, `CHANGELOG.md`, `dist/`

- [ ] **Step 1: README.** In `### Databases`, after the "Running databases are marked" bullet, add:

```markdown
- **Run several databases at once.** Right-click a database → **Run Alongside** (or **Run Alongside Without Debugging**) starts its server next to whatever already runs, with that database's own version and branches, on the first free port from 8100. It does not touch launch.json: F5 still runs each version's selected database. **Stop Server** on a database's row stops that database's server. A database whose repository is a single checkout on another branch is not started — switching the branch would break the servers already running — and you are offered one copy per branch for that repository instead.
```

In the "Running databases are marked" bullet, after "`running :8017` for a server this extension started", add ", on whichever port it runs".

- [ ] **Step 2: CHANGELOG.** Under `[Unreleased]` → `### Added`:

```markdown
- **Run several databases at once.** Run Alongside, on a database's row, starts its server next to the ones already running — another database of the same version, or of another version — on the first free port from 8100, without writing to launch.json. Stop Server on a row stops that database's server. The Databases view now knows which database each server runs from the server itself, so it stays right after you select another database.
```

- [ ] **Step 3: Verify.** Run tsc and lint, the full suite (0 failing), the gated real-Odoo test from Task 5, and the checkpoints real-PostgreSQL suite (`ODT_PG_TEST=1 …`; it must still pass 4). Then `npm run compile`.

- [ ] **Step 4: Commit.** `git add README.md CHANGELOG.md dist` with the message `[DOC] Describe running several databases at once; rebuild`, ending with your model's trailer.

## After the tasks (controller)

1. Run the final whole-branch review on the most capable model over this plan's range.
2. Run the live window check under Xvfb with the `/tmp/claude/odt6` fixture. Its stub `odoo-bin` must also **listen on its `-p` port**, so the port probe sees it. Use two databases of 17.0 and one of 18.0 (a second fake tree), and check:
   - a. F5 on X; Run Alongside on Y (same version) gives "running :8100"; Run Alongside on Z (18.0) gives ":8101". Three stub processes, each with its own `-p` and `-d`.
   - b. Select Y. The tree still says X runs on 8017 and Y on 8100.
   - c. Run Alongside on X says "already running in this window on port 8017".
   - d. Stop Server on Y's row stops only Y.
   - e. A checkpoint of Z stops Z and restarts it as an alongside run, on a 81xx port, not 8018.
   - f. A repo in checkout mode with Y mapped to another branch: Run Alongside refuses and names both branches, and the button opens the mode change.
   - g. Restarting X with F5 while X also runs alongside stops the alongside run.
3. Drop every database you made.
