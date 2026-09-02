# 1.3.0 beta — what changed and what to poke at

Thanks for testing. This release rewrites how environments are created and how
custom code is laid out, so the parts most likely to break are the ones you hit
in the first ten minutes.

**Install:** `code --install-extension odoo-devtools-vscode-1.3.0.vsix`, then
reload. Your existing projects and databases are migrated in place — see
*Coming from 1.2* at the bottom before you start.

**Report anything odd** on [Discord](https://discord.gg/5DMzx3nr9z). Include what
you clicked and what the notification said. "It felt confusing" is a valid and
useful report.

---

## The three big changes

### 1. Versions build themselves

Before, you pointed the extension at an Odoo checkout and a virtualenv you had
made yourself. Now the **+ in the Versions view** does it: pick a branch, confirm
a name, and it creates a git worktree, picks a Python that branch actually
supports, builds a virtualenv and installs the requirements.

Everything lands under one folder — `~/odoo-dev` by default — and your own Odoo
checkout is only ever used as the source to cut worktrees from. It is never run,
so it stays yours to switch branches in.

**Look at:** does provisioning finish for the branches you care about? Does it
pick a sane Python? Is the progress notification honest about what it is doing,
and does Cancel actually stop it?

### 2. Several versions at once

Because each version owns its worktree, activating a version no longer checks
anything out — so two versions can run at the same time. Ports and debugger
names are derived from the branch, so they cannot collide. The Databases view
marks what is live and on which port, and `Ctrl+Alt+O B` opens the right one.

**Look at:** start two versions together. Do both stay up? Does the Databases
view show both? Does Open in Browser land on the correct port each time?

### 3. Custom code, one copy per branch

This is the one we most want feedback on.

Your addon repos are still a **plain checkout** by default — one branch at a
time, exactly as before. Nothing changes unless you opt in.

When you need two versions of your own code live at once (upgrades, mostly),
right-click the repository in **Repos** → **Use One Copy Per Branch**. From then
on each branch gets its own directory, and the addons path, the module list, the
Project Repos tree and the generated workspace all follow the active version.

It is still one git repository. Commits made in a copy land on the real branch
and push normally. Each copy has its own uncommitted changes, so unfinished work
in one version does not follow you into another.

**Look at:** turn it on, switch versions, and check you are editing the file you
think you are. Then turn it back off and confirm your repo is intact. If the
branch you need is checked out in your main copy, you should be *asked* what to
do — never surprised.

---

## Smaller things you will notice

- **Creating a database now asks which branch each project repo should use.** It
  used to silently record whatever happened to be checked out.
- **Switch notifications say what actually happens** — reusing a worktree,
  checking out a branch, or a missing environment — instead of always claiming a
  checkout.
- **Opening a file that belongs to another version warns you**, so edits do not
  land in the wrong copy.
- **Checkout hooks** are now `odooDebugger.postSwitchCommands` and also run when
  the version changes. Your old settings migrate automatically.
- The Get Started walkthrough was rewritten. If you have five spare minutes,
  click through it as if you were new and tell us where it lies.

## Coming from 1.2

Your old versions point at paths you configured by hand, which the new layout
does not know about. Run **Odoo DevTools: Check Version Environments** from the
Command Palette first — it reports which versions are stale and offers to
rebuild them under `~/odoo-dev`.

Databases keep their data. The per-database branch field was removed; the branch
now comes from the database's version, which is where it was always meant to
live.

## Known rough edges

- Provisioning a branch for the first time is slow — it is a real clone-equivalent
  plus a `pip install`. Subsequent versions reuse the object store and are much
  faster.
- The screen recordings were removed from the README because they showed the old
  flow. New ones are coming; the written steps are current.
- Every UI path described above passes its unit tests but has had limited use on
  real machines. That is what this beta is.
