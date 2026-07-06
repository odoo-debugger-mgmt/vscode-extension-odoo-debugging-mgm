# Change Log

All notable changes to the "odoo-devtools-vscode" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.2.0] - Unreleased

### Changed

- **Databases now carry their full environment.** Selecting a database aligns the active version, the core Odoo repo branches, and the project repo branches through a single switch pipeline with one summary notification, replacing three different prompt flows.
- `odooDebugger.databaseSwitchBehavior` simplified to `auto` (new default) / `ask` / `never`. Legacy values (`auto-both`, `auto-version-only`, `auto-branch-only`) are migrated automatically. `ask` is now a single non-modal notification instead of a blocking quick-pick.
- **Database creation is 2–3 prompts instead of ~6**: choose the method, pick the source (dump/template/existing), confirm the pre-filled name. The version is auto-detected from the database itself (base module version), and the current branch of every project repo is captured automatically as the database's working state.
- **Connect to Existing** now lists your live PostgreSQL databases instead of asking you to type a name.
- **Version creation is 2 prompts**: pick the branch (listed from your odoo repo), confirm the suggested name. Paths and ports come from `odooDebugger.defaultVersion.*` and stay editable in the Versions tree.
- New databases use their plain PostgreSQL identifier as the display name (the "Project • Kind • Date • #hash" format is retired; existing names are kept).

### Added

- Odoo version auto-detection from PostgreSQL: restored/connected databases are probed for their Odoo series (e.g. `17.0`, `saas-17.4`) and linked to the matching version profile, with a one-click offer to create the profile when missing.

### Fixed

- Removed contributed commands that were never implemented (`Get Database`, Explorer `New File`/`New Folder`/`Rename`/`Delete` aliases), which errored with "command not found".
- Removed the accidental `install` and `npm` runtime dependencies.
- Legacy per-database `odooVersion` data is migrated into version links (or the branch label) on first activation.

## [Unreleased]

- Initial release