## Explore the rest

- **Switching contexts**: selecting a database restores the version and project repo branches recorded for it (`odooDebugger.databaseSwitchBehavior`: `auto` / `ask` / `never`). The status bar shows the active project, database and version — click any of them to switch.
- **Testing view**: toggle testing mode, pick test tags/modules/classes/methods, a test file, `--stop-after-init` and a log level; the launch configuration follows along.
- **Database templates**: save a prepared database as a template (`createdb -T`) and spin up clones in seconds from the Databases view.
- **Project Repos** in the Explorer sidebar: a project-scoped file tree showing the copy of each repository the active version uses, with its current branch and a relocate action when a folder moved.
- **Odoo DevTools: Check Version Environments** reports versions whose checkout or interpreter is missing, or that predate your current environments folder, and offers to rebuild them.
- **Editor actions**: right-click inside a module file to run its tests, mark the module for upgrade, or reveal it in the Modules view.
- **Keybindings**: everything hangs off the `Ctrl+Alt+O` chord — server (`S`/`X`/`N`/`R`/`H`), switching (`D` database, `V` version, `W` workspace), creating (`C` project, `Shift+D` database, `Shift+M` module, `Shift+V` version), working (`M` configure modules, `U` upgrade current module, `F` run tests for current file, `T` testing mode, `L`/`O` tickets, `B` browser) — plus `Ctrl+Alt+P` for project search. Forget one? `Ctrl+Alt+O K` shows the full list as a runnable cheat sheet.
