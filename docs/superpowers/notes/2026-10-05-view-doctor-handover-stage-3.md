# View Doctor — handover after stage 2 (2026-10-05)

Read this before touching the View Doctor. It covers:
- what exists;
- what stage 3 is;
- the traps already paid for;
- how to verify;
- how the maintainer wants the work run.

The stage 1 handover (`docs/superpowers/notes/2026-10-05-view-doctor-handover.md`) is still accurate for what it describes. This note adds stage 2 and briefs stage 3. Where they differ, this one wins.

## 1. Where things stand

- **Repo:** `/home/odoo/Dev/vscode-extension-odoo-debugger`, branch **`v-1.5`**, head **`f586ca7`** at handover.
  - `v-1.5` stays its own branch. **Never merge it into `v-1.4` or anything else, never push, and never offer to.** Skip the "finish the branch" step of any workflow that would offer a merge, a push or a PR.
- **Spec (the authority):** `docs/superpowers/specs/2026-10-02-view-doctor-design.md`. **§5 is stage 3.** §1 ("viewNotes.ts") describes the note stage 3 needs.
- **Plans, both done:**
  - `docs/superpowers/plans/2026-10-02-view-doctor-stage-1.md`
  - `docs/superpowers/plans/2026-10-05-view-doctor-stage-2.md`, whose 22 rulings still bind the code they shaped.
- **What the feature is:** odoo-manager's view fixer (`/home/odoo/Dev/odoo-manager`) brought natively into the extension, with no webserver.

The user's four requests:

| # | Request | Status |
|---|---|---|
| 1 | See which views are disabled | **Done** (Views tree, stage 1) |
| 2 | Side by side | **Done** (Compare with Original + Render, stage 2) |
| 3 | Change the arch directly | **Done** (`odoo-view:` files, stage 1) |
| 4 | Upgrade script from the changes | **Next: stage 3** |

Choices the user made, which are not up for re-litigation:
- **Where the script goes:** a module's `migrations/<version>/` folder chosen through a picker that also offers an untitled editor.
- **The extension never runs `git commit`.** An auto-commit with a message template was discussed and explicitly dropped.
- **The tree** lists upgrade-disabled views first, then all other inactive views.
- **The "view vs its parent" diff** is out of scope.

## 2. What exists (stage 1 + stage 2)

Stage 1's pieces are listed in the stage 1 handover §2. Stage 2 added:

| File | What it is |
|---|---|
| `resources/scripts/view_worker.py` | New commands. `new_session` mints an admin session for the first active internal user with Settings access. `make_action` creates or reuses one `[View Doctor] <model> #<root>` window action, writing only when its values changed. `recent_ids` returns the newest ids the render user can open, `[]` on any error except a lost connection. Commands now: `get_arch`, `save`, `activate`, `deactivate`, `new_session`, `make_action`, `recent_ids`. Add new ones to `COMMANDS`. |
| `src/services/views/viewQueries.ts` | `sqlText(value)`: text goes into SQL **hex-encoded**, never quoted. Also `findViewByXmlid`, `findViewsLike`. |
| `src/services/views/viewMatch.ts` | Pure `matchView`: xmlid, then same id, then the unique same name, else a pick. `tree` and `list` count as one type. |
| `src/services/views/odooFrameProxy.ts` | The gated reverse proxy for the render frames. Security-reviewed twice; read its header before touching it. |
| `src/services/views/renderPlan.ts`, `renderSession.ts` | Frame URLs per series, and both sides on the newest shared record. |
| `src/views/viewPairing.ts` | `PairProject`, `upgradePair(project)`, `isReadOnlyOriginal`, `pickOtherDatabase`, `findCounterpart`, `diffArguments`. **Reuse `upgradePair` for "which database is the original".** |
| `src/views/viewRenderPanel.ts` | The render `WebviewPanel`, with generation counters so the last render asked for wins and a closed tab stays closed. |
| `src/commands/viewDoctorCommands.ts` | Now also `viewDoctor.compare` and `viewDoctor.render`. |
| `package.json` | Setting `odooDebugger.views.allowEditOriginal`. Row menus: inline `@1` Open Arch, `@2` Compare, `@3` Render; `1_open@1..4`, `2_state`, `3_copy`, `9_danger`. |

**Existing helpers stage 3 should reuse:**
- `resolveReposForDatabase` (`src/services/versionRepos.ts:58`) and `collectModuleDiscovery` (`src/services/psaeInternal.ts:26`), to list the modules of a database's version.
- `readModuleManifest` (`src/services/manifest.ts:74`) for the manifest version.
- `ViewService.rows(db, ids)` and `ViewService.doctorGroups(db)` (`src/services/views/viewService.ts`), plus `getViewRows`, `viewRowsSql` and `sqlIdList` in `viewQueries.ts`.
- `upgradePair` (`src/views/viewPairing.ts`).
- `context.globalStorageUri` for the notes. It is **not profile-isolated** (memory `dev-sandbox-workflow`), so the F5 sandbox and the installed build share it. Name files so that cannot hurt.

## 3. Stage 3: what to build (spec §5, plus §1 "viewNotes.ts")

**Port, don't reinvent.** odoo-manager has this working and tested:

| odoo-manager | Lines | What it is |
|---|---|---|
| `odoo_manager/view_note.py` | 287 | The note: build, classify, status, baseline, `unchanged_reason` (257-287) |
| `odoo_manager/upgrade_script.py` | 354 | `render_replace_script` (76-185), `_instance_entry` / `_activate_entry` (199-260), `render_instance_script` (265-354) |
| `odoo_manager/docker_manager.py` | 2764-2795 | The fingerprint query: `md5(arch_db::text)`, `write_date`, `arch_updated`, xmlid `noupdate` and module |
| `tests/test_view_note.py`, `tests/test_view_note_flow.py`, `tests/test_upgrade_script.py` | 260 + 701 + 378 | The tests to port |
| `CLAUDE.md` | 135-203 | The invariants (summarized in §4 below). **Read the whole passage.** |

**1. The note** (`src/services/views/viewNotes.ts`, pure apart from file I/O).
- One JSON file per database under `globalStorageUri/view-notes/`. It is machine-local, not in the shared store.
- Port `build`, `classify`, `status`, `baseline` and `unchanged_reason`.
- **What it captures:**
  - the upgrade-disabled set, when first listed, with an `arch_md5` baseline;
  - a journal of every view the extension saved or activated. Hook into `ViewFileSystemProvider`'s `onSaved` in `src/extension.ts`, and into `viewDoctor.activate`.
- **Only reported and still disabled** views enter the note (odoo-manager's reasoning is in `view_note.py`'s docstring).
- Normalize the file shape on read (the plain-JSON trap). A missing or garbled file is an empty note, never an error.
- Fingerprints are one psql query (port the `docker_manager.py:2764` query into `viewQueries.ts`, through `runSql`).

**2. The script generator** (`src/services/views/upgradeScript.ts`, pure).
- Port `render_instance_script` and the per-view variant.
- `VIEWS` and `ACTIVATE` lists, one `util.edit_view(cr, xmlid, arch, skip_if_not_noupdate=False, active=True)` loop, and a raw `UPDATE ir_ui_view SET active = true` for activate-only views.
- A view with no xmlid falls back to its id, with a "this database only" comment.
- Script header: `from odoo.upgrade import util`, plus a comment that upgrade-util must be on the upgrade path.
- Keep the invariants as code comments **and** tests.

**3. Commands.**
- **Create Upgrade Script** on the tree title covers every re-enabled or edited view in the note.
- **Add to Upgrade Script** on a row covers one view. Put it in a non-destructive right-click group, never `9_danger`, and not inline unless you have a reason.
- **After generating, report what was left out:** still disabled, deleted, no arch.
- Which database: the tree's database (the upgraded side in Upgrade mode).

**4. Where it goes** (a QuickPick, remembered per project in `workspaceState`).
1. **A module's migrations folder.**
   - Candidates are the modules in the database's version repos. The owning module of the views comes first when it lives in a custom repo.
   - Then an InputBox for the version folder, prefilled with the manifest version bumped one patch. Offer to bump `__manifest__.py` to match, since Odoo runs `migrations/<v>/` only when the installed version is lower.
   - Write `migrations/<v>/end-update_views.py`. `end-` runs after every module has loaded.
   - **If the file exists, merge** the new entries into its `VIEWS` / `ACTIVATE` lists. If it cannot be parsed, write a numbered sibling instead (`end-update_views_2.py`). Never overwrite.
2. **Untitled editor:** the same content as an unsaved Python document.

**5. Docs.** CHANGELOG `[Unreleased]` and the README "Disabled views (View Doctor)" section. Rebuild `dist/` with `npm run compile` in the last commit.

**Decisions you will need to make** (rule and record them; the spec is silent):
- How "edited here" shows in the tree. The spec lists an "Edited here" group, and stage 1 didn't build it. It is cheap once the journal exists.
- What a merged script does when a view already listed gets a newer arch: replace its entry, don't duplicate it.
- What happens when the owning module is in a read-only or core repo. Never offer Odoo core or enterprise modules; offer only custom repos.

## 4. Traps already paid for (stage 1's list still applies, plus these)

**From stage 2:**
- **Odoo 18.0 renamed view type `tree` to `list`.** Any comparison of view types across an upgrade must treat them as one (`viewMatch.ts` has the normalizer).
- **Odoo 19's web client caches `get_views` in IndexedDB.** The proxy's gate sends `Clear-Site-Data: "storage"`. Do not widen it to `"cookies"` or `"*"`: cookies ignore ports, so that would wipe both sides' gate cookies.
- **The proxy refuses non-GET requests and websocket upgrades with a foreign `Origin`.** So the render iframes must never get a `sandbox` attribute, which makes the browser send `Origin: null`.
- **`context_get()` in the shell reads OdooBot.** Run it as the user: `user.with_user(user).context_get()`.
- **Commit trailers:** use the attribution your harness gives *this session*. Two stage 2 commits carry a subagent's own model name; that was ruled acceptable, so leave them.

**From odoo-manager's CLAUDE.md, which stage 3 must keep:**
- **`util.edit_view` silently does nothing** for a view whose xmlid is `noupdate=False`, which is every view a custom module ships, unless you pass `skip_if_not_noupdate=False`. Always pass it, with `active=True`.
- **`write_date` cannot tell an edit from an activation; `arch_updated` can.** Activating is an ORM write, so `write_date` moves either way. `arch_updated` flips to True only when the arch is written, and a module load resets it.
  - `unchanged_reason` leaves the arch out (activate only) **only when it can prove** the arch wasn't edited: the hash matches the noted one, or `arch_updated` is not True.
  - **Every doubt keeps the arch.** A wrong "unchanged" silently drops a fix; a wrong "changed" only adds noise.
- **A view's `xml_id` is computed, with no column.** It is the first `ir_model_data` row ordered by `(module, name)`. `viewRowsSql` already does this, so a view is named the same way in the tree and in the script.
- **Odoo's view composition is lenient.** An xpath that matches nothing still activates, and the patch is silently dropped. "Activated" does not mean "fixed"; the script carries the arch regardless.
- **The Discuss report and "everything inactive now" are different data.** The note keeps only what the report listed and is still disabled.
- `studio_customization`, `__export__` and `__import__` views are never shipped by a module (`NOT_SHIPPED_MODULES` in `view_note.py`).

## 5. How to verify

Stage 1's §5 recipe still holds. In short:
- **Type check and lint:** `npx tsc -p . --noEmit`; `npm run lint` must show **0 errors** (117 warnings is the baseline).
- **Tests run in a real Extension Host, outside the Bash sandbox** (`dangerouslyDisableSandbox: true`), with `env -u ELECTRON_RUN_AS_NODE`.
  - Full suite: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npm test`. At handover: **678 passing, 18 pending.**
  - Focused: `npx vscode-test --grep "<suite>"`.
  - The test run rebuilds `dist/`, so run `git checkout -- dist` unless the commit ships it.
- **Real-Odoo integration** (`src/test/viewWorker.integration.test.ts`) is skipped unless `ODT_VIEW_TEST_PYTHON` / `ODT_VIEW_TEST_ODOO` / `ODT_VIEW_TEST_DB` are set. **The base DBs were dropped at handover.**
  - Rebuild them per version (17, 18, 19) with the stage 1 handover's §5 command.
  - The suite needs 18 passing on each. Drop your `odt_view_*` DBs when done.
  - `venv-15.0` and `venv-16.0` cannot start Odoo; don't modify them.
- **The real window:** see the memory `odoo-debugger-verification.md` and the Task 8 notes in the stage 2 plan. The scratch HOME and fixture from the stage 2 live check are kept at `/tmp/claude/odt2` and can be reused.

**Stage 3's real end-to-end check (spec "Manual" step 7), made local:**
- **upgrade-util** is at `/home/odoo/Dev/upgrade-util`. Pass `--upgrade-path=/home/odoo/Dev/upgrade-util/src` so `from odoo.upgrade import util` imports.
- Steps:
  1. Make a tiny custom module that ships a view, install it on a DB copy, and break and disable the view.
  2. Fix it through the extension, then generate the script into that module's `migrations/<bumped version>/`.
  3. Restore the broken state: a fresh copy, with the view broken and disabled again.
  4. Bump the manifest and run `-u <module> --stop-after-init` with the upgrade path. Assert the view comes back fixed and active.
- Also check an **activate-only** view, which must keep its arch, and a **studio** (xmlid-less) view, which uses the id fallback.
- Don't run a full 17 → 18 platform upgrade; nothing local can.
- **Ports for the scripts' tests:** odoo-manager's 3 test files are the reference; port their cases rather than inventing new ones.

## 6. How the maintainer wants work run

- **Process.**
  - The spec already covers stage 3, so go straight to a **stage 3 plan** at `docs/superpowers/plans/<date>-view-doctor-stage-3.md`, using the writing-plans skill.
  - Show the user the plan, then execute it with **subagent-driven development**: a fresh implementer per task, a task review per task, and one final whole-branch review on the most capable model.
  - Give security-sensitive or lifecycle-heavy tasks the most capable model for review. In stage 2, those reviews found real defects in the plan's own code.
- **Unattended rulings.**
  - The user is often away and asked not to be asked for permission. Make rulings and record them (`Ruling: <decision> — <why> — <cost if wrong>`).
  - At the end, **list every ruling** in the final message.
  - Stop only for something destructive, a security concern, or an external side effect such as a push or a merge.
- **Working style.** Smart defaults over prompts. Destructive actions are right-click only, behind a modal. Any automated behaviour is toggleable by a setting.
- **Commits.**
  - Odoo-style prefixes `[ADD]` / `[IMP]` / `[FIX]` / `[REF]` / `[DOC]`, each with a body, plus your harness's Co-Authored-By trailer.
  - **Never `git add -A`.** The repo root has unrelated untracked dotfiles, and `.superpowers/` is not git-ignored.
- **Copy style.** Plain, short sentences, matching the existing CHANGELOG and README voice.

## 7. Open items carried over (none block stage 3)

**Never verified live** (the user will smoke-test):
- Render against the user's real upgraded databases;
- Compare and Render on a list view across the `tree`/`list` rename (unit-tested only);
- Copy External ID and Open Parent (stage 1);
- anything on Windows, Odoo 15/16, saas-18.x, or remote windows (SSH, Codespaces).

**Accepted and recorded in stage 2:**
- Minted admin sessions stay in Odoo's session store until Odoo's 7-day cleanup.
- Render leaves one inert `[View Doctor] …` action per rendered view in each database, the original included. The README says so.
- No `frame-ancestors` allowlist: a hostile page inside VS Code's own browser storage could frame the admin Odoo. This needs a click, and the user's normal browser is unaffected.
- Saving while that side's server is down shows the proxy's error text until Reload.

**Deferred minors** (fix only if you are already in the file):
- Stage 1's list (stage 1 handover §7) is unchanged.
- The PostgreSQL round-trip test in `viewQueries.test.ts` skips on any error, so an SQL error would show as pending.
- `pickOtherDatabase` asks even when there is only one other database.
- The page-side `reload` message is accepted from any window; its only effect is a frame reload.
- Proxies for databases no longer shown stay open until the tab closes.
- `Clear-Site-Data` is sent on 17/18 too, which resets in-frame localStorage.
- Several render lifecycle paths (start flow, update race, proxy eviction) are fixed but have no dedicated tests.
