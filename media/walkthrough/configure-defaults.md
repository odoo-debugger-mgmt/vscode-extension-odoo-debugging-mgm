## Configure your default paths

New version profiles copy their settings from `odooDebugger.defaultVersion.*`, so set these once and every version starts out right:

- **odooPath / enterprisePath / designThemesPath** — where your Odoo core repositories live
- **customAddonsPath** — the folder containing your custom addon sources (git repos and plain folders with Odoo modules are auto-detected)
- **pythonPath** — your virtualenv's Python executable
- **dumpsFolder** — where your database dumps are stored

Absolute paths are recommended.

Tip: if you don't have Odoo checked out yet, the **Setup Odoo** action in the Projects view can clone the Odoo repositories for you — full setup with a virtualenv, or a fast **shallow clone** of a single branch into any folder, with a version profile created for it in one click.
