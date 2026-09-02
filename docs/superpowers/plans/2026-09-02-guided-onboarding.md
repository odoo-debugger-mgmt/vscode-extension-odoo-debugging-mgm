# Guided Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the path from a cold install to a configured upgrade workbench: setup offers the versions to build, a resumable queue builds them, one command configures an upgrade, and the dead ends along the way become offers.

**Architecture:** Two new pure modules carry the logic — `versionProposal` (which versions to offer, derived from the user's repo branches and the source repo's real branch list) and `provisionQueue` (a persisted state machine that builds one version at a time). Setup gains a multi-select fed by the first and a custom-addons row; the existing `provisionAndCreateVersion` gains a silent mode so the queue can drive it. `diagnoseVersion` learns a fourth health for the case its current wording gets wrong. A new `upgradePlan` module maps "upgrade repo X from A to B" onto the versions, repo modes and branch assignments that already exist.

**Tech Stack:** TypeScript, VS Code extension API (`QuickPick` with `canPickMany`, `globalState`, TreeDataProvider, `ConfigurationTarget`), Mocha `suite`/`test` with node `assert` under `@vscode/test-cli`, `git worktree`.

**Spec:** `docs/superpowers/specs/2026-09-02-guided-onboarding-design.md`

## Global Constraints

These hold for every task; they are the invariants the codebase already maintains.

- **Never spawn a shell.** All process execution goes through `runCommand`/`tryRunCommand` in `src/services/process.ts`, or `execFile` with an argument array. No `exec`, no string interpolation into a command line.
- **All user-facing messages go through `src/services/notifications.ts`** (`showInfo`, `showWarning`, `showError`, `showModalWarning`) and all logging through `src/services/logger.ts` (`logger.debug/info/warn/error`, `errorMessage`). Never call `vscode.window.show*Message` directly.
- **Pure logic is separated from I/O and tested.** Proposal, queue transitions, diagnosis and planning take plain data and return plain data; `vscode` and `fs` live in thin wrappers. Follow `src/services/pythonToolchain.ts` (pure `rankInterpreters`, impure `discoverInterpreters`).
- **Never resolve an unset path with `normalizePath`.** `normalizePath('')` yields the workspace root, which exists. Use `resolveOptionalPath` from `src/utils.ts`, which returns `undefined` for a blank path.
- **Settings that describe the machine are written at `ConfigurationTarget.Global`**, so one setup covers every workspace. A workspace that already overrides a key keeps its override.
- **`checkout` is the default repo branch mode.** A repo that has not opted in must resolve to `repo.path` and behave exactly as it does today.
- **Custom-repo worktrees check out the real branch, never `odt/<branch>`.** The `odt/` alias is correct for Odoo core, where nobody commits.
- **The source checkout is never modified without explicit confirmation.** Never detach silently, never stash on the user's behalf.
- **Destructive actions never sit on inline hover icons** — right-click menu only, with confirmation.
- **Any automated behaviour must be silenceable**, via a `globalState` dismissal flag or a setting.
- **Verification gate for every task:** `npm run compile-tests` (grep the output for `error TS` — a stale `out/` lets tests pass against old code), `npm run lint`, `npm run compile`, `npm test`. All four clean before committing. The suite is at **187 passing** at the start of this plan.
- **Commit style:** `[ADD]`, `[FIX]`, `[IMP]`, `[REF]`, `[DOC]` prefix followed by an imperative sentence, matching `git log`.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/services/versionProposal.ts` | Pure: which version branches to offer, and why |
| `src/services/provisionQueue.ts` | Queue state transitions (pure) plus its `globalState` persistence |
| `src/services/upgradePlan.ts` | Pure: maps an upgrade intent onto versions, repo modes and branch assignments |
| `src/commands/versionPick.ts` | The multi-select UI over `VersionCandidate[]` |
| `src/commands/upgradeCommand.ts` | The `odoo.setUpUpgrade` command |
| `src/test/versionProposal.test.ts`, `provisionQueue.test.ts`, `upgradePlan.test.ts`, `customAddonsDetection.test.ts` | Unit tests for the above |

**Modified:** `src/services/setupDetection.ts` (custom-addons detection), `src/services/setupFlow.ts` and `src/services/setupState.ts` (the custom-addons row), `src/services/versionMigration.ts` (the `source-repo` health), `src/odooInstaller.ts` (silent provisioning, clone defaults, `BRANCH_OPTIONS` removal), `src/commands/projectCommands.ts` (setup hand-off), `src/commands/versionCommands.ts` (branch-pick source), `src/versionsTreeProvider.ts` (queue states), `src/extension.ts` (queue drain, migration offer), `src/settingsStore.ts` (silent read), `src/module.ts` (testing guard), `src/debugger.ts` (start preconditions), `src/project.ts` (repo picker), `package.json`, `README.md`, `CHANGELOG.md`.

---

### Task 1: Version proposal

The pure function that decides which branches setup offers. Nothing reads it yet; it exists first so the picker in Task 4 and the upgrade command in Task 8 share one source of candidates.

**Files:**
- Create: `src/services/versionProposal.ts`
- Test: `src/test/versionProposal.test.ts`

**Interfaces:**
- Consumes: `parseOdooSeries` from `src/services/database.ts`.
- Produces:
  - `interface RepoBranch { repoName: string; branch: string }`
  - `interface VersionCandidate { branch: string; reason: string; picked: boolean }`
  - `function branchToSeries(branch: string): string | undefined`
  - `function proposeVersions(repoBranches: RepoBranch[], seriesBranches: string[], existing: string[]): VersionCandidate[]`
  - `const MAX_SERIES_ROWS = 4`

- [ ] **Step 1: Write the failing tests**

Create `src/test/versionProposal.test.ts`:

```ts
import * as assert from 'assert';
import { branchToSeries, proposeVersions } from '../services/versionProposal';

suite('Version proposal', () => {
    test('maps a prefixed custom branch to its Odoo series', () => {
        assert.strictEqual(branchToSeries('17.0-bunka'), '17.0');
        assert.strictEqual(branchToSeries('saas-18.4-client'), 'saas-18.4');
        assert.strictEqual(branchToSeries('19.0'), '19.0');
    });

    test('keeps master and ignores branches with no series', () => {
        assert.strictEqual(branchToSeries('master'), 'master');
        assert.strictEqual(branchToSeries('MASTER'), 'master');
        assert.strictEqual(branchToSeries('feature/login'), undefined);
        assert.strictEqual(branchToSeries(''), undefined);
    });

    test('offers repo-derived series first, picked, with the repo as the reason', () => {
        const candidates = proposeVersions(
            [{ repoName: 'psae-internal', branch: '17.0-bunka' }],
            ['19.0', '18.0', '17.0'],
            []
        );

        assert.strictEqual(candidates[0].branch, '17.0');
        assert.strictEqual(candidates[0].picked, true);
        assert.ok(candidates[0].reason.includes('psae-internal'));
        assert.ok(candidates[0].reason.includes('17.0-bunka'));
        // The series list must not repeat it.
        assert.strictEqual(candidates.filter(entry => entry.branch === '17.0').length, 1);
    });

    test('picks the newest series when no repository suggests one', () => {
        const candidates = proposeVersions([], ['19.0', '18.0', '17.0'], []);

        assert.deepStrictEqual(candidates.map(entry => entry.branch), ['19.0', '18.0', '17.0']);
        assert.deepStrictEqual(candidates.map(entry => entry.picked), [true, false, false]);
    });

    test('drops branches that already have a version', () => {
        const candidates = proposeVersions(
            [{ repoName: 'psae-internal', branch: '19.0-bunka' }],
            ['19.0', '18.0'],
            ['19.0']
        );

        assert.deepStrictEqual(candidates.map(entry => entry.branch), ['18.0']);
    });

    test('caps the series rows so the picker stays a glance', () => {
        const candidates = proposeVersions(
            [],
            ['master', '19.0', '18.0', '17.0', '16.0', '15.0'],
            []
        );

        assert.strictEqual(candidates.length, 4);
    });

    test('deduplicates repositories that agree on a series', () => {
        const candidates = proposeVersions(
            [
                { repoName: 'psae-internal', branch: '17.0-bunka' },
                { repoName: 'client-addons', branch: '17.0-bunka' }
            ],
            [],
            []
        );

        assert.strictEqual(candidates.length, 1);
        assert.strictEqual(candidates[0].branch, '17.0');
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run compile-tests && npm test`
Expected: FAIL — `Cannot find module '../services/versionProposal'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/versionProposal.ts`:

```ts
/**
 * Which Odoo versions to offer, and why. The strongest signal is already on
 * disk: a custom repository sitting on `17.0-bunka` says the user needs a
 * 17.0 version far more reliably than any hardcoded "latest three" list.
 *
 * Pure: takes the branches and returns rows. The scanning that produces those
 * branches lives in the callers.
 */
import { parseOdooSeries } from './database';

export interface RepoBranch {
    repoName: string;
    branch: string;
}

export interface VersionCandidate {
    branch: string;
    /** Shown as the row description: why this is being offered. */
    reason: string;
    picked: boolean;
}

/** How many series rows are offered beyond the repo-derived ones. */
export const MAX_SERIES_ROWS = 4;

/**
 * The Odoo series a branch belongs to. `parseOdooSeries` already turns
 * `17.0-bunka` into `17.0` and `saas-18.4-client` into `saas-18.4`; only
 * `master`, which carries no numbers, needs handling here.
 */
export function branchToSeries(branch: string): string | undefined {
    const trimmed = branch?.trim();
    if (!trimmed) {
        return undefined;
    }
    if (/^master$/i.test(trimmed)) {
        return 'master';
    }
    return parseOdooSeries(trimmed);
}

function seriesReason(branch: string, index: number): string {
    if (/^master$/i.test(branch)) {
        return 'development branch';
    }
    return index === 0 ? 'latest stable' : 'stable release';
}

export function proposeVersions(
    repoBranches: RepoBranch[],
    seriesBranches: string[],
    existing: string[]
): VersionCandidate[] {
    const taken = new Set(existing.map(entry => entry.trim()).filter(Boolean));
    const candidates: VersionCandidate[] = [];
    const seen = new Set<string>();

    // Repo-derived rows first: the user's own branches are the strongest
    // statement about which versions they need.
    for (const entry of repoBranches) {
        const series = branchToSeries(entry.branch);
        if (!series || taken.has(series) || seen.has(series)) {
            continue;
        }
        seen.add(series);
        candidates.push({
            branch: series,
            reason: `${entry.repoName} has ${entry.branch.trim()}`,
            picked: true
        });
    }

    let offered = 0;
    for (const branch of seriesBranches) {
        if (offered >= MAX_SERIES_ROWS) {
            break;
        }
        const trimmed = branch.trim();
        if (!trimmed || taken.has(trimmed) || seen.has(trimmed)) {
            continue;
        }
        seen.add(trimmed);
        candidates.push({
            branch: trimmed,
            reason: seriesReason(trimmed, offered),
            // Nothing else suggested a version: offer to build the newest.
            picked: candidates.length === 0
        });
        offered += 1;
    }

    return candidates;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: PASS — 194 passing.

- [ ] **Step 5: Commit**

```bash
git add src/services/versionProposal.ts src/test/versionProposal.test.ts
git commit -m "[ADD] Propose versions from the user's own branches, not a fixed list"
```

---

### Task 2: The provisioning queue

The state machine and its persistence. No provisioning runs yet — Task 3 supplies the runner — so this task is entirely testable as data.

**Files:**
- Create: `src/services/provisionQueue.ts`
- Test: `src/test/provisionQueue.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module besides `vscode` for the accessors).
- Produces:
  - `interface QueuedVersion { branch: string; name: string }`
  - `interface QueueState { active?: QueuedVersion; pending: QueuedVersion[] }`
  - `const EMPTY_QUEUE: QueueState`
  - `const QUEUE_STATE_KEY = 'odt.provisionQueue'`
  - `function enqueue(state: QueueState, entries: QueuedVersion[]): QueueState`
  - `function takeNext(state: QueueState): QueueState`
  - `function finishActive(state: QueueState): QueueState`
  - `function queueLabel(state: QueueState, branch: string): 'building…' | 'queued' | undefined`
  - `function describeDrain(succeeded: string[], failed: string[]): string`
  - `function readQueue(context: vscode.ExtensionContext): QueueState`
  - `function writeQueue(context: vscode.ExtensionContext, state: QueueState): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `src/test/provisionQueue.test.ts`:

```ts
import * as assert from 'assert';
import {
    EMPTY_QUEUE,
    QueueState,
    describeDrain,
    enqueue,
    finishActive,
    queueLabel,
    takeNext
} from '../services/provisionQueue';

const entry = (branch: string): { branch: string; name: string } => ({ branch, name: `Odoo ${branch}` });

suite('Provisioning queue', () => {
    test('enqueue appends and never duplicates a branch', () => {
        const state = enqueue(enqueue(EMPTY_QUEUE, [entry('19.0')]), [entry('19.0'), entry('18.0')]);

        assert.deepStrictEqual(state.pending.map(item => item.branch), ['19.0', '18.0']);
    });

    test('enqueue does not re-queue the branch being built', () => {
        const building = takeNext(enqueue(EMPTY_QUEUE, [entry('19.0')]));
        const state = enqueue(building, [entry('19.0')]);

        assert.strictEqual(state.active?.branch, '19.0');
        assert.deepStrictEqual(state.pending, []);
    });

    test('takeNext promotes the head and finishActive clears it', () => {
        const queued = enqueue(EMPTY_QUEUE, [entry('19.0'), entry('18.0')]);

        const building = takeNext(queued);
        assert.strictEqual(building.active?.branch, '19.0');
        assert.deepStrictEqual(building.pending.map(item => item.branch), ['18.0']);

        const done = finishActive(building);
        assert.strictEqual(done.active, undefined);
        assert.deepStrictEqual(done.pending.map(item => item.branch), ['18.0']);
    });

    test('takeNext on an empty queue is a no-op', () => {
        assert.deepStrictEqual(takeNext(EMPTY_QUEUE), EMPTY_QUEUE);
    });

    test('a failed entry leaves the queue drainable', () => {
        // Failure and success take the same transition: the entry is removed
        // either way, so one bad branch cannot wedge the queue.
        const state: QueueState = takeNext(enqueue(EMPTY_QUEUE, [entry('nope'), entry('18.0')]));
        const after = finishActive(state);

        assert.strictEqual(after.active, undefined);
        assert.strictEqual(takeNext(after).active?.branch, '18.0');
    });

    test('queueLabel reports what the version row should say', () => {
        const state = takeNext(enqueue(EMPTY_QUEUE, [entry('19.0'), entry('18.0')]));

        assert.strictEqual(queueLabel(state, '19.0'), 'building…');
        assert.strictEqual(queueLabel(state, '18.0'), 'queued');
        assert.strictEqual(queueLabel(state, '17.0'), undefined);
    });

    test('describeDrain names both outcomes in one sentence', () => {
        assert.strictEqual(describeDrain(['19.0', '18.0'], []), 'Provisioned 19.0, 18.0.');
        assert.strictEqual(
            describeDrain(['19.0'], ['18.0']),
            'Provisioned 19.0. Failed: 18.0 - use Check Version Environments to retry.'
        );
        assert.strictEqual(
            describeDrain([], ['18.0']),
            'Failed: 18.0 - use Check Version Environments to retry.'
        );
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run compile-tests && npm test`
Expected: FAIL — `Cannot find module '../services/provisionQueue'`.

- [ ] **Step 3: Write the implementation**

Create `src/services/provisionQueue.ts`:

```ts
/**
 * The queue that builds versions one at a time.
 *
 * Setup can select several versions at once. Building them all inside one
 * progress notification means watching a bar for ten minutes before touching
 * anything, so the first is built in the foreground and the rest are queued.
 * One at a time, deliberately: concurrent `pip install`s contend for the same
 * wheel cache and finish no sooner than sequential ones.
 *
 * The transitions are pure and tested as data; only the two accessors at the
 * bottom touch vscode. State is persisted so a window reload resumes the
 * queue rather than silently dropping what is left.
 */
import type * as vscode from 'vscode';

export interface QueuedVersion {
    branch: string;
    name: string;
}

export interface QueueState {
    /** The entry being built right now, if any. */
    active?: QueuedVersion;
    pending: QueuedVersion[];
}

export const EMPTY_QUEUE: QueueState = { pending: [] };

export const QUEUE_STATE_KEY = 'odt.provisionQueue';

function knownBranches(state: QueueState): Set<string> {
    const branches = new Set(state.pending.map(entry => entry.branch));
    if (state.active) {
        branches.add(state.active.branch);
    }
    return branches;
}

/** Appends entries, skipping any branch already queued or being built. */
export function enqueue(state: QueueState, entries: QueuedVersion[]): QueueState {
    const known = knownBranches(state);
    const added: QueuedVersion[] = [];

    for (const entry of entries) {
        if (known.has(entry.branch)) {
            continue;
        }
        known.add(entry.branch);
        added.push(entry);
    }

    return { active: state.active, pending: [...state.pending, ...added] };
}

/** Promotes the head to active. A queue that is already busy is unchanged. */
export function takeNext(state: QueueState): QueueState {
    if (state.active || state.pending.length === 0) {
        return state;
    }
    const [next, ...rest] = state.pending;
    return { active: next, pending: rest };
}

/**
 * Clears the active entry. Success and failure share this transition: an
 * entry is removed either way, so one unbuildable branch cannot wedge the
 * queue behind it.
 */
export function finishActive(state: QueueState): QueueState {
    return { active: undefined, pending: state.pending };
}

/** What the Versions row should say for a branch, if the queue owns it. */
export function queueLabel(state: QueueState, branch: string): 'building…' | 'queued' | undefined {
    if (state.active?.branch === branch) {
        return 'building…';
    }
    return state.pending.some(entry => entry.branch === branch) ? 'queued' : undefined;
}

/** One summary sentence for the whole drain, rather than one per version. */
export function describeDrain(succeeded: string[], failed: string[]): string {
    const parts: string[] = [];
    if (succeeded.length > 0) {
        parts.push(`Provisioned ${succeeded.join(', ')}.`);
    }
    if (failed.length > 0) {
        parts.push(`Failed: ${failed.join(', ')} - use Check Version Environments to retry.`);
    }
    return parts.join(' ');
}

// ---------------------------------------------------------------------------
// vscode-backed accessors
// ---------------------------------------------------------------------------

export function readQueue(context: vscode.ExtensionContext): QueueState {
    const stored = context.globalState.get<QueueState>(QUEUE_STATE_KEY);
    if (!stored || !Array.isArray(stored.pending)) {
        return EMPTY_QUEUE;
    }
    return { active: stored.active, pending: stored.pending };
}

export async function writeQueue(context: vscode.ExtensionContext, state: QueueState): Promise<void> {
    await context.globalState.update(QUEUE_STATE_KEY, state);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: PASS — 201 passing.

- [ ] **Step 5: Commit**

```bash
git add src/services/provisionQueue.ts src/test/provisionQueue.test.ts
git commit -m "[ADD] A resumable queue that builds one version at a time"
```

---

### Task 3: Drive the queue, and show it on the rows

Gives `provisionAndCreateVersion` a silent mode, adds the runner that drains the queue, and surfaces `building…` / `queued` in the Versions view.

**Files:**
- Modify: `src/odooInstaller.ts` (the `provisionAndCreateVersion` signature and its two prompts)
- Modify: `src/services/provisionQueue.ts` (add the runner)
- Modify: `src/versionsTreeProvider.ts:17-22` (`provisioningLabel`)
- Modify: `src/extension.ts` (drain on activation)

**Interfaces:**
- Consumes: `enqueue`, `takeNext`, `finishActive`, `readQueue`, `writeQueue`, `describeDrain` (Task 2).
- Produces:
  - `provisionAndCreateVersion(branch: string, name: string, options?: { silent?: boolean }): Promise<VersionModel | undefined>` — when `silent`, no provision-or-profile prompt and no per-version notification.
  - `function drainProvisionQueue(context: vscode.ExtensionContext, onProgress?: () => void): Promise<void>` in `provisionQueue.ts`
  - `function setQueueSnapshot(state: QueueState): void` and `function currentQueueSnapshot(): QueueState` in `provisionQueue.ts` — a module-level cache the tree reads synchronously, since `TreeItem` construction cannot await.
  - `function stopProvisionQueue(context: vscode.ExtensionContext): Promise<void>` — clears what has not been built yet.

- [ ] **Step 1: Add the silent mode to provisioning**

In `src/odooInstaller.ts`, change the signature and skip both prompts when silent:

```ts
export async function provisionAndCreateVersion(
    branch: string,
    name: string,
    options: { silent?: boolean } = {}
): Promise<VersionModel | undefined> {
    const setup = readSetupState();
    if (!setup.isConfigured || !setup.sourceRepo) {
        if (options.silent) {
            // The queue reports failures in one summary; a prompt per entry
            // during a background drain is worse than the summary.
            logger.warn(`[queue] skipping ${branch}: the machine is not set up`);
            return undefined;
        }
        const choice = await showWarning('Odoo DevTools is not set up yet.', 'Set Up');
        if (choice === 'Set Up') {
            await vscode.commands.executeCommand('odoo.setup');
        }
        return undefined;
    }

    const spec: ProvisionSpec = {
        branch,
        sourceRepoPath: setup.sourceRepo,
        enterpriseRepoPath: setup.enterpriseRepo,
        designThemesRepoPath: setup.designThemesRepo,
        root: setup.provisioningRoot
    };

    if (!options.silent) {
        const plan = buildPlan(spec, await probeProvision(spec));
        const detail = plan
            .map(step => `${step.status === 'satisfied' ? '$(check)' : '$(add)'} ${step.label}`)
            .join('  ');

        const choice = await vscode.window.showQuickPick(
            [
                {
                    label: isFullySatisfied(plan) ? 'Create profile (already provisioned)' : 'Provision',
                    detail,
                    provision: true
                },
                {
                    label: 'Profile only',
                    detail: 'Create the version without building an environment',
                    provision: false
                }
            ],
            { title: `Provision Odoo ${branch}?`, placeHolder: 'Choose how to create this version', ignoreFocusOut: true }
        );
        if (!choice) {
            return undefined;
        }
        if (!choice.provision) {
            return VersionsService.getInstance().createVersion(name, branch);
        }
    }
```

The body from `const result = await vscode.window.withProgress(...)` onward is unchanged, except the trailing notifications, which become:

```ts
    if (!options.silent) {
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
    }

    return version;
```

- [ ] **Step 2: Add the runner and the snapshot to `provisionQueue.ts`**

Append to `src/services/provisionQueue.ts`:

```ts
/**
 * The tree builds its items synchronously, so it cannot await `readQueue`.
 * The runner keeps this snapshot in step with what it persists.
 */
let snapshot: QueueState = EMPTY_QUEUE;

export function currentQueueSnapshot(): QueueState {
    return snapshot;
}

export function setQueueSnapshot(state: QueueState): void {
    snapshot = state;
}

let draining = false;

/**
 * Builds every queued version, one at a time, reporting once at the end.
 * Re-entrant calls return immediately: activation and a fresh enqueue can
 * both ask for a drain, and only one may run.
 */
export async function drainProvisionQueue(
    context: vscode.ExtensionContext,
    onProgress: () => void = () => undefined
): Promise<void> {
    if (draining) {
        return;
    }
    draining = true;

    const succeeded: string[] = [];
    const failed: string[] = [];

    try {
        // Imported lazily: odooInstaller pulls in the whole provisioning
        // stack, and this module is loaded by the tree provider.
        const { provisionAndCreateVersion } = await import('../odooInstaller');

        for (;;) {
            const next = takeNext(readQueue(context));
            if (!next.active) {
                break;
            }
            const entry = next.active;
            await persist(context, next, onProgress);

            try {
                const version = await provisionAndCreateVersion(entry.branch, entry.name, { silent: true });
                (version ? succeeded : failed).push(entry.branch);
            } catch (error) {
                logger.warn(`[queue] provisioning ${entry.branch} failed:`, error);
                failed.push(entry.branch);
            }

            await persist(context, finishActive(readQueue(context)), onProgress);
        }
    } finally {
        draining = false;
    }

    if (succeeded.length + failed.length > 0) {
        void showInfo(describeDrain(succeeded, failed));
    }
}

/**
 * The in-flight progress notification's companion: offered while entries
 * remain so a drain can be abandoned without waiting it out.
 */
export async function offerStop(context: vscode.ExtensionContext, remaining: number): Promise<void> {
    if (remaining === 0) {
        return;
    }
    const choice = await showInfo(`Building ${remaining} more version(s).`, 'Stop Building');
    if (choice === 'Stop Building') {
        await stopProvisionQueue(context);
        void showInfo('Stopped. Versions already built are untouched.');
    }
}

/**
 * Clears everything not yet built. Versions already provisioned are left
 * alone: this stops future work, it does not undo finished work.
 */
export async function stopProvisionQueue(context: vscode.ExtensionContext): Promise<void> {
    const state = readQueue(context);
    const cleared: QueueState = { active: state.active, pending: [] };
    setQueueSnapshot(cleared);
    await writeQueue(context, cleared);
}

async function persist(
    context: vscode.ExtensionContext,
    state: QueueState,
    onProgress: () => void
): Promise<void> {
    setQueueSnapshot(state);
    await writeQueue(context, state);
    onProgress();
}
```

Add the imports this needs at the top of the file: `import { logger } from './logger';` and `import { showInfo } from './notifications';`.

- [ ] **Step 3: Show the queue state on the version rows**

In `src/versionsTreeProvider.ts`, replace `provisioningLabel`:

```ts
import { currentQueueSnapshot, queueLabel } from './services/provisionQueue';

/** Provisioned state for the tree description, from the shared predicate. */
function provisioningLabel(version: VersionModel): string {
    const queued = queueLabel(currentQueueSnapshot(), version.odooVersion);
    if (queued) {
        return queued;
    }
    return isVersionProvisioned(resolveOptionalPath(version.settings.pythonPath))
        ? 'provisioned'
        : 'not provisioned';
}
```

- [ ] **Step 4: Drain on activation**

In `src/extension.ts`, beside the other activation nudges near line 217:

```ts
    setQueueSnapshot(readQueue(context));
    void drainProvisionQueue(context, () => void refreshAll({ reason: 'ui' }))
        .catch(error => logger.warn('Provisioning queue failed:', error));
```

with `import { drainProvisionQueue, readQueue, setQueueSnapshot } from './services/provisionQueue';`.

- [ ] **Step 5: Verify and commit**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: PASS — 201 passing, no `error TS`.

```bash
git add src/odooInstaller.ts src/services/provisionQueue.ts src/versionsTreeProvider.ts src/extension.ts
git commit -m "[ADD] Drain the provisioning queue and show its state on version rows"
```

---

### Task 4: Setup offers the versions, and three defects go

Replaces setup's *Create a Version* hand-off with the multi-select, and clears defects 1-3 from the spec's Problem section.

**Files:**
- Create: `src/commands/versionPick.ts`
- Modify: `src/commands/projectCommands.ts:133-148` (the `odoo.setup` handler)
- Modify: `src/commands/versionCommands.ts:126` (branch-pick source)
- Modify: `src/odooInstaller.ts` (delete `BRANCH_OPTIONS`, `pickBranch`, `pickCloneDepth`; simplify `cloneOdooRepositories`)

**Interfaces:**
- Consumes: `proposeVersions`, `VersionCandidate` (Task 1); `enqueue`, `writeQueue`, `drainProvisionQueue`, `offerStop` (Tasks 2-3); `listSeriesBranches` from `src/services/gitService.ts`; `readSetupState` from `src/services/setupState.ts`.
- Produces:
  - `function pickVersionsToBuild(candidates: VersionCandidate[]): Promise<string[] | undefined>` — the chosen branches, `undefined` on cancel.
  - `function collectRepoBranches(): Promise<RepoBranch[]>` — branches of the repos across saved projects, capped at 12 repos.

- [ ] **Step 1: Write the picker**

Create `src/commands/versionPick.ts`:

```ts
/**
 * The multi-select shown at the end of setup. Candidates come from
 * `proposeVersions`, so this file only renders them and handles the custom
 * branch row.
 */
import * as vscode from 'vscode';
import { VersionCandidate, RepoBranch } from '../services/versionProposal';
import { SettingsStore } from '../settingsStore';
import { getRepoBranch } from '../services/branches';
import { normalizePath } from '../utils';
import { logger } from '../services/logger';

interface CandidateItem extends vscode.QuickPickItem {
    branch?: string;
    custom?: boolean;
}

/** Stated, not measured: enough to stop someone ticking four boxes blind. */
const PER_VERSION_COST = '≈2 GB and a few minutes each';

const CUSTOM_ITEM: CandidateItem = {
    label: '$(pencil) Custom branch…',
    description: 'e.g. "saas-18.4"',
    custom: true
};

export async function pickVersionsToBuild(candidates: VersionCandidate[]): Promise<string[] | undefined> {
    if (candidates.length === 0) {
        return [];
    }

    const items: CandidateItem[] = candidates.map(candidate => ({
        label: candidate.branch,
        description: candidate.reason,
        branch: candidate.branch,
        picked: candidate.picked
    }));

    const picks = await vscode.window.showQuickPick([...items, CUSTOM_ITEM], {
        title: `Which Odoo versions do you want?  (${PER_VERSION_COST})`,
        placeHolder: 'Each builds a worktree, a virtualenv and its requirements',
        canPickMany: true,
        ignoreFocusOut: true
    });
    if (!picks) {
        return undefined;
    }

    const branches = picks.map(pick => pick.branch).filter((branch): branch is string => !!branch);

    if (picks.some(pick => pick.custom)) {
        const entered = await vscode.window.showInputBox({
            title: 'Custom branch',
            placeHolder: 'e.g. "saas-18.4", "master"',
            ignoreFocusOut: true,
            validateInput: value => value.trim() ? undefined : 'Branch is required.'
        });
        const trimmed = entered?.trim();
        if (trimmed && !branches.includes(trimmed)) {
            branches.push(trimmed);
        }
    }

    return branches;
}

/**
 * Branches of the repositories across saved projects. On a fresh install
 * there are no projects, so this costs nothing; the cap keeps it cheap for
 * someone with a large workspace.
 */
export async function collectRepoBranches(): Promise<RepoBranch[]> {
    try {
        const data = await SettingsStore.get('odoo-debugger-data.json');
        const repos = (data.projects ?? [])
            .flatMap((project: any) => project.repos ?? [])
            .slice(0, 12);

        const branches: RepoBranch[] = [];
        for (const repo of repos) {
            const branch = await getRepoBranch(normalizePath(repo.path));
            if (branch) {
                branches.push({ repoName: repo.name, branch });
            }
        }
        return branches;
    } catch (error) {
        logger.debug('Could not read repository branches for the version proposal:', error);
        return [];
    }
}
```

- [ ] **Step 2: Wire it into `odoo.setup`**

In `src/commands/projectCommands.ts`, replace the tail of the `odoo.setup` handler (from `const next = await showInfo('Odoo DevTools is set up.', 'Create a Version');` to the end of the block):

```ts
        const setup = readSetupState();
        const candidates = proposeVersions(
            await collectRepoBranches(),
            setup.sourceRepo ? await listSeriesBranches(setup.sourceRepo) : [],
            versionsService.getVersions().map(version => version.odooVersion)
        );

        const branches = await pickVersionsToBuild(candidates);
        if (!branches || branches.length === 0) {
            return;
        }

        // The first is built in the foreground so work can start; the rest
        // are queued and drained one at a time.
        const [first, ...rest] = branches;
        if (rest.length > 0) {
            const queued = enqueue(readQueue(context), rest.map(branch => ({ branch, name: `Odoo ${branch}` })));
            setQueueSnapshot(queued);
            await writeQueue(context, queued);
        }

        await provisionAndCreateVersion(first, `Odoo ${first}`);
        await refreshAll({ reason: 'ui' });
        void drainProvisionQueue(context, () => void refreshAll({ reason: 'ui' }));
        // Offered alongside the drain, so a long build can be abandoned
        // without waiting it out.
        void offerStop(context, rest.length);
```

- [ ] **Step 3: Fix the branch-pick source (defect 1)**

In `src/commands/versionCommands.ts`, in the `odoo.createVersion` handler, replace the two lines that read the active version's path:

```ts
            // The source repository, not the active version's worktree: on a
            // first run there is no active version, and the picker would fall
            // back to a free-text box seconds after setup configured a repo
            // full of branches.
            const odooVersion = await pickOdooBranch(readSetupState().sourceRepo, 'Create Version');
            if (!odooVersion) { return; }
```

Delete the now-unused `activeSettings` and `odooPath` locals above it.

- [ ] **Step 4: Silence the clone questions (defect 2) and delete the hardcoded list (defect 3)**

In `src/odooInstaller.ts`, delete `BRANCH_OPTIONS`, `pickBranch` and `pickCloneDepth` entirely, and change `cloneOdooRepositories` to stop asking:

```ts
export async function cloneOdooRepositories(defaultBaseDir: string): Promise<string | undefined> {
    const baseDir = await pickDestination(defaultBaseDir);
    if (!baseDir) {
        return undefined;
    }

    const targets = await pickCloneTargets();
    if (!targets) {
        return undefined;
    }

    // Neither branch nor depth is asked: this clone is only ever a source to
    // cut worktrees from, and `ensureWorktree` fetches whatever branch a
    // version needs on demand.
    const branch = DEFAULT_CLONE_BRANCH;
    const shallow = true;
```

with, near the top of the file:

```ts
/** The clone is a worktree source; its own branch is immaterial. */
const DEFAULT_CLONE_BRANCH = '19.0';
```

The rest of the function is unchanged.

- [ ] **Step 5: Verify and commit**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: PASS — 201 passing.

```bash
git add src/commands/versionPick.ts src/commands/projectCommands.ts src/commands/versionCommands.ts src/odooInstaller.ts
git commit -m "[IMP] Offer the versions to build at the end of setup"
```

---

### Task 5: Setup records where custom addons live

**Files:**
- Modify: `src/services/setupDetection.ts` (add the custom-addons scan)
- Modify: `src/services/setupFlow.ts` (proposal, description, edit and persist)
- Test: `src/test/customAddonsDetection.test.ts`

**Interfaces:**
- Consumes: `searchRoots` (existing).
- Produces:
  - `interface AddonsChild { name: string; isGitRepo: boolean; hasOdooBin: boolean }`
  - `function countCustomRepos(children: AddonsChild[]): number` — pure
  - `function detectCustomAddonsRoot(roots: string[]): string | undefined` — impure scan
  - `SetupProposal.customAddonsPath?: string` and `SetupProposal.customAddonsCount?: number`

- [ ] **Step 1: Write the failing test**

Create `src/test/customAddonsDetection.test.ts`:

```ts
import * as assert from 'assert';
import { countCustomRepos } from '../services/setupDetection';

suite('Custom addons detection', () => {
    test('counts git repositories that are not the core ones', () => {
        const count = countCustomRepos([
            { name: 'psae-internal', isGitRepo: true, hasOdooBin: false },
            { name: 'client-addons', isGitRepo: true, hasOdooBin: false }
        ]);

        assert.strictEqual(count, 2);
    });

    test('excludes the Odoo source repository and its siblings', () => {
        const count = countCustomRepos([
            { name: 'odoo', isGitRepo: true, hasOdooBin: true },
            { name: 'enterprise', isGitRepo: true, hasOdooBin: false },
            { name: 'design-themes', isGitRepo: true, hasOdooBin: false },
            { name: 'psae-internal', isGitRepo: true, hasOdooBin: false }
        ]);

        assert.strictEqual(count, 1);
    });

    test('ignores directories that are not git repositories', () => {
        const count = countCustomRepos([
            { name: 'notes', isGitRepo: false, hasOdooBin: false },
            { name: 'psae-internal', isGitRepo: true, hasOdooBin: false }
        ]);

        assert.strictEqual(count, 1);
    });

    test('a fork named after the client still counts as core when it has odoo-bin', () => {
        const count = countCustomRepos([{ name: 'bunka-odoo', isGitRepo: true, hasOdooBin: true }]);

        assert.strictEqual(count, 0);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run compile-tests && npm test`
Expected: FAIL — `countCustomRepos` is not exported.

- [ ] **Step 3: Implement the detection**

Append to `src/services/setupDetection.ts`:

```ts
export interface AddonsChild {
    name: string;
    isGitRepo: boolean;
    hasOdooBin: boolean;
}

/**
 * How many of a directory's children are the user's own repositories. The
 * core repos are excluded by the same rules detection uses elsewhere:
 * `odoo-bin` identifies the source repo whatever it is named, and the two
 * optional repos are identified by name.
 */
export function countCustomRepos(children: AddonsChild[]): number {
    return children.filter(child =>
        child.isGitRepo && !child.hasOdooBin && !classifyByName(child.name)
    ).length;
}

export function readAddonsChildren(dir: string): AddonsChild[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }

    return entries
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => {
            const child = path.join(dir, entry.name);
            return {
                name: entry.name,
                isGitRepo: fs.existsSync(path.join(child, '.git')),
                hasOdooBin: fs.existsSync(path.join(child, 'odoo-bin'))
            };
        });
}

/**
 * The first search root holding at least one repository of the user's own.
 * Roots are already ordered by trust, and the workspace comes before the home
 * directory, which is the common case: the workspace *is* that directory.
 */
export function detectCustomAddonsRoot(roots: string[]): string | undefined {
    for (const root of roots) {
        if (countCustomRepos(readAddonsChildren(root)) > 0) {
            logger.debug(`[setup] custom addons look like they live in ${root}`);
            return root;
        }
    }
    return undefined;
}
```

- [ ] **Step 4: Add the row to the setup proposal**

In `src/services/setupFlow.ts`, extend `SetupProposal`:

```ts
export interface SetupProposal {
    sourceRepo?: string;
    enterpriseRepo?: string;
    designThemesRepo?: string;
    provisioningRoot: string;
    sourceBranch?: string;
    customAddonsPath?: string;
    customAddonsCount?: number;
}
```

In `buildProposal`, after `const best = pickBest(...)`:

```ts
    const configuredAddons = vscode.workspace
        .getConfiguration('odooDebugger')
        .get<string>('defaultVersion.customAddonsPath', '')
        .trim();
    // A configured value only counts when it is there; the shipped default is
    // a workspace-relative path that usually is not.
    const customAddonsPath = (configuredAddons && fs.existsSync(configuredAddons))
        ? configuredAddons
        : detectCustomAddonsRoot(roots);
```

and include it in the returned object:

```ts
        customAddonsPath,
        customAddonsCount: customAddonsPath
            ? countCustomRepos(readAddonsChildren(customAddonsPath))
            : undefined
```

Export the helper as `readAddonsChildren` (not a local) from `setupDetection.ts`, and import it in `setupFlow.ts` alongside `countCustomRepos` and `detectCustomAddonsRoot`.

In `describe`, add the row before the environments row:

```ts
        proposal.customAddonsPath
            ? `Custom addons: ${proposal.customAddonsPath} (${proposal.customAddonsCount ?? 0} repositories)`
            : undefined,
```

In `editProposal`, after the provisioning root prompt:

```ts
    // Optional: a user doing pure Odoo work has no custom addons, and the
    // repository picker in project creation recovers when this is unset.
    const addons = await browseForFolder(
        'Select the folder holding your custom addon repositories (Esc to skip)',
        proposal.customAddonsPath
    );
```

and include `customAddonsPath: addons ?? proposal.customAddonsPath` in its return object.

In `persist`, write it at user scope beside the rest:

```ts
    if (proposal.customAddonsPath) {
        await vscode.workspace.getConfiguration('odooDebugger').update(
            'defaultVersion.customAddonsPath',
            proposal.customAddonsPath,
            vscode.ConfigurationTarget.Global
        );
    }
```

- [ ] **Step 5: Verify and commit**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: PASS — 205 passing.

```bash
git add src/services/setupDetection.ts src/services/setupFlow.ts src/test/customAddonsDetection.test.ts
git commit -m "[ADD] Detect and record where custom addons live during setup"
```

---

### Task 6: Versions that predate provisioning are offered a migration

**Files:**
- Modify: `src/services/versionMigration.ts`
- Modify: `src/commands/versionCommands.ts:26-66` (`odoo.checkVersions` passes the source repo)
- Modify: `src/extension.ts:267-291` (`promptStaleVersions` becomes the migration offer)
- Test: `src/test/versionMigration.test.ts` (extend)

**Interfaces:**
- Consumes: `readSetupState` (existing), `enqueue`/`writeQueue`/`drainProvisionQueue` (Tasks 2-3).
- Produces:
  - `type VersionHealth = 'healthy' | 'relocated' | 'missing' | 'unprovisioned' | 'source-repo'`
  - `diagnoseVersion(version: VersionLike, root: string, exists: (candidate: string) => boolean, sourceRepo?: string): VersionDiagnosis`
  - `function migratable(diagnoses: VersionDiagnosis[]): VersionDiagnosis[]` — the three unsafe healths, worst first.

- [ ] **Step 1: Write the failing tests**

Append to `src/test/versionMigration.test.ts`:

```ts
    test('a version running out of the source repository is not merely relocated', () => {
        const diagnosis = diagnoseVersion(
            {
                id: 'v1',
                name: 'Odoo 17.0',
                odooVersion: '17.0',
                odooPath: '/home/dev/src/odoo',
                pythonPath: '/home/dev/src/venv/bin/python'
            },
            '/home/dev/odoo-dev',
            () => true,
            '/home/dev/src/odoo'
        );

        assert.strictEqual(diagnosis.health, 'source-repo');
        assert.ok(diagnosis.detail.includes('source repository'));
    });

    test('the source repo is compared after path resolution', () => {
        const diagnosis = diagnoseVersion(
            {
                id: 'v1',
                name: 'Odoo 17.0',
                odooVersion: '17.0',
                odooPath: '/home/dev/src/odoo/',
                pythonPath: '/home/dev/src/venv/bin/python'
            },
            '/home/dev/odoo-dev',
            () => true,
            '/home/dev/src/./odoo'
        );

        assert.strictEqual(diagnosis.health, 'source-repo');
    });

    test('a working version outside the provisioning root stays relocated', () => {
        const diagnosis = diagnoseVersion(
            {
                id: 'v1',
                name: 'Odoo 17.0',
                odooVersion: '17.0',
                odooPath: '/home/dev/old/odoo-17.0',
                pythonPath: '/home/dev/old/venv/bin/python'
            },
            '/home/dev/odoo-dev',
            () => true,
            '/home/dev/src/odoo'
        );

        assert.strictEqual(diagnosis.health, 'relocated');
    });

    test('migratable returns the unsafe healths worst first, without relocated', () => {
        const entries = migratable([
            { versionId: 'a', name: 'a', health: 'relocated', expectedOdooPath: '', detail: '' },
            { versionId: 'b', name: 'b', health: 'unprovisioned', expectedOdooPath: '', detail: '' },
            { versionId: 'c', name: 'c', health: 'source-repo', expectedOdooPath: '', detail: '' },
            { versionId: 'd', name: 'd', health: 'missing', expectedOdooPath: '', detail: '' },
            { versionId: 'e', name: 'e', health: 'healthy', expectedOdooPath: '', detail: '' }
        ]);

        assert.deepStrictEqual(entries.map(entry => entry.versionId), ['c', 'd', 'b']);
    });
```

Add `migratable` to the file's existing import from `../services/versionMigration`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run compile-tests && npm test`
Expected: FAIL — `diagnoseVersion` takes three arguments; `migratable` is not exported.

- [ ] **Step 3: Implement the health and the selector**

In `src/services/versionMigration.ts`:

```ts
export type VersionHealth = 'healthy' | 'relocated' | 'missing' | 'unprovisioned' | 'source-repo';
```

Add the check to `diagnoseVersion`, after the `pythonPath` existence check and **before** the relocated comparison:

```ts
export function diagnoseVersion(
    version: VersionLike,
    root: string,
    exists: (candidate: string) => boolean,
    sourceRepo?: string
): VersionDiagnosis {
```

```ts
    // Before provisioning existed, a version ran out of whatever checkout the
    // user had. When that checkout is the source repository, the version is
    // not merely untidy: switching that repo's branch changes what it runs,
    // and activating it switches that repo's branch.
    if (sourceRepo?.trim() && path.resolve(odooPath) === path.resolve(sourceRepo.trim())) {
        return {
            ...base,
            health: 'source-repo',
            detail: `It runs out of the source repository at ${odooPath}. Migrating gives it its own worktree at ${expectedOdooPath}.`
        };
    }
```

Then update the rank and add the selector:

```ts
/** Versions worth offering to fix, worst first. */
export function needsAttention(diagnoses: VersionDiagnosis[]): VersionDiagnosis[] {
    const rank: Record<VersionHealth, number> = {
        'source-repo': 0,
        missing: 1,
        unprovisioned: 2,
        relocated: 3,
        healthy: 4
    };
    return diagnoses
        .filter(entry => entry.health !== 'healthy')
        .sort((a, b) => rank[a.health] - rank[b.health]);
}

/**
 * The healths where something is broken or unsafe. `relocated` is left out
 * deliberately: it works, moving it is optional, and a nag about tidiness is
 * worse than none.
 */
export function migratable(diagnoses: VersionDiagnosis[]): VersionDiagnosis[] {
    const unsafe = new Set<VersionHealth>(['source-repo', 'missing', 'unprovisioned']);
    return needsAttention(diagnoses).filter(entry => unsafe.has(entry.health));
}
```

- [ ] **Step 4: Pass the source repo at both call sites**

In `src/commands/versionCommands.ts`, in `odoo.checkVersions`, capture the setup state once and pass it:

```ts
            const setup = readSetupState();
            const diagnoses = versionsService.getVersions().map(version => diagnoseVersion(
                { /* unchanged */ },
                setup.provisioningRoot,
                candidate => fs.existsSync(candidate),
                setup.sourceRepo
            ));
```

In `src/extension.ts`, replace `promptStaleVersions` with the migration offer:

```ts
/** One dismissible offer; "Later" is remembered so it never nags. */
const MIGRATION_DISMISSED_KEY = 'odooDevtools.versionMigrationDismissed';

/**
 * Versions built before provisioning keep working, but nothing tells the user
 * a migration exists - and one shape of them runs out of the source
 * repository, which is unsafe rather than untidy.
 */
async function promptLegacyVersions(context: vscode.ExtensionContext): Promise<void> {
    if (context.globalState.get<boolean>(MIGRATION_DISMISSED_KEY)) {
        return;
    }

    const setup = readSetupState();
    const diagnoses = VersionsService.getInstance().getVersions().map(version => diagnoseVersion(
        {
            id: version.id,
            name: version.name,
            odooVersion: version.odooVersion,
            odooPath: resolveOptionalPath(version.settings.odooPath),
            pythonPath: resolveOptionalPath(version.settings.pythonPath)
        },
        setup.provisioningRoot,
        candidate => fs.existsSync(candidate),
        setup.sourceRepo
    ));

    const stale = migratable(diagnoses);
    if (stale.length === 0) {
        return;
    }

    const choice = await showInfo(
        `${stale.length} version(s) were built before provisioning and can be migrated.`,
        'Migrate',
        'Later'
    );
    if (choice === 'Migrate') {
        const versions = VersionsService.getInstance();
        const entries = stale
            .map(entry => versions.getVersion(entry.versionId))
            .filter((version): version is VersionModel => !!version)
            .map(version => ({ branch: version.odooVersion, name: version.name }));

        const queued = enqueue(readQueue(context), entries);
        setQueueSnapshot(queued);
        await writeQueue(context, queued);
        void drainProvisionQueue(context);
    } else if (choice === 'Later') {
        await context.globalState.update(MIGRATION_DISMISSED_KEY, true);
    }
}
```

and change the activation call to `promptLegacyVersions(context).catch(error => logger.debug('Version health check failed:', error));`.

`src/extension.ts` needs three added imports for this: `migratable` from `./services/versionMigration`, `enqueue`/`readQueue`/`writeQueue`/`setQueueSnapshot`/`drainProvisionQueue` from `./services/provisionQueue` (the drain import is already there from Task 3), and `import type { VersionModel } from './models/version';` for the type predicate.

- [ ] **Step 5: Verify and commit**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: PASS — 209 passing.

```bash
git add src/services/versionMigration.ts src/commands/versionCommands.ts src/extension.ts src/test/versionMigration.test.ts
git commit -m "[ADD] Offer to migrate versions built before provisioning"
```

---

### Task 7: Dead ends become offers

**Files:**
- Modify: `src/project.ts:372-378` (`getRepo`)
- Modify: `src/settingsStore.ts:236-257` (silent read)
- Modify: `src/module.ts` (the six testing-mode refusals and the database refusals)
- Modify: `src/debugger.ts:476-500` (`startDebugServer`)

**Interfaces:**
- Produces:
  - `SettingsStore.peekSelectedProject(): Promise<{ data: DebuggerData; project: ProjectModel } | null>` — same as `getSelectedProject` but shows nothing.
  - `function ensureModuleEditable(project: ProjectModel, db: DatabaseModel | undefined): Promise<boolean>` in `src/module.ts`.

- [ ] **Step 1: Give `getRepo` a way forward**

In `src/project.ts`, replace the throw:

```ts
export async function getRepo(targetPath: string, searchFilter?: string): Promise<RepoModel[]> {
    let scanPath = targetPath;
    let devsRepos = findRepositories(scanPath);

    if (devsRepos.length === 0) {
        // The custom addons folder is the one location setup can legitimately
        // be left without, so this must offer a way forward rather than throw
        // after the project name has already been typed.
        const choice = await showWarning(
            `No repositories found in ${scanPath}.`,
            'Choose Folder…'
        );
        if (choice !== 'Choose Folder…') {
            throw new Error('No repositories found in the custom-addons path.');
        }

        const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Use This Folder',
            title: 'Select the folder holding your addon repositories'
        });
        const chosen = picked?.[0]?.fsPath;
        if (!chosen) {
            throw new Error('No repositories found in the custom-addons path.');
        }

        devsRepos = findRepositories(chosen);
        if (devsRepos.length === 0) {
            void showError(`No repositories found in ${chosen}.`);
            throw new Error('No repositories found in the custom-addons path.');
        }

        scanPath = chosen;
        // Remembered, so the next project does not ask again.
        await vscode.workspace.getConfiguration('odooDebugger').update(
            'defaultVersion.customAddonsPath',
            chosen,
            vscode.ConfigurationTarget.Global
        );
        invalidateRepositoryDiscoveryCache();
    }
```

with `import { invalidateRepositoryDiscoveryCache } from './services/runtimeCache';` added. The rest of the function is unchanged.

- [ ] **Step 2: Split the silent read from the prompting one**

In `src/settingsStore.ts`:

```ts
    /**
     * The selected project without any notification. Background callers - the
     * debugger sync in particular - must not raise "create a project first"
     * from a refresh the user did not ask for.
     */
    static async peekSelectedProject(): Promise<{ data: DebuggerData; project: ProjectModel } | null> {
        const data = await this.get('odoo-debugger-data.json');
        const projects: ProjectModel[] = data.projects;
        if (!Array.isArray(projects) || projects.length === 0) {
            return null;
        }
        const project = projects.find((p: ProjectModel) => p.isSelected === true);
        return project ? { data, project } : null;
    }

    static async getSelectedProject(): Promise<{ data: DebuggerData; project: ProjectModel } | null> {
        const data = await this.get('odoo-debugger-data.json');

        const projects: ProjectModel[] = data.projects;
        if (!projects || projects.length === 0) {
            void showError('No projects yet.', 'Create Project').then(choice => {
                if (choice === 'Create Project') {
                    void vscode.commands.executeCommand('projectSelector.create');
                }
            });
            return null;
        }

        if (typeof projects !== 'object') {
            void showError('Unable to load projects.');
            return null;
        }

        const project = projects.find((p: ProjectModel) => p.isSelected === true);
        if (!project) {
            void showError('No project is selected.', 'Select Project').then(choice => {
                if (choice === 'Select Project') {
                    void vscode.commands.executeCommand('odoo-debugger.quickProjectSearch');
                }
            });
            return null;
        }

        return { data, project };
    }
```

In `src/debugger.ts`, `setupDebugger` uses `SettingsStore.peekSelectedProject()` instead of `getSelectedProject()`.

- [ ] **Step 3: One testing-mode guard with a button**

In `src/module.ts`, add the helper and replace all six copies of the pair of refusals:

```ts
/**
 * Whether module selections may be edited right now. The two refusals were
 * repeated at six call sites; hoisting them means the button that fixes each
 * one exists in a single place.
 */
export async function ensureModuleEditable(
    project: ProjectModel,
    db: DatabaseModel | undefined
): Promise<boolean> {
    if (!db) {
        void showError('No database is selected.', 'Select Database').then(choice => {
            if (choice === 'Select Database') {
                void vscode.commands.executeCommand('dbSelector.quickSearch');
            }
        });
        return false;
    }
    if (project.testingConfig?.isEnabled) {
        void showError('Testing mode is on, so module selections are locked.', 'Disable Testing Mode')
            .then(choice => {
                if (choice === 'Disable Testing Mode') {
                    void vscode.commands.executeCommand('odoo.toggleTestingMode');
                }
            });
        return false;
    }
    return true;
}
```

Each call site becomes:

```ts
    const db: DatabaseModel | undefined = project.dbs.find((db: DatabaseModel) => db.isSelected === true);
    if (!(await ensureModuleEditable(project, db))) {
        return;
    }
```

- [ ] **Step 4: Start Server checks its preconditions**

In `src/debugger.ts`:

```ts
export async function startDebugServer(options: { noDebug?: boolean } = {}): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        void showError("Open a workspace to use this command.");
        return undefined;
    }
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }

    const versionsService = VersionsService.getInstance();
    const workspaceSettings = await versionsService.getActiveVersionSettings();
    const activeVersion = versionsService.getActiveVersion();

    // Handing an unprovisioned version to vscode.debug produces its generic
    // "configuration not found" error, which says nothing about the cause.
    if (!isVersionProvisioned(resolveOptionalPath(workspaceSettings.pythonPath))) {
        const choice = await showError(
            `"${activeVersion?.name ?? 'This version'}" has no environment to run.`,
            'Provision'
        );
        if (choice === 'Provision' && activeVersion) {
            await provisionExistingVersion(activeVersion.id);
        }
        return;
    }

    const db = activeVersion
        ? resolveDbForVersion(result.project.dbs, result.project.selectedDbByVersion, activeVersion.id)
        : undefined;
    if (!db) {
        const choice = await showError('No database is selected for this version.', 'Select Database');
        if (choice === 'Select Database') {
            await vscode.commands.executeCommand('dbSelector.quickSearch');
        }
        return;
    }

    const existingSession = getSessionByName(workspaceSettings.debuggerName);
    if (existingSession) {
        await vscode.debug.stopDebugging(existingSession);
    }
    const started = await vscode.debug.startDebugging(
        workspaceFolders[0],
        workspaceSettings.debuggerName,
        { noDebug: options.noDebug === true }
    );
    if (!started) {
        void showError(`Could not start "${workspaceSettings.debuggerName}". Its launch entry may not be written yet.`);
    }
}
```

Add the imports it needs: `isVersionProvisioned` from `./services/provisioning`, `resolveOptionalPath` from `./utils`, `resolveDbForVersion` from `./services/dbResolution`, and `provisionExistingVersion` from `./odooInstaller`.

- [ ] **Step 5: Verify and commit**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: PASS — 209 passing.

```bash
git add src/project.ts src/settingsStore.ts src/module.ts src/debugger.ts
git commit -m "[IMP] Give the messages that block the daily loop the action they name"
```

---

### Task 8: "Set Up an Upgrade"

**Files:**
- Create: `src/services/upgradePlan.ts`
- Create: `src/commands/upgradeCommand.ts`
- Test: `src/test/upgradePlan.test.ts`
- Modify: `src/commands/index.ts` (register), `package.json` (command + menus)

**Interfaces:**
- Consumes: `branchToSeries` (Task 1); `enqueue`/`writeQueue`/`drainProvisionQueue` (Tasks 2-3); `resolveRepoPath` from `src/services/repoPaths.ts`; `classifySourceConflict`/`describeSourceConflict` from `src/services/sourceConflict.ts`; `sanitizeProjectRepoBranchAssignments` from `src/services/environment.ts`.
- Produces:
  - `interface UpgradeRepo { name: string; path: string; fromBranch: string; toBranch: string }`
  - `interface UpgradeInput { repos: UpgradeRepo[]; fromSeries: string; toSeries: string; existingVersions: string[]; dbs: Array<{ id: string; versionId?: string }>; versionIdBySeries: Record<string, string | undefined> }`
  - `interface UpgradePlan { versionsToCreate: string[]; reposToWorktree: string[]; assignments: Array<{ dbId: string; repoName: string; repoPath: string; branch: string }> }`
  - `function buildUpgradePlan(input: UpgradeInput): UpgradePlan`
  - `function describeUpgradePlan(plan: UpgradePlan, input: UpgradeInput): string`

- [ ] **Step 1: Write the failing tests**

Create `src/test/upgradePlan.test.ts`:

```ts
import * as assert from 'assert';
import { UpgradeInput, buildUpgradePlan, describeUpgradePlan } from '../services/upgradePlan';

const input = (overrides: Partial<UpgradeInput> = {}): UpgradeInput => ({
    repos: [{ name: 'psae-internal', path: '/src/psae-internal', fromBranch: '17.0-bunka', toBranch: '19.0-bunka' }],
    fromSeries: '17.0',
    toSeries: '19.0',
    existingVersions: [],
    dbs: [],
    versionIdBySeries: {},
    ...overrides
});

suite('Upgrade plan', () => {
    test('creates both versions when neither exists', () => {
        const plan = buildUpgradePlan(input());

        assert.deepStrictEqual(plan.versionsToCreate, ['17.0', '19.0']);
    });

    test('does not recreate a version that already exists', () => {
        const plan = buildUpgradePlan(input({ existingVersions: ['19.0'] }));

        assert.deepStrictEqual(plan.versionsToCreate, ['17.0']);
    });

    test('marks every named repository for per-branch copies', () => {
        const plan = buildUpgradePlan(input());

        assert.deepStrictEqual(plan.reposToWorktree, ['psae-internal']);
    });

    test('assigns each database the branch its version upgrades to', () => {
        const plan = buildUpgradePlan(input({
            existingVersions: ['17.0', '19.0'],
            versionIdBySeries: { '17.0': 'v17', '19.0': 'v19' },
            dbs: [{ id: 'crm-17', versionId: 'v17' }, { id: 'crm-19', versionId: 'v19' }]
        }));

        assert.deepStrictEqual(plan.assignments, [
            { dbId: 'crm-17', repoName: 'psae-internal', repoPath: '/src/psae-internal', branch: '17.0-bunka' },
            { dbId: 'crm-19', repoName: 'psae-internal', repoPath: '/src/psae-internal', branch: '19.0-bunka' }
        ]);
    });

    test('leaves databases on unrelated versions alone', () => {
        const plan = buildUpgradePlan(input({
            existingVersions: ['17.0', '19.0'],
            versionIdBySeries: { '17.0': 'v17', '19.0': 'v19' },
            dbs: [{ id: 'other', versionId: 'v18' }, { id: 'unassigned' }]
        }));

        assert.deepStrictEqual(plan.assignments, []);
    });

    test('the description names the versions, the repos and the mapping', () => {
        const built = input();
        const text = describeUpgradePlan(buildUpgradePlan(built), built);

        assert.ok(text.includes('17.0'));
        assert.ok(text.includes('19.0'));
        assert.ok(text.includes('psae-internal'));
        assert.ok(text.includes('one copy per branch'));
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run compile-tests && npm test`
Expected: FAIL — `Cannot find module '../services/upgradePlan'`.

- [ ] **Step 3: Write the planner**

Create `src/services/upgradePlan.ts`:

```ts
/**
 * "I am upgrading this repository from 17.0 to 19.0" is one sentence. It maps
 * onto three things that already exist: two versions, a per-branch copy of
 * the repository, and a branch mapping per database. This module does the
 * mapping; the command applies it.
 *
 * Pure: nothing here touches git, settings or the filesystem.
 */

export interface UpgradeRepo {
    name: string;
    path: string;
    fromBranch: string;
    toBranch: string;
}

export interface UpgradeInput {
    repos: UpgradeRepo[];
    fromSeries: string;
    toSeries: string;
    existingVersions: string[];
    dbs: Array<{ id: string; versionId?: string }>;
    /** Version id per series, for the series that already have one. */
    versionIdBySeries: Record<string, string | undefined>;
}

export interface UpgradePlan {
    versionsToCreate: string[];
    reposToWorktree: string[];
    assignments: Array<{ dbId: string; repoName: string; repoPath: string; branch: string }>;
}

export function buildUpgradePlan(input: UpgradeInput): UpgradePlan {
    const existing = new Set(input.existingVersions.map(entry => entry.trim()));
    const versionsToCreate = [input.fromSeries, input.toSeries]
        .filter(series => series.trim() && !existing.has(series.trim()));

    const branchForSeries = (series: string, repo: UpgradeRepo): string | undefined => {
        if (series === input.fromSeries) {
            return repo.fromBranch;
        }
        return series === input.toSeries ? repo.toBranch : undefined;
    };

    const assignments: UpgradePlan['assignments'] = [];
    for (const db of input.dbs) {
        if (!db.versionId) {
            continue;
        }
        const series = [input.fromSeries, input.toSeries]
            .find(candidate => input.versionIdBySeries[candidate] === db.versionId);
        if (!series) {
            continue;
        }
        for (const repo of input.repos) {
            const branch = branchForSeries(series, repo);
            if (branch) {
                assignments.push({ dbId: db.id, repoName: repo.name, repoPath: repo.path, branch });
            }
        }
    }

    return {
        versionsToCreate,
        reposToWorktree: input.repos.map(repo => repo.name),
        assignments
    };
}

export function describeUpgradePlan(plan: UpgradePlan, input: UpgradeInput): string {
    const versionRow = [input.fromSeries, input.toSeries]
        .map(series => plan.versionsToCreate.includes(series) ? `Odoo ${series} (will be built)` : `Odoo ${series} (exists)`)
        .join(', ');

    const mapping = input.repos
        .map(repo => `${repo.fromBranch} → ${input.fromSeries}, ${repo.toBranch} → ${input.toSeries}`)
        .join('; ');

    return [
        `Versions: ${versionRow}`,
        `Custom code: ${plan.reposToWorktree.join(', ')} — one copy per branch`,
        `Branches: ${mapping}`
    ].join('  •  ');
}
```

- [ ] **Step 4: Write the command**

Create `src/commands/upgradeCommand.ts`. It asks for the repositories and the two branches, shows the plan, and applies it. Repository mode changes route through the existing modal and source-conflict handling; nothing is written before the confirmation.

```ts
/**
 * `odoo.setUpUpgrade`: configures the versions, per-branch repository copies
 * and database branch mapping for one upgrade, from a single reviewable plan.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import type { CommandDeps } from './index';
import { SettingsStore } from '../settingsStore';
import { stripSettings, normalizePath } from '../utils';
import { showError, showInfo, showModalWarning } from '../services/notifications';
import { errorMessage, logger } from '../services/logger';
import { getRepoBranch } from '../services/branches';
import { branchToSeries } from '../services/versionProposal';
import { buildUpgradePlan, describeUpgradePlan, UpgradeInput, UpgradeRepo } from '../services/upgradePlan';
import { enqueue, readQueue, writeQueue, setQueueSnapshot, drainProvisionQueue } from '../services/provisionQueue';
import { sanitizeProjectRepoBranchAssignments } from '../services/environment';
import { RepoModel } from '../models/repo';

export function registerUpgradeCommand(deps: CommandDeps): void {
    const { context, versionsService, refreshAll } = deps;

    context.subscriptions.push(vscode.commands.registerCommand('odoo.setUpUpgrade', async () => {
        try {
            const result = await SettingsStore.getSelectedProject();
            if (!result) {
                return;
            }
            const { data, project } = result;

            const repos: RepoModel[] = project.repos ?? [];
            if (repos.length === 0) {
                void showError('This project has no repositories to upgrade.');
                return;
            }

            const pickedRepos = await vscode.window.showQuickPick(
                repos.map(repo => ({ label: repo.name, description: repo.path, repo, picked: true })),
                {
                    title: 'Set Up an Upgrade',
                    placeHolder: 'Which repositories are being upgraded?',
                    canPickMany: true,
                    ignoreFocusOut: true
                }
            );
            if (!pickedRepos || pickedRepos.length === 0) {
                return;
            }

            const currentBranch = await getRepoBranch(normalizePath(pickedRepos[0].repo.path));
            const fromBranch = await vscode.window.showInputBox({
                title: 'Upgrading from',
                prompt: 'The branch your custom code is on today',
                value: currentBranch ?? '',
                ignoreFocusOut: true,
                validateInput: value => branchToSeries(value) ? undefined : 'Must name an Odoo series, e.g. "17.0-client".'
            });
            if (!fromBranch) {
                return;
            }

            const toBranch = await vscode.window.showInputBox({
                title: 'Upgrading to',
                prompt: 'The branch the upgraded code lives on',
                ignoreFocusOut: true,
                validateInput: value => branchToSeries(value) ? undefined : 'Must name an Odoo series, e.g. "19.0-client".'
            });
            if (!toBranch) {
                return;
            }

            const fromSeries = branchToSeries(fromBranch)!;
            const toSeries = branchToSeries(toBranch)!;
            if (fromSeries === toSeries) {
                void showError('The two branches are on the same Odoo series; there is nothing to run side by side.');
                return;
            }

            const upgradeRepos: UpgradeRepo[] = pickedRepos.map(pick => ({
                name: pick.repo.name,
                path: pick.repo.path,
                fromBranch: fromBranch.trim(),
                toBranch: toBranch.trim()
            }));

            const versionIdBySeries: Record<string, string | undefined> = {};
            for (const version of versionsService.getVersions()) {
                versionIdBySeries[version.odooVersion] = version.id;
            }

            const input: UpgradeInput = {
                repos: upgradeRepos,
                fromSeries,
                toSeries,
                existingVersions: versionsService.getVersions().map(version => version.odooVersion),
                dbs: (project.dbs ?? []).map((db: any) => ({ id: db.id, versionId: db.versionId })),
                versionIdBySeries
            };
            const plan = buildUpgradePlan(input);

            const confirmed = await vscode.window.showQuickPick(
                [
                    { label: '$(check) Use these', detail: describeUpgradePlan(plan, input), apply: true },
                    { label: '$(x) Cancel', detail: 'Change nothing', apply: false }
                ],
                { title: `Upgrade ${upgradeRepos.map(repo => repo.name).join(', ')}: ${fromSeries} → ${toSeries}`, ignoreFocusOut: true }
            );
            if (!confirmed?.apply) {
                return;
            }

            // Versions first: the repo worktrees and assignments describe an
            // environment those versions run.
            if (plan.versionsToCreate.length > 0) {
                const queued = enqueue(
                    readQueue(context),
                    plan.versionsToCreate.map(branch => ({ branch, name: `Odoo ${branch}` }))
                );
                setQueueSnapshot(queued);
                await writeQueue(context, queued);
                void drainProvisionQueue(context, () => void refreshAll({ reason: 'ui' }));
            }

            // Mode changes keep their own confirmation: creating a per-branch
            // copy moves where the user edits that repository's code.
            for (const repo of repos.filter(entry => plan.reposToWorktree.includes(entry.name))) {
                if (repo.branchMode === 'worktree') {
                    continue;
                }
                const confirm = await showModalWarning(
                    `"${repo.name}" will get one copy per branch, created under the provisioning root. That copy becomes where you edit its code for each branch.`,
                    'Create Worktrees'
                );
                if (confirm !== 'Create Worktrees') {
                    continue;
                }
                repo.branchMode = 'worktree';
            }

            for (const assignment of plan.assignments) {
                const db = (project.dbs ?? []).find((entry: any) => entry.id === assignment.dbId);
                if (!db) {
                    continue;
                }
                const existing = sanitizeProjectRepoBranchAssignments(db.projectRepoBranches)
                    .filter(entry => entry.repoName !== assignment.repoName);
                db.projectRepoBranches = [
                    ...existing,
                    { repoName: assignment.repoName, repoPath: assignment.repoPath, branch: assignment.branch }
                ];
            }

            await SettingsStore.saveWithoutComments(stripSettings(data));
            void showInfo(`Configured the ${fromSeries} → ${toSeries} upgrade.`);
            await refreshAll();
        } catch (error) {
            logger.error('Set Up an Upgrade failed:', error);
            void showError(`Could not set up the upgrade: ${errorMessage(error)}`);
        }
    }));
}
```

Register it in `src/commands/index.ts` alongside the other registrations, and add to `package.json`:

```json
{ "command": "odoo.setUpUpgrade", "title": "Set Up an Upgrade", "category": "Odoo DevTools", "icon": "$(arrow-up)" }
```

with two menu entries — the Versions title bar and the Repos view context menu:

```json
{ "command": "odoo.setUpUpgrade", "when": "view == versionsManager", "group": "navigation@8" },
{ "command": "odoo.setUpUpgrade", "when": "view == repoSelector", "group": "1_modify@3" }
```

- [ ] **Step 5: Offer it once, in context**

A user mid-upgrade will not go looking for a command they have never seen. In
`src/extension.ts`, beside the other activation nudges, add one dismissible
offer for the state that identifies an upgrade: a repository whose branch names
a series that has no version.

```ts
/** One dismissible offer; "Later" is remembered so it never nags. */
const UPGRADE_HINT_DISMISSED_KEY = 'odooDevtools.upgradeHintDismissed';

async function promptUpgradeSetup(context: vscode.ExtensionContext): Promise<void> {
    if (context.globalState.get<boolean>(UPGRADE_HINT_DISMISSED_KEY)) {
        return;
    }

    const result = await SettingsStore.peekSelectedProject();
    if (!result) {
        return;
    }

    const existing = new Set(VersionsService.getInstance().getVersions().map(version => version.odooVersion));
    if (existing.size === 0) {
        // Nothing is set up yet; the first-run prompt owns this moment.
        return;
    }

    for (const repo of result.project.repos ?? []) {
        const branch = await getRepoBranch(normalizePath(repo.path));
        const series = branch ? branchToSeries(branch) : undefined;
        if (!series || existing.has(series)) {
            continue;
        }

        const choice = await showInfo(
            `"${repo.name}" is on ${branch}, but there is no Odoo ${series} version.`,
            'Set Up an Upgrade',
            'Later'
        );
        if (choice === 'Set Up an Upgrade') {
            await vscode.commands.executeCommand('odoo.setUpUpgrade');
        } else if (choice === 'Later') {
            await context.globalState.update(UPGRADE_HINT_DISMISSED_KEY, true);
        }
        return;
    }
}
```

Call it from activation as `promptUpgradeSetup(context).catch(error => logger.debug('Upgrade hint failed:', error));`.

- [ ] **Step 6: Verify and commit**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: PASS — 215 passing.

```bash
git add src/services/upgradePlan.ts src/commands/upgradeCommand.ts src/commands/index.ts src/test/upgradePlan.test.ts src/extension.ts package.json
git commit -m "[ADD] Set Up an Upgrade: versions, per-branch code and branch mapping in one plan"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Update the changelog**

Under the unreleased/1.3.0 heading, in `### Added`:

```markdown
- **Setup offers the versions to build.** Finishing setup now asks which Odoo versions you want, with the list derived from your own repositories' branches and the source repo's real branch list rather than a hardcoded table. The first is built while you wait; the rest are queued and built one at a time, resuming after a window reload, with `building…` and `queued` shown on the version rows.
- **Setup records where your custom addons live**, so creating a project finds your repositories instead of failing on a path nobody configured. Leaving it unset is allowed; the repository picker then offers to browse.
- **Set Up an Upgrade** configures a whole upgrade from one confirmation: both versions, one copy per branch of the repositories being upgraded, and the branch each database maps to.
- **Versions built before provisioning are offered a migration** instead of being left to fail later. A version running out of the source repository is now reported as unsafe rather than merely relocated, because switching that repository's branch changes what it runs.
```

In `### Fixed`:

```markdown
- The first branch pick after setup lists the source repository's branches instead of falling back to a free-text box.
- Cloning during setup no longer asks for a branch or clone depth: the clone is only ever a worktree source.
- A background refresh no longer raises "create a project first" on an install that has no projects yet.
- Starting the server reports what is actually wrong - an unprovisioned version or an unselected database - instead of VS Code's generic launch failure.
```

- [ ] **Step 2: Update the README**

In the versions section, after the existing provisioning bullets:

```markdown
- **Setup offers to build several versions at once.** The list comes from your repositories' branches and the source repo's branches, not a fixed table. The first is built while you wait; the rest queue up and build one at a time, surviving a window reload.
- **Set Up an Upgrade** (Versions view title bar) configures both versions, per-branch copies of the repositories being upgraded, and each database's branch mapping — from one plan you confirm before anything is written.
```

- [ ] **Step 3: Verify and commit**

Run: `npm run compile-tests && npm run lint && npm run compile && npm test`
Expected: PASS — 215 passing.

```bash
git add README.md CHANGELOG.md
git commit -m "[DOC] Document guided setup, the provisioning queue and Set Up an Upgrade"
```

---

## Manual verification notes

These flows touch VS Code menu wiring and git state, which the unit suite cannot reach. Verify in the Extension Development Host:

1. **Fresh setup.** Clear `odooDebugger.sourceRepo.*` and `provisioning.root` at user scope, reload, run `odoo.setup`. Expect: the summary carries a *Custom addons* row; the multi-select follows; the first version builds in the foreground; the rest show `queued` and then `building…` on their rows.
2. **Queue resumption.** Select three versions, reload the window while the second is building. Expect the drain to resume and a single summary at the end.
3. **Migration offer.** Point a version's `odooPath` at the configured source repo, reload. Expect the offer; *Later* must not reappear after a second reload.
4. **Upgrade flow.** On a project with one repo, run *Set Up an Upgrade* across two series. Expect the modal naming the worktree directory, the branch assignments written on the matching databases, and a dirty source checkout to be refused by name.
5. **Dead ends.** With no projects, run any module command and Start Server; every message must carry a working button.
