## Work on several versions at once

Each version already owns its Odoo worktree, so two versions can run side by side. Your own addons are a plain checkout by default — one branch at a time — which is what you want for everyday work.

During an upgrade it isn't. Right-click a repository in **Repos** and choose **Use One Copy Per Branch**: every branch that repository is mapped to gets its own directory under the environments folder, and the addons path, module discovery, the Project Repos tree and the generated workspace all follow the active version.

- It is one git repository. Commits made in a copy land on the real branch and `git push` works normally.
- Each copy is a real working tree with its own dirty state, so an unfinished change in one version does not follow you into another.
- If the branch you need is checked out in the source repository, you are asked before anything moves — never surprised.

Turning the mode back off removes the copies the extension created. Repositories you never opt in behave exactly as before.
