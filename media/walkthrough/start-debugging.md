## Select modules and start debugging

In the **Modules** view, click a module to cycle its state: install → upgrade → unmanaged. Your selections become `-i` / `-u` arguments in the generated launch configuration.

Then start Odoo:

- **Odoo DevTools: Start Server** (`Ctrl+Alt+O S`) launches Odoo under the debugger with the active version's environment and the selected database
- **Odoo DevTools: Start Shell** opens an interactive `odoo-bin shell` against the selected database

Each provisioned version gets its own launch entry, debugger name and port, filled in from its branch — so two versions can run at the same time without colliding. To run another database next to it, right-click it in the Databases view → **Run Alongside**. The Versions and Databases views show which are live and on which port, and **Open in Browser** uses that port.

The extension maintains only its own entries in `.vscode/launch.json` (or in your `.code-workspace` file); your other launch configurations are left untouched.
