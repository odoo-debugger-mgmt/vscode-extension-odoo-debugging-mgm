## Select modules and start debugging

In the **Modules** view, click a module to cycle its state: install → upgrade → unmanaged. Your selections become `-i` / `-u` arguments in the generated launch configuration.

Then start Odoo:

- **Odoo DevTools: Start Server** (`Ctrl+Alt+O S`) launches Odoo under the debugger with the active version's settings and the selected database
- **Odoo DevTools: Start Shell** opens an interactive `odoo-bin shell` against the selected database

The extension maintains its own entry in `.vscode/launch.json`; your other launch configurations are left untouched.
