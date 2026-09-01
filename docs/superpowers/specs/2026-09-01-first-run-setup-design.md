# First-run setup: design

**Status:** approved for implementation.
**Background:** `docs/superpowers/notes/2026-09-01-onboarding-rework.md` — the
eleven observations this design answers.

## Problem

The extension has no concept of being *set up*. Five separate symptoms, one
cause:

1. **`odooPath` means three different things** — the source repo to worktree
   from (`provisionAndCreateVersion`), the thing whose *parent* becomes the
   provisioning root (`resolveProvisioningRoot`), and the worktree a version
   runs from (`version.settings.odooPath`). It is declared once, as a *default
   for new versions*.
2. **"Setup Odoo" writes no configuration at all.** It asks five questions,
   clones into the chosen directory, and then hands off to provisioning, which
   reads `./odoo` from the workspace. Answering *"Choose a different folder…"*
   — an offered answer — produces a successful clone followed by *"No Odoo
   repository at &lt;workspace&gt;/odoo. Run 'Setup Odoo' first."*
3. **Defaults are indistinguishable from configuration.** `./odoo`,
   `./venv/bin/python` and friends always resolve to something, so nothing can
   tell "the user chose this" from "nobody has ever set this".
4. **Setup asks five questions before doing anything**, four of which have an
   obvious answer.
5. **It is per-workspace.** Every new folder starts from nothing, even though
   the source repo and the environments built from it are machine-level
   infrastructure.

## Design

### 1. The source repo becomes infrastructure

Four settings, declared at **user scope** so one setup covers the machine, with
workspace override available for a client that needs a different fork:

| Setting | Default | Meaning |
| --- | --- | --- |
| `odooDebugger.sourceRepo.odoo` | `""` | Absolute path to the odoo git repo worktrees are cut from. Never run directly. |
| `odooDebugger.sourceRepo.enterprise` | `""` | Optional. |
| `odooDebugger.sourceRepo.designThemes` | `""` | Optional. |
| `odooDebugger.provisioning.root` | `""` → `~/odoo-dev` | Where worktrees and virtualenvs are built. |

`provisioning.root` already exists; only its empty-value resolution changes,
from *the source repo's parent* to `~/odoo-dev`. That breaks the silent
coupling where moving the source repo relocated every future environment.

The three `odooDebugger.defaultVersion.*Path` keys stop being read as source
repos. They remain as per-version defaults for the *Profile only* path, which
is the one case where no provisioning happens.

**Migration.** On activation, when `sourceRepo.odoo` is empty and the legacy
`defaultVersion.odooPath` resolves to a directory containing `odoo-bin`, that
path is adopted into `sourceRepo.odoo` at user scope and the adoption is
logged. Nobody who is working today is interrupted.

### 2. "Configured" becomes a real predicate

```ts
// src/services/setupState.ts
interface SetupState {
    sourceRepo?: string;
    enterpriseRepo?: string;
    designThemesRepo?: string;
    provisioningRoot: string;
    isConfigured: boolean;
}
```

`isConfigured` is true when `sourceRepo` is set **and** the directory it names
contains `odoo-bin`. A path that was configured and later moved reads as *not
configured*, which is the honest answer and routes the user back to setup
instead of into a confusing provisioning failure.

The state drives a context key, `odoo-debugger.is_configured`, so welcome
content and menu items can react to it.

### 3. Detection answers the questions instead of asking them

```ts
// src/services/setupDetection.ts
interface RepoCandidate { path: string; kind: RepoKind; branch?: string }
type RepoKind = 'odoo' | 'enterprise' | 'design-themes';
```

Search roots, in priority order: the current configuration values, the
workspace folders, then `~/src`, `~/Dev`, `~/dev`, `~/Projects`, `~/odoo` and
the home directory itself — each scanned one level deep. An odoo repo is
identified by `odoo-bin` beside a `.git`; enterprise and design-themes by
directory name plus `.git`.

Scanning is bounded (one level, a fixed root list) and only runs when setup is
invoked or the first-run check fires, never on every activation.

### 4. One confirmation, not five prompts

`odoo.setup` replaces the five sequential prompts with a single summary the
user accepts or edits:

```
Found an Odoo repository:
  Source      ~/src/odoo           19.0
  Enterprise  ~/src/enterprise     ✓
  Provision   ~/odoo-dev           will be created

  [Use these]  [Change…]  [Cancel]
```

*Use these* writes the settings and finishes. *Change…* opens the individual
pickers — the existing flow, reached only when detection was wrong.

When nothing is detected, the summary is replaced by an offer to clone, which
reuses the existing clone machinery with the destination defaulting to the
provisioning root's parent, and **writes the settings afterwards** — the bug in
observation 2.

Setup ends by offering *Create your first version*, handing off to the
provisioning flow that already exists.

Setup is re-runnable and idempotent: run against a configured workspace it
shows the current state as the proposal.

### 5. First run is a notification, not a wall

On activation, when `!isConfigured` and the user has not dismissed it (a
`globalState` flag, so *Later* is remembered across windows), one non-modal
notification:

> Odoo DevTools isn't set up yet.  **[Set Up]** **[Later]**

Plus a persistent `Set Up Odoo DevTools` button in the Versions and Projects
welcome views, gated on `!odoo-debugger.is_configured`. The button is the
durable path; the notification is the discoverable one.

### 6. Provisioning reads the new settings

`provisionAndCreateVersion` takes its `sourceRepoPath`, `enterpriseRepoPath`
and `designThemesRepoPath` from `sourceRepo.*` rather than
`defaultVersion.*Path`, and its `root` from the new provisioning-root
resolution. Its "no repository" error becomes an offer to run setup rather
than an instruction to.

## Out of scope

The walkthrough (`media/walkthrough/`) still describes the pre-provisioning
model. Rewriting it is a separate pass; this design only removes the step that
would become actively wrong (`configureDefaults`, which walks the user through
settings that are now derived or superseded).
