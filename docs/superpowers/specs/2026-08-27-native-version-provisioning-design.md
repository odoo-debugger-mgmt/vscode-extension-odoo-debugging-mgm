# Native Version Provisioning

**Date:** 2026-08-27
**Branch:** v-1.3
**Approved direction:** Worktree-backed parallel versions · per-version interpreter chosen from the branch's own declared requirements · `uv` with reuse of existing interpreters · managed root layout · system dependencies detected and explained, never installed silently · one provisioning flow replacing the split between `Setup Odoo` and `Create Version`.

## Problem

A Version is a settings profile bound to a branch, but nothing ensures the environment that profile points at actually exists or is correct.

- **Versions cannot run in parallel.** `alignEnvironment` checks out the target branch into shared repo folders, so `./odoo` is on one branch at a time. Comparing an upgrade side by side — 17.0 and 18.0 up at once against the same customer data — is impossible.
- **Every version shares one interpreter.** `Setup Odoo` creates a single `venv/` from whatever `python3` resolves to. The observed result on a real machine: `odoo-venv-17.0`, `odoo-venv-18.0` and `odoo-venv` all running Python 3.14.4, while 17.0 upstream targets 3.10.
- **`setupPythonEnvironment` is fire-and-forget.** It writes commands into a terminal and returns immediately (`odooInstaller.ts:200`). The `fs.existsSync(venvPython)` check that follows (`odooInstaller.ts:235`) therefore runs before `python -m venv` has finished, so new version profiles usually get no `pythonPath` at all. Failures are invisible to the extension.
- **Directory names are hardcoded.** Clones always land in `<baseDir>/odoo`, `<baseDir>/enterprise`, `<baseDir>/venv`, so a second version collides with the first.
- **Two overlapping setup commands.** `Setup Odoo` clones and builds an environment; `Create Version` makes a profile that assumes one already exists. Neither owns the whole job.
- **Non-Python dependencies are invisible.** A missing `wkhtmltopdf` surfaces as a failed PDF report at runtime with nothing connecting it to setup.

Docker solves all of this by making the code tree, interpreter and packages one immutable image. The goal here is the same seamlessness natively.

## Design

### Mental model

**A Version owns its environment.** Provisioning gives a version its own git worktree, its own interpreter chosen from what that branch declares it needs, and its own venv. Versions stop competing for one checkout, so `alignEnvironment` has nothing left to check out for a provisioned version.

**Provisioned-ness is a fact about the filesystem, not stored state.** Provisioning probes what exists, plans only the missing steps, and executes those — the same compute-diff-then-apply shape as `alignEnvironment` and `reconcile`. Re-running after a failure resumes; an environment the user built by hand is adopted rather than rebuilt.

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

`git worktree add <destPath> <branch>`, with three cases that must be handled explicitly:

- **Branch absent from a shallow clone.** `Setup Odoo` recommends `--depth 1 --single-branch`, so this is the common case. `git fetch --depth 1 origin <branch>:<branch>` first — valid on a shallow clone and cheap — then add the worktree.
- **Branch already checked out in the main clone.** Git refuses the same branch in two worktrees. Detect via `git worktree list --porcelain`, and use the existing path as this version's path instead of failing.
- **Destination exists.** If it is already a worktree of this repo on this branch, adopt it. Otherwise report a conflict and stop; never delete user directories.

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

**Ranking** is pure logic and unit-tested. With `preferredPython` known: exact match, then newest at or above the floor and at or below preferred, then newest above preferred (usable, warned), then anything below the floor (unusable). With `preferredPython` undefined, the floor alone governs — newest at or above it wins, and no mismatch warning is issued. The warning names the mismatch — *"17.0 targets Python 3.10; using 3.14"* — which is precisely the condition currently silent on the reference machine.

**`ensureUv`** returns `uv` from `odooDebugger.provisioning.uvPath` if set, else from `PATH`, else downloads the pinned release for the current platform into `context.globalStorageUri`, verifying the SHA-256 published with the release asset. `odooDebugger.provisioning.autoDownloadUv` (default `true`) disables the download for offline or restricted environments.

**`ensureInterpreter`** returns the best ranked interpreter when one is at or above the floor. Otherwise, with uv available, `uv python install <preferred>`. With no acceptable interpreter and no uv, it fails with the specific missing version named.

**Venv and requirements** use `uv venv --python <path>` and `uv pip install -r requirements.txt` when uv is present, otherwise `<python> -m venv` and `<venv>/bin/pip install -r`. Both are awaited through `runCommand` with `token` and `onStderrLine` wired to the progress reporter. uv's global cache hardlinks wheels, so shared dependencies are not re-downloaded per version.

Windows uses `Scripts\python.exe` and `Scripts\pip.exe`, consistent with `createVersionForClone`'s existing handling.

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

Provisioning writes real values into fields `VersionSettings` already has: `odooPath`, `enterprisePath`, `designThemesPath`, `pythonPath`. **No migration is required** — existing versions keep working untouched, and provisioning one is an offered upgrade.

One additive optional field:

```ts
managedPaths?: string[];   // absolute paths this extension created
```

Defaults to `[]` through the existing partial-merge in `VersionModel`'s constructor, so stored versions without it load unchanged. It exists so **Delete Version** can offer to remove what the extension created and never offers to delete a hand-made checkout.

### 8. Command flow

`Create Version` becomes the provisioning flow:

1. **Branch** quick-pick (unchanged source: `getBranchesWithMetadata` on the configured `odooPath`, with a manual-entry row).
2. **Name** input, pre-filled `Odoo {branch}` (unchanged).
3. **Plan preview** — a quick-pick summarizing what will be created and what is already satisfied, with *Provision* / *Profile only* / *Cancel*. *Profile only* preserves today's metadata-only behavior.
4. Awaited provisioning with per-step progress.
5. Version profile written with the resolved paths; the existing *Set Active* offer follows.

`Setup Odoo` becomes the first-run entry point: when no odoo repository is configured or found, it clones one and continues into the same provisioning flow. The clone-only branch and its follow-up offers are retained.

### Out of scope

Projects, Repos, Modules, Testing and the debugger are untouched — they operate on host addons folders and are unaffected by which worktree a version points at. `alignEnvironment` is not modified; it naturally becomes a no-op for provisioned versions because their branches are already correct. Docker as an alternative runtime is a separate decision.

## Error handling

- Hard failures stop the plan and leave completed steps intact. Because `planProvision` re-probes, re-running resumes rather than restarting.
- Cancellation is honored between steps and inside `runCommand` via `token`; partial results are reported, never silently discarded.
- Requirements-derivation failures fall back to the floor `(3, 10)` with `source: 'fallback'` surfaced in the summary, rather than blocking.
- Interpreter mismatches above the preferred version are warnings, not errors — provisioning continues.
- Doctor findings never block and never fail the run.
- uv download failure falls back to discovered interpreter plus stdlib `venv`/`pip`, with the degradation stated in the summary.
- Worktree conflicts report the conflicting path and stop; no user directory is deleted.
- All diagnostics go to the existing **Odoo DevTools** output channel via `logger`.

## Testing

Pure logic gets unit tests alongside the existing `src/test` suites:

- `odooRequirements.test.ts` — floor from `setup.py` literal, floor from `release.py` `MIN_PY_VERSION`, fallback when neither parses; preferred-Python derivation from real 17.0 / 18.0 / 19.0 header fixtures; unrecognized header yields no preferred version.
- `pythonToolchain.test.ts` — interpreter ranking across exact-preferred, above-preferred, at-floor and below-floor candidates; Windows path construction.
- `systemDeps.test.ts` — probe result to impact and platform install-hint mapping.
- `provisioning.test.ts` — plan construction marks satisfied steps correctly and a fully satisfied plan produces no work.

Subprocess-bound code (git, uv, pip) stays thin and is not unit-tested, consistent with `postgres.ts` and `dumpImport.ts`.

`npm run lint`, the webpack compile and the `tsc` test compile must pass.
