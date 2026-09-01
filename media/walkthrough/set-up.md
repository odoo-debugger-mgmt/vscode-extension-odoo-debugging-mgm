## Set up once, for the whole machine

Odoo DevTools needs to know two things, and only once:

- **Source repository** — the Odoo git repo it cuts per-version worktrees from. It is never run directly, so it stays yours to switch branches freely.
- **Environments directory** — where per-version worktrees and virtualenvs are built. Defaults to `~/odoo-dev`.

Run **Odoo DevTools: Set Up**. It looks for Odoo checkouts you already have and shows what it found for confirmation — usually one click. If there is nothing to find, it offers to clone the repositories and records where it put them.

Both settings are stored at user level, so every workspace you open afterwards is already set up. A workspace that needs a different fork can override them.

Once set up, **Create Version** builds a complete environment for any branch: worktree, the Python version that branch actually needs, a virtualenv, and its requirements.
