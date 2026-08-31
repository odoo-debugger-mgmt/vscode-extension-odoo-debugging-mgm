# Native Version Provisioning

**Date:** 2026-08-27
**Branch:** v-1.3
**Approved direction:** Worktree-backed parallel versions · per-version interpreter chosen from the branch's own declared requirements · `uv` with reuse of existing interpreters · managed root layout · system dependencies detected and explained, never installed silently · one provisioning flow replacing the split between `Setup Odoo` and `Create Version` · derived, read-only debugger identity so versions can run concurrently · a single post-switch hook list · running-state indicators in the Databases view.

## Problem

A Version is a settings profile bound to a branch, but nothing ensures the environment that profile points at actually exists or is correct.

- **Versions cannot run in parallel.** `alignEnvironment` checks out the target branch into shared repo folders, so `./odoo` is on one branch at a time. Comparing an upgrade side by side — 17.0 and 18.0 up at once against the same customer data — is impossible.
- **Every version shares one interpreter.** `Setup Odoo` creates a single `venv/` from whatever `python3` resolves to. The observed result on a real machine: `odoo-venv-17.0`, `odoo-venv-18.0` and `odoo-venv` all running Python 3.14.4, while 17.0 upstream targets 3.10.
- **`setupPythonEnvironment` is fire-and-forget.** It writes commands into a terminal and returns immediately (`odooInstaller.ts:200`). The `fs.existsSync(venvPython)` check that follows (`odooInstaller.ts:235`) therefore runs before `python -m venv` has finished, so new version profiles usually get no `pythonPath` at all. Failures are invisible to the extension.
- **Directory names are hardcoded.** Clones always land in `<baseDir>/odoo`, `<baseDir>/enterprise`, `<baseDir>/venv`, so a second version collides with the first.
- **Two overlapping setup commands.** `Setup Odoo` clones and builds an environment; `Create Version` makes a profile that assumes one already exists. Neither owns the whole job.
- **Non-Python dependencies are invisible.** A missing `wkhtmltopdf` surfaces as a failed PDF report at runtime with nothing connecting it to setup.
- **Versions cannot be told apart by the debugger.** Every version inherits `debuggerName: "odoo:19.0"` from the shared default, and the managed launch entry is matched by name, so two versions overwrite each other's configuration. Renaming that single entry on every switch is also what made the Run and Debug dropdown point at a stale configuration.
- **Session handling assumes exactly one server.** `isOwnSession` compares against the active version's name and `findOwnDebugSession` reads `activeDebugSession`, so a second running instance cannot be tracked or stopped correctly.
- **Per-version hooks do not work.** `checkoutCoreRepos` reads `preCheckoutCommands` / `postCheckoutCommands` from global configuration, so the identically-named fields on `VersionSettings` — editable in the Versions tree — are never read. Project repos receive no hooks at all.
- **Nothing shows what is running.** With one server at a time this was implicit; with several it is not.

Docker solves all of this by making the code tree, interpreter and packages one immutable image. The goal here is the same seamlessness natively.

## Design

### Mental model

**A Version owns its environment.** Provisioning gives a version its own git worktree, its own interpreter chosen from what that branch declares it needs, and its own venv. Versions stop competing for one checkout, so `alignEnvironment` has nothing left to check out for a provisioned version.

**Provisioned-ness is a fact about the filesystem, not stored state.** Provisioning probes what exists, plans only the missing steps, and executes those — the same compute-diff-then-apply shape as `alignEnvironment` and `reconcile`. Re-running after a failure resumes rather than restarting, and anything already present at a version's own paths is reused rather than rebuilt. Paths *outside* those — the user's own checkouts, the source repository — are never claimed; *Profile only* (§8) exists for anyone who has set an environment up by hand and just wants the profile.

### 1. Requirements derivation — `src/services/odooRequirements.ts`

Reads a checkout and returns what that branch needs. Pure logic over file contents, no execution.

```ts
interface OdooPythonWindow {
    series: string;            // "17.0" — cross-check only; branch name wins
    minPython: [number, number];
    preferredPython?: [number, number];
    source: 'setup.py' | 'release.py' | 'fallback';
}
readOdooPythonWindow(odooPath: string): Promise<OdooPythonWindow>
```

**Floor** (`minPython`), in order:

1. `setup.py` → literal `python_requires='>=3.10'`. Present in 17.0 and 18.0.
2. `odoo/release.py` → `MIN_PY_VERSION = (3, 10)`. Present in 19.0, where `setup.py` computes `python_requires` from it rather than stating a literal.
3. Neither parses → `(3, 10)`, flagged `source: 'fallback'`.

**Preferred** (`preferredPython`): `requirements.txt`'s header comment names the distributions Odoo targets for that branch —

```
# The officially supported versions of the following packages are their
# python3-* equivalent distributed in Ubuntu 22.04 and Debian 11
```

Parse the named releases, map each to its default `python3`, and take the newest:

| Distribution | Default Python |
| --- | --- |
| Ubuntu 20.04 | 3.8 |
| Ubuntu 22.04 | 3.10 |
| Ubuntu 24.04 | 3.12 |
| Debian 11 | 3.9 |
| Debian 12 | 3.11 |
| Debian 13 | 3.13 |

Verified against the live repository: 17.0 → Ubuntu 22.04 / Debian 11 → **3.10**; 18.0 and 19.0 → Ubuntu 24.04 / Debian 12 → **3.12**.

This table describes distributions, not Odoo, so it changes only when a new LTS ships — not on every Odoo release. Unrecognized or absent header: `preferredPython` is undefined and the floor alone governs.

**Explicitly rejected:** deriving a ceiling from `python_version` environment markers in `requirements.txt`. Measured across 17.0, 18.0 and 19.0, the highest marker is `3.14` in all three, so markers carry no per-branch signal.

### 2. Worktrees — `src/services/worktree.ts`

```ts
ensureWorktree(repoPath: string, branch: string, destPath: string): Promise<WorktreeResult>
```

**The source repository is only ever a source.** A version never runs out of it, even when it happens to sit on the right branch: that directory is user-controlled and can be switched away underneath the version, which would leave a "19.0" version silently running 17.0 code.

Git refuses to check the same branch out in two worktrees, so every managed worktree gets its own local branch `odt/<branch>`, created from `refs/remotes/origin/<branch>` — branching from a remote-tracking ref sets upstream, so `git pull` works inside the worktree. The name is unconditional on purpose: choosing it only on collision would make provisioning depend on whatever the source repo happened to be checked out on at the time.

Cases handled explicitly:

- **Branch absent from a shallow clone.** `Setup Odoo` recommends `--depth 1 --single-branch`, so this is the common case. `git fetch --depth 1 origin +refs/heads/<branch>:refs/remotes/origin/<branch>` first — valid and cheap on a shallow clone, and the explicit refspec also works on a single-branch clone, where the default one would not fetch it. Falls back to a local `<branch>` when there is no remote.
- **Managed branch left over** from a previously removed worktree: reused rather than recreated, since `git worktree add -b` refuses an existing name.
- **Destination already a worktree:** adopted — this is the "already provisioned" case. Only the destination is ever adopted; a worktree elsewhere holding the branch is deliberately not reused.
- **Destination exists but is not a worktree:** report a conflict and stop; never delete user directories.

Because a managed worktree reports `odt/19.0` while its version targets `19.0`, `branchSatisfiesTarget(current, target)` treats both as correct. Without it the environment diff (§9) would ask git to check out `19.0` inside the worktree, which fails while the source repo holds that branch — reintroducing the very problem this removes.

Removing a version's worktree also deletes its managed branch: `git worktree remove` leaves it behind.

Worktrees share the repository object store, so each additional version costs one working tree rather than a full clone.

### 3. Python toolchain — `src/services/pythonToolchain.ts`

```ts
discoverInterpreters(): Promise<InterpreterInfo[]>
rankInterpreters(found: InterpreterInfo[], window: OdooPythonWindow): InterpreterInfo[]
ensureUv(): Promise<string | undefined>
ensureInterpreter(window: OdooPythonWindow, token): Promise<string>
ensureVenv(pythonPath: string, venvPath: string, token): Promise<string>
installRequirements(venvPath: string, requirementsPath: string, progress, token): Promise<void>
```

**Discovery** scans `python3.<minor>` on `PATH`, `~/.pyenv/versions/*/bin/python`, and platform-standard locations, reading each one's version via `--version`.

**Ranking** is pure logic and unit-tested. With `preferredPython` known: exact match, then newest at or above the floor and at or below preferred, then — above preferred — the **closest** rather than the newest, since running a branch far above the Python it was written for fails at server initialization. Anything below the floor is unusable. With `preferredPython` undefined, the floor alone governs — newest at or above it wins, and no mismatch warning is issued. The warning names the mismatch — *"17.0 targets Python 3.10; using 3.14"* — which is precisely the condition currently silent on the reference machine.

**`ensureUv`** returns `uv` from `odooDebugger.provisioning.uvPath` if set, else from `PATH`, else downloads the pinned release for the current platform into `context.globalStorageUri`, verifying the SHA-256 published with the release asset. `odooDebugger.provisioning.autoDownloadUv` (default `true`) disables the download for offline or restricted environments.

**`ensureInterpreter`** returns the best ranked interpreter when one is at or above the floor. Otherwise, with uv available, `uv python install <preferred>`. With no acceptable interpreter and no uv, it fails with the specific missing version named.

**Venv and requirements** use `uv venv --python <path>` and `uv pip install -r requirements.txt` when uv is present, otherwise `<python> -m venv` and `<venv>/bin/pip install -r`. Both are awaited through `runCommand` with `token` and `onStderrLine` wired to the progress reporter. uv's global cache hardlinks wheels, so shared dependencies are not re-downloaded per version.

Windows uses `Scripts\python.exe` and `Scripts\pip.exe`, consistent with `createVersionForClone`'s existing handling.

**Step-up retry.** Some pins exist only to mirror a distribution package and have no Linux wheel. Odoo 17.0's `gevent==21.8.0` (tagged `# (Jammy)`) is the canonical case: PyPI carries cp310 wheels for macOS and Windows only, and it cannot be built from source either, because its `build-system.requires` demands `cython>=3.0a9` and the Cython 3.0 alphas have been removed from PyPI. Since the exact distro target is precisely where this bites, a failed requirements install retries **once** on the next interpreter above, rebuilding the virtualenv and recording which Python was actually used. 17.0's pins for 3.11 and 3.12 both resolve cleanly.

### 4. System dependency doctor — `src/services/systemDeps.ts`

```ts
interface SystemDepReport { id: string; present: boolean; impact: string; installHint?: string }
checkSystemDeps(venvPath?: string): Promise<SystemDepReport[]>
```

Probes, each mapped to a plain-language consequence:

| Check | Method | Impact when missing |
| --- | --- | --- |
| `wkhtmltopdf` | `wkhtmltopdf --version` | PDF reports fail; everything else works |
| `psql` / `createdb` / `dropdb` | on `PATH` | Database features unavailable (already a documented requirement) |
| `node` + `rtlcss` | `rtlcss --version` | Right-to-left stylesheets not generated |
| `lxml`, `psycopg2`, `ldap` | import probe in the provisioned venv | Server will not start; indicates missing build headers |

`installHint` is a copy-paste command chosen by detected platform (`apt`, `dnf`, `brew`, or a documentation link on Windows). **Nothing is executed and nothing escalates privileges.** The doctor never blocks provisioning; it appends to the completion summary and is separately runnable as `Odoo DevTools: Check System Dependencies`.

The `wkhtmltopdf` check reports the patched-Qt build in its version string when present, since report fidelity depends on it.

### 5. Orchestration — `src/services/provisioning.ts`

```ts
interface ProvisionSpec {
    branch: string;
    sourceRepoPath: string;
    root: string;
    includeEnterprise: boolean;
    includeDesignThemes: boolean;
}
interface ProvisionStep { id: string; label: string; status: 'satisfied' | 'needed'; detail?: string }
planProvision(spec: ProvisionSpec): Promise<ProvisionStep[]>
executeProvision(spec, plan, progress, token): Promise<ProvisionResult>
```

Steps, in order: resolve worktree(s) → read the Python window → resolve interpreter → create venv → install requirements → run the doctor.

`planProvision` probes each step and marks it `satisfied` or `needed`; a fully satisfied plan reports "already provisioned" and performs no writes. `executeProvision` runs only the `needed` steps inside one `withProgress({ cancellable: true })`, streaming subprocess output through `onStderrLine`.

### 6. Layout

`odooDebugger.provisioning.root` (default: the parent directory of the configured `odooPath`) contains, per version:

```
<root>/odoo-<branch>/            git worktree of the odoo repo
<root>/enterprise-<branch>/      git worktree of the enterprise repo (optional)
<root>/design-themes-<branch>/   git worktree of design-themes (optional)
<root>/venv-<branch>/            virtualenv built for that branch
```

Branch names are slugified for filesystem safety: path separators and other unsafe characters become `-`, so `19.0`, `saas-19.2` and `master` are unchanged, while `feature/upgrade-17` becomes `feature-upgrade-17`.

### 7. Version model

Provisioning writes real values into fields `VersionSettings` already has: `odooPath`, `enterprisePath`, `designThemesPath`, `pythonPath`. **Provisioning itself requires no migration** — existing versions keep working untouched, and provisioning one is an offered upgrade. The two migrations this design does introduce are unrelated to paths and are described where they belong: hook renaming in §10, identity healing in §11.

Two additive optional fields, both defaulting through the existing partial-merge so stored data loads unchanged:

```ts
// VersionSettings
managedPaths?: string[];                        // absolute paths this extension created

// ProjectModel
selectedDbByVersion?: Record<string, string>;   // versionId → dbId (see §12)
```

`managedPaths` exists so **Delete Version** can offer to remove what the extension created — via `git worktree remove` plus deletion of the managed branch — and never offers to delete a hand-made checkout. Since every core worktree is now created rather than adopted, this list covers all of them.

### 8. Command flow

`Create Version` becomes the provisioning flow:

1. **Branch** quick-pick (unchanged source: `getBranchesWithMetadata` on the configured `odooPath`, with a manual-entry row).
2. **Name** input, pre-filled `Odoo {branch}` (unchanged).
3. **Plan preview** — a quick-pick summarizing what will be created and what is already satisfied, with *Provision* / *Profile only* / *Cancel*. *Profile only* preserves today's metadata-only behavior.
4. Awaited provisioning with per-step progress.
5. Version profile written with the resolved paths; the existing *Set Active* offer follows.

`Setup Odoo` becomes the first-run entry point: when no odoo repository is configured or found, it clones one and continues into the same provisioning flow. The clone-only branch and its follow-up offers are retained.

### 9. Switching model

`EnvironmentTarget` carries three jobs. Provisioning removes exactly one of them:

| Field | Meaning | Under provisioning |
| --- | --- | --- |
| `versionId` | version to activate | **unchanged** |
| `coreBranch` | branch for odoo / enterprise / design-themes | **removed** — each version owns its worktree |
| `repoAssignments` | branches for the project's custom addon repos | **unchanged** |

Core repos get one worktree per version: stable, one per series. Project repos keep checkouts: volatile, per database, and the place active editing happens — a worktree per feature branch would fragment the working copy.

Activating a provisioned version therefore performs no git operation. It cannot fail on a dirty tree, and it completes instantly. `databaseSwitchBehavior` keeps its meaning, now governing version activation and project-repo checkouts.

`computeEnvironmentDiff` gains one field, replacing the bare `coreBranch`:

```ts
coreRepoPipeline?: {
    paths: string[];         // the version's core repo (worktree) paths
    branch: string;
    needsCheckout: boolean;  // false when the worktree is already correct
}
```

It is present when **the version changed** or when a branch actually differs — the first condition is what keeps hooks firing (§10) once checkouts stop happening. `checkoutCoreRepos` is renamed `alignCoreRepos` and runs, per repo: hooks → checkout if `needsCheckout` → done. Non-provisioned versions take the identical path with `needsCheckout: true`, so their behavior is unchanged.

### 10. Hook semantics

Two defects exist today:

1. Hooks are read from global configuration — `config.get<string[]>('preCheckoutCommands')` in `checkout.ts:215` — so the `preCheckoutCommands` / `postCheckoutCommands` fields on `VersionSettings`, editable in the Versions tree, are **never read**. Per-version hooks have never worked.
2. Hooks fire only inside `checkoutCoreRepos`. `checkoutRepoBranch` does not run them, so project repos never receive hooks either.

Both are fixed by collapsing to a single list with a name that states when it runs:

```ts
postSwitchCommands: string[]
```

Resolution order: the version's `settings.postSwitchCommands`, falling back to `odooDebugger.defaultVersion.postSwitchCommands`. It runs after the environment is aligned, per core repo, with that repo as the working directory — whether or not a checkout occurred. Output continues to go to the **Odoo Debugger: Branch Hooks** channel.

`preCheckoutCommands` is **removed, not relocated**. Its purpose was guarding a checkout about to happen — the canonical entry is `git restore .`, clearing the way so the switch can proceed. Provisioning makes core switching non-destructive, so there is nothing left to guard, and the same command run *after* alignment does not guard anything: it discards uncommitted work in the worktree on every activation. A pre-checkout hook has no post-switch equivalent, so it is dropped and the user is told exactly what was dropped.

**Migration**, applied once to both global settings and every stored version:

- `postCheckoutCommands` → `postSwitchCommands`, values preserved. In settings the rename is written back to whichever scope defined it, following `migrateLegacySwitchBehaviorSetting`; an already-populated `postSwitchCommands` is never overwritten.
- `preCheckoutCommands` → **deleted**, in both places.
- When anything was dropped, one notification names the exact commands and says they ran before a branch switch, so the user can re-add any that still make sense afterwards.

### 11. Parallel execution and derived identity

Running two versions at once requires that their launch configurations not collide. Today every version inherits `debuggerName: "odoo:19.0"` from `odooDebugger.defaultVersion.debuggerName`, and `updateManagedLaunchConfig` matches by name — so two versions **overwrite each other's entry** and parallel execution silently fails.

Identity becomes derived and read-only:

| Field | Derivation |
| --- | --- |
| `debuggerName` | `${prefix}:${branch}` → `odoo:17.0` |
| `portNumber` | `8000 + major` → `8017` |
| `shellPortNumber` | `5000 + major` → `5017` |

Non-numeric series (`master`, `saas-17.4`) and collisions fall through to the next free value above the base, checked against both other versions and live sockets.

`odooDebugger.defaultVersion.debuggerName`, `.portNumber` and `.shellPortNumber` are removed; `odooDebugger.debuggerNamePrefix` (default `odoo`) replaces them. The three fields render in the Versions tree as read-only rows described as *derived from branch* — visible, not editable.

Existing versions are **healed, not rewritten**: stored values are left alone unless two versions collide on name or port, in which case the newer is re-derived and the change logged.

**Session tracking.** `isOwnSession` compares against the active version's `debuggerName` (`server.ts:69`) and `findOwnDebugSession` reads `vscode.debug.activeDebugSession` — both assume one session. They become a `Map<debuggerName, DebugSession>` fed by the existing start/terminate listeners, where "own" means *any known version's* name. `server_running` is true when the map is non-empty; Stop Server targets the active version's session, prompting when several are running.

**F5.** Because names are now stable and unique, and `updateManagedLaunchConfig` inserts rather than replaces, launch.json accumulates one durable entry per version and nothing is renamed out from under the Run and Debug dropdown — the cause of the historical "F5 starts the wrong configuration" behavior. There is no public API to set the dropdown's selection, so F5 follows the dropdown while `Ctrl+Alt+O S` follows the active version. This divergence is documented rather than hidden: it is what allows one version to be debugged from the dropdown while another is launched from the chord.

Breakpoints bind per worktree path, so they no longer bleed across versions the way they do when a shared checkout changes branch. The generated project workspace (`projectWorkspace.ts`) includes the active version's worktree folders, so files opened from it belong to the version being run.

### 12. Per-version database resolution

`prepareArgs` resolves the database globally today (`project.dbs.find(isSelected)`), so one `-d` exists per project. Module selections are already per database (`db.modules`), so they follow the database automatically once it is resolved per version.

The project gains one additive optional field:

```ts
selectedDbByVersion?: Record<string, string>;   // versionId → dbId
```

`prepareArgs` takes `(project, version)` and resolves in order: the remembered database for that version → the selected database when its `versionId` matches → the selected database. Selecting a database records it against its version.

This lets every sync write **one launch entry per provisioned version**, each carrying its own database, so the dropdown becomes a genuine version switcher and F5 is always correct. It builds on `DatabaseModel.versionId`, which already exists and is already populated by `detectOdooSeries`.

### 13. Running-state indicators

The Databases view shows which databases are live, from a service rather than tree-decoration logic, so later features can consume the same state:

```ts
// src/services/runningState.ts
interface RunningInstance {
    versionId?: string;
    debuggerName?: string;
    dbName: string;
    port?: number;
    origin: 'managed' | 'external';
}
getRunningInstances(): Promise<RunningInstance[]>
```

Two signals, merged:

- **Managed** — the session map from §11 gives the running versions; each resolves to its database through §12. Authoritative for sessions the extension started.
- **External** — `SELECT datname, count(*) FROM pg_stat_activity WHERE datname IS NOT NULL GROUP BY datname` reports databases with live backends, catching servers started from a terminal or another window. A version's port answering is a secondary hint.

Rendering follows the v1.2 rule that state is carried by icon **shape**, not color, so it survives row highlighting: `$(debug-alt)` for managed-running, `$(pulse)` for external, nothing for idle, with the port appended to the existing `•`-joined description. The green check for *selected* is unchanged and orthogonal.

Refresh is event-driven — the existing debug start/terminate listeners already fire — with the PostgreSQL probe cached in `runtimeCache` under a short TTL and refreshed when the view is expanded. No background polling.

### Out of scope

Projects, Repos, Modules and Testing are untouched — they operate on host addons folders and are unaffected by which worktree a version points at. Docker as an alternative runtime is a separate decision. Split-view comparison of two running instances is out of scope; §13 exists so that it has a state source when it is designed.

## Error handling

- Hard failures stop the plan and leave completed steps intact. Because `planProvision` re-probes, re-running resumes rather than restarting.
- Cancellation is honored between steps and inside `runCommand` via `token`; partial results are reported, never silently discarded.
- Requirements-derivation failures fall back to the floor `(3, 10)` with `source: 'fallback'` surfaced in the summary, rather than blocking.
- Interpreter mismatches above the preferred version are warnings, not errors — provisioning continues.
- Doctor findings never block and never fail the run.
- uv download failure falls back to discovered interpreter plus stdlib `venv`/`pip`, with the degradation stated in the summary.
- Worktree conflicts report the conflicting path and stop; no user directory is deleted.
- `postSwitchCommands` failures are reported per repo and do not roll back an activation that already succeeded, matching today's post-checkout behavior.
- Identity collisions are healed silently and logged; they never block activation.
- Stop Server with several sessions running prompts for which to stop rather than guessing.
- The `pg_stat_activity` probe is best-effort: on failure, running state degrades to managed sessions only, with no error surfaced.
- All diagnostics go to the existing **Odoo DevTools** output channel via `logger`.

## Testing

Pure logic gets unit tests alongside the existing `src/test` suites:

- `odooRequirements.test.ts` — floor from `setup.py` literal, floor from `release.py` `MIN_PY_VERSION`, fallback when neither parses; preferred-Python derivation from real 17.0 / 18.0 / 19.0 header fixtures; unrecognized header yields no preferred version.
- `pythonToolchain.test.ts` — interpreter ranking across exact-preferred, above-preferred, at-floor and below-floor candidates; Windows path construction.
- `systemDeps.test.ts` — probe result to impact and platform install-hint mapping.
- `provisioning.test.ts` — plan construction marks satisfied steps correctly and a fully satisfied plan produces no work.
- `versionIdentity.test.ts` — name and port derivation for numeric series, `master` and `saas-*`; collision fallback; healing leaves non-colliding legacy values untouched.
- `hookMigration.test.ts` — `postCheckoutCommands` renamed with values preserved; non-empty `preCheckoutCommands` prepended and the old key removed; already-migrated input is a no-op.
- `dbResolution.test.ts` — resolution order across remembered, version-matched and fallback databases, including a version with no database at all.
- `runningState.test.ts` — merging managed sessions with external connection rows, including the same database appearing in both.

Existing suites that must be updated rather than added to: `launchConfig.test.ts` gains a case proving two differently-named managed entries coexist without either being removed.

Subprocess-bound code (git, uv, pip) stays thin and is not unit-tested, consistent with `postgres.ts` and `dumpImport.ts`.

`npm run lint`, the webpack compile and the `tsc` test compile must pass.
