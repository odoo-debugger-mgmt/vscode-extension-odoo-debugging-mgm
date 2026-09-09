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

## 6 · Upgrade mode — rebuilt around the two databases

The flow no longer asks which repositories are upgrading, nor two questions per
repository. It asks for two **databases** and deduces the rest.

### 6.1 Both databases already exist

Have a 17.0 database and a 19.0 database in the project.

1. Run **Set Up an Upgrade**. Expect: a *from* database pick, a *to* database
   pick, then — if your repo has exactly one branch per series — straight to the
   review screen. Count the dialogs: it should be about four, not ten.
2. On the review screen, select a branch line and change it. You should come
   back to the review with the new value shown.
3. Accept. Exactly **one** modal should appear, and only because copies are
   about to be created. It must name the directories.
4. A progress notification must appear **while the copies are created** — this
   is the thing that used to happen silently, minutes later.
5. At the end, a notification offers **Start Both Servers**.

### 6.2 Creating the target database

Run it again choosing **Create a new database…** for the target.

1. It asks the target series and the branch — and must **not** ask either of
   them again later in the flow.
2. An empty database is created and linked to the target version.
3. `Start Both Servers` should build the source's module set into it. Check the
   Upgrade view's Modules row for the count, and the launch args for `-i`.

### 6.3 The Upgrade view and the pair

- With the mode off, the **Upgrade** view shows exactly **one** row -
  `Upgrade Disabled` - the way the Testing view shows `Testing Disabled`. There
  is no second button and no title-bar icon; `ctrl+alt+o shift+u` is the
  shortcut.
- With it on: the toggle, a From and a To section (each expanding to version,
  database and a branch per repo), the module count, and Start Both Servers.
- **Versions** and **Databases** should each show **two** checked rows, marked
  `upgrading from` / `upgrading to` - and the *selected* one must still be
  distinguishable (filled circle vs plain check), because selecting a side is
  how you choose whose modules you are editing.

### 6.4 What the mode blocks, and what it must not

Blocked - these disappear from the menus and refuse from the palette with an
**Exit Upgrade Mode** action:

- turning **testing mode** on
- **rename / restore / change version / configure repo branches / delete** on
  either paired database
- **change branch / delete / set-all-settings** on either paired version, and
  editing any individual version setting
- **activating a version** that is not part of the pair
- **selecting a database** that is not part of the pair
- **Use One Copy Per Branch** on a repo in the upgrade, and **removing** such a
  repo from the project

Still available, and worth checking explicitly - hiding these was a real
regression once, when the pair rows were given their own `contextValue` and
emptied the whole right-click menu:

- **Open in Browser**, **Open psql Shell**, **Copy Database Name**,
  **Clone Database**
- **Open Version in Browser**, **Clone Version**

### 6.5 Editing each side's modules

1. Click the *from* database. The Modules view now shows that database, and
   marking a module install/upgrade writes to it.
2. Click the *to* database and confirm the same module reads **unmarked** - the
   marks are per database, not shared.
3. Selecting a side must **not** realign the workspace: your source checkouts
   stay on whatever branch you left them on. That is the difference between
   selecting a side and switching databases normally.

### 6.6 Leaving

Toggle the mode off. It should confirm, restore the target database's previous
modules, and say plainly that the copies and versions are kept.

### 6.7 The bug this release fixes

With the copies built, switch databases back and forth several times, and
activate each version in turn.

**The "using the source checkout" warning and its modal must never appear**, and
your source checkout must stay on whatever branch you left it on. That path used
to check the assigned branch out *in the source repository* on every switch,
which took the branch away from the copy that needed it.

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
- **Repositories are now included in an upgrade by deduction**: one with no
  branch on either series drops out silently. If a repository you expected is
  missing from the review screen, that is why — and it is worth telling me,
  because there is currently no way to add it back from inside the flow.
- The **`Set Up an Upgrade`** entry on the Repos context menu has been removed;
  it ignored which repository you right-clicked and asked about all of them.
