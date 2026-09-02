## Create a project

A **project** groups the repositories and databases you work with for one customer/task. The creation wizard walks you through:

1. Naming the project
2. Selecting its repositories (from your custom addons folder)
3. Setting up a database — fresh, restored from a dump, cloned from a template, or connected to an existing PostgreSQL database

The database's Odoo version is detected automatically from its data and linked to the matching version profile. You are then asked which branch each project repository should use for this database — nothing is assumed from what happens to be checked out.

That answer is the database's working state: selecting the database later restores exactly that combination of version and project branches.
