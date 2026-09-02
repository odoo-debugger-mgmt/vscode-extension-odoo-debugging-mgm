# Screen capture plan

The 1.2 GIFs were removed in 1.3.0: every one of them showed a flow that no
longer exists (hand-configured paths, checkout-based version switching,
database creation capturing the current branch). This is what to record to
replace them.

## Tooling

**Record with [Peek](https://github.com/phw/peek)** (`sudo apt install peek`).
It is a resizable frame you drop over the area you want, it exports GIF, WebM
and MP4, and it does nothing else — which is the point when the alternative is
fighting OBS to crop a region.

Wayland note: Peek's GIF recording needs XWayland. If your session is Wayland
and the frame records black, run VS Code with `--ozone-platform=x11` for the
capture session, or record with `wf-recorder -g "$(slurp)"` and convert.

**Optimise every capture before committing it.** Straight out of Peek a
30-second clip is 5–15 MB, and it ships inside the `.vsix` to every user.

```bash
# GIF: cap the palette and frame rate, then compress losslessly
gifsicle -O3 --lossy=80 --colors 128 in.gif -o out.gif
```

**Prefer MP4 over GIF where the target allows it.** The VS Code Marketplace
README renders GitHub-flavoured Markdown and does *not* play video, so the
README needs GIFs. The walkthrough (`media/walkthrough/*.md`) and the docs in
this folder can both use MP4, at roughly a tenth of the size:

```bash
ffmpeg -i in.mp4 -vf "scale=1280:-2" -c:v libx264 -crf 28 -preset slow \
       -movflags +faststart out.mp4
```

### Budget

Assets ship inside the extension. The 1.2 set was 12 MB of a 12.5 MB package.

- **Hard cap: 1.5 MB per GIF, 6 MB for the whole `resources/assets` folder.**
- 1280×720 or smaller. Crop to the panel that matters — a full 4K desktop
  scaled down is unreadable and enormous.
- 10–15 fps. These are UI clicks, not motion.
- 15–25 seconds each. If a scenario needs longer, it needs splitting.

### Before you hit record

- Fresh VS Code profile (`code --profile capture`) so no unrelated extensions,
  no personal repos in the Explorer, no unread notification badges.
- Default Dark Modern theme, editor font ~14px, sidebar wide enough that
  version names are not truncated.
- Scrub identifying data: customer repo names, ticket numbers, database names,
  absolute paths containing your username. Use `~/odoo-dev` and a repo named
  something neutral.
- Move the mouse deliberately and pause ~1s on each result. Viewers cannot
  scrub a GIF.

---

## Scenarios to record

Ordered by how much they carry. If only three get made, make the first three.

### 1. `setup.gif` — first run *(README step 2, walkthrough `setUp`)*

**Replaces:** `odoo-setup.gif`, `vscode-settings.gif`.

Start from a VS Code window with the extension freshly installed and no
configuration. The first-run notification appears; accept it. Setup detects the
Odoo checkouts already on disk and shows them for confirmation. Confirm. Show
the environments directory defaulting to `~/odoo-dev`.

**The point:** two answers, mostly pre-filled, once per machine — not a
settings file to fill in. This is the single most important capture, because
step 3 of the old Quick Start actively taught the wrong thing.

### 2. `create-version.gif` — provisioning *(README step 4, walkthrough `createVersion`)*

**Replaces:** `version-setup.gif`.

Create Version. Pick a branch from the list. Confirm the suggested name. Then
let the progress notification run: worktree, interpreter selection, virtualenv,
requirements. Finish on the Versions tree showing the version provisioned, with
its derived port.

**The point:** one command produces a working environment. Do not cut the
progress — the wait is the feature, and testers need to know it is normal.

Record a branch whose requirements install quickly, or trim the middle of the
`pip install` with a cut rather than a speed-up.

### 3. `per-version-code.gif` — one copy per branch *(walkthrough `perVersionCode`)*

**No predecessor — this is the 1.3 headline feature and has never been shown.**

Two versions already provisioned. Right-click a repository in **Repos** →
**Use One Copy Per Branch**, and accept the explanation dialog. Then switch the
active version and show the Project Repos tree following it: same repository,
different branch, different working copy. Ideally show a file open from each.

**The point:** custom addons stop being a single shared checkout. This is what
you most want testers to exercise, so it is worth the extra seconds.

### 4. `parallel-versions.gif` — two servers at once

**No predecessor.**

Start the server on one version. Without stopping it, switch to a second
version and start that one too. Show both running in the Databases view with
their ports, then **Open in Browser** on each landing on the right port.

**The point:** the reason worktrees exist. Static screenshots cannot show it.

### 5. `create-project.gif` — project and first database *(README step 5)*

**Replaces:** `project-creation.gif`, `database-creation.gif`.

Create Project: name, repository selection, then a database — restore from a
dump is the most representative. Show the Odoo version being detected from the
database, and **the prompt asking which branch each project repo should use**.

**The point:** that last prompt is new. The old GIF showed branches being
captured silently, which is exactly the behaviour that was removed.

### 6. `modules.gif` — module selection *(README step 6)*

**Replaces:** `module-management.gif`.

Click modules to cycle install → upgrade → unmanaged, then show the generated
`-i` / `-u` in `.vscode/launch.json`.

**The point:** unchanged behaviour, but the old GIF is from a different theme
and icon set. Lowest priority — re-record only if the visual mismatch bothers
you.

### 7. `check-environments.gif` — migration *(README step 3 tail)*

**No predecessor.**

Run **Check Version Environments** against a version left over from 1.2, show
it reported as missing or relocated, and accept the rebuild.

**The point:** existing users have this problem right now. Short and worth it.

---

## Where each one lands

| Capture | README | Walkthrough step |
|---|---|---|
| `setup.gif` | step 2 | `setUp` |
| `create-version.gif` | step 4 | `createVersion` |
| `per-version-code.gif` | "One copy per branch" | `perVersionCode` |
| `parallel-versions.gif` | Versions view | — |
| `create-project.gif` | step 5 | `createProject` |
| `modules.gif` | step 6 | `startDebugging` |
| `check-environments.gif` | step 3 | — |

Walkthrough steps take `"media": {"image": "..."}` or `{"markdown": "..."}` but
not both, so a step that gains an image loses its prose. Keep the prose and
reference the image from inside the Markdown file instead.
