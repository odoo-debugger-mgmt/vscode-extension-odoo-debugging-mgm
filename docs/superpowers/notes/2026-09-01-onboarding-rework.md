# Notes: onboarding & setup rework

Running notes gathered while implementing the parallel-versions plan. Not a
design yet — raw observations plus the one decision already taken.

**Status:** open. Feeds a future spec.

---

## The decision already taken

> "The extension should expect an Odoo path from the start that will be used
> for provisioning the workspaces, etc. Therefore having this thought out
> during initial setup of the extension is probably favorable."

Today the source repository path is a *default for new versions*
(`odooDebugger.defaultVersion.odooPath`, default `./odoo`) that provisioning
happens to reuse as its clone source. That is backwards. Since §2 of the
native-provisioning design, the source repo is infrastructure: every version
worktrees off it, and it is deliberately never run directly (commit
`f1d4d4c`, "Never run a version out of the source repository"). It should be
a first-class, explicitly-configured property of the workspace, established
during setup — not inferred from a per-version default.

---

## Observations

### 1. `odooPath` carries three unrelated meanings

`odooDebugger.defaultVersion.odooPath` is read as two different things, and
a version's own `settings.odooPath` is a third:

- `provisionAndCreateVersion` (`src/odooInstaller.ts:222`) uses the config
  value as `spec.sourceRepoPath` — the repo to create worktrees *from*.
- `resolveProvisioningRoot` (`src/odooInstaller.ts:210`) derives the
  provisioning root from **its parent directory** when
  `odooDebugger.provisioning.root` is unset. So where every worktree and venv
  lands is a side effect of where the source repo happens to sit.
- Each version's `settings.odooPath` is the worktree that version *runs* from
  — written at creation from `result.paths.odooPath`.

One key name, three meanings, and a silent coupling between the source repo's
location and the provisioning root.

**Implication for setup:** these want to be separate and explicit. Something
like `odooDebugger.sourceRepo` (what to worktree from) alongside the existing
`odooDebugger.provisioning.root` (where environments are built), with the
latter defaulting to somewhere independent rather than to the former's parent.

### 2. The shipped defaults describe a layout provisioning no longer produces

The defaults (`./odoo`, `./enterprise`, `./design-themes`,
`./venv/bin/python`) describe a hand-built single-checkout workspace. A
provisioned version instead gets `odoo-17.0/`, `enterprise-17.0/`,
`venv-17.0/` under the provisioning root.

So the `defaultVersion.*Path` keys are now really *source repo* locations,
and the per-version path defaults are never what a provisioned version
actually uses — they are overwritten at creation time. Anything in the
walkthrough or README presenting `./odoo` as "your Odoo path" is now
describing the source repo, not a runtime path. Worth saying so explicitly.

### 3. Setup has no notion of "not set up yet"

`getDefaultVersionSettings()` always returns a full settings object, so
`./odoo` reads as configured even when nothing exists there.
`provisionAndCreateVersion` only discovers the problem at use time and errors
with *"No Odoo repository at … Run 'Setup Odoo' first."*

A setup flow wants a real "is this workspace initialised?" predicate to gate
welcome content and to decide whether to run setup automatically, rather than
every path silently defaulting to a plausible-looking relative path that may
point at nothing.

### 4. The walkthrough predates provisioning

`media/walkthrough/` still carries `create-version.md` and
`configure-defaults.md` from the pre-provisioning model. `create-version.md`
should now lead with provisioning (pick a branch → worktree + venv +
requirements), and `configure-defaults.md` walks through per-version defaults
that are now mostly derived or overwritten.

### 5. Three settings stop being user-editable (from this plan's Task 2)

`debuggerName`, `portNumber` and `shellPortNumber` become derived read-only
values, and their three `odooDebugger.defaultVersion.*` configuration keys are
removed outright. `configure-defaults.md` walks the user through the defaults
UI, so it needs updating regardless of the wider rework.

### 6. `normalizePath('')` silently resolves to the workspace root

Found while wiring the provisioned-version check. `normalizePath` joins a
relative path onto the workspace, so an **unset** path becomes the workspace
root — which exists. Any "is this configured thing present?" test written the
obvious way therefore reports *yes* for a version that has nothing configured.

Fixed for this plan by adding `resolveOptionalPath` in `src/utils.ts`, which
returns `undefined` for a blank path, and routing both call sites through it.
Worth auditing the other `fs.existsSync(normalizePath(...))` sites during the
rework — the same trap applies to every path a setup flow might leave empty.

### 7. `getDefaultVersionSettings()` returns `any`

Removing three keys from it type-checked cleanly, because the return type is
`any`. Nothing told the compiler that `defaultSettings.debuggerName` had become
`undefined` at four call sites — I had to find them by grep. If setup is going
to rework what defaults mean, giving this function a real return type first
would make that rework far safer.

### 8. Model baselines asserted a plausible-but-wrong default

`VersionModel` and `SettingsModel` hardcoded `odoo:19.0` / `8019` / `5019`. Any
creation path that bypassed `createVersion` produced a 17.0 version wearing a
19.0 identity, and nothing detected it because the values *looked* valid. Now
blanked (`''` / `0` / `0`) so "not derived yet" is distinguishable from
"derived".

The same pattern is everywhere in the defaults: `./odoo`, `./enterprise`,
`./venv/bin/python` are all plausible-looking values that may correspond to
nothing on disk. A setup flow should distinguish *unset* from *set to the
default* — see observation 3.

### 9. `updateActiveSettings` has no callers

`VersionsService.updateActiveSettings` (`src/versionsService.ts`) is dead code.
Harmless, but it is a settings write path that bypasses the identity guards, so
it should be deleted rather than left as a trap for a future setup flow.

---

## Open questions for the rework

- Should setup **require** a source repo up front, or offer to clone one into
  a chosen location as its first step? "Setup Odoo" already clones — the
  question is whether that becomes the entry point rather than a command the
  user has to find.
- Should the provisioning root default somewhere independent of the source
  repo (`~/.odoo-devtools/`, or a workspace-relative `.odt/`) instead of the
  source repo's parent?
- Does a workspace ever legitimately have more than one source repo — a
  personal fork plus upstream? If so `sourceRepo` is a list, not a path.
- Where do `enterprise` and `design-themes` fit? They are optional today
  (provisioning degrades to a warning when absent), which is probably right,
  but setup should ask rather than let them default to `./enterprise`.
