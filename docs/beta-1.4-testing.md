# 1.4.0 beta — several workspaces, one set of data

Thanks for testing. 1.4 is about the way most of us actually work: one
workspace per Odoo version (`~/v17/acme`, `~/v19/acme`), open side by side.
Until now each workspace kept its own projects, versions and databases, so you
set everything up twice and the two copies drifted apart. In 1.4 they can share
one store, and each window still keeps its own selection.

**Install:** `code --install-extension --force odoo-devtools-vscode-1.4.0.vsix`,
then reload every open window. It needs **VS Code 1.101 or later**.

**Nothing changes until you opt in.** Your workspaces keep their own
`.vscode/odoo-debugger-data.json` until you run Choose Data Store. Everything
from 1.3 works as before.

**Report anything odd** on [Discord](https://discord.gg/5DMzx3nr9z): what you
clicked, what the notification said, and which window you were in. With two
windows involved, "which window" matters. "It felt confusing" is a valid and
useful report.

---

## Before you start

- **Back up first.** Copy `.vscode/odoo-debugger-data.json` from the workspaces
  you will use, or run **Odoo DevTools: Export Data…** in each.
- **Use your real setup.** Two or more workspaces, one per Odoo version, each
  with its own clone of your project repositories, is the case we most want to
  hear about. One clone for every version, and one copy per branch, are
  supported too. If that is how you work, say so in your report.
- **Real servers and real builds are the gap.** We tested against stand-in
  Odoo servers, a stand-in Odoo source and no PostgreSQL. You are the first to
  run this against real databases and full `pip install`s.

## 1. Move your workspaces onto a shared store

In your first workspace: **Odoo DevTools: Choose Data Store…** → **Shared
store** → **All workspaces**. It offers to bring that workspace's data along
and lists what it will add. Choose **Bring It Along**.

Then open your second workspace. It already sees the shared store, because you
chose *All workspaces*. If it has data of its own, run Choose Data Store there
too and bring that along as well. Versions are matched by branch, so you should
not end up with two "Odoo 17.0".

**Look at:**

- Do both windows show the same projects, databases and versions afterwards?
- Is anything missing, or duplicated?
- Did the dialogs tell you what was about to happen before you committed?

## 2. Each window has its own selection

Select a different project, database or version in each window.

**Look at:**

- Does selecting in one window ever change what the other one selected, runs or
  launches (F5, Start Server, Copy Odoo Command)? It should not.
- Rename a database, or mark a module for install, in one window. The other
  should show it within a couple of seconds, without you doing anything.
- Leave both windows open for a while. Nothing should keep refreshing on its
  own.

## 3. Each workspace runs its own version

The first time a workspace opens the shared store, it is asked once which
version it runs, for example *"Use Odoo 19.0 in this workspace? (acme here is on
main, which acme-db19 runs.)"*. Answer it. If you dismiss it, a **Which
version here?** item stays in the status bar until you do.

**Look at:**

- Was the proposal right for your workspace? If not, tell us what the workspace
  holds (which repositories, on which branches), so we can see why it guessed
  wrong.
- After answering, F5 and Start Server should run **this workspace's own
  clone**. Check the addons path in `.vscode/launch.json`.
- Select a database of another version: you are asked before the window
  switches. *Switch for Now* and *Run … Here From Now On* should do what they
  say.
- Hover a version in the Versions view: "Also runs in:" names the other
  workspace. Right-click → **Open the Workspace for a Version…** brings it up.

## 4. An upgrade across your two workspaces

In the 17.0 workspace: **Set Up an Upgrade**, from a 17.0 database to a 19.0
one. When each version has its own clone, no copies are made: the
confirmation says *"Each version already has its own checkout of these, so no
copies are made"* and names both clones.

**Look at:**

- Do the branch pickers offer each side's own branches, opening on the branch
  that clone is on?
- **Start This Side** in each window starts only that window's side, with its
  own clone and database. **Start Both Servers** from either window starts
  both.
- **Open the Other Side** brings up the other workspace's window.
- Turn the upgrade off and on. With both clones still on their branches, it
  resumes without asking anything.

## 5. Builds from two windows

Create a version (Provision) in each window at about the same time. The second
one should show *"Waiting for another window to finish building…"* and build
only after the first has finished. **Cancel** while it waits builds nothing.

**Look at:** you should end up with one version per branch, never two.

## 6. Going back

- **Choose Data Store… → This workspace only** puts a workspace back on its own
  file. Moving it back to the shared store again should keep its version and
  its selection, with no "was deleted in another window" message.
- **Export Data…** and **Import Data…** move data between stores or machines.
  Import's preview says exactly what a merge will add. **Replace…** asks a
  second time and defaults to keeping your data.

---

## Known rough edges

- **Stop Both Servers stops what this window started.** If each side was
  started from its own window, stop each from its own window.
- **The upgrade's database pickers show the database name**, not a display name
  you gave it.
- **`launch.json` is rewritten on the next change**, not when a window opens. If
  you delete it, select a database to get it back.
- **Waiting for another window's build** can take up to about two minutes to
  notice that the other window froze or closed, then it carries on with the
  queue.
- **Cursor, VSCodium, Windows and macOS have not been tried.** The shared store
  needs `node:sqlite` from the editor's runtime. If your editor refuses with a
  message naming its Node version, tell us which editor and version.

## Coming from 1.3

Nothing to do. Your data and selections carry over on first start, and every
workspace stays on its own file until you run Choose Data Store.
