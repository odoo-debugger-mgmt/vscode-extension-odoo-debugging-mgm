## Configure your default paths

New version profiles copy their settings from `odooDebugger.defaultVersion.*`, so set these once and every version starts out right:

- **odooPath / enterprisePath / designThemesPath** — where your Odoo core repositories live
- **customAddonsPath** — the folder containing your custom addon repositories (git repos are auto-detected)
- **pythonPath** — your virtualenv's Python executable
- **dumpsFolder** — where your database dumps are stored

Absolute paths are recommended.

Tip: if you don't have Odoo checked out yet, the **Setup Odoo** action in the Projects view can clone `odoo` + `enterprise` and create a virtualenv for you.
