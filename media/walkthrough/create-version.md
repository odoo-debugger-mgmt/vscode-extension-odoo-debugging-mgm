## Create a version

A **version** is a complete environment for one Odoo branch (e.g. `17.0`, `saas-18.4`, `master`): its own git worktree of the Odoo source, a Python interpreter that branch supports, a virtualenv with the branch's requirements, and the runtime settings used to launch it.

Creating one: pick the branch (listed from your Odoo repository), confirm the name, and the extension builds the environment under your environments folder, with live progress and cancellation. *Profile only* registers the version without building anything.

The debugger name and ports are derived from the branch — `odoo:17.0` on ports 8017/5017 — so versions never collide and several can run at once. Activating a version checks nothing out: each version already owns its worktree. Expand a version in the **Versions** view to see or edit its settings.
