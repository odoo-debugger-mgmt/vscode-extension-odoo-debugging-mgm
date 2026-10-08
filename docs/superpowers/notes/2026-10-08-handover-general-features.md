# Handover: general features on v-1.5 (2026-10-08)

Read this first. Then read the two specs in §3, and `2026-10-06-view-doctor-handover-stage-4.md` for the View Doctor side of this branch.

## 1. Ground rules (from the user, still in force)

- **Branch `v-1.5`.** Never merge it, never push it, and never offer to; it stays its own branch. The extension never runs `git commit` for the user.
- **The user is often away.**
  - Don't ask for permission mid-task. Make rulings and record each one as *decision — why — cost if wrong*. List every ruling in your final message.
  - Stop only for something destructive, a security concern, or an external side effect.
- **Approval gates still apply.** Implementation starts only after the user approves the written spec and then the plan (superpowers brainstorming → writing-plans). In the last session the user chose subagent-driven development: a fresh implementer per task, a task review per task, and a final whole-branch review on the most capable model.
- **Verify for real, not only with unit tests.** That means the gated integration tests where they apply, plus a live window check under Xvfb for anything that touches menus, trees or launch.json. The user has caught menu-wiring bugs that unit tests missed.
- **Leave alone:**
  - the uncommitted `.vscode/launch.json` and `.vscode/tasks.json`, which are the user's edits;
  - the untracked dotfiles in the repo root (`.claude/`, `.mcp.json`, `.bashrc`, …). Never stage them.

## 2. What the user asked for on 2026-10-07, and where each item stands

| # | Request | State |
|---|---|---|
| 1 | Make the debugger name and ports manually overridable; warn on conflicts. The debugger name was the real pain point: people want F5 to rerun the server, or run it on another database | **Done**: 2d7f9f6, f1a21aa |
| 2 | Database checkpoints: copies kept as real PG databases, fast to restore ("templates would help") | **Spec written; the user has not reviewed it yet** |
| 3 | Compare old against new code at several levels (file, method, record, …) | **Spec written** (combined with 4 and 5); not reviewed |
| 4 | Expose "upgrade" features to workspaces in general | Same spec, Part B |
| 5 | Several DBs per version, several projects. *"We should be able to run multiple servers. Comparison can be restricted to 2."* | Same spec, Part A |
| 6 | Module dependency view: expand deeper levels, fetched on demand | **Done**: 26ec0e1 |

The user's answers on 2026-10-07:
- keep everything on v-1.5;
- item 6's design is approved;
- for item 2, stopping the server (after asking) is fine;
- items 3–5 go in one spec;
- "do what you see fits" on order.

## 3. Next step: the two specs are waiting on the user

- `docs/superpowers/specs/2026-10-07-database-checkpoints-design.md`
- `docs/superpowers/specs/2026-10-07-compare-and-multi-server-design.md`

Each spec ends with a rulings table the user may override.

**Before you write a plan,** the user must say they have reviewed the spec. Fold in any changes they ask for, then use superpowers:writing-plans and save to `docs/superpowers/plans/<date>-<topic>.md`.

**Recommended order:**
1. Checkpoints.
2. Compare spec, Part A (servers keyed by database).
3. Part B (the comparison partner). It uses a checkpoint as a partner, and Render needs Part A's Run Alongside.
4. Part C (compare).

Each part ships on its own.

**Facts the checkpoint spec rests on** (verified in code, 2026-10-07):
- Clone and Templates use `createdb -T` and **never copy the filestore**. No code in `src/` mentions the filestore or the data dir.
- They fail while a server is connected, because `releaseDatabase` only ends View Doctor shells.
- The Databases tree (`src/views/dbsView.ts`) is flat: `getChildren` ignores `element` and `getParent` returns undefined. Checkpoint rows need both handled. Remember the recursion trap.
- Local PostgreSQL is 17.6 (`psql` client 18.6), so `STRATEGY FILE_COPY` is available.

## 4. What was built (items 1 and 6)

### Item 6: deep dependencies (26ec0e1)

- `src/services/moduleDependencies.ts`:
  - `ModuleLocator` resolves a name to a module folder. It looks in core addons first, in `--addons-path` order (enterprise, themes, `odoo/odoo/addons`, `odoo/addons`), then in the project's repos.
  - `dependencyExpansion()` returns `expandable`, `cycle` or `missing`.
  - Lookups are lazy, one name per expand, cached per tree build. Names that aren't plain folder names are never looked up.
- `src/module.ts`: dependency rows carry `dependency: { path, branch }`. Their ids chain from the parent (`<parent>::dep::<name>`). Descriptions: `project module`, `core` or `not found`, plus ` • cycle`.

### Item 1: editable identity (2d7f9f6, f1a21aa)

- `settings.customIdentity?: IdentityKey[]` lists the keys the user set by hand.
- `src/services/versionIdentity.ts`:
  - `customKeys`, `automaticPart`;
  - `healIdentities`: values set by hand are reserved first and never patched, and automatic ones move off them. Patches are now `Partial<VersionIdentity>`;
  - `identityConflicts`;
  - `sessionOwner`: a shared name belongs to the active version, else the oldest.
- `VersionsService`:
  - `setIdentityValue` heals right away and returns `{ conflicts, moved }`;
  - `resetIdentityValue`;
  - `identityConflictsOf`;
  - `rederiveIdentity` (branch change) keeps values set by hand;
  - `cloneVersion` drops them.
- `debugger.ts`:
  - `launchCandidates()`;
  - `setupDebugger` writes **one entry per shared name**, for its owner;
  - `startServerForVersion` refuses a version that is not the owner of its shared name, and names which running version holds a port;
  - `dropUnusedLaunchEntry(name)` runs after a rename.
- `debugSessions.ts`:
  - `trackSession(session, versionId)` and `versionIdOfSession(name)`;
  - `runningState.collectManaged` iterates sessions, not versions.
- UI:
  - identity rows read `automatic` or `set by you`, with contextValue `versionSettingIdentity` / `versionSettingIdentityCustom`;
  - **Make Automatic Again** (`odoo.makeIdentityAutomatic`) is on custom rows only, hidden in the palette, and guarded in upgrade mode;
  - Start Both Servers refuses a pair that shares a name or port.
- Rulings:
  - a shared name means one launch entry that follows the active version;
  - a clone gets fresh automatic values;
  - Start Both refuses a shared pair.

### Verification done

- Unit suite: **862 passing, 26 pending, 0 failing**.
- Lint: 0 errors, 117 warnings, which is the baseline.
- Live Xvfb check, 10 of 10 pass:
  - the automatic and set-by-you rows;
  - the moved-off toast;
  - the conflict warning;
  - one shared `Odoo` entry that follows the active version;
  - F5 running the active version's src and DB;
  - Make Automatic Again only on custom rows;
  - deep dependencies, cycle and not-found rows.
- The fixture stays at `/tmp/claude/odt5`: fake 17/18 Odoo trees with a stub `odoo-bin`, the `ws/acme` repo with a deliberate cycle, and screenshots in `shots/`.

## 5. How to verify (unchanged recipe)

- `npx tsc -p . --noEmit`, then `npm run lint`.
- `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test [--grep "<suite>"]`, run **outside the sandbox**.
- `npm run compile` for dist/. Commit dist with the feature, or run `git checkout -- dist`.
- The Xvfb live-window recipe is in the memory file `odoo-debugger-verification.md`:
  - scratch HOME, `env -i`;
  - copy ms-python extensions into the scratch HOME;
  - replace `odoo-bin` with a stub that logs argv;
  - "Debug: Start Debugging" from the palette, not F5;
  - filter `ps` on `comm != bash` before killing.
- The gated real-Odoo suites, and building `odt_view_base_*`, are in the stage 1 and stage 4 handovers. Drop the databases when done.

## 6. Open items, not started

- **About 250 extension-host warnings** "Accessing a resource scoped configuration without providing a resource" for `odooDebugger.search.*`, from `src/utils.ts:231`. They predate this work. It's a small fix if the user wants it.
- **Still the user's to delete:** the four Odoo session files from the stage 4 live check, listed in the stage 4 handover.
- **Not verified live:** Windows, Odoo 15/16, and remote windows. The handovers list these.
