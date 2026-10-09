## Explore the rest

- **Switching contexts**: selecting a database restores the version and project repo branches recorded for it (`odooDebugger.databaseSwitchBehavior`: `auto` / `ask` / `never`). The status bar shows the active project, database and version — click any of them to switch.
- **Upgrade mode** (`Ctrl+Alt+O Shift+U`): two databases on two versions, run side by side, with the source's modules staged onto the target. Turning it off keeps the upgrade.
- **Testing view**: toggle testing mode, pick test tags/modules/classes/methods, a test file, `--stop-after-init` and a log level; the launch configuration follows along.
- **Database templates**: save a prepared database as a template and create databases from it in seconds, attachments included, from the Databases view.
- **Checkpoints**: right-click a database → **Create Checkpoint** copies its state in seconds; **Restore Checkpoint** puts it back, attachments included.
- **Several servers at once**: **Run Alongside** on a database's row starts its server next to the ones already running, on its own port.
- **Comparing two databases**: give a database a comparison partner — another database, or one of its checkpoints — and compare a file, a module, a class or method, or a record with it.
- **Views** view: the views a database has turned off, after an upgrade or otherwise. Edit an arch and save it to the database, compare it with the partner, render it in Odoo inside VS Code, check its XPaths, and turn your fixes into an upgrade script.
- **Project Repos** in the Explorer sidebar: a project-scoped file tree showing the copy of each repository the active version uses, with its current branch and a relocate action when a folder moved.
- **Odoo DevTools: Check Version Environments** reports versions whose checkout or interpreter is missing, or that predate your current environments folder, and offers to rebuild them.
- **Editor actions**: right-click inside a module file to run its tests, mark the module for upgrade, reveal it in the Modules view, or compare it with the partner.
- **Keybindings**: everything hangs off the `Ctrl+Alt+O` chord — server (`S`/`X`/`N`/`R`/`H`), switching (`D` database, `V` version, `W` workspace), creating (`C` project, `Shift+D` database, `Shift+M` module, `Shift+V` version), working (`M` configure modules, `U` upgrade current module, `F` run tests for current file, `T` testing mode, `Shift+U` upgrade mode, `L`/`O` tickets, `B` browser) — plus `Ctrl+Alt+P` for project search. Forget one? `Ctrl+Alt+O K` shows the full list as a runnable cheat sheet.
