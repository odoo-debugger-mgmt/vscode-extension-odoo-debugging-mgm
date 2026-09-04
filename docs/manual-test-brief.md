# Manual test brief — v1.3.0 beta

**For:** an agent or person who can drive a VS Code window and see it.
**Branch:** `v-1.3` (currently `e0571f8`). **Build:** `npm run build:vsix`, or press <kbd>F5</kbd> in this repo to open an Extension Development Host.

## Read this first: what is already covered

Do **not** spend time re-checking these. The repo has 243 passing tests
(`npm test`), and they run inside a real Extension Host, not a mock:

- Every pure decision — branch→series parsing, the provisioning queue's state
  transitions, version health diagnosis, switch-summary wording, upgrade-plan
  construction, identity derivation and port allocation.
- The per-branch copies against **real git** (`src/test/customWorktree.integration.test.ts`):
  a copy is created when the source is free; a background sync stays silent,
  reports the conflict, falls back to the source checkout and leaves the working
  tree untouched; a dirty source is refused; one blocked repo does not stop others.
- **Items 4 and 5 in full** (`src/test/sourceConflict.integration.test.ts`): the
  move/detach arbitration and the rule that a sync never blocks. See those
  sections — they now ask for almost nothing.

What no test here can judge is **whether a human can tell what is happening**.
That is what this brief is for. Report on wording, sequence, and whether the
thing you were told would happen is the thing that happened.

## How to report

For each item: what you did, what you saw, and whether it matched. Verbatim
notification text is the single most useful thing you can send back — most of
the risk in this release is in wording that is subtly wrong rather than in code
that throws. Screenshots for anything visual. **Say plainly when you could not
test something and why**; a gap reported is worth more than a guess.

---

## Setup you will need

- A real Odoo clone (any recent series) for the source repository.
- **Two custom addon repositories**, each with at least two branches on
  different Odoo series — e.g. `17.0-acme` and `19.0-acme` in one,
  `17.0-other` and `19.0-other` in the other. Two repos with *different*
  branch names matters: item 6 exists because the old code assumed they matched.
- PostgreSQL running.
- Expect provisioning to take minutes and download ~2 GB per version. Budget for
  it, and do not report slowness as a defect unless the UI gives no sign of life.

### Driving the window on this machine

The session is GNOME on **Wayland**, where VS Code is a native Wayland client
and invisible to X automation: `import -window root` captures a 0x0 XWayland
surface, `grim` fails (no wlr-screencopy under GNOME), and there is no Xorg
session to fall back to. The way around it is an X *server*, not an X session:

```bash
Xvfb :99 -screen 0 1920x1080x24 &
DISPLAY=:99 code --extensionDevelopmentPath=<repo> \
  --user-data-dir=<scratch> --extensions-dir=<scratch> \
  --ozone-platform=x11 --disable-gpu --new-window <fixture>
# drive:    xdotool key/type/mousemove --window <id>
# observe:  import -window root shot.png
```

Prefer an integration test in `src/test/*.integration.test.ts` wherever the
question is behavioural. Those run in the Extension Host the suite already
launches, assert real git and filesystem state, and do not go stale. Reach for
the GUI only when the question is genuinely about what something looks like.

---

## 1 · First run — the whole point of the release

Start from a clean slate: a fresh VS Code profile, and clear the extension's
global state (easiest: run the Extension Development Host with
`--profile-temp`).

1. Note whether a first-run notification appears on its own.
2. Run **Odoo DevTools: Set Up**. Record how many things it asks you and whether
   the confirmation summary matches what is actually on your disk — source repo,
   enterprise, design-themes, custom addons folder with a repository count, and
   the environments folder.
3. At the version multi-select: **does it offer versions matching your own repo
   branches, and does each row say which repository suggested it?** Pick two.
4. Watch the first build in the foreground and the second land afterwards.

**Report:** the total number of interactions; whether the stated cost
(`≈2 GB and a few minutes each`) appeared before you committed; whether the
version rows ever read `building…` and `queued`; and the final summary text.

**Specifically check:** the second version must **not** start building until the
first finishes. Two concurrent `pip install`s is the bug this was changed to
prevent, and it is only visible by watching.

## 2 · Reload mid-build

While the queue is draining, reload the window (**Developer: Reload Window**).

The remaining build should resume by itself. Report what, if anything, told you
that — and whether you would have known without being told to look.

## 3 · Per-branch copies — the headline feature

Right-click a repository in **Repos** → **Use One Copy Per Branch**. It is also
on Project Repos in the Explorer; confirm both.

1. Read the modal. It should name absolute directories, say *copies* rather
   than *worktrees*, and — when no branches are mapped yet — say plainly that
   nothing is created now. Confirm the menu entry flips to **Use a Single
   Checkout** once the mode is on.
2. Accept, then switch between two versions and confirm the Project Repos tree,
   the Modules list and the addons path follow.
3. Open a file from one version's copy while the *other* version is active. A
   wrong-copy warning should offer to reopen it in the active copy. Try both
   its dismiss options.
4. Turn the mode back off. Confirm copies are removed — and that a copy with
   uncommitted changes is **kept** and named.

## 4 · The source-conflict path — now automated

**Covered by `src/test/sourceConflict.integration.test.ts`.** Move, Detach,
dismissal, declining the move picker, and the dirty refusal are all asserted
against real repositories: that the checkout lands where the dialog promised,
that the copy is created, that nothing is stashed and no untracked file is lost.

Only the *appearance* is left. If you have a spare minute, trigger it once and
say whether the modal reads clearly — but do not spend a session on it.

## 5 · The sync must never interrupt you — now automated

**Covered by the same file.** Three consecutive non-interactive passes over two
conflicting repositories raise zero modals, warn about nothing, move neither
checkout, still build the copies that need no arbitration, and report both
blocked repos for the offer. A repeat pass once the copies exist is a no-op.

The stub counts only `{ modal: true }` calls, which is the distinction that
matters: a dismissible notification from a sync is fine, a blocking dialog is
not.

What is still worth a human: whether the **Resolve** offer arrives at a sensible
moment during ordinary work, rather than whether it blocks.

## 6 · Set Up an Upgrade — with two differently-named repos

Run **Set Up an Upgrade** and select **both** custom repositories.

It should ask *per repository* — you should see the repo's name in each picker
title. Confirm the second repository's pickers are seeded with your first
answers but still list **its own** branches.

1. Give repo A `17.0-acme` → `19.0-acme` and repo B `17.0-other` → `19.0-other`.
2. Read the plan modal. Is it legible with two repositories? Does each line name
   the right branches for the right repo?
3. Accept, then verify each repo's copies use **its own** branch names.
4. Separately, try giving two repos branches on *different* series (`17.0-acme`
   and `18.0-other`). It should refuse and name the mismatch.

## 7 · Change Branch

On a **provisioned** version, run **Change Branch**.

It should warn that the environment will be rebuilt, then rebuild it. Afterwards
confirm the version's `odooPath` points at the **new** branch's worktree and the
port and debugger name changed to match. Report the Run and Debug dropdown entry.

Then do the same on an unprovisioned (profile-only) version: it should just
change, with no rebuild.

## 8 · Branch mapping — one picker, not N

Create a database in a project with **three or more repositories** and choose
*Choose branch per repository*.

You should get **one picker listing every repository**, each already showing a
branch, with a **Done** row. Report:

- whether the pre-filled branches were the ones you would have chosen
- how many interactions it took in total
- what happens if you Escape instead of pressing Done (should discard cleanly,
  not half-apply)
- whether the per-item buttons (change / clear) are discoverable

This replaced one dialog per repository. If it feels worse than that, say so.

## 9 · Running two versions at once

Start a server on one version. Without stopping it, activate a second and start
that one too.

Confirm both stay up, both show in the Databases view with their ports, and
**Open in Browser** lands on the correct port for each. Then stop one and
confirm the other survives.

## 10 · Failure paths

Each should offer the fix, not just name it:

- **Start Server** on an unprovisioned version → offers **Provision**.
- **Start Server** with no database for that version → offers **Select Database**.
- A module command with no project selected → offers **Create Project** or
  **Select Project**, and **only one notification appears** (a duplicate second
  toast was removed; if you see two, that is a regression).
- An empty **Repos** view → offers **Choose Custom Addons Folder** and
  **Create Project**.
- Press <kbd>Esc</kbd> at each step of **Create Project**. It should stop
  quietly — **no red error**.

## 11 · Migration from 1.2, if you can

Only if you have a 1.2 install with hand-configured versions.

Run **Check Version Environments**. A version whose `odooPath` *is* the source
repository should be reported as the worst case, with an explanation of why it
is unsafe rather than untidy. Migrate it and confirm **exactly one** version
exists for that branch afterwards — not two.

## 12 · Onboarding text

Open the walkthrough (**Get Started with Odoo DevTools**) and read all six steps
as if new. Same for the README Quick Start.

Report anything that describes behaviour you did not observe. The screen
recordings were removed because they showed the old flow; the prose was rewritten
but has not been checked against a real run by anyone.

---

## Known-unknowns worth your attention

Things I could not verify and am genuinely unsure about:

- **The persistent branch picker** (item 8) hides itself to open a sub-picker and
  re-shows afterwards, guarded by a flag so a late `onDidHide` cannot dispose it
  mid-edit. The ordering is right in theory. Rapid Escape-and-reopen is the way
  to break it if it is breakable.
- **`Create Missing Per-Branch Copies`** was added with this change and has never
  been run. It may not appear where you expect — it is palette-only.
- **Four permanent, machine-wide dismissals**, not three: first-run, migration,
  upgrade hint, and the wrong-copy guard's *Don't warn again*. All are by design
  and none re-arms. Do not press any of them until you have finished the item
  they belong to; clearing global state is the only way back.
- Whether **`Set Up an Upgrade`** on the Repos context menu is confusing: it
  ignores which repository you right-clicked and asks for all of them.
