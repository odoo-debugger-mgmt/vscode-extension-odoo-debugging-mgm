# Database Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-click a database → *Create Checkpoint* keeps a protected PostgreSQL copy of it (filestore hard-linked) under its row. *Restore* swaps it back in by rename, and the database's server comes back if it was running. Clone and Templates get the same copy, so they keep attachments too.

**Architecture:** There are three pure layers, each tested against a fake. `odooDataDir.ts` finds the filestore. `filestore.ts` hard-links a tree. `databaseCopy.ts` holds the SQL and rename steps, with rollback, over a `CopyBackend` interface. `connectionRelease.ts` decides what to stop and what to ask, over `ReleaseHost`/`ReleaseUi` interfaces. `copyRuntime.ts` is the only file that wires them to psql, the debug sessions and the dialogs. The Databases tree gains child rows, and four commands act on them.

**Tech Stack:** TypeScript (VS Code extension API, mocha TDD `suite`/`test` in the Extension Host), PostgreSQL 17 via `psql`, Node `fs/promises`.

**Spec:** `docs/superpowers/specs/2026-10-07-database-checkpoints-design.md`. The user reviewed it and said "go ahead" on 2026-10-08. Read it with this plan. Also read `docs/superpowers/notes/2026-10-08-handover-general-features.md` §1 (rules) and §5 (verification).

## Global Constraints

- Branch `v-1.5` only. **Never merge, push, or offer to.** The extension never runs `git commit` for the user.
- Leave the uncommitted `.vscode/launch.json` and `.vscode/tasks.json` and the untracked root dotfiles alone. **Never `git add -A` or `git add .`**; add the files you touched by name.
- Commits: `[ADD]` / `[IMP]` / `[FIX]` / `[REF]` / `[DOC]` prefix, a short body, and the trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. `dist/` is rebuilt only in Task 9. In other tasks run `git checkout -- dist` after tests, if the tests touched it.
- Projects from `SettingsStore` are **plain JSON cast to the model**, not hydrated: a new field is `undefined` on every existing project. Read `checkpoints` only through `checkpointsOf()`.
- `getChildren(element)` handles `element` first. A `getChildren` that ignores it recurses as soon as a row is collapsible.
- Destructive actions are right-click only, behind a modal. Restore and Delete Checkpoint are never inline.
- Every shell-out goes through `runCommand` (arguments as arrays, no shell). Identifiers go through `quotePgIdentifier`. Text values go into SQL only through `sqlText` (`src/services/views/viewQueries.ts`), or as psql `:'var'` variables on stdin.
- Checkpoint name: `<db>__cp_<base36 epoch seconds>`. Over 63 bytes, the database part is cut and a 6-character SHA-1 hash of the full name is added.
- A checkpoint is protected: `ALTER DATABASE … WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`. Dropping one sets `IS_TEMPLATE false` first.
- The copy is `CREATE DATABASE "<t>" TEMPLATE "<s>" STRATEGY FILE_COPY` on PostgreSQL ≥ 15 (`server_version_num` ≥ 150000), and plain `CREATE DATABASE "<t>" TEMPLATE "<s>"` before that.
- Modal copy, verbatim from the spec:
  - stop: `"<db>" is running in this window. Stop it to <purpose>? It restarts afterwards.`, with the button **Stop and Continue**;
  - restore: `Restore "<db label>" to "<checkpoint label>"? Everything since is lost.`, with the buttons **Restore** and **Checkpoint Current State, then Restore**.
- Copy style: plain, short sentences, like the existing CHANGELOG and README.
- Verification commands (all from the repo root):
  - `npx tsc -p . --noEmit` — 0 errors.
  - `npm run lint` — 0 errors. 117 warnings is the baseline; new files add none.
  - Tests run **outside the Bash sandbox** (`dangerouslyDisableSandbox: true`) with `env -u ELECTRON_RUN_AS_NODE`. One suite: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "<suite name>"`. Full suite: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npm test`. Baseline before this plan: 862 passing, 26 pending, 0 failing.
- IDE diagnostics `OWL000` in TS files are false positives; trust `tsc`.

## Review Focus

These are the inputs the spec implies but no happy-path test would hit, most likely first. Each has a test in the task named.

1. **A long database name** (60+ bytes). The checkpoint, `__restoring` and `__replaced` names stay ≤ 63 bytes and stay distinct; PostgreSQL would otherwise truncate them silently, and two names would collide. (Task 2.)
2. **A restore that fails halfway**, at the second rename or at the filestore swap. The database is back under its own name with its own filestore, and the error says so. If the undo fails too, the error names `<db>__replaced`. (Task 3.)
3. **A restore after an interrupted one.** A leftover `<db>__restoring` is dropped. A leftover `<db>__replaced` is refused and named, because it may be the only copy of the data. (Task 3.)
4. **A connection that comes back during the copy**: the View Doctor's arch poll reconnects every 3 s. The copy retries after ending only the extension's own backends; a stranger's connection is never ended without the modal. (Tasks 3 and 4.)
5. **A filestore on another filesystem, or a database with no filestore folder.** EXDEV falls back to a real copy and says so in the log. No folder gives `filestore: false`, and restoring that checkpoint removes the live folder. (Tasks 1 and 3.)

## Rulings made while planning

Each is *decision — why — cost if wrong*. They add to the spec's six.

- **P1. Scope.** The user's "go ahead" (2026-10-08) approves both specs and the two rulings proposed before it: a free `--gevent-port` for Alongside runs with workers, and reads of a checkpoint partner taking turns. The user then said to execute without waiting — cost if wrong: the work follows the spec as written.
- **P2.** The checkpoint record's PostgreSQL name field is `id`, not `dbName`. The store's three-way merge matches array records by `id`, so checkpoints added in two windows both survive — cost if wrong: none.
- **P3.** Release and restart wrap the copy (`withReleased` in `copyRuntime.ts`) instead of living inside `copyDatabase`. *Checkpoint Current State, then Restore* then stops the server once and asks once, not twice — cost if wrong: none; the spec's step order is kept.
- **P4.** A checkpoint carries a database comment, `odoo-devtools checkpoint of <db>`. Reconcile finds orphans by that comment, because truncated names cannot be parsed back — cost if wrong: a checkpoint made by hand in psql is not recognised.
- **P5.** Reconcile lists orphaned checkpoint databases unticked and confirms before dropping them. Dropping one is destructive, and another workspace may own it — cost if wrong: one more click.
- **P6.** A copy, drop or rename retries up to 4 times, 500 ms apart, when PostgreSQL says "is being accessed by other users". Between tries it ends only the extension's own backends (`odoo-devtools-query` and View Doctor shells) — cost if wrong: under 2 s more before an honest failure.
- **P7.** An interrupted restore's `<db>__restoring` is dropped without asking: it is only a copy of a checkpoint. `<db>__replaced` is refused and named — cost if wrong: the user renames or drops it in psql once.
- **P8.** Delete Database also removes the database's filestore folder, as Odoo's own drop does. The hard links keep the checkpoints' files — cost if wrong: the attachments of a deleted database are gone with it.
- **P9.** Renaming a template renames its filestore folder, and deleting its database removes the folder — cost if wrong: none.
- **P10.** If a filestore folder exists under the target's name but no database does, a copy replaces the folder: it belongs to no database — cost if wrong: stray files from a database dropped outside the extension are lost.
- **P11.** Restore, Rename and Delete Checkpoint are hidden from the palette, because they need a row. Create Checkpoint stays and acts on the selected database — cost if wrong: palette users use the tree.
- **P12.** A clone gets no checkpoint records — cost if wrong: none; the checkpoints stay with their source.
- **P13.** *Checkpoint Current State, then Restore* labels the new checkpoint `Before restoring <label>` without asking — cost if wrong: one rename.
- **P14.** The data dir also honours `XDG_DATA_HOME` on Linux, `OPENERP_SERVER`, and Windows' `odoo.conf` next to `odoo-bin`, because Odoo 17 and 19's `tools/config.py` do. Relative paths resolve against the server's run directory — cost if wrong: none.
- **P15.** The source and the target share one data dir: the source database's version's — cost if wrong: none for one data dir per machine, the normal case.
- **P16.** The inline icon for Create Checkpoint is `$(bookmark)`, and a checkpoint row's is `$(history)` (from the spec) — cost if wrong: a cosmetic swap.

## File structure

| File | Responsibility |
|---|---|
| `src/services/odooDataDir.ts` (new) | `resolveOdooDataDir()`: pure, finds Odoo's data dir the way Odoo does |
| `src/services/filestore.ts` (new) | `linkTree()` hard-link copy with fallback; `removeTree`, `dirExists`, `renameDir` |
| `src/services/checkpoints.ts` (new) | `CheckpointModel`, `checkpointsOf`/`setCheckpoints`, naming, labels, age/size formatting, size/comment SQL and parsers, orphan finder. Pure |
| `src/services/databaseCopy.ts` (new) | `CopyBackend`; `copyDatabase`, `discardDatabase`, `stageRestore`, `swapInRestored`, `retryWhileBusy`. Pure over the backend |
| `src/services/connectionRelease.ts` (new) | `releaseForCopy()` over `ReleaseHost`/`ReleaseUi`; the connection SQL and its parser. Pure |
| `src/services/copyRuntime.ts` (new) | the real backend, host and dialogs; `withReleased()`, `filestoreRootFor()` |
| `src/models/db.ts` | `checkpoints?: CheckpointModel[]` field |
| `src/dbs.ts` | Clone, Create from Template, Create Template, template rename/delete, Delete Database, and Reconcile all move onto the copy |
| `src/services/reconcile.ts` | stale checkpoint records and orphaned checkpoint databases |
| `src/views/dbsView.ts` | checkpoint rows, `getChildren(element)`, `getParent` |
| `src/commands/checkpointCommands.ts` (new) | Create / Restore / Rename / Delete Checkpoint |
| `src/commands/index.ts`, `package.json` | registration, commands, menus |
| `src/test/*.test.ts` | unit tests per task; `checkpoints.integration.test.ts` gated by `ODT_PG_TEST=1` |
| `README.md`, `CHANGELOG.md`, `dist/` | Task 9 |

---

### Task 1: The data dir and the hard-link tree copy

**Files:**
- Create: `src/services/odooDataDir.ts`
- Create: `src/services/filestore.ts`
- Test: `src/test/odooDataDir.test.ts`, `src/test/filestore.test.ts`

**Interfaces:**
- Produces:
  - `resolveOdooDataDir(inputs: DataDirInputs): string`
  - `interface DataDirInputs { extraParams: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; home: string; cwd: string; odooPath: string; readText(file: string): string | undefined }`
  - `extraParamValue(tokens: string[], long: string, short: string): string | undefined`
  - `readConfigDataDir(text: string): string | undefined`
  - `filestoreRootOf(dataDir: string, platform?: NodeJS.Platform): string`, which returns `<dataDir>/filestore`
  - `linkTree(src: string, dst: string, ops?: LinkOps): Promise<LinkTreeResult>`
  - `interface LinkTreeResult { files: number; copied: number }`
  - `interface LinkOps { link(src: string, dst: string): Promise<void>; copyFile(src: string, dst: string): Promise<void> }`
  - `dirExists(dir: string): Promise<boolean>`
  - `removeTree(dir: string): Promise<void>`
  - `renameDir(from: string, to: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`src/test/odooDataDir.test.ts`:

```ts
import * as assert from 'assert';
import { extraParamValue, filestoreRootOf, readConfigDataDir, resolveOdooDataDir, DataDirInputs } from '../services/odooDataDir';

function inputs(overrides: Partial<DataDirInputs> = {}, files: Record<string, string> = {}): DataDirInputs {
    return {
        extraParams: '--log-handler,odoo.addons.base.models.ir_attachment:WARNING',
        env: {},
        platform: 'linux',
        home: '/home/me',
        cwd: '/work',
        odooPath: '/work/odoo',
        readText: file => files[file],
        ...overrides
    };
}

suite('Odoo data dir', () => {
    test('reads --data-dir in every form, the last one winning', () => {
        assert.strictEqual(extraParamValue(['--data-dir=/a'], '--data-dir', '-D'), '/a');
        assert.strictEqual(extraParamValue(['--data-dir /b'], '--data-dir', '-D'), '/b');
        assert.strictEqual(extraParamValue(['--data-dir', '/c'], '--data-dir', '-D'), '/c');
        assert.strictEqual(extraParamValue(['-D', '/d'], '--data-dir', '-D'), '/d');
        assert.strictEqual(extraParamValue(['-D /e'], '--data-dir', '-D'), '/e');
        assert.strictEqual(extraParamValue(['-D/f'], '--data-dir', '-D'), '/f');
        assert.strictEqual(extraParamValue(['-D', '/x', '--data-dir=/y'], '--data-dir', '-D'), '/y');
        assert.strictEqual(extraParamValue(['--dev=all', '-d', 'db'], '--data-dir', '-D'), undefined);
    });

    test('a --data-dir in the extra params wins over everything', () => {
        const dir = resolveOdooDataDir(inputs(
            { extraParams: '--dev=all,--data-dir=~/odoo-data', env: { ODOO_RC: '/etc/odoo.conf' } },
            { '/etc/odoo.conf': '[options]\ndata_dir = /srv/elsewhere\n' }
        ));
        assert.strictEqual(dir, '/home/me/odoo-data');
    });

    test('a relative --data-dir resolves against the run directory', () => {
        assert.strictEqual(resolveOdooDataDir(inputs({ extraParams: '-D,data' })), '/work/data');
    });

    test('then the config file named by -c, $ODOO_RC, $OPENERP_SERVER, ~/.odoorc, ~/.openerp_serverrc', () => {
        const conf = (dir: string) => `[options]\naddons_path = x\ndata_dir = ${dir}\n`;
        assert.strictEqual(resolveOdooDataDir(inputs(
            { extraParams: '-c,/etc/a.conf', env: { ODOO_RC: '/etc/b.conf' } },
            { '/etc/a.conf': conf('/from/c'), '/etc/b.conf': conf('/from/rc') }
        )), '/from/c');
        assert.strictEqual(resolveOdooDataDir(inputs(
            { env: { ODOO_RC: '/etc/b.conf', OPENERP_SERVER: '/etc/c.conf' } },
            { '/etc/b.conf': conf('/from/rc'), '/etc/c.conf': conf('/from/openerp') }
        )), '/from/rc');
        assert.strictEqual(resolveOdooDataDir(inputs(
            { env: { OPENERP_SERVER: '/etc/c.conf' } },
            { '/etc/c.conf': conf('/from/openerp') }
        )), '/from/openerp');
        assert.strictEqual(resolveOdooDataDir(inputs({}, { '/home/me/.odoorc': conf('$HOME/odoorc-data') })), '/home/me/odoorc-data');
        assert.strictEqual(resolveOdooDataDir(inputs({}, { '/home/me/.openerp_serverrc': conf('/legacy') })), '/legacy');
    });

    test('a config file without data_dir falls through to the default', () => {
        assert.strictEqual(
            resolveOdooDataDir(inputs({}, { '/home/me/.odoorc': '[options]\nhttp_port = 8069\n' })),
            '/home/me/.local/share/Odoo'
        );
    });

    test('reads data_dir only from the [options] section, with = or :', () => {
        assert.strictEqual(readConfigDataDir('[other]\ndata_dir = /no\n[options]\ndata_dir: /yes\n'), '/yes');
        assert.strictEqual(readConfigDataDir('; comment\n[options]\n  data_dir   =   /spaced  \n'), '/spaced');
        assert.strictEqual(readConfigDataDir('[options]\ndata_dir = False\n'), undefined);
        assert.strictEqual(readConfigDataDir('[options]\ndata_dir =\n'), undefined);
    });

    test('the platform defaults', () => {
        assert.strictEqual(resolveOdooDataDir(inputs()), '/home/me/.local/share/Odoo');
        assert.strictEqual(resolveOdooDataDir(inputs({ env: { XDG_DATA_HOME: '/xdg' } })), '/xdg/Odoo');
        assert.strictEqual(
            resolveOdooDataDir(inputs({ platform: 'darwin', home: '/Users/me' })),
            '/Users/me/Library/Application Support/Odoo'
        );
        assert.strictEqual(
            resolveOdooDataDir(inputs({
                platform: 'win32', home: 'C:\\Users\\me', cwd: 'C:\\work', odooPath: 'C:\\work\\odoo',
                env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }
            })),
            'C:\\Users\\me\\AppData\\Local\\OpenERP S.A.\\Odoo'
        );
    });

    test('on Windows the default config file is odoo.conf next to odoo-bin', () => {
        assert.strictEqual(
            resolveOdooDataDir(inputs(
                { platform: 'win32', home: 'C:\\Users\\me', cwd: 'C:\\work', odooPath: 'C:\\work\\odoo', env: {} },
                { 'C:\\work\\odoo\\odoo.conf': '[options]\ndata_dir = D:\\odoo-data\n' }
            )),
            'D:\\odoo-data'
        );
    });

    test('the filestore root is <data dir>/filestore', () => {
        assert.strictEqual(filestoreRootOf('/home/me/.local/share/Odoo'), '/home/me/.local/share/Odoo/filestore');
    });
});
```

`src/test/filestore.test.ts`:

```ts
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { dirExists, linkTree, removeTree, renameDir, LinkOps } from '../services/filestore';

async function tree(root: string): Promise<string[]> {
    const out: string[] = [];
    async function walk(dir: string) {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                out.push(path.relative(root, full) + '/');
                await walk(full);
            } else {
                out.push(path.relative(root, full));
            }
        }
    }
    await walk(root);
    return out.sort();
}

suite('Filestore tree copy', () => {
    let tmp: string;

    setup(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'odt-fs-'));
        await fs.mkdir(path.join(tmp, 'src', 'ab'), { recursive: true });
        await fs.mkdir(path.join(tmp, 'src', 'cd', 'empty'), { recursive: true });
        await fs.writeFile(path.join(tmp, 'src', 'ab', 'ab12'), 'one');
        await fs.writeFile(path.join(tmp, 'src', 'cd', 'cd34'), 'two');
    });

    teardown(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    test('hard-links every file into the same tree, empty folders included', async () => {
        const result = await linkTree(path.join(tmp, 'src'), path.join(tmp, 'dst'));
        assert.deepStrictEqual(result, { files: 2, copied: 0 });
        assert.deepStrictEqual(await tree(path.join(tmp, 'dst')), await tree(path.join(tmp, 'src')));
        const [a, b] = await Promise.all([
            fs.stat(path.join(tmp, 'src', 'ab', 'ab12')),
            fs.stat(path.join(tmp, 'dst', 'ab', 'ab12'))
        ]);
        assert.strictEqual(a.ino, b.ino, 'the file is linked, not copied');
    });

    test('falls back to copying, for the rest of the tree, when linking is refused', async () => {
        let linkCalls = 0;
        const ops: LinkOps = {
            link: async () => {
                linkCalls++;
                throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
            },
            copyFile: (from, to) => fs.copyFile(from, to)
        };
        const result = await linkTree(path.join(tmp, 'src'), path.join(tmp, 'dst'), ops);
        assert.deepStrictEqual(result, { files: 2, copied: 2 });
        assert.strictEqual(linkCalls, 1, 'once refused, linking is not tried again');
        assert.strictEqual(await fs.readFile(path.join(tmp, 'dst', 'cd', 'cd34'), 'utf8'), 'two');
    });

    test('any other link error is not swallowed', async () => {
        const ops: LinkOps = {
            link: async () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); },
            copyFile: (from, to) => fs.copyFile(from, to)
        };
        await assert.rejects(linkTree(path.join(tmp, 'src'), path.join(tmp, 'dst'), ops), /no space/);
    });

    test('never merges into an existing folder', async () => {
        await fs.mkdir(path.join(tmp, 'dst'));
        await assert.rejects(linkTree(path.join(tmp, 'src'), path.join(tmp, 'dst')), /already exists/);
    });

    test('dirExists, renameDir and removeTree', async () => {
        assert.strictEqual(await dirExists(path.join(tmp, 'src')), true);
        assert.strictEqual(await dirExists(path.join(tmp, 'nope')), false);
        await fs.writeFile(path.join(tmp, 'file'), 'x');
        assert.strictEqual(await dirExists(path.join(tmp, 'file')), false, 'a file is not a folder');
        await renameDir(path.join(tmp, 'src'), path.join(tmp, 'moved'));
        assert.strictEqual(await dirExists(path.join(tmp, 'moved')), true);
        await removeTree(path.join(tmp, 'moved'));
        assert.strictEqual(await dirExists(path.join(tmp, 'moved')), false);
        await removeTree(path.join(tmp, 'moved'));
    });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run compile-tests` — Expected: TS errors, because the modules do not exist yet.

- [ ] **Step 3: Implement `src/services/odooDataDir.ts`**

```ts
/**
 * Where Odoo keeps its data dir, found the way Odoo itself finds it
 * (odoo/tools/config.py, 15.0-19.0): `--data-dir` on the command line, else
 * `data_dir` in the config file, else the platform default from appdirs. The
 * filestore of database `x` is `<data dir>/filestore/x`. Pure: the caller
 * passes the environment and a file reader.
 */
import * as path from 'node:path';

export interface DataDirInputs {
    /** The version's comma-separated extra parameters, as passed to odoo-bin. */
    extraParams: string;
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    home: string;
    /** Where odoo-bin runs; relative paths resolve here. */
    cwd: string;
    /** The version's odoo folder: on Windows, Odoo's default config file sits next to odoo-bin. */
    odooPath: string;
    /** A file's text, or undefined when it cannot be read. */
    readText(file: string): string | undefined;
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
    return platform === 'win32' ? path.win32 : path.posix;
}

/** The value of an option in comma-split extra params; the last one wins, as with optparse. */
export function extraParamValue(tokens: string[], long: string, short: string): string | undefined {
    let value: string | undefined;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === long || token === short) {
            if (i + 1 < tokens.length) {
                value = tokens[++i];
            }
        } else if (token.startsWith(`${long}=`) || token.startsWith(`${long} `)) {
            value = token.slice(long.length + 1);
        } else if (token.startsWith(short) && !token.startsWith('--')) {
            value = token.slice(short.length);
        }
    }
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

/** `data_dir` from an Odoo config file's [options] section. */
export function readConfigDataDir(text: string): string | undefined {
    let section = '';
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith(';') || line.startsWith('#')) {
            continue;
        }
        const header = /^\[(.+)\]$/.exec(line);
        if (header) {
            section = header[1].trim();
            continue;
        }
        if (section !== 'options') {
            continue;
        }
        const match = /^data_dir\s*[=:]\s*(.*)$/.exec(line);
        if (match) {
            const value = match[1].trim();
            return value && value !== 'False' && value !== 'None' ? value : undefined;
        }
    }
    return undefined;
}

/** `~`, `$VAR`, `${VAR}` and `%VAR%` expanded, then made absolute against `cwd`. */
function expandPath(value: string, inputs: DataDirInputs): string {
    const p = pathApi(inputs.platform);
    let expanded = value.replace(/^~(?=$|[\\/])/, inputs.home);
    expanded = expanded.replace(/\$\{(\w+)\}|\$(\w+)|%(\w+)%/g, (whole, a, b, c) => {
        const name = a ?? b ?? c;
        if (name === 'HOME' && inputs.env.HOME === undefined) {
            return inputs.home;
        }
        return inputs.env[name] ?? whole;
    });
    return p.resolve(inputs.cwd, expanded);
}

function defaultConfigFile(inputs: DataDirInputs): string | undefined {
    const p = pathApi(inputs.platform);
    if (inputs.platform === 'win32') {
        return p.join(inputs.odooPath, 'odoo.conf');
    }
    const current = p.join(inputs.home, '.odoorc');
    const legacy = p.join(inputs.home, '.openerp_serverrc');
    if (inputs.readText(current) === undefined && inputs.readText(legacy) !== undefined) {
        return legacy;
    }
    return current;
}

function platformDefault(inputs: DataDirInputs): string {
    const p = pathApi(inputs.platform);
    if (inputs.platform === 'win32') {
        const local = inputs.env.LOCALAPPDATA || p.join(inputs.home, 'AppData', 'Local');
        return p.join(local, 'OpenERP S.A.', 'Odoo');
    }
    if (inputs.platform === 'darwin') {
        return p.join(inputs.home, 'Library', 'Application Support', 'Odoo');
    }
    return p.join(inputs.env.XDG_DATA_HOME || p.join(inputs.home, '.local', 'share'), 'Odoo');
}

export function resolveOdooDataDir(inputs: DataDirInputs): string {
    const tokens = inputs.extraParams.split(',').map(token => token.trim()).filter(Boolean);

    const fromArgs = extraParamValue(tokens, '--data-dir', '-D');
    if (fromArgs) {
        return expandPath(fromArgs, inputs);
    }

    const configArg = extraParamValue(tokens, '--config', '-c');
    const configFile = configArg
        ? expandPath(configArg, inputs)
        : inputs.env.ODOO_RC || inputs.env.OPENERP_SERVER || defaultConfigFile(inputs);
    const text = configFile ? inputs.readText(configFile) : undefined;
    const fromConfig = text === undefined ? undefined : readConfigDataDir(text);
    if (fromConfig) {
        return expandPath(fromConfig, inputs);
    }

    return platformDefault(inputs);
}

export function filestoreRootOf(dataDir: string, platform: NodeJS.Platform = process.platform): string {
    return pathApi(platform).join(dataDir, 'filestore');
}
```

- [ ] **Step 4: Implement `src/services/filestore.ts`**

```ts
/**
 * Odoo's filestore copied by hard links. Safe because Odoo never changes a
 * filestore file in place: a file is named by the SHA-1 of its content,
 * written once only when it does not exist yet (ir_attachment._file_write,
 * 15.0-19.0), and the garbage collector only unlinks. So two folders can share
 * the underlying files forever, and a checkpoint of a 5 GB filestore costs
 * almost nothing.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface LinkTreeResult {
    files: number;
    /** Files copied because linking was refused (another filesystem, some Windows volumes). */
    copied: number;
}

export interface LinkOps {
    link(src: string, dst: string): Promise<void>;
    copyFile(src: string, dst: string): Promise<void>;
}

const realOps: LinkOps = {
    link: (src, dst) => fs.link(src, dst),
    copyFile: (src, dst) => fs.copyFile(src, dst)
};

/** Errors that mean "links are not possible here", not "something broke". */
const NO_LINKS = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'ENOSYS']);

export async function dirExists(dir: string): Promise<boolean> {
    try {
        return (await fs.stat(dir)).isDirectory();
    } catch {
        return false;
    }
}

export async function removeTree(dir: string): Promise<void> {
    await fs.rm(dir, { recursive: true, force: true });
}

export async function renameDir(from: string, to: string): Promise<void> {
    await fs.rename(from, to);
}

/** Recreates `src` at `dst`, linking every file. `dst` must not exist. */
export async function linkTree(src: string, dst: string, ops: LinkOps = realOps): Promise<LinkTreeResult> {
    if (await dirExists(dst) || await fs.lstat(dst).then(() => true, () => false)) {
        throw new Error(`${dst} already exists.`);
    }
    const result: LinkTreeResult = { files: 0, copied: 0 };
    let linking = true;

    async function walk(from: string, to: string): Promise<void> {
        await fs.mkdir(to, { recursive: true });
        for (const entry of await fs.readdir(from, { withFileTypes: true })) {
            const source = path.join(from, entry.name);
            const target = path.join(to, entry.name);
            if (entry.isDirectory()) {
                await walk(source, target);
            } else if (entry.isSymbolicLink()) {
                await fs.symlink(await fs.readlink(source), target);
            } else if (entry.isFile()) {
                result.files++;
                if (linking) {
                    try {
                        await ops.link(source, target);
                        continue;
                    } catch (error) {
                        if (!NO_LINKS.has((error as NodeJS.ErrnoException).code ?? '')) {
                            throw error;
                        }
                        linking = false;
                    }
                }
                await ops.copyFile(source, target);
                result.copied++;
            }
        }
    }

    await walk(src, dst);
    return result;
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Odoo data dir|Filestore tree copy"`, outside the sandbox. Expected: all pass.

- [ ] **Step 6: Lint, then commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist 2>/dev/null; git add src/services/odooDataDir.ts src/services/filestore.ts src/test/odooDataDir.test.ts src/test/filestore.test.ts
git commit -m "[ADD] Find Odoo's data dir and hard-link a filestore tree

Both are for database checkpoints: the filestore of a copy is linked,
not copied, because Odoo writes filestore files once.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The checkpoint model, names and formatting

**Files:**
- Create: `src/services/checkpoints.ts`
- Modify: `src/models/db.ts` (field and constructor option)
- Test: `src/test/checkpoints.test.ts`

**Interfaces:**
- Consumes: `sqlText(value: string): string` from `src/services/views/viewQueries.ts`
- Produces:
  - `interface CheckpointModel { id: string; label: string; createdAt: string; filestore: boolean }`
  - `checkpointsOf(db: { checkpoints?: unknown }): CheckpointModel[]`, a sanitized copy
  - `setCheckpoints(db: { checkpoints?: unknown }, list: CheckpointModel[]): void`
  - `derivedDbName(base: string, suffix: string): string`
  - `checkpointDbName(db: string, now: Date, taken: Set<string>): string`, where `taken` holds lower-cased names
  - `defaultCheckpointLabel(now: Date): string`, for example `7 Oct 15:42`
  - `formatAge(createdAt: string, now: Date): string`
  - `formatBytes(bytes: number): string`
  - `checkpointSizeSql(names: string[]): string` and `parseSizes(output: string): Map<string, number>`
  - `CHECKPOINT_COMMENT_PREFIX = 'odoo-devtools checkpoint of '`
  - `checkpointComment(source: string): string`
  - `CHECKPOINT_COMMENTS_SQL: string` and `parseCheckpointComments(output: string): Array<{ name: string; source: string }>`
  - `findOrphanCheckpoints(rows: Array<{ name: string; source: string }>, existing: Set<string>, recorded: Set<string>): Array<{ name: string; source: string }>`, where both sets hold lower-cased names

- [ ] **Step 1: Write the failing test** `src/test/checkpoints.test.ts`

```ts
import * as assert from 'assert';
import {
    checkpointDbName, checkpointsOf, setCheckpoints, derivedDbName, defaultCheckpointLabel, formatAge,
    formatBytes, parseSizes, checkpointSizeSql, checkpointComment, parseCheckpointComments,
    findOrphanCheckpoints, CHECKPOINT_COMMENT_PREFIX
} from '../services/checkpoints';

const bytes = (value: string) => Buffer.byteLength(value, 'utf8');

suite('Checkpoints', () => {
    test('checkpointsOf: a project read from the store may have no field at all', () => {
        assert.deepStrictEqual(checkpointsOf({}), []);
        assert.deepStrictEqual(checkpointsOf({ checkpoints: 'junk' }), []);
    });

    test('checkpointsOf drops records without a name and fills the rest in', () => {
        const list = checkpointsOf({ checkpoints: [
            { id: 'shop__cp_abc', label: 'before', createdAt: '2026-10-07T15:42:00.000Z', filestore: true },
            { label: 'no id' },
            null,
            { id: 'shop__cp_def' }
        ] });
        assert.strictEqual(list.length, 2);
        assert.deepStrictEqual(list[0], { id: 'shop__cp_abc', label: 'before', createdAt: '2026-10-07T15:42:00.000Z', filestore: true });
        assert.strictEqual(list[1].id, 'shop__cp_def');
        assert.strictEqual(list[1].label, 'shop__cp_def');
        assert.strictEqual(list[1].filestore, false);
        assert.ok(!Number.isNaN(Date.parse(list[1].createdAt)));
    });

    test('setCheckpoints writes the list back onto the plain object', () => {
        const db: { checkpoints?: unknown } = {};
        setCheckpoints(db, [{ id: 'a', label: 'a', createdAt: '2026-10-07T00:00:00.000Z', filestore: false }]);
        assert.strictEqual(checkpointsOf(db).length, 1);
    });

    test('the checkpoint name is <db>__cp_<base36 epoch seconds>', () => {
        const now = new Date('2026-10-07T15:42:00Z');
        const seconds = Math.floor(now.getTime() / 1000).toString(36);
        assert.strictEqual(checkpointDbName('shop', now, new Set()), `shop__cp_${seconds}`);
    });

    test('two checkpoints in one second get distinct names', () => {
        const now = new Date('2026-10-07T15:42:00Z');
        const first = checkpointDbName('shop', now, new Set());
        const second = checkpointDbName('shop', now, new Set([first.toLowerCase()]));
        assert.notStrictEqual(first, second);
    });

    test('long names are cut to 63 bytes, with a hash, and stay distinct', () => {
        const long = 'a'.repeat(62);
        const now = new Date('2026-10-07T15:42:00Z');
        const cp = checkpointDbName(long, now, new Set());
        const restoring = derivedDbName(long, '__restoring');
        const replaced = derivedDbName(long, '__replaced');
        for (const name of [cp, restoring, replaced]) {
            assert.ok(bytes(name) <= 63, `${name} is ${bytes(name)} bytes`);
        }
        assert.ok(restoring.endsWith('__restoring') && replaced.endsWith('__replaced'));
        assert.notStrictEqual(derivedDbName('b'.repeat(62), '__replaced'), replaced, 'different bases, different names');
        assert.strictEqual(derivedDbName('shop', '__replaced'), 'shop__replaced', 'short names are not touched');
    });

    test('multi-byte names are cut on a character boundary', () => {
        const name = derivedDbName('é'.repeat(40), '__restoring');
        assert.ok(bytes(name) <= 63);
        assert.ok(!name.includes('\uFFFD'));
    });

    test('the default label is day, month and time', () => {
        assert.strictEqual(defaultCheckpointLabel(new Date(2026, 9, 7, 15, 42)), '7 Oct 15:42');
        assert.strictEqual(defaultCheckpointLabel(new Date(2026, 0, 3, 9, 5)), '3 Jan 09:05');
    });

    test('age reads like the rest of the tree', () => {
        const now = new Date('2026-10-07T15:42:00Z');
        const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
        assert.strictEqual(formatAge(ago(20 * 1000), now), 'just now');
        assert.strictEqual(formatAge(ago(5 * 60 * 1000), now), '5 min ago');
        assert.strictEqual(formatAge(ago(2 * 3600 * 1000), now), '2 h ago');
        assert.strictEqual(formatAge(ago(3 * 86400 * 1000), now), '3 d ago');
        assert.strictEqual(formatAge('not a date', now), '');
    });

    test('sizes', () => {
        assert.strictEqual(formatBytes(512), '512 B');
        assert.strictEqual(formatBytes(15 * 1024 * 1024), '15 MB');
        assert.strictEqual(formatBytes(1.45 * 1024 * 1024 * 1024), '1.4 GB');
        assert.strictEqual(formatBytes(2.5 * 1024), '2.5 KB');
    });

    test('the size query is one statement and its output parses', () => {
        const sql = checkpointSizeSql(['a__cp_1', "we'ird"]);
        assert.ok(sql.includes('pg_database_size'));
        assert.ok(!sql.includes("we'ird"), 'names go in as sqlText, never raw');
        const sizes = parseSizes('a__cp_1|8000000\nb|12\n\n');
        assert.strictEqual(sizes.get('a__cp_1'), 8000000);
        assert.strictEqual(sizes.get('b'), 12);
    });

    test('the comment names the source, and orphans are found by it', () => {
        assert.strictEqual(checkpointComment('shop'), `${CHECKPOINT_COMMENT_PREFIX}shop`);
        const rows = parseCheckpointComments([
            `shop__cp_1|${CHECKPOINT_COMMENT_PREFIX}shop`,
            `gone__cp_1|${CHECKPOINT_COMMENT_PREFIX}gone`,
            'tpl_base|',
            'other|some comment'
        ].join('\n'));
        assert.deepStrictEqual(rows, [{ name: 'shop__cp_1', source: 'shop' }, { name: 'gone__cp_1', source: 'gone' }]);
        const orphans = findOrphanCheckpoints(rows, new Set(['shop', 'shop__cp_1', 'gone__cp_1']), new Set());
        assert.deepStrictEqual(orphans, [{ name: 'gone__cp_1', source: 'gone' }]);
        assert.deepStrictEqual(findOrphanCheckpoints(rows, new Set(['shop']), new Set(['gone__cp_1'])), [], 'a recorded one is not an orphan');
    });
});
```

- [ ] **Step 2: Run to see it fail** — `npm run compile-tests`. Expected: TS errors, because the module does not exist.

- [ ] **Step 3: Implement `src/services/checkpoints.ts`**

```ts
/**
 * Database checkpoints: protected PostgreSQL copies of a database, listed
 * under it, restored by swapping them in. This module is the pure part: the
 * stored record, names, labels and the SQL text of the read-only queries.
 */
import * as crypto from 'node:crypto';
import { sqlText } from './views/viewQueries';

export interface CheckpointModel {
    /** The PostgreSQL database holding it. Named `id` so the store merges records by it. */
    id: string;
    label: string;
    createdAt: string;
    /** False when the source had no filestore folder. */
    filestore: boolean;
}

const MAX_IDENTIFIER_BYTES = 63;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The checkpoints of a database read from the store. Projects there are
 * plain JSON, so the field may be missing or malformed on any of them.
 */
export function checkpointsOf(db: { checkpoints?: unknown }): CheckpointModel[] {
    if (!Array.isArray(db.checkpoints)) {
        return [];
    }
    const list: CheckpointModel[] = [];
    for (const entry of db.checkpoints as unknown[]) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const raw = entry as Partial<Record<keyof CheckpointModel, unknown>>;
        if (typeof raw.id !== 'string' || raw.id.trim() === '') {
            continue;
        }
        const id = raw.id.trim();
        list.push({
            id,
            label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : id,
            createdAt: typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))
                ? raw.createdAt
                : new Date().toISOString(),
            filestore: raw.filestore === true
        });
    }
    return list;
}

export function setCheckpoints(db: { checkpoints?: unknown }, list: CheckpointModel[]): void {
    db.checkpoints = list.map(entry => ({ ...entry }));
}

function cutToBytes(value: string, maxBytes: number): string {
    let out = '';
    for (const char of value) {
        if (Buffer.byteLength(out + char, 'utf8') > maxBytes) {
            break;
        }
        out += char;
    }
    return out;
}

/**
 * `base + suffix`, kept within PostgreSQL's 63 bytes. PostgreSQL would
 * truncate a longer name silently, and two of them could then be one; so the
 * base is cut instead and a hash of the full name keeps them apart.
 */
export function derivedDbName(base: string, suffix: string): string {
    const full = `${base}${suffix}`;
    if (Buffer.byteLength(full, 'utf8') <= MAX_IDENTIFIER_BYTES) {
        return full;
    }
    const hash = crypto.createHash('sha1').update(full).digest('hex').slice(0, 6);
    const tail = `_${hash}${suffix}`;
    const head = cutToBytes(base, MAX_IDENTIFIER_BYTES - Buffer.byteLength(tail, 'utf8')).replace(/_+$/, '');
    return `${head || 'db'}${tail}`;
}

/** `<db>__cp_<base36 epoch seconds>`, moved on a second when taken. */
export function checkpointDbName(db: string, now: Date, taken: Set<string>): string {
    let seconds = Math.floor(now.getTime() / 1000);
    for (;;) {
        const name = derivedDbName(db, `__cp_${seconds.toString(36)}`);
        if (!taken.has(name.toLowerCase())) {
            return name;
        }
        seconds++;
    }
}

export function defaultCheckpointLabel(now: Date): string {
    const pad = (n: number) => `${n}`.padStart(2, '0');
    return `${now.getDate()} ${MONTHS[now.getMonth()]} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function formatAge(createdAt: string, now: Date): string {
    const then = Date.parse(createdAt);
    if (Number.isNaN(then)) {
        return '';
    }
    const minutes = Math.floor((now.getTime() - then) / 60000);
    if (minutes < 1) {
        return 'just now';
    }
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} h ago`;
    }
    return `${Math.floor(hours / 24)} d ago`;
}

export function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    const shown = unit === 0 || value >= 10 ? Math.round(value).toString() : (Math.floor(value * 10) / 10).toString();
    return `${shown} ${units[unit]}`;
}

/**
 * One query for every checkpoint's size. pg_database_size reads the files;
 * it never connects to the checkpoint, which refuses connections.
 */
export function checkpointSizeSql(names: string[]): string {
    const list = names.map(sqlText).join(', ');
    return `SELECT datname, pg_database_size(oid) FROM pg_database WHERE datname IN (${list});`;
}

/** `name|bytes` lines, as `runSql` prints them. */
export function parseSizes(output: string): Map<string, number> {
    const sizes = new Map<string, number>();
    for (const line of output.split('\n')) {
        const cut = line.lastIndexOf('|');
        if (cut <= 0) {
            continue;
        }
        const value = Number(line.slice(cut + 1).trim());
        if (Number.isFinite(value)) {
            sizes.set(line.slice(0, cut).trim(), value);
        }
    }
    return sizes;
}

export const CHECKPOINT_COMMENT_PREFIX = 'odoo-devtools checkpoint of ';

export function checkpointComment(source: string): string {
    return `${CHECKPOINT_COMMENT_PREFIX}${source}`;
}

/** Every protected database with its comment; checkpoints are among them. */
export const CHECKPOINT_COMMENTS_SQL =
    "SELECT datname, coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datistemplate;";

export function parseCheckpointComments(output: string): Array<{ name: string; source: string }> {
    const rows: Array<{ name: string; source: string }> = [];
    for (const line of output.split('\n')) {
        const cut = line.indexOf('|');
        if (cut <= 0) {
            continue;
        }
        const comment = line.slice(cut + 1);
        if (comment.startsWith(CHECKPOINT_COMMENT_PREFIX)) {
            rows.push({ name: line.slice(0, cut), source: comment.slice(CHECKPOINT_COMMENT_PREFIX.length) });
        }
    }
    return rows;
}

/** Checkpoints whose source database is gone and that nothing here records. */
export function findOrphanCheckpoints(
    rows: Array<{ name: string; source: string }>,
    existing: Set<string>,
    recorded: Set<string>
): Array<{ name: string; source: string }> {
    return rows.filter(row => !existing.has(row.source.toLowerCase()) && !recorded.has(row.name.toLowerCase()));
}
```

- [ ] **Step 4: Add the field to `src/models/db.ts`**

Add `import type { CheckpointModel } from '../services/checkpoints';`. Add `checkpoints?: CheckpointModel[];` to `DatabaseOptions`. In the class, after `testingModuleStates?`, add:

```ts
    /**
     * Protected copies of this database (see services/checkpoints.ts). Read
     * it only through checkpointsOf(): a project from the store is plain
     * JSON, so this is undefined on every database saved before it existed.
     */
    checkpoints?: CheckpointModel[];
```

In the constructor, after `testingModuleStates`, add:

```ts
        this.checkpoints = Array.isArray(options.checkpoints) ? options.checkpoints : undefined;
```

- [ ] **Step 5: Run to see it pass** — `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Checkpoints"`, outside the sandbox. Expected: PASS.

- [ ] **Step 6: Lint, then commit**

```bash
npx tsc -p . --noEmit && npm run lint
git add src/services/checkpoints.ts src/models/db.ts src/test/checkpoints.test.ts
git commit -m "[ADD] Checkpoint records, names and labels

Names stay within PostgreSQL's 63 bytes. A checkpoint's database comment
names its source, so orphans can be found without parsing names.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The copy, the drop and the restore swap

**Files:**
- Create: `src/services/databaseCopy.ts`
- Test: `src/test/databaseCopy.test.ts`

**Interfaces:**
- Consumes:
  - `derivedDbName` (Task 2);
  - `LinkTreeResult` (Task 1);
  - `quotePgIdentifier` from `src/services/postgres.ts`;
  - `sqlText` from `src/services/views/viewQueries.ts`.
- Produces:
  - `interface CopyBackend { sql(statement: string): Promise<string>; freeOwnConnections(db: string): Promise<void>; files: FilestoreOps; log(message: string): void; sleep(ms: number): Promise<void> }`. `sql` runs on the `postgres` maintenance database.
  - `interface FilestoreOps { exists(dir: string): Promise<boolean>; linkTree(src: string, dst: string): Promise<LinkTreeResult>; rename(from: string, to: string): Promise<void>; remove(dir: string): Promise<void> }`
  - `interface CopyOptions { filestoreRoot?: string; protect?: { comment: string } }`
  - `interface CopyResult { filestore: boolean; copiedFiles: number }`
  - `serverVersionNum(backend: CopyBackend): Promise<number>`, cached per backend object
  - `createDatabaseSql(target: string, source: string, versionNum: number): string`
  - `databaseExistsVia(backend: CopyBackend, name: string): Promise<boolean>`
  - `retryWhileBusy<T>(backend: CopyBackend, db: string, run: () => Promise<T>): Promise<T>`
  - `copyDatabase(backend, source, target, options: CopyOptions): Promise<CopyResult>`, where the source is already released
  - `discardDatabase(backend, name, filestoreRoot?: string): Promise<void>`
  - `stageRestore(backend, db, checkpointDb, filestoreRoot?: string): Promise<string>`, which returns the staged name
  - `swapInRestored(backend, db, staged, filestoreRoot?: string): Promise<void>`

- [ ] **Step 1: Write the failing test** `src/test/databaseCopy.test.ts`

The fake backend keeps a set of databases and a set of folders, and logs every call, so step order and rollback can be asserted as data.

```ts
import * as assert from 'assert';
import * as path from 'node:path';
import {
    copyDatabase, createDatabaseSql, discardDatabase, retryWhileBusy, stageRestore, swapInRestored, CopyBackend
} from '../services/databaseCopy';

interface Fake extends CopyBackend {
    dbs: Set<string>;
    dirs: Set<string>;
    calls: string[];
    failOn?: (call: string) => boolean;
    busyTimes: number;
}

const ROOT = '/data/filestore';

function fake(dbs: string[], dirs: string[] = [], versionNum = 170006): Fake {
    const f: Fake = {
        dbs: new Set(dbs),
        dirs: new Set(dirs.map(dir => path.join(ROOT, dir))),
        calls: [],
        busyTimes: 0,
        log: () => undefined,
        sleep: async () => undefined,
        freeOwnConnections: async db => { f.calls.push(`free ${db}`); },
        sql: async statement => {
            f.calls.push(statement);
            if (f.failOn?.(statement)) {
                throw new Error(`failed: ${statement}`);
            }
            if (statement === 'SHOW server_version_num;') {
                return String(versionNum);
            }
            let m = /^CREATE DATABASE "([^"]+)" TEMPLATE "([^"]+)"/.exec(statement);
            if (m) {
                if (f.busyTimes > 0) {
                    f.busyTimes--;
                    throw new Error(`source database "${m[2]}" is being accessed by other users`);
                }
                f.dbs.add(m[1]);
                return '';
            }
            m = /^DROP DATABASE IF EXISTS "([^"]+)"/.exec(statement);
            if (m) {
                f.dbs.delete(m[1]);
                return '';
            }
            m = /^ALTER DATABASE "([^"]+)" RENAME TO "([^"]+)"/.exec(statement);
            if (m) {
                f.dbs.delete(m[1]);
                f.dbs.add(m[2]);
                return '';
            }
            m = /^SELECT 1 FROM pg_database WHERE datname = convert_from\(decode\('([0-9a-f]+)'/.exec(statement);
            if (m) {
                return f.dbs.has(Buffer.from(m[1], 'hex').toString('utf8')) ? '1' : '';
            }
            return '';
        },
        files: {
            exists: async dir => f.dirs.has(dir),
            linkTree: async (src, dst) => {
                f.calls.push(`link ${path.basename(src)} -> ${path.basename(dst)}`);
                if (f.failOn?.(`link ${path.basename(dst)}`)) {
                    throw new Error('link failed');
                }
                f.dirs.add(dst);
                return { files: 3, copied: 0 };
            },
            rename: async (from, to) => {
                const call = `mv ${path.basename(from)} -> ${path.basename(to)}`;
                f.calls.push(call);
                if (f.failOn?.(call)) {
                    throw new Error(`failed: ${call}`);
                }
                f.dirs.delete(from);
                f.dirs.add(to);
            },
            remove: async dir => {
                f.calls.push(`rm ${path.basename(dir)}`);
                f.dirs.delete(dir);
            }
        }
    };
    return f;
}

const sqlCalls = (f: Fake) => f.calls.filter(call => !call.startsWith('SELECT 1') && call !== 'SHOW server_version_num;');

suite('Database copy', () => {
    test('FILE_COPY from PostgreSQL 15, the plain template copy before', () => {
        assert.strictEqual(createDatabaseSql('b', 'a', 150000), 'CREATE DATABASE "b" TEMPLATE "a" STRATEGY FILE_COPY;');
        assert.strictEqual(createDatabaseSql('b', 'a', 140010), 'CREATE DATABASE "b" TEMPLATE "a";');
    });

    test('a checkpoint copy: database, filestore links, comment, protection', async () => {
        const f = fake(['shop'], ['shop']);
        const result = await copyDatabase(f, 'shop', 'shop__cp_1', { filestoreRoot: ROOT, protect: { comment: 'odoo-devtools checkpoint of shop' } });
        assert.deepStrictEqual(result, { filestore: true, copiedFiles: 0 });
        const calls = sqlCalls(f);
        assert.strictEqual(calls[0], 'CREATE DATABASE "shop__cp_1" TEMPLATE "shop" STRATEGY FILE_COPY;');
        assert.strictEqual(calls[1], 'link shop -> shop__cp_1');
        assert.ok(calls[2].startsWith('COMMENT ON DATABASE "shop__cp_1" IS convert_from('));
        assert.strictEqual(calls[3], 'ALTER DATABASE "shop__cp_1" WITH ALLOW_CONNECTIONS false IS_TEMPLATE true;');
    });

    test('no filestore folder: filestore false, nothing linked', async () => {
        const f = fake(['shop']);
        const result = await copyDatabase(f, 'shop', 'shop__cp_1', { filestoreRoot: ROOT });
        assert.deepStrictEqual(result, { filestore: false, copiedFiles: 0 });
        assert.ok(!f.calls.some(call => call.startsWith('link')));
    });

    test('a stray filestore folder under the target name is replaced', async () => {
        const f = fake(['shop'], ['shop', 'copy']);
        await copyDatabase(f, 'shop', 'copy', { filestoreRoot: ROOT });
        const rm = f.calls.indexOf('rm copy');
        assert.ok(rm >= 0 && rm < f.calls.indexOf('link shop -> copy'));
    });

    test('refuses a target that already exists', async () => {
        const f = fake(['shop', 'copy']);
        await assert.rejects(copyDatabase(f, 'shop', 'copy', {}), /already exists/);
        assert.ok(!f.calls.some(call => call.startsWith('CREATE')));
    });

    test('a failure removes everything the copy made, and leaves the source', async () => {
        const f = fake(['shop'], ['shop']);
        f.failOn = call => call.startsWith('ALTER DATABASE "shop__cp_1" WITH ALLOW');
        await assert.rejects(copyDatabase(f, 'shop', 'shop__cp_1', { filestoreRoot: ROOT, protect: { comment: 'c' } }));
        assert.deepStrictEqual([...f.dbs], ['shop']);
        assert.deepStrictEqual([...f.dirs], [path.join(ROOT, 'shop')]);
    });

    test('a busy source is retried after freeing our own connections, then reported', async () => {
        const f = fake(['shop']);
        f.busyTimes = 2;
        await copyDatabase(f, 'shop', 'copy', {});
        assert.strictEqual(f.calls.filter(call => call === 'free shop').length, 2);
        assert.ok(f.dbs.has('copy'));

        const g = fake(['shop']);
        g.busyTimes = 10;
        await assert.rejects(copyDatabase(g, 'shop', 'copy', {}), /being accessed by other users/);
    });

    test('retryWhileBusy does not retry other errors', async () => {
        const f = fake([]);
        let runs = 0;
        await assert.rejects(retryWhileBusy(f, 'x', async () => { runs++; throw new Error('disk full'); }), /disk full/);
        assert.strictEqual(runs, 1);
    });

    test('discard unprotects, drops and removes the filestore', async () => {
        const f = fake(['shop__cp_1'], ['shop__cp_1']);
        await discardDatabase(f, 'shop__cp_1', ROOT);
        assert.deepStrictEqual(sqlCalls(f), [
            'ALTER DATABASE "shop__cp_1" WITH IS_TEMPLATE false;',
            'DROP DATABASE IF EXISTS "shop__cp_1";',
            'rm shop__cp_1'
        ]);
        assert.strictEqual(f.dbs.size + f.dirs.size, 0);
    });

    test('stageRestore copies the checkpoint, unprotected, and drops a leftover staging copy first', async () => {
        const f = fake(['shop', 'shop__cp_1', 'shop__restoring'], ['shop__cp_1']);
        const staged = await stageRestore(f, 'shop', 'shop__cp_1', ROOT);
        assert.strictEqual(staged, 'shop__restoring');
        const calls = sqlCalls(f);
        assert.ok(calls.indexOf('DROP DATABASE IF EXISTS "shop__restoring";') < calls.indexOf('CREATE DATABASE "shop__restoring" TEMPLATE "shop__cp_1" STRATEGY FILE_COPY;'));
        assert.ok(!calls.some(call => call.includes('ALLOW_CONNECTIONS false')));
        assert.ok(f.dirs.has(path.join(ROOT, 'shop__restoring')));
    });

    test('stageRestore refuses when an interrupted restore left the old data behind', async () => {
        const f = fake(['shop', 'shop__cp_1', 'shop__replaced']);
        await assert.rejects(stageRestore(f, 'shop', 'shop__cp_1', ROOT), /shop__replaced/);
        assert.ok(!f.calls.some(call => call.startsWith('CREATE') || call.startsWith('DROP')));
    });

    test('the swap: rename both ways, swap the folders, drop the old state', async () => {
        const f = fake(['shop', 'shop__restoring'], ['shop', 'shop__restoring']);
        await swapInRestored(f, 'shop', 'shop__restoring', ROOT);
        assert.deepStrictEqual(sqlCalls(f), [
            'ALTER DATABASE "shop" RENAME TO "shop__replaced";',
            'ALTER DATABASE "shop__restoring" RENAME TO "shop";',
            'mv shop -> shop__replaced',
            'mv shop__restoring -> shop',
            'ALTER DATABASE "shop__replaced" WITH IS_TEMPLATE false;',
            'DROP DATABASE IF EXISTS "shop__replaced";',
            'rm shop__replaced'
        ]);
        assert.deepStrictEqual([...f.dbs], ['shop']);
        assert.deepStrictEqual([...f.dirs], [path.join(ROOT, 'shop')]);
    });

    test('a checkpoint without a filestore removes the live folder', async () => {
        const f = fake(['shop', 'shop__restoring'], ['shop']);
        await swapInRestored(f, 'shop', 'shop__restoring', ROOT);
        assert.deepStrictEqual([...f.dirs], []);
    });

    test('a failed second rename puts the database back', async () => {
        const f = fake(['shop', 'shop__restoring'], ['shop', 'shop__restoring']);
        f.failOn = call => call === 'ALTER DATABASE "shop__restoring" RENAME TO "shop";';
        await assert.rejects(swapInRestored(f, 'shop', 'shop__restoring', ROOT), /failed/);
        assert.deepStrictEqual([...f.dbs].sort(), ['shop', 'shop__restoring']);
        assert.ok(f.dirs.has(path.join(ROOT, 'shop')));
    });

    test('a failed folder swap undoes the folders and both renames', async () => {
        const f = fake(['shop', 'shop__restoring'], ['shop', 'shop__restoring']);
        f.failOn = call => call === 'mv shop__restoring -> shop';
        await assert.rejects(swapInRestored(f, 'shop', 'shop__restoring', ROOT));
        assert.deepStrictEqual([...f.dbs].sort(), ['shop', 'shop__restoring']);
        assert.deepStrictEqual([...f.dirs].sort(), [path.join(ROOT, 'shop'), path.join(ROOT, 'shop__restoring')]);
    });

    test('when the undo fails too, the error names where the data is', async () => {
        const f = fake(['shop', 'shop__restoring'], []);
        f.failOn = call => call === 'ALTER DATABASE "shop__restoring" RENAME TO "shop";'
            || call === 'ALTER DATABASE "shop__replaced" RENAME TO "shop";';
        await assert.rejects(swapInRestored(f, 'shop', 'shop__restoring', ROOT), /shop__replaced/);
    });

    test('failing to drop the old state is logged, not a failed restore', async () => {
        const f = fake(['shop', 'shop__restoring']);
        const logs: string[] = [];
        f.log = message => logs.push(message);
        f.failOn = call => call === 'DROP DATABASE IF EXISTS "shop__replaced";';
        await swapInRestored(f, 'shop', 'shop__restoring', ROOT);
        assert.ok(logs.some(line => line.includes('shop__replaced')));
    });
});
```

- [ ] **Step 2: Run to see it fail** — `npm run compile-tests`. Expected: TS errors, because the module does not exist.

- [ ] **Step 3: Implement `src/services/databaseCopy.ts`**

```ts
/**
 * Copying, dropping and swapping whole databases, with their filestore. One
 * routine for checkpoints, Clone and Templates. Pure over `CopyBackend`, so
 * step order and rollback are tested as data; copyRuntime.ts wires the real
 * psql and file system in. Releasing the source - stopping a server, ending
 * connections - is the caller's job (connectionRelease.ts), done once around
 * however many steps need it.
 */
import * as path from 'node:path';
import type { LinkTreeResult } from './filestore';
import { quotePgIdentifier } from './postgres';
import { sqlText } from './views/viewQueries';
import { derivedDbName } from './checkpoints';

export interface FilestoreOps {
    exists(dir: string): Promise<boolean>;
    linkTree(src: string, dst: string): Promise<LinkTreeResult>;
    rename(from: string, to: string): Promise<void>;
    remove(dir: string): Promise<void>;
}

export interface CopyBackend {
    /** One statement on the `postgres` maintenance database; trimmed stdout. */
    sql(statement: string): Promise<string>;
    /** Ends the extension's own backends on `db`: query probes, View Doctor shells. */
    freeOwnConnections(db: string): Promise<void>;
    files: FilestoreOps;
    log(message: string): void;
    sleep(ms: number): Promise<void>;
}

export interface CopyOptions {
    /** `<data dir>/filestore`; without it the filestore is left alone. */
    filestoreRoot?: string;
    /** Makes the copy a checkpoint: refuses connections, is a template, carries this comment. */
    protect?: { comment: string };
}

export interface CopyResult {
    filestore: boolean;
    copiedFiles: number;
}

const BUSY = /is being accessed by other users/;
const BUSY_ATTEMPTS = 4;
const BUSY_DELAY_MS = 500;

const versionCache = new WeakMap<CopyBackend, Promise<number>>();

export function serverVersionNum(backend: CopyBackend): Promise<number> {
    let cached = versionCache.get(backend);
    if (!cached) {
        cached = backend.sql('SHOW server_version_num;').then(out => Number.parseInt(out, 10) || 0);
        versionCache.set(backend, cached);
    }
    return cached;
}

/**
 * FILE_COPY copies the data files instead of writing every page to the WAL:
 * seconds instead of minutes on a large database. Before 15 that was the
 * only strategy, and the keyword does not exist.
 */
export function createDatabaseSql(target: string, source: string, versionNum: number): string {
    const strategy = versionNum >= 150000 ? ' STRATEGY FILE_COPY' : '';
    return `CREATE DATABASE ${quotePgIdentifier(target)} TEMPLATE ${quotePgIdentifier(source)}${strategy};`;
}

export async function databaseExistsVia(backend: CopyBackend, name: string): Promise<boolean> {
    return (await backend.sql(`SELECT 1 FROM pg_database WHERE datname = ${sqlText(name)};`)) === '1';
}

/**
 * Runs `run`, retrying while PostgreSQL says `db` has other sessions. Between
 * tries only the extension's own backends are ended - the View Doctor's arch
 * poll reconnects every 3 s. Anyone else's connection is the release step's
 * to ask about, never ended here.
 */
export async function retryWhileBusy<T>(backend: CopyBackend, db: string, run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await run();
        } catch (error) {
            if (attempt >= BUSY_ATTEMPTS || !BUSY.test(String((error as Error)?.message ?? error))) {
                throw error;
            }
            await backend.freeOwnConnections(db);
            await backend.sleep(BUSY_DELAY_MS);
        }
    }
}

export async function copyDatabase(backend: CopyBackend, source: string, target: string, options: CopyOptions): Promise<CopyResult> {
    if (await databaseExistsVia(backend, target)) {
        throw new Error(`A database named "${target}" already exists.`);
    }
    const versionNum = await serverVersionNum(backend);
    const root = options.filestoreRoot;
    let createdDb = false;
    let createdFiles = false;
    try {
        await retryWhileBusy(backend, source, () => backend.sql(createDatabaseSql(target, source, versionNum)));
        createdDb = true;

        let filestore = false;
        let copiedFiles = 0;
        if (root && await backend.files.exists(path.join(root, source))) {
            const to = path.join(root, target);
            // No database owns a folder under a name that has no database.
            if (await backend.files.exists(to)) {
                await backend.files.remove(to);
            }
            createdFiles = true;
            const linked = await backend.files.linkTree(path.join(root, source), to);
            filestore = true;
            copiedFiles = linked.copied;
            if (linked.copied > 0) {
                backend.log(`Filestore of ${source}: links were refused, so ${linked.copied} of ${linked.files} files were copied.`);
            }
        }

        if (options.protect) {
            await backend.sql(`COMMENT ON DATABASE ${quotePgIdentifier(target)} IS ${sqlText(options.protect.comment)};`);
            await backend.sql(`ALTER DATABASE ${quotePgIdentifier(target)} WITH ALLOW_CONNECTIONS false IS_TEMPLATE true;`);
        }
        return { filestore, copiedFiles };
    } catch (error) {
        if (createdDb) {
            await discardDatabase(backend, target).catch(cleanup => backend.log(`Could not drop the partial copy ${target}: ${cleanup}`));
        }
        if (createdFiles && root) {
            await backend.files.remove(path.join(root, target)).catch(cleanup => backend.log(`Could not remove ${target}'s filestore: ${cleanup}`));
        }
        throw error;
    }
}

/** Drops a database - a protected one too - and its filestore folder. */
export async function discardDatabase(backend: CopyBackend, name: string, filestoreRoot?: string): Promise<void> {
    if (await databaseExistsVia(backend, name)) {
        await backend.sql(`ALTER DATABASE ${quotePgIdentifier(name)} WITH IS_TEMPLATE false;`);
        await retryWhileBusy(backend, name, () => backend.sql(`DROP DATABASE IF EXISTS ${quotePgIdentifier(name)};`));
    }
    if (filestoreRoot) {
        await backend.files.remove(path.join(filestoreRoot, name));
    }
}

const rename = (from: string, to: string) => `ALTER DATABASE ${quotePgIdentifier(from)} RENAME TO ${quotePgIdentifier(to)};`;

/**
 * Restore, part one: the checkpoint copied to `<db>__restoring`, unprotected,
 * while the database and its server are still untouched.
 */
export async function stageRestore(backend: CopyBackend, db: string, checkpointDb: string, filestoreRoot?: string): Promise<string> {
    const replaced = derivedDbName(db, '__replaced');
    if (await databaseExistsVia(backend, replaced)) {
        throw new Error(`"${replaced}" is left over from an interrupted restore and may hold the data of "${db}". Rename or drop it in psql first.`);
    }
    const staged = derivedDbName(db, '__restoring');
    // A leftover staging copy is only ever a copy of a checkpoint.
    await discardDatabase(backend, staged, filestoreRoot);
    await copyDatabase(backend, checkpointDb, staged, { filestoreRoot });
    return staged;
}

/**
 * Restore, part two, with `db` released: renamed out of the way, the staged
 * copy renamed in, the filestore folders swapped the same way, then the old
 * state dropped. The database never goes missing: any failure undoes the
 * steps done, in reverse.
 */
export async function swapInRestored(backend: CopyBackend, db: string, staged: string, filestoreRoot?: string): Promise<void> {
    const replaced = derivedDbName(db, '__replaced');
    const undo: Array<() => Promise<unknown>> = [];
    try {
        await retryWhileBusy(backend, db, () => backend.sql(rename(db, replaced)));
        undo.push(() => backend.sql(rename(replaced, db)));
        await backend.sql(rename(staged, db));
        undo.push(() => backend.sql(rename(db, staged)));

        if (filestoreRoot) {
            const live = path.join(filestoreRoot, db);
            const old = path.join(filestoreRoot, replaced);
            const next = path.join(filestoreRoot, staged);
            if (await backend.files.exists(old)) {
                await backend.files.remove(old);
            }
            if (await backend.files.exists(live)) {
                await backend.files.rename(live, old);
                undo.push(() => backend.files.rename(old, live));
            }
            if (await backend.files.exists(next)) {
                await backend.files.rename(next, live);
                undo.push(() => backend.files.rename(live, next));
            }
        }
    } catch (error) {
        let undone = true;
        for (const step of undo.reverse()) {
            try {
                await step();
            } catch (undoError) {
                undone = false;
                backend.log(`Could not undo a restore step: ${undoError}`);
            }
        }
        if (!undone) {
            throw new Error(`Restoring "${db}" failed and could not be undone: its previous state is in "${replaced}". ${(error as Error)?.message ?? error}`);
        }
        throw error;
    }

    try {
        await discardDatabase(backend, replaced, filestoreRoot);
    } catch (error) {
        backend.log(`Restored "${db}", but could not drop its previous state "${replaced}": ${error}`);
    }
}
```

- [ ] **Step 4: Run to see it pass** — `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Database copy"`, outside the sandbox. Expected: PASS. If the folder-swap test sees a leftover `shop__replaced` folder, remember that `rm` of a missing folder is a no-op in the fake too. The assertions read the final sets, not the call list.

- [ ] **Step 5: Lint, then commit**

```bash
npx tsc -p . --noEmit && npm run lint
git add src/services/databaseCopy.ts src/test/databaseCopy.test.ts
git commit -m "[ADD] One copy routine for databases, and a restore by rename

CREATE DATABASE ... STRATEGY FILE_COPY from PostgreSQL 15, the filestore
linked, protection for checkpoints. A restore stages the checkpoint first
and swaps it in by rename, undoing every step on failure.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Releasing a database: our server, our connections, and asking about the rest

**Files:**
- Create: `src/services/connectionRelease.ts`
- Create: `src/services/copyRuntime.ts`
- Test: `src/test/connectionRelease.test.ts`

**Interfaces:**
- Consumes:
  - `CopyBackend` (Task 3);
  - `linkTree`, `dirExists`, `removeTree`, `renameDir` (Task 1);
  - `resolveOdooDataDir`, `filestoreRootOf` (Task 1);
  - `releaseDatabase`, `runSql` from `src/services/postgres.ts`;
  - `runCommand` from `src/services/process.ts`;
  - `ownQueryEnv`, `OWN_QUERY_APP_NAME` from `src/services/database.ts`;
  - `VIEW_WORKER_APP_NAME` from `src/services/views/viewWorkerArgs.ts`;
  - `getRunningInstances` from `src/services/runningState.ts`;
  - `getSessionByName` from `src/services/debugSessions.ts`;
  - `startServerForVersion`, `runDirectory` from `src/debugger.ts`;
  - `VersionsService.getInstance().getVersion(id)` / `.getActiveVersion()`.
- Produces:
  - `interface DbConnection { pid: number; application: string; client: string; user: string }`
  - `interface ManagedRun { versionId: string; debuggerName: string; noDebug: boolean }`
  - `interface ReleaseHost { letGo(db: string): Promise<void>; ownRun(db: string): Promise<ManagedRun | undefined>; stop(run: ManagedRun): Promise<void>; start(run: ManagedRun): Promise<void>; connections(db: string): Promise<DbConnection[]>; endOwnQueries(db: string): Promise<void>; end(db: string, pids: number[]): Promise<void>; sleep(ms: number): Promise<void> }`
  - `interface ReleaseUi { confirmStop(db: string, run: ManagedRun): Promise<boolean>; confirmEnd(db: string, connections: DbConnection[]): Promise<boolean> }`
  - `interface Release { stopped?: ManagedRun; restart(): Promise<void> }`
  - `releaseForCopy(db: string, host: ReleaseHost, ui: ReleaseUi): Promise<Release | undefined>`, which returns undefined when the user said no
  - `CONNECTIONS_SQL: string` (psql `:'db'`) and `parseConnections(output: string): DbConnection[]`
  - `describeConnection(c: DbConnection): string`
  - `copyRuntime.ts`:
    - `realCopyBackend(): CopyBackend`
    - `realReleaseHost(): ReleaseHost`
    - `dialogReleaseUi(purpose: string): ReleaseUi`
    - `filestoreRootFor(versionId?: string): string`
    - `withReleased<T>(db: string, purpose: string, work: () => Promise<T>): Promise<{ done: true; value: T } | { done: false }>`

- [ ] **Step 1: Write the failing test** `src/test/connectionRelease.test.ts`

```ts
import * as assert from 'assert';
import {
    describeConnection, parseConnections, releaseForCopy, DbConnection, ManagedRun, ReleaseHost, ReleaseUi
} from '../services/connectionRelease';

const RUN: ManagedRun = { versionId: 'v17', debuggerName: 'Odoo 17', noDebug: true };
const PSQL: DbConnection = { pid: 41, application: 'psql', client: '', user: 'odoo' };
const ODOO: DbConnection = { pid: 42, application: 'odoo-1234', client: '127.0.0.1', user: 'odoo' };

function host(opts: { run?: ManagedRun; connections?: DbConnection[][] } = {}) {
    const calls: string[] = [];
    // Each connections() call takes the next snapshot; the last one repeats.
    const snapshots = opts.connections ?? [[]];
    let read = 0;
    const h: ReleaseHost = {
        letGo: async db => { calls.push(`letGo ${db}`); },
        ownRun: async () => opts.run,
        stop: async run => { calls.push(`stop ${run.debuggerName}`); },
        start: async run => { calls.push(`start ${run.debuggerName} noDebug=${run.noDebug}`); },
        connections: async () => snapshots[Math.min(read++, snapshots.length - 1)],
        endOwnQueries: async db => { calls.push(`endOwn ${db}`); },
        end: async (db, pids) => { calls.push(`end ${db} ${pids.join(',')}`); },
        sleep: async () => undefined
    };
    return { h, calls };
}

function ui(answers: { stop?: boolean; end?: boolean } = {}) {
    const asked: string[] = [];
    const u: ReleaseUi = {
        confirmStop: async () => { asked.push('stop'); return answers.stop ?? true; },
        confirmEnd: async (_db, list) => { asked.push(`end ${list.map(c => c.pid).join(',')}`); return answers.end ?? true; }
    };
    return { u, asked };
}

suite('Releasing a database', () => {
    test('nothing running and nothing connected: no questions', async () => {
        const { h, calls } = host();
        const { u, asked } = ui();
        const release = await releaseForCopy('shop', h, u);
        assert.ok(release);
        assert.deepStrictEqual(asked, []);
        assert.deepStrictEqual(calls, ['letGo shop', 'endOwn shop']);
        await release.restart();
        assert.deepStrictEqual(calls, ['letGo shop', 'endOwn shop'], 'nothing to restart');
    });

    test('our server is stopped after asking, waited for, and restarted the same way', async () => {
        const { h, calls } = host({ run: RUN, connections: [[ODOO], [ODOO], []] });
        const { u, asked } = ui();
        const release = await releaseForCopy('shop', h, u);
        assert.ok(release);
        assert.deepStrictEqual(asked, ['stop'], 'the server\'s own connections are waited out, not asked about');
        assert.deepStrictEqual(release.stopped, RUN);
        await release.restart();
        assert.deepStrictEqual(calls.filter(c => c.startsWith('st')), ['stop Odoo 17', 'start Odoo 17 noDebug=true']);
    });

    test('saying no to stopping changes nothing', async () => {
        const { h, calls } = host({ run: RUN });
        const { u } = ui({ stop: false });
        assert.strictEqual(await releaseForCopy('shop', h, u), undefined);
        assert.ok(!calls.some(c => c.startsWith('stop') || c.startsWith('end ')));
    });

    test('other connections are listed and ended only after End Them', async () => {
        const { h, calls } = host({ connections: [[PSQL, ODOO], []] });
        const { u, asked } = ui();
        const release = await releaseForCopy('shop', h, u);
        assert.ok(release);
        assert.deepStrictEqual(asked, ['end 41,42']);
        assert.ok(calls.includes('end shop 41,42'));
    });

    test('declining End Them restarts the server it stopped and gives up', async () => {
        const { h, calls } = host({ run: RUN, connections: [[PSQL]] });
        const { u } = ui({ end: false });
        assert.strictEqual(await releaseForCopy('shop', h, u), undefined);
        assert.ok(calls.includes('start Odoo 17 noDebug=true'));
        assert.ok(!calls.some(c => c.startsWith('end ')));
    });

    test('a connection that survives being ended is an error, after restarting', async () => {
        const { h, calls } = host({ run: RUN, connections: [[PSQL]] });
        const { u } = ui();
        await assert.rejects(releaseForCopy('shop', h, u), /psql/);
        assert.ok(calls.includes('start Odoo 17 noDebug=true'));
    });

    test('parses the connection query and describes each one', () => {
        const rows = parseConnections(`41\x1fpsql\x1f\x1fodoo\n42\x1fodoo-1234\x1f127.0.0.1\x1fodoo\n\n`);
        assert.deepStrictEqual(rows, [PSQL, ODOO]);
        assert.strictEqual(describeConnection(PSQL), 'psql (local socket)');
        assert.strictEqual(describeConnection(ODOO), 'odoo-1234 (127.0.0.1)');
        assert.strictEqual(describeConnection({ pid: 1, application: '', client: '10.0.0.2', user: 'x' }), 'an unnamed client (10.0.0.2)');
    });
});
```

- [ ] **Step 2: Run to see it fail** — `npm run compile-tests`. Expected: TS errors.

- [ ] **Step 3: Implement `src/services/connectionRelease.ts`**

```ts
/**
 * Freeing a database for a copy, a rename or a drop: PostgreSQL refuses all
 * three while anyone else is connected. Our own server is stopped (after
 * asking) and restarted afterwards; our own backends are ended silently; and
 * anything else is listed, ended only after the user says so. Pure over
 * ReleaseHost and ReleaseUi; copyRuntime.ts provides the real ones.
 */
import { OWN_QUERY_APP_NAME } from './database';
import { VIEW_WORKER_APP_NAME } from './views/viewWorkerArgs';

export interface DbConnection {
    pid: number;
    application: string;
    client: string;
    user: string;
}

/** A server this window started on the database. */
export interface ManagedRun {
    versionId: string;
    debuggerName: string;
    noDebug: boolean;
}

export interface ReleaseHost {
    /** Release listeners and View Doctor shells everywhere (postgres.releaseDatabase). */
    letGo(db: string): Promise<void>;
    ownRun(db: string): Promise<ManagedRun | undefined>;
    /** Resolves once the session has ended. */
    stop(run: ManagedRun): Promise<void>;
    start(run: ManagedRun): Promise<void>;
    /** Everyone else's client connections: not ours, not the View Doctor's. */
    connections(db: string): Promise<DbConnection[]>;
    endOwnQueries(db: string): Promise<void>;
    end(db: string, pids: number[]): Promise<void>;
    sleep(ms: number): Promise<void>;
}

export interface ReleaseUi {
    confirmStop(db: string, run: ManagedRun): Promise<boolean>;
    confirmEnd(db: string, connections: DbConnection[]): Promise<boolean>;
}

export interface Release {
    stopped?: ManagedRun;
    restart(): Promise<void>;
}

const POLL_MS = 250;
/** A stopped Odoo closes its connections as it exits: up to 10 s. */
const SERVER_EXIT_POLLS = 40;
const ENDED_POLLS = 20;

// psql reads it on stdin, so :'db' stays a variable, never spliced in.
export const CONNECTIONS_SQL = `SELECT pid, coalesce(application_name, ''), coalesce(host(client_addr), ''), coalesce(usename, '')
FROM pg_stat_activity
WHERE datname = :'db' AND pid <> pg_backend_pid() AND backend_type = 'client backend'
  AND coalesce(application_name, '') NOT IN ('${OWN_QUERY_APP_NAME}', '${VIEW_WORKER_APP_NAME}');
`;

/** Rows separated by newlines, fields by the unit separator (psql -F '\x1f'). */
export function parseConnections(output: string): DbConnection[] {
    const rows: DbConnection[] = [];
    for (const line of output.split('\n')) {
        const [pid, application = '', client = '', user = ''] = line.split('\x1f');
        const id = Number.parseInt(pid ?? '', 10);
        if (Number.isSafeInteger(id) && id > 0) {
            rows.push({ pid: id, application, client, user });
        }
    }
    return rows;
}

export function describeConnection(connection: DbConnection): string {
    const who = connection.application || 'an unnamed client';
    return `${who} (${connection.client || 'local socket'})`;
}

async function pollUntilEmpty(host: ReleaseHost, db: string, polls: number): Promise<DbConnection[]> {
    let current = await host.connections(db);
    for (let i = 0; i < polls && current.length > 0; i++) {
        await host.sleep(POLL_MS);
        current = await host.connections(db);
    }
    return current;
}

export async function releaseForCopy(db: string, host: ReleaseHost, ui: ReleaseUi): Promise<Release | undefined> {
    await host.letGo(db);

    const run = await host.ownRun(db);
    if (run) {
        if (!await ui.confirmStop(db, run)) {
            return undefined;
        }
        await host.stop(run);
    }
    const release: Release = {
        stopped: run,
        restart: async () => {
            if (run) {
                await host.start(run);
            }
        }
    };

    await host.endOwnQueries(db);
    let others = run ? await pollUntilEmpty(host, db, SERVER_EXIT_POLLS) : await host.connections(db);
    if (others.length === 0) {
        return release;
    }

    if (!await ui.confirmEnd(db, others)) {
        await release.restart();
        return undefined;
    }
    await host.end(db, others.map(connection => connection.pid));
    others = await pollUntilEmpty(host, db, ENDED_POLLS);
    if (others.length > 0) {
        await release.restart();
        throw new Error(`Could not end the connections to "${db}": ${others.map(describeConnection).join(', ')}.`);
    }
    return release;
}
```

- [ ] **Step 4: Implement `src/services/copyRuntime.ts`**

```ts
/**
 * The real CopyBackend, ReleaseHost and dialogs: psql, the file system, this
 * window's debug sessions. Kept apart so databaseCopy.ts and
 * connectionRelease.ts stay testable as data.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CopyBackend } from './databaseCopy';
import { dirExists, linkTree, removeTree, renameDir } from './filestore';
import { filestoreRootOf, resolveOdooDataDir } from './odooDataDir';
import { releaseDatabase, runSql } from './postgres';
import { runCommand } from './process';
import { ownQueryEnv, OWN_QUERY_APP_NAME } from './database';
import { VIEW_WORKER_APP_NAME } from './views/viewWorkerArgs';
import { CONNECTIONS_SQL, DbConnection, describeConnection, ManagedRun, parseConnections, releaseForCopy, ReleaseHost, ReleaseUi } from './connectionRelease';
import { getRunningInstances, invalidateRunningState } from './runningState';
import { getSessionByName } from './debugSessions';
import { VersionsService } from '../versionsService';
import { runDirectory, startServerForVersion } from '../debugger';
import { logger, errorMessage } from './logger';
import { showModalWarning, showWarning } from './notifications';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function psqlWithDb(db: string, sql: string, extra: string[] = []): Promise<string> {
    const { stdout } = await runCommand('psql', [
        '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-v', `db=${db}`, ...extra, '-d', 'postgres', '-tA'
    ], { env: ownQueryEnv(), input: sql });
    return stdout;
}

const END_OWN_SQL = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE datname = :'db' AND pid <> pg_backend_pid()
  AND application_name IN ('${OWN_QUERY_APP_NAME}', '${VIEW_WORKER_APP_NAME}');
`;

// Only the pids the user saw and agreed to; a newcomer is not among them.
const END_PIDS_SQL = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE datname = :'db' AND pid = ANY(string_to_array(:'pids', ',')::int[]);
`;

export function realCopyBackend(): CopyBackend {
    return {
        sql: statement => runSql('postgres', statement),
        freeOwnConnections: async db => { await psqlWithDb(db, END_OWN_SQL); },
        files: { exists: dirExists, linkTree: (src, dst) => linkTree(src, dst), rename: renameDir, remove: removeTree },
        log: message => logger.info(message),
        sleep
    };
}

export function realReleaseHost(): ReleaseHost {
    return {
        letGo: db => releaseDatabase(db),
        ownRun: async db => {
            invalidateRunningState();
            const instance = (await getRunningInstances())
                .find(entry => entry.origin === 'managed' && entry.dbName === db && entry.debuggerName && entry.versionId);
            if (!instance?.debuggerName || !instance.versionId) {
                return undefined;
            }
            const session = getSessionByName(instance.debuggerName);
            return { versionId: instance.versionId, debuggerName: instance.debuggerName, noDebug: session?.configuration?.noDebug === true };
        },
        stop: async run => {
            const session = getSessionByName(run.debuggerName);
            if (!session) {
                return;
            }
            await vscode.debug.stopDebugging(session);
            for (let i = 0; i < 120 && getSessionByName(run.debuggerName) === session; i++) {
                await sleep(250);
            }
            if (getSessionByName(run.debuggerName) === session) {
                throw new Error(`"${run.debuggerName}" did not stop within 30 seconds.`);
            }
        },
        start: async run => {
            const result = await startServerForVersion(run.versionId, { noDebug: run.noDebug, quiet: true });
            if (!result.ok) {
                throw new Error(result.message ?? `Could not start "${run.debuggerName}".`);
            }
        },
        connections: async db => parseConnections(await psqlWithDb(db, CONNECTIONS_SQL, ['-F', '\x1f'])),
        endOwnQueries: async db => { await psqlWithDb(db, END_OWN_SQL); },
        end: async (db, pids) => { await psqlWithDb(db, END_PIDS_SQL, ['-v', `pids=${pids.join(',')}`]); },
        sleep
    };
}

/** `purpose` finishes "Stop it to …?": "take the checkpoint", "restore it", "copy it". */
export function dialogReleaseUi(purpose: string): ReleaseUi {
    return {
        confirmStop: async db => (await showModalWarning(
            `"${db}" is running in this window. Stop it to ${purpose}? It restarts afterwards.`,
            'Stop and Continue'
        )) === 'Stop and Continue',
        confirmEnd: async (db, connections: DbConnection[]) => (await showModalWarning(
            `"${db}" has ${connections.length === 1 ? 'another connection' : `${connections.length} other connections`}: `
            + `${connections.map(describeConnection).join(', ')}. End ${connections.length === 1 ? 'it' : 'them'} to continue?`,
            'End Them'
        )) === 'End Them'
    };
}

/** `<data dir>/filestore` for a version's server (the active version's when none is given). */
export function filestoreRootFor(versionId?: string): string {
    const service = VersionsService.getInstance();
    const version = (versionId ? service.getVersion(versionId) : undefined) ?? service.getActiveVersion();
    const settings = version?.settings;
    // Not getWorkspacePath(): it toasts when no folder is open.
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const cwd = runDirectory(workspace);
    const dataDir = resolveOdooDataDir({
        extraParams: settings?.extraParams ?? '',
        env: process.env,
        platform: process.platform,
        home: os.homedir(),
        cwd,
        odooPath: path.resolve(cwd, settings?.odooPath ?? './odoo'),
        readText: file => {
            try {
                return fs.readFileSync(file, 'utf8');
            } catch {
                return undefined;
            }
        }
    });
    return filestoreRootOf(dataDir);
}

/**
 * Runs `work` with `db` released, then restarts what was stopped - even when
 * `work` fails. `{ done: false }` means the user said no.
 */
export async function withReleased<T>(db: string, purpose: string, work: () => Promise<T>): Promise<{ done: true; value: T } | { done: false }> {
    const release = await releaseForCopy(db, realReleaseHost(), dialogReleaseUi(purpose));
    if (!release) {
        return { done: false };
    }
    try {
        return { done: true, value: await work() };
    } finally {
        try {
            await release.restart();
        } catch (error) {
            void showWarning(`The server for "${db}" did not restart: ${errorMessage(error)}`);
        } finally {
            invalidateRunningState();
        }
    }
}
```

- [ ] **Step 5: Run to see it pass** — `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Releasing a database"`, outside the sandbox. Expected: PASS. Also run `npx tsc -p . --noEmit`; it catches an import cycle through `debugger.ts` only as a type error, if at all. If activation then fails in the full suite (Task 9), import `startServerForVersion` lazily: `const { startServerForVersion } = await import('../debugger');`.

- [ ] **Step 6: Lint, then commit**

```bash
npx tsc -p . --noEmit && npm run lint
git add src/services/connectionRelease.ts src/services/copyRuntime.ts src/test/connectionRelease.test.ts
git commit -m "[ADD] Free a database for a copy: stop our server, ask about the rest

Our own server is stopped after asking and restarted the same way, debug
or not. Our own backends are ended silently. Anyone else's connection
is listed and ended only after End Them.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Clone, Templates, Delete Database and Reconcile on the new copy

**Files:**
- Modify: `src/dbs.ts`:
  - `cloneDatabaseFromTemplate` (≈ line 797);
  - its caller in `createDb` (≈ line 771);
  - `cloneDatabaseFlow` (≈ 1100);
  - `deleteDb` (≈ 1038);
  - `reconcileDatabasesFlow` (≈ 1170);
  - `createTemplateFromSource` (≈ 1532);
  - `manageSingleTemplate` (≈ 1696).
- Modify: `src/services/reconcile.ts`
- Test: `src/test/reconcile.test.ts` (new; covers the pure part)

**Interfaces:**
- Consumes:
  - `copyDatabase`, `discardDatabase`, `databaseExistsVia` (Task 3);
  - `realCopyBackend`, `withReleased`, `filestoreRootFor` (Task 4);
  - `checkpointsOf`, `CHECKPOINT_COMMENTS_SQL`, `parseCheckpointComments`, `findOrphanCheckpoints` (Task 2);
  - `renameDir`, `dirExists` (Task 1).
- Produces:
  - `cloneDatabaseFromTemplate(targetDbName: string, templateDbName: string, versionId?: string): Promise<boolean>`, which returns false when cancelled
  - `StaleReferences` gains `checkpoints: StaleCheckpointReference[]` and `orphanCheckpoints: Array<{ name: string; source: string }>`
  - `interface StaleCheckpointReference { projectName: string; dbId: string; checkpoint: CheckpointModel }`
  - pure `collectStaleCheckpoints(projects, existingLower: Set<string>): { stale: StaleCheckpointReference[]; recorded: Set<string> }` in `reconcile.ts`

- [ ] **Step 1: Write the failing test** `src/test/reconcile.test.ts`

```ts
import * as assert from 'assert';
import { collectStaleCheckpoints } from '../services/reconcile';

suite('Reconcile checkpoints', () => {
    test('a record whose database is gone is stale; the rest are recorded', () => {
        const projects = [{
            name: 'Shop',
            dbs: [
                { id: 'shop', checkpoints: [
                    { id: 'shop__cp_1', label: 'a', createdAt: '2026-10-07T00:00:00.000Z', filestore: true },
                    { id: 'shop__cp_2', label: 'b', createdAt: '2026-10-07T00:00:00.000Z', filestore: true }
                ] },
                { id: 'plain' }
            ]
        }];
        const { stale, recorded } = collectStaleCheckpoints(projects, new Set(['shop', 'shop__cp_1']));
        assert.deepStrictEqual(stale.map(entry => [entry.projectName, entry.dbId, entry.checkpoint.id]), [['Shop', 'shop', 'shop__cp_2']]);
        assert.deepStrictEqual([...recorded].sort(), ['shop__cp_1', 'shop__cp_2']);
    });
});
```

- [ ] **Step 2: Run to see it fail** — `npm run compile-tests`. Expected: TS error, because `collectStaleCheckpoints` is not exported.

- [ ] **Step 3: Extend `src/services/reconcile.ts`**

Add imports: `import { runSql } from './postgres';` (next to `listPostgresDatabases`), and `import { checkpointsOf, CHECKPOINT_COMMENTS_SQL, parseCheckpointComments, findOrphanCheckpoints, CheckpointModel } from './checkpoints';`. Then add:

```ts
export interface StaleCheckpointReference {
    projectName: string;
    dbId: string;
    checkpoint: CheckpointModel;
}

/** Checkpoint records whose database is gone, and every name recorded at all. */
export function collectStaleCheckpoints(
    projects: Array<{ name: string; dbs?: Array<{ id?: string; checkpoints?: unknown }> }>,
    existingLower: Set<string>
): { stale: StaleCheckpointReference[]; recorded: Set<string> } {
    const stale: StaleCheckpointReference[] = [];
    const recorded = new Set<string>();
    for (const project of projects) {
        for (const db of project.dbs ?? []) {
            for (const checkpoint of checkpointsOf(db ?? {})) {
                recorded.add(checkpoint.id.toLowerCase());
                if (db?.id && !existingLower.has(checkpoint.id.toLowerCase())) {
                    stale.push({ projectName: project.name, dbId: db.id, checkpoint });
                }
            }
        }
    }
    return { stale, recorded };
}
```

Extend `StaleReferences` with `checkpoints: StaleCheckpointReference[]; orphanCheckpoints: Array<{ name: string; source: string }>;`. In `findStaleReferences`, before the `return`, add:

```ts
    const { stale: checkpoints, recorded } = collectStaleCheckpoints(data.projects ?? [], existingLower);
    let orphanCheckpoints: Array<{ name: string; source: string }> = [];
    try {
        orphanCheckpoints = findOrphanCheckpoints(parseCheckpointComments(await runSql('postgres', CHECKPOINT_COMMENTS_SQL)), existingLower, recorded);
    } catch (error) {
        logger.debug('Could not read checkpoint comments:', error);
    }
```

Return `{ databases, templates, checkpoints, orphanCheckpoints }`. In `logStaleReferences`, count `stale.checkpoints.length + stale.orphanCheckpoints.length` in `total`.

- [ ] **Step 4: `cloneDatabaseFromTemplate` on the copy routine** (`src/dbs.ts`)

Add to the imports:

```ts
import { copyDatabase, discardDatabase, databaseExistsVia } from './services/databaseCopy';
import { filestoreRootFor, realCopyBackend, withReleased } from './services/copyRuntime';
import { checkpointsOf } from './services/checkpoints';
import { dirExists, renameDir } from './services/filestore';
import { clearInstalledModuleCache } from './services/database';
```

Replace `cloneDatabaseFromTemplate` with:

```ts
/**
 * Copies `templateDbName` into `targetDbName` - the database and its
 * filestore - replacing any existing database of that name. Returns false
 * when the user declined to free the source.
 */
export async function cloneDatabaseFromTemplate(targetDbName: string, templateDbName: string, versionId?: string): Promise<boolean> {
    const backend = realCopyBackend();
    const root = filestoreRootFor(versionId);
    const outcome = await withReleased(templateDbName, 'copy it', () => vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Setting up database ${targetDbName}`,
        cancellable: false
    }, async (progress) => {
        if (await databaseExistsVia(backend, targetDbName)) {
            progress.report({ message: 'Dropping existing database...', increment: 20 });
            await discardDatabase(backend, targetDbName, root);
        }
        progress.report({ message: `Copying "${templateDbName}"...`, increment: 50 });
        await copyDatabase(backend, templateDbName, targetDbName, { filestoreRoot: root });
        clearInstalledModuleCache(targetDbName);
        progress.report({ message: 'Complete!', increment: 30 });
    }));
    return outcome.done;
}
```

In `createDb`, the template branch becomes:

```ts
    } else if (creationMethod === 'template' && selectedTemplate) {
        if (!await cloneDatabaseFromTemplate(dbName, selectedTemplate.templateDbName)) {
            return undefined;
        }
    }
```

A database created from a template has no version yet; the active version's data dir is used (P15).

In `cloneDatabaseFlow`, replace `await cloneDatabaseFromTemplate(targetName, db.id);` with:

```ts
    if (!await cloneDatabaseFromTemplate(targetName, db.id, db.versionId)) {
        return;
    }
```

The clone's `new DatabaseModel(...)` passes no `checkpoints` (P12): leave it as is.

- [ ] **Step 5: Templates** (`createTemplateFromSource`, `manageSingleTemplate`)

In `createTemplateFromSource`, replace the `withProgress` block that calls `createDatabase(templateDbName, sourceDbName)` with:

```ts
    const sourceVersionId = (data.projects ?? [])
        .flatMap(project => (project.dbs ?? []) as DatabaseModel[])
        .find(db => db.id === sourceDbName)?.versionId;
    const backend = realCopyBackend();
    const root = filestoreRootFor(sourceVersionId);
    const outcome = await withReleased(sourceDbName, 'copy it', () => vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Creating template ${templateDbName}`,
        cancellable: false
    }, async (progress) => {
        progress.report({ message: `Copying "${sourceDbName}"...`, increment: 30 });
        await copyDatabase(backend, sourceDbName, templateDbName, { filestoreRoot: root });
        progress.report({ message: 'Saving template metadata...', increment: 70 });
    }));
    if (!outcome.done) {
        return templates;
    }
```

In `manageSingleTemplate`:
- After `await renameDatabase(selectedTemplate.templateDbName, newTemplateDbName);`, add:

```ts
        const root = filestoreRootFor();
        const oldFolder = path.join(root, selectedTemplate.templateDbName);
        if (await dirExists(oldFolder)) {
            await renameDir(oldFolder, path.join(root, newTemplateDbName));
        }
```

- Replace `await dropDatabaseIfExists(selectedTemplate.templateDbName);` with `await discardDatabase(realCopyBackend(), selectedTemplate.templateDbName, filestoreRootFor());`.

If `dropDatabaseIfExists` or `createDatabase` are then unused in `dbs.ts`, remove them from the import. `setupDatabase` still uses `createDatabase`, `dropDatabase` and `databaseExists`.

- [ ] **Step 6: Delete Database names the checkpoints and removes the filestore**

In `deleteDb`, replace the confirmation and the drop with:

```ts
    const checkpoints = checkpointsOf(db);
    const withAll = `Delete with ${checkpoints.length} Checkpoint${checkpoints.length === 1 ? '' : 's'}`;
    const confirm = checkpoints.length === 0
        ? await showModalWarning(`Are you sure you want to delete the database "${dbLabel}"?`, 'Delete')
        : await showModalWarning(
            `Delete the database "${dbLabel}"? It has ${checkpoints.length === 1 ? 'a checkpoint' : `${checkpoints.length} checkpoints`}: `
            + `${checkpoints.map(cp => cp.label).join(', ')}. Delete keeps them; Reconcile Databases lists them afterwards.`,
            'Delete',
            withAll
        );
    if (confirm !== 'Delete' && confirm !== withAll) {
        return;
    }

    await setupDatabase(db.id, undefined, true);
    const backend = realCopyBackend();
    const root = filestoreRootFor(db.versionId);
    // Odoo's own drop removes the filestore too; a checkpoint's links keep its files.
    await discardDatabase(backend, db.id, root).catch(error => logger.warn(`Could not remove the filestore of ${db.id}:`, error));
    if (confirm === withAll) {
        for (const checkpoint of checkpoints) {
            await discardDatabase(backend, checkpoint.id, root)
                .catch(error => logger.warn(`Could not delete checkpoint ${checkpoint.id}:`, error));
        }
    }
```

`discardDatabase` on a database already dropped by `setupDatabase` is just the filestore removal: it checks existence first. Keep the rest of `deleteDb` (removing the record, reselecting, saving) unchanged.

- [ ] **Step 7: Reconcile shows stale checkpoint records and orphans**

In `reconcileDatabasesFlow`:
- Change `total` to `stale.databases.length + stale.templates.length + stale.checkpoints.length + stale.orphanCheckpoints.length`.
- Widen `StalePick`'s `staleKind` to `'db' | 'template' | 'checkpoint' | 'orphan'`, and add `dbId?: string`.
- Append these picks:

```ts
        ...stale.checkpoints.map(entry => ({
            label: `$(history) ${entry.checkpoint.label}`,
            description: `Checkpoint of "${entry.dbId}" in project "${entry.projectName}"`,
            detail: `Checkpoint database "${entry.checkpoint.id}" no longer exists`,
            picked: true,
            staleKind: 'checkpoint' as const,
            key: entry.checkpoint.id,
            projectName: entry.projectName,
            dbId: entry.dbId
        })),
        // Dropping a database is destructive, and another workspace may own it: unticked.
        ...stale.orphanCheckpoints.map(orphan => ({
            label: `$(trash) ${orphan.name}`,
            description: 'Orphaned checkpoint database',
            detail: `A checkpoint of "${orphan.source}", which no longer exists. Ticking it drops the database.`,
            picked: false,
            staleKind: 'orphan' as const,
            key: orphan.name
        }))
```

After `chosen` is read, collect `const checkpointKeys = new Set<string>()` (lower-cased ids of the `'checkpoint'` picks) and `const orphanNames = chosen.filter(pick => pick.staleKind === 'orphan').map(pick => pick.key)`. Then:
- If `orphanNames.length > 0`, confirm with `showModalWarning(\`Drop ${orphanNames.length} orphaned checkpoint database${orphanNames.length === 1 ? '' : 's'}? This cannot be undone.\`, 'Drop')`. If the answer is not `'Drop'`, clear `orphanNames`.
- In the existing per-project loop, also filter each db's checkpoints: `const kept = checkpointsOf(db).filter(cp => !checkpointKeys.has(cp.id.toLowerCase())); if (kept.length !== checkpointsOf(db).length) { setCheckpoints(db, kept); }`. Do this for every project, not only those with stale databases. Import `setCheckpoints` too.
- After saving, run `for (const name of orphanNames) { await discardDatabase(realCopyBackend(), name, filestoreRootFor()); }`.
- Make the final toast count only what was removed: `chosen.length` minus the orphans that were not dropped.

- [ ] **Step 8: Compile, test, lint, commit**

Run: `npx tsc -p . --noEmit && npm run lint`, then `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Reconcile checkpoints|Templates|Postgres service"`, outside the sandbox. Expected: PASS.

```bash
git checkout -- dist 2>/dev/null; git add src/dbs.ts src/services/reconcile.ts src/test/reconcile.test.ts
git commit -m "[FIX] Clone and Templates copy the filestore and free the source first

Clone Database, Create from Template and Create Template used createdb -T:
no filestore, so a copy's attachments and asset bundles pointed at
nothing, and a running server made them fail. They now use the copy
routine. Delete Database removes the filestore and names the database's
checkpoints; Reconcile lists stale checkpoint records and orphans.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Checkpoint rows in the Databases tree

**Files:**
- Modify: `src/views/dbsView.ts`
- Test: `src/test/dbsView.test.ts` (new)

**Interfaces:**
- Consumes: `checkpointsOf`, `formatAge`, `formatBytes`, `checkpointSizeSql`, `parseSizes`, `CheckpointModel` (Task 2); `runSql` (postgres.ts).
- Produces:
  - checkpoint rows: `TreeItem & { database: DatabaseModel; checkpoint: CheckpointModel }`, with `contextValue === 'checkpoint'` and `id === \`${db.id}::checkpoint::${cp.id}\``;
  - `extractCheckpointFromEvent(event: unknown): { database: DatabaseModel; checkpoint: CheckpointModel } | null`, exported from `dbsView.ts`;
  - `DbsTreeProvider.checkpointRows(db: DatabaseModel): vscode.TreeItem[]`, public for tests;
  - `DbsTreeProvider.setCheckpointSizes(sizes: Map<string, number>)`, a test seam.

- [ ] **Step 1: Write the failing test** `src/test/dbsView.test.ts`

```ts
import * as assert from 'assert';
import * as vscode from 'vscode';
import { DbsTreeProvider, extractCheckpointFromEvent } from '../views/dbsView';
import { SortPreferences } from '../sortPreferences';
import type { DatabaseModel } from '../models/db';

function provider(): DbsTreeProvider {
    const memento = { get: () => undefined, update: async () => undefined, keys: () => [] } as unknown as vscode.Memento;
    return new DbsTreeProvider(new SortPreferences(memento));
}

const db = {
    id: 'shop', name: 'shop', isSelected: true, createdAt: new Date('2026-10-01T00:00:00Z'), modules: [],
    checkpoints: [
        { id: 'shop__cp_1', label: 'before fix', createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), filestore: true },
        { id: 'shop__cp_2', label: 'newer', createdAt: new Date(Date.now() - 60 * 1000).toISOString(), filestore: false }
    ]
} as unknown as DatabaseModel;

suite('Databases tree checkpoints', () => {
    test('a database row lists its checkpoints, newest first; a checkpoint row lists nothing', async () => {
        const tree = provider();
        tree.setCheckpointSizes(new Map([['shop__cp_1', 15 * 1024 * 1024]]));
        const rows = tree.checkpointRows(db);
        assert.deepStrictEqual(rows.map(row => row.label), ['newer', 'before fix']);
        assert.strictEqual(rows[1].contextValue, 'checkpoint');
        assert.strictEqual(rows[1].id, 'shop::checkpoint::shop__cp_1');
        assert.strictEqual(rows[1].description, '2 h ago • 15 MB');
        assert.strictEqual(rows[1].collapsibleState, vscode.TreeItemCollapsibleState.None);
        assert.ok((rows[1].iconPath as vscode.ThemeIcon).id === 'history');
        assert.deepStrictEqual(await tree.getChildren(rows[1]), [], 'no recursion into a checkpoint');
        const parsed = extractCheckpointFromEvent(rows[1]);
        assert.strictEqual(parsed?.checkpoint.id, 'shop__cp_1');
        assert.strictEqual(parsed?.database.id, 'shop');
    });

    test('a database with no checkpoints field (plain JSON from the store) has no rows', () => {
        const plain = { id: 'old', name: 'old', createdAt: new Date(), modules: [] } as unknown as DatabaseModel;
        assert.deepStrictEqual(provider().checkpointRows(plain), []);
    });

    test('getParent of a checkpoint row is its database row', async () => {
        const tree = provider();
        const parentRow = { id: 'shop', contextValue: 'database', database: db, label: 'shop', collapsibleState: 1 } as unknown as vscode.TreeItem;
        (tree as unknown as { rows: Map<string, vscode.TreeItem> }).rows.set('shop', parentRow);
        const [row] = tree.checkpointRows(db);
        assert.strictEqual(tree.getParent(row), parentRow);
        assert.strictEqual(tree.getParent(parentRow), undefined);
    });
});
```

Check `SortPreferences`'s constructor with `grep -n "constructor" src/sortPreferences.ts`, and adapt the fake if it takes a context instead of a memento.

- [ ] **Step 2: Run to see it fail** — `npm run compile-tests`. Expected: TS errors.

- [ ] **Step 3: Implement in `src/views/dbsView.ts`**

Imports:

```ts
import { checkpointsOf, checkpointSizeSql, formatAge, formatBytes, parseSizes, CheckpointModel } from '../services/checkpoints';
import { runSql } from '../services/postgres';
import { logger } from '../services/logger';
```

Module-level types and helper:

```ts
type DbRow = vscode.TreeItem & { database?: DatabaseModel };
type CheckpointRow = vscode.TreeItem & { database: DatabaseModel; checkpoint: CheckpointModel };

export function extractCheckpointFromEvent(event: unknown): { database: DatabaseModel; checkpoint: CheckpointModel } | null {
    const row = event as Partial<CheckpointRow> | undefined;
    if (row && row.contextValue === 'checkpoint' && row.database && row.checkpoint) {
        return { database: row.database, checkpoint: row.checkpoint };
    }
    return null;
}
```

In the class, add fields:

```ts
    /** Checkpoint rows by id, reused for reveal like `rows`. */
    private readonly checkpointRowCache = new Map<string, CheckpointRow>();
    /** pg_database_size of every checkpoint, read once per refresh. */
    private checkpointSizes = new Map<string, number>();
```

Replace `getParent`:

```ts
    /** Checkpoint rows sit under their database's row; databases are top-level. */
    getParent(item: vscode.TreeItem): vscode.TreeItem | undefined {
        if (item.contextValue === 'checkpoint') {
            const db = (item as CheckpointRow).database;
            return db ? this.rows.get(db.id) : undefined;
        }
        return undefined;
    }

    setCheckpointSizes(sizes: Map<string, number>): void {
        this.checkpointSizes = sizes;
    }

    checkpointRows(db: DatabaseModel): vscode.TreeItem[] {
        const now = new Date();
        return checkpointsOf(db)
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
            .map(checkpoint => {
                const id = `${db.id}::checkpoint::${checkpoint.id}`;
                const size = this.checkpointSizes.get(checkpoint.id);
                const fresh = new vscode.TreeItem(checkpoint.label, vscode.TreeItemCollapsibleState.None) as CheckpointRow;
                fresh.id = id;
                fresh.iconPath = new vscode.ThemeIcon('history');
                fresh.contextValue = 'checkpoint';
                fresh.description = [formatAge(checkpoint.createdAt, now), size === undefined ? '' : formatBytes(size)]
                    .filter(Boolean).join(' \u2022 ');
                const created = new Date(checkpoint.createdAt);
                fresh.tooltip = new vscode.MarkdownString([
                    `**${checkpoint.label}**`,
                    `**Checkpoint of:** ${db.id}`,
                    `**Created:** ${isNaN(created.getTime()) ? checkpoint.createdAt : created.toLocaleString()}`,
                    ...(size === undefined ? [] : [`**Size:** ${formatBytes(size)}`]),
                    `**Filestore:** ${checkpoint.filestore ? 'yes' : 'none (the database had no filestore folder)'}`,
                    `**PostgreSQL name:** ${checkpoint.id}`
                ].join('\n\n'));
                fresh.database = db;
                fresh.checkpoint = checkpoint;
                const row = Object.assign(this.checkpointRowCache.get(id) ?? fresh, fresh);
                this.checkpointRowCache.set(id, row);
                return row;
            });
    }

    private async readCheckpointSizes(dbs: DatabaseModel[]): Promise<void> {
        const names = dbs.flatMap(db => checkpointsOf(db).map(cp => cp.id));
        if (names.length === 0) {
            this.checkpointSizes = new Map();
            return;
        }
        try {
            this.checkpointSizes = parseSizes(await runSql('postgres', checkpointSizeSql(names)));
        } catch (error) {
            logger.debug('Could not read checkpoint sizes:', error);
            this.checkpointSizes = new Map();
        }
    }
```

At the top of `getChildren` (rename `_element` to `element`):

```ts
        // A row asks for its own children: only a database row has any. Falling
        // through to the root list here would make every collapsible row recurse.
        if (element) {
            const db = (element as DbRow).database;
            return element.contextValue === 'database' && db ? this.checkpointRows(db) : [];
        }
```

In the root path, after the `running` map is built, add `await this.readCheckpointSizes(dbs);`.

In `buildDatabaseItem`:
- Create the item with `checkpointsOf(db).length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None`.
- Push the count into `descriptionParts` after the upgrade part:

```ts
        const checkpointCount = checkpointsOf(db).length;
        if (checkpointCount > 0) {
            descriptionParts.push(`${checkpointCount} checkpoint${checkpointCount === 1 ? '' : 's'}`);
        }
```

- [ ] **Step 4: Run to see it pass** — `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Databases tree checkpoints"`, outside the sandbox. Expected: PASS.

- [ ] **Step 5: Lint, then commit**

```bash
npx tsc -p . --noEmit && npm run lint
git add src/views/dbsView.ts src/test/dbsView.test.ts
git commit -m "[ADD] List a database's checkpoints under its row

Each checkpoint shows its label, age and size. The sizes are read in
one query per refresh, without connecting to the checkpoints.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Create, Restore, Rename and Delete Checkpoint

**Files:**
- Create: `src/commands/checkpointCommands.ts`
- Modify: `src/commands/index.ts` (register)
- Modify: `package.json`: `contributes.commands`, `menus.view/item/context`, `menus.commandPalette`
- Modify: `src/test/upgradeGuards.test.ts` (adds to `MUST_STAY`)
- Test: `src/test/checkpointMenus.test.ts` (new)

**Interfaces:**
- Consumes:
  - Tasks 2–6;
  - `extractDatabaseFromEvent` (dbs.ts);
  - `SettingsStore.getSelectedProject()`, `SettingsStore.saveWithoutComments(stripSettings(data))`;
  - `listPostgresDatabases`;
  - `clearInstalledModuleCache`, `invalidateRunningState`;
  - `showModalWarning`, `showAutoInfo`, `showError`;
  - `getDatabaseLabel`.
- Produces: the commands `dbSelector.createCheckpoint`, `dbSelector.restoreCheckpoint`, `dbSelector.renameCheckpoint` and `dbSelector.deleteCheckpoint`.

- [ ] **Step 1: Write the failing menu test** `src/test/checkpointMenus.test.ts`

```ts
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface MenuEntry { command: string; when?: string; group?: string }

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
const itemMenus = manifest.contributes.menus['view/item/context'] as MenuEntry[];
const palette = manifest.contributes.menus.commandPalette as MenuEntry[];
const commands = (manifest.contributes.commands as Array<{ command: string }>).map(entry => entry.command);

suite('Checkpoint menus', () => {
    const ids = ['dbSelector.createCheckpoint', 'dbSelector.restoreCheckpoint', 'dbSelector.renameCheckpoint', 'dbSelector.deleteCheckpoint'];

    test('every checkpoint command is contributed', () => {
        for (const id of ids) {
            assert.ok(commands.includes(id), `${id} is not in contributes.commands`);
        }
    });

    test('Create is on database rows, inline and in the menu', () => {
        const entries = itemMenus.filter(entry => entry.command === 'dbSelector.createCheckpoint');
        assert.ok(entries.some(entry => entry.group?.startsWith('inline')));
        assert.ok(entries.some(entry => !entry.group?.startsWith('inline')));
        for (const entry of entries) {
            assert.ok(/viewItem == database\b/.test(entry.when ?? ''), entry.when);
        }
    });

    test('Restore, Rename and Delete are on checkpoint rows only, never inline, never in the palette', () => {
        for (const id of ids.slice(1)) {
            const entries = itemMenus.filter(entry => entry.command === id);
            assert.ok(entries.length > 0, `${id} has no row menu entry`);
            for (const entry of entries) {
                assert.ok(/viewItem == checkpoint\b/.test(entry.when ?? ''), `${id}: ${entry.when}`);
                assert.ok(!entry.group?.startsWith('inline'), `${id} must not be inline`);
            }
            assert.ok(palette.some(entry => entry.command === id && entry.when === 'false'), `${id} must be hidden from the palette`);
        }
    });

    test('Delete Checkpoint is in the danger group', () => {
        const entry = itemMenus.find(item => item.command === 'dbSelector.deleteCheckpoint');
        assert.ok(entry?.group?.startsWith('9_danger'));
    });
});
```

- [ ] **Step 2: Run to see it fail** — `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Checkpoint menus"`, outside the sandbox. Expected: FAIL, "is not in contributes.commands".

- [ ] **Step 3: `package.json`**

Add to `contributes.commands`, after `dbSelector.reconcile`:

```json
      {
        "command": "dbSelector.createCheckpoint",
        "title": "Create Checkpoint",
        "category": "Odoo DevTools",
        "icon": "$(bookmark)"
      },
      {
        "command": "dbSelector.restoreCheckpoint",
        "title": "Restore Checkpoint",
        "category": "Odoo DevTools"
      },
      {
        "command": "dbSelector.renameCheckpoint",
        "title": "Rename Checkpoint",
        "category": "Odoo DevTools"
      },
      {
        "command": "dbSelector.deleteCheckpoint",
        "title": "Delete Checkpoint",
        "category": "Odoo DevTools"
      },
```

Add to `menus.view/item/context`, next to the `dbSelector.clone` entry:

```json
        {
          "command": "dbSelector.createCheckpoint",
          "when": "view == dbSelector && viewItem == database",
          "group": "inline@1"
        },
        {
          "command": "dbSelector.createCheckpoint",
          "when": "view == dbSelector && viewItem == database",
          "group": "1_database@5"
        },
        {
          "command": "dbSelector.restoreCheckpoint",
          "when": "view == dbSelector && viewItem == checkpoint",
          "group": "1_checkpoint@1"
        },
        {
          "command": "dbSelector.renameCheckpoint",
          "when": "view == dbSelector && viewItem == checkpoint",
          "group": "1_checkpoint@2"
        },
        {
          "command": "dbSelector.deleteCheckpoint",
          "when": "view == dbSelector && viewItem == checkpoint",
          "group": "9_danger@1"
        },
```

Add to `menus.commandPalette`, next to the `dbSelector.clone` `"when": "false"` entry:

```json
        { "command": "dbSelector.restoreCheckpoint", "when": "false" },
        { "command": "dbSelector.renameCheckpoint", "when": "false" },
        { "command": "dbSelector.deleteCheckpoint", "when": "false" },
```

Match the file's existing formatting, one key per line, as in the surrounding entries.

In `src/test/upgradeGuards.test.ts`:
- Add `'dbSelector.createCheckpoint'` and `'dbSelector.restoreCheckpoint'` to `MUST_STAY` (spec §3.5: both are allowed in upgrade mode). `MUST_STAY` only checks that no entry carries the upgrade guard.
- The test "the pair rows keep the contextValue their menus are keyed to" asserts that every `view == dbSelector` entry contains `viewItem == database`. The checkpoint entries are keyed to `viewItem == checkpoint` on purpose, so widen that assertion: `/viewItem == (database|checkpoint)\b/.test(entry.when ?? '')`. Keep the message, and add a comment: checkpoint rows are the database rows' children, with their own menu.

- [ ] **Step 4: Implement `src/commands/checkpointCommands.ts`**

```ts
/**
 * Database checkpoints: protected copies of a database, kept as PostgreSQL
 * databases and restored by swapping them back in (services/databaseCopy.ts).
 */
import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { registerCommand } from './registerCommand';
import { SettingsStore } from '../settingsStore';
import type { DatabaseModel } from '../models/db';
import { extractDatabaseFromEvent } from '../dbs';
import { extractCheckpointFromEvent } from '../views/dbsView';
import { getDatabaseLabel, stripSettings } from '../utils';
import { listPostgresDatabases } from '../services/postgres';
import { clearInstalledModuleCache } from '../services/database';
import { invalidateRunningState } from '../services/runningState';
import {
    checkpointComment, checkpointDbName, checkpointsOf, defaultCheckpointLabel, setCheckpoints, CheckpointModel
} from '../services/checkpoints';
import { copyDatabase, discardDatabase, stageRestore, swapInRestored } from '../services/databaseCopy';
import { filestoreRootFor, realCopyBackend, withReleased } from '../services/copyRuntime';
import { showAutoInfo, showError, showModalWarning } from '../services/notifications';
import { logger, errorMessage } from '../services/logger';

const RESTORE = 'Restore';
const CHECKPOINT_THEN_RESTORE = 'Checkpoint Current State, then Restore';

/** Re-reads the store and applies `change` to the database's record, then saves. */
async function updateCheckpoints(dbId: string, change: (list: CheckpointModel[]) => CheckpointModel[]): Promise<boolean> {
    const result = await SettingsStore.getSelectedProject();
    const target = (result?.project.dbs as DatabaseModel[] | undefined)?.find(entry => entry.id === dbId);
    if (!result || !target) {
        return false;
    }
    setCheckpoints(target, change(checkpointsOf(target)));
    await SettingsStore.saveWithoutComments(stripSettings(result.data));
    return true;
}

async function takenNames(): Promise<Set<string>> {
    return new Set((await listPostgresDatabases()).map(name => name.toLowerCase()));
}

/** Copies `db` into a new protected checkpoint; the caller has released it. */
async function takeCheckpoint(db: DatabaseModel, label: string, root: string): Promise<CheckpointModel> {
    const now = new Date();
    const id = checkpointDbName(db.id, now, await takenNames());
    const copied = await copyDatabase(realCopyBackend(), db.id, id, { filestoreRoot: root, protect: { comment: checkpointComment(db.id) } });
    const checkpoint: CheckpointModel = { id, label, createdAt: now.toISOString(), filestore: copied.filestore };
    if (!await updateCheckpoints(db.id, list => [...list, checkpoint])) {
        logger.warn(`Checkpoint ${id} was created, but "${db.id}" is no longer in the project; Reconcile Databases will list it.`);
    }
    return checkpoint;
}

async function selectedDatabase(): Promise<DatabaseModel | undefined> {
    const result = await SettingsStore.getSelectedProject();
    return (result?.project.dbs as DatabaseModel[] | undefined)?.find(entry => entry.isSelected);
}

export function registerCheckpointCommands(deps: CommandDeps): void {
    const { context, refreshAll } = deps;

    context.subscriptions.push(registerCommand('dbSelector.createCheckpoint', async (event?: unknown) => {
        try {
            const db = extractDatabaseFromEvent(event) ?? await selectedDatabase();
            if (!db) {
                void showError('Select a database to checkpoint.');
                return;
            }
            const entered = await vscode.window.showInputBox({
                prompt: `Label for the checkpoint of "${getDatabaseLabel(db)}"`,
                value: defaultCheckpointLabel(new Date()),
                ignoreFocusOut: true
            });
            if (entered === undefined) {
                return;
            }
            const label = entered.trim() || defaultCheckpointLabel(new Date());
            const root = filestoreRootFor(db.versionId);
            const outcome = await withReleased(db.id, 'take the checkpoint', () => vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Creating checkpoint "${label}" of ${db.id}`
            }, () => takeCheckpoint(db, label, root)));
            if (outcome.done) {
                showAutoInfo(`Checkpoint "${label}" of "${getDatabaseLabel(db)}" created.`, 3000);
            }
        } catch (err) {
            void showError(`Failed to create the checkpoint: ${errorMessage(err)}`);
            logger.error('Error creating a checkpoint:', err);
        }
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(registerCommand('dbSelector.restoreCheckpoint', async (event: unknown) => {
        const picked = extractCheckpointFromEvent(event);
        if (!picked) {
            void showError('Right-click a checkpoint to restore it.');
            return;
        }
        const { database: db, checkpoint } = picked;
        const dbLabel = getDatabaseLabel(db);
        const choice = await showModalWarning(
            `Restore "${dbLabel}" to "${checkpoint.label}"? Everything since is lost.`,
            RESTORE,
            CHECKPOINT_THEN_RESTORE
        );
        if (choice !== RESTORE && choice !== CHECKPOINT_THEN_RESTORE) {
            return;
        }
        const backend = realCopyBackend();
        const root = filestoreRootFor(db.versionId);
        let staged: string | undefined;
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Restoring ${db.id} to "${checkpoint.label}"`
            }, async progress => {
                progress.report({ message: 'Copying the checkpoint...' });
                staged = await stageRestore(backend, db.id, checkpoint.id, root);
                const outcome = await withReleased(db.id, 'restore it', async () => {
                    if (choice === CHECKPOINT_THEN_RESTORE) {
                        progress.report({ message: 'Checkpointing the current state...' });
                        await takeCheckpoint(db, `Before restoring ${checkpoint.label}`, root);
                    }
                    progress.report({ message: 'Swapping it in...' });
                    await swapInRestored(backend, db.id, staged!, root);
                });
                if (outcome.done) {
                    showAutoInfo(`"${dbLabel}" is back to "${checkpoint.label}".`, 3000);
                }
            });
        } catch (err) {
            void showError(`Failed to restore the checkpoint: ${errorMessage(err)}`);
            logger.error('Error restoring a checkpoint:', err);
        } finally {
            // Gone after a successful swap: it was renamed to the database.
            if (staged) {
                await discardDatabase(backend, staged, root).catch(error => logger.warn(`Could not drop ${staged}:`, error));
            }
            clearInstalledModuleCache(db.id);
            invalidateRunningState();
        }
        await refreshAll();
    }));

    context.subscriptions.push(registerCommand('dbSelector.renameCheckpoint', async (event: unknown) => {
        const picked = extractCheckpointFromEvent(event);
        if (!picked) {
            return;
        }
        const entered = await vscode.window.showInputBox({
            prompt: `New label for this checkpoint of "${getDatabaseLabel(picked.database)}"`,
            value: picked.checkpoint.label,
            ignoreFocusOut: true,
            validateInput: value => (value.trim() ? undefined : 'The label cannot be empty')
        });
        const label = entered?.trim();
        if (!label || label === picked.checkpoint.label) {
            return;
        }
        await updateCheckpoints(picked.database.id, list => list.map(cp => cp.id === picked.checkpoint.id ? { ...cp, label } : cp));
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(registerCommand('dbSelector.deleteCheckpoint', async (event: unknown) => {
        const picked = extractCheckpointFromEvent(event);
        if (!picked) {
            return;
        }
        const { database: db, checkpoint } = picked;
        const confirm = await showModalWarning(
            `Delete the checkpoint "${checkpoint.label}" of "${getDatabaseLabel(db)}"? This cannot be undone.`,
            'Delete'
        );
        if (confirm !== 'Delete') {
            return;
        }
        try {
            await discardDatabase(realCopyBackend(), checkpoint.id, filestoreRootFor(db.versionId));
            await updateCheckpoints(db.id, list => list.filter(cp => cp.id !== checkpoint.id));
            showAutoInfo(`Checkpoint "${checkpoint.label}" deleted.`, 2500);
        } catch (err) {
            void showError(`Failed to delete the checkpoint: ${errorMessage(err)}`);
            logger.error('Error deleting a checkpoint:', err);
        }
        await refreshAll({ reason: 'ui' });
    }));
}
```

In `src/commands/index.ts`, import `registerCheckpointCommands` from `./checkpointCommands` and call it in `registerAllCommands`, right after `registerDbCommands(deps)`.

- [ ] **Step 5: Run the menu tests and the guard tests**

Run: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Checkpoint menus|What upgrade mode hides|Extension Test Suite"`, outside the sandbox. Expected: PASS.

- [ ] **Step 6: Lint, then commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist 2>/dev/null; git add src/commands/checkpointCommands.ts src/commands/index.ts package.json src/test/checkpointMenus.test.ts src/test/upgradeGuards.test.ts
git commit -m "[ADD] Create, restore, rename and delete database checkpoints

Create Checkpoint is on a database's row, inline too, and in the palette
for the selected database. Restore, Rename and Delete are on the
checkpoint's right-click menu. A running server in this window is
stopped after asking and restarted afterwards.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The gated real-PostgreSQL test

**Files:**
- Create: `src/test/checkpoints.integration.test.ts`

**Interfaces:**
- Consumes:
  - `copyDatabase`, `stageRestore`, `swapInRestored`, `discardDatabase` (Task 3);
  - `releaseForCopy` and `ReleaseUi` (Task 4);
  - `realCopyBackend`, `realReleaseHost` (Task 4);
  - `checkpointComment`, `checkpointSizeSql`, `parseSizes`, `parseCheckpointComments` (Task 2);
  - `createDatabase`, `runSql`, `databaseExists` (postgres.ts).

Skipped unless `ODT_PG_TEST=1`. `ODT_PG_TEST_ODOO` may list Odoo checkouts, comma-separated; their `odoo/service/db.py` gives the real `list_dbs` query. Without it, the 17.0 text quoted below is used (verified the same in 15.0–19.0 on 2026-10-08).

- [ ] **Step 1: Write the test**

```ts
/**
 * Checkpoints against a real PostgreSQL. Skipped unless ODT_PG_TEST=1.
 * ODT_PG_TEST_ODOO=<odoo checkout>[,<odoo checkout>...] reads list_dbs's
 * query from each checkout's odoo/service/db.py. Every database it makes is
 * named odt_cp_* and dropped afterwards.
 */
import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { createDatabase, databaseExists, runSql } from '../services/postgres';
import { copyDatabase, discardDatabase, stageRestore, swapInRestored } from '../services/databaseCopy';
import { releaseForCopy, ReleaseUi, DbConnection } from '../services/connectionRelease';
import { realCopyBackend, realReleaseHost } from '../services/copyRuntime';
import { checkpointComment, checkpointSizeSql, parseCheckpointComments, parseSizes } from '../services/checkpoints';

const enabled = process.env.ODT_PG_TEST === '1';
const LIST_DBS_17 = "select datname from pg_database where datdba=(select usesysid from pg_user where usename=current_user) and not datistemplate and datallowconn and datname not in %s order by datname";

function listDbsQueries(): string[] {
    const trees = (process.env.ODT_PG_TEST_ODOO ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
    if (trees.length === 0) {
        return [LIST_DBS_17];
    }
    return trees.map(tree => {
        const source = fsSync.readFileSync(path.join(tree, 'odoo', 'service', 'db.py'), 'utf8');
        const match = /cr\.execute\("(select datname from pg_database where datdba[^"]+)"/.exec(source);
        assert.ok(match, `no list_dbs query in ${tree}`);
        return match[1];
    });
}

(enabled ? suite : suite.skip)('Checkpoints on a real PostgreSQL', function () {
    this.timeout(120000);
    const suffix = `${process.pid}_${Date.now().toString(36)}`;
    const db = `odt_cp_${suffix}`;
    const checkpoint = `${db}__cp_test`;
    let root: string;
    let holder: ChildProcess | undefined;
    const backend = realCopyBackend();

    suiteSetup(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'odt-cp-fs-'));
        await createDatabase(db);
        await runSql(db, 'CREATE TABLE odt_t (v int); INSERT INTO odt_t VALUES (1);');
        await fs.mkdir(path.join(root, db, 'ab'), { recursive: true });
        await fs.writeFile(path.join(root, db, 'ab', 'first'), 'one');
    });

    suiteTeardown(async () => {
        holder?.kill();
        const names = (await runSql('postgres', "SELECT datname FROM pg_database WHERE datname LIKE 'odt\\_cp\\_%';")).split('\n').filter(Boolean);
        for (const name of names) {
            await discardDatabase(backend, name).catch(() => undefined);
        }
        await fs.rm(root, { recursive: true, force: true });
    });

    test('a session on the database is ended only after the prompt says yes', async () => {
        holder = spawn('psql', ['--no-psqlrc', '-d', db], { env: { ...process.env, PGAPPNAME: 'odt-test-holder' }, stdio: ['pipe', 'ignore', 'ignore'] });
        for (let i = 0; i < 40; i++) {
            const seen = await runSql('postgres', `SELECT count(*) FROM pg_stat_activity WHERE datname = '${db}' AND application_name = 'odt-test-holder';`);
            if (seen === '1') {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        const asked: DbConnection[][] = [];
        const ui: ReleaseUi = { confirmStop: async () => false, confirmEnd: async (_db, list) => { asked.push(list); return true; } };
        const release = await releaseForCopy(db, realReleaseHost(), ui);
        assert.ok(release);
        assert.strictEqual(asked.length, 1);
        assert.deepStrictEqual(asked[0].map(c => c.application), ['odt-test-holder']);
    });

    test('a checkpoint is a protected copy that Odoo does not list, and its size reads', async () => {
        const result = await copyDatabase(backend, db, checkpoint, { filestoreRoot: root, protect: { comment: checkpointComment(db) } });
        assert.deepStrictEqual(result, { filestore: true, copiedFiles: 0 });
        assert.strictEqual(
            await runSql('postgres', `SELECT datallowconn::text || ',' || datistemplate::text FROM pg_database WHERE datname = '${checkpoint}';`),
            'false,true'
        );
        for (const query of listDbsQueries()) {
            const listed = (await runSql('postgres', query.replace('%s', "('postgres','template0','template1')"))).split('\n');
            assert.ok(listed.includes(db), 'the source is listed');
            assert.ok(!listed.includes(checkpoint), 'the checkpoint is not');
        }
        const [a, b] = await Promise.all([fs.stat(path.join(root, db, 'ab', 'first')), fs.stat(path.join(root, checkpoint, 'ab', 'first'))]);
        assert.strictEqual(a.ino, b.ino);
        const sizes = parseSizes(await runSql('postgres', checkpointSizeSql([checkpoint])));
        assert.ok((sizes.get(checkpoint) ?? 0) > 0);
        const comments = parseCheckpointComments(await runSql('postgres', "SELECT datname, coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datistemplate;"));
        assert.ok(comments.some(row => row.name === checkpoint && row.source === db));
    });

    test('restore brings the data and the filestore back', async () => {
        await runSql(db, 'INSERT INTO odt_t VALUES (2);');
        await fs.writeFile(path.join(root, db, 'ab', 'second'), 'two');
        await fs.rm(path.join(root, db, 'ab', 'first'));

        const staged = await stageRestore(backend, db, checkpoint, root);
        await swapInRestored(backend, db, staged, root);

        assert.strictEqual(await runSql(db, 'SELECT string_agg(v::text, \',\' ORDER BY v) FROM odt_t;'), '1');
        assert.deepStrictEqual((await fs.readdir(path.join(root, db, 'ab'))).sort(), ['first']);
        assert.strictEqual(await databaseExists(staged), false);
        assert.strictEqual(await databaseExists(`${db}__replaced`), false);
        assert.strictEqual(await databaseExists(checkpoint), true, 'the checkpoint is kept');
    });

    test('a checkpoint is deleted with its filestore', async () => {
        await discardDatabase(backend, checkpoint, root);
        assert.strictEqual(await databaseExists(checkpoint), false);
        await assert.rejects(fs.stat(path.join(root, checkpoint)));
    });
});
```

- [ ] **Step 2: Run it for real**

Run, outside the sandbox: `npm run compile-tests && ODT_PG_TEST=1 ODT_PG_TEST_ODOO=/home/odoo/odoo-dev/odoo-17.0,/home/odoo/odoo-dev/odoo-18.0,/home/odoo/odoo-dev/odoo-19.0 env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Checkpoints on a real PostgreSQL"`. Expected: 4 passing. Without `ODT_PG_TEST`, the suite is pending.

If `runSql(db, '<two statements>')` fails because `-c` runs them as one implicit transaction, that is fine. If psql refuses the two statements, split them into two calls.

- [ ] **Step 3: Check nothing is left behind**

Run: `psql -d postgres -tAc "SELECT datname FROM pg_database WHERE datname LIKE 'odt\_cp\_%'"`. Expected: no rows.

- [ ] **Step 4: Commit**

```bash
git add src/test/checkpoints.integration.test.ts
git commit -m "[ADD] Test checkpoints against a real PostgreSQL

Gated by ODT_PG_TEST=1. It ends a held session after the prompt, checks
that Odoo's own list_dbs query skips checkpoints, and restores data and
filestore.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Docs, the full suite, and the build

**Files:**
- Modify: `README.md` (§ Databases), `CHANGELOG.md` (`[Unreleased]`), and `dist/` (rebuilt)

- [ ] **Step 1: README**

In `### Databases`:
- In the first bullet, replace `**From Template** (\`createdb -T\` clone)` with `**From Template** (a copy of a template database, attachments included)`.
- After the Templates bullet, add:

```markdown
- **Checkpoints** keep a database's state to come back to. Right-click a database → **Create Checkpoint**, or use its bookmark icon. The checkpoint is a full PostgreSQL copy, taken in seconds, with its attachments linked rather than copied. It is listed under the database with its age and size. Right-click it → **Restore Checkpoint** puts the database back exactly as it was, attachments included; the checkpoint is kept, so you can restore it again. **Checkpoint Current State, then Restore** keeps what you had too. A server running the database in this window is stopped after asking and restarted afterwards. Checkpoints refuse connections, so they cannot change, and Odoo's database list does not show them. Deleting a database asks whether to delete its checkpoints too.
- **Clone** and **Templates** copy the filestore as well, so a copy's attachments and stored assets work. They first ask to stop a server running the source, or to end other connections to it.
```

In the **Reconcile Databases** bullet, append: ` It also lists checkpoint records whose database is gone, and checkpoint databases whose source is gone.`

- [ ] **Step 2: CHANGELOG**

Under `## [Unreleased]` → `### Added`, append:

```markdown
- **Database checkpoints.** Create Checkpoint, on a database's row, keeps a full copy of the database to restore later. It is a PostgreSQL database copied with `STRATEGY FILE_COPY`, so it takes seconds, not a dump, and its filestore is hard-linked, so it costs almost no space. Checkpoints are listed under their database with their age and size. Restore Checkpoint swaps the copy back in by renaming, so the database never goes missing, and restarts the database's server if it was running in this window. Checkpoints refuse connections and stay out of Odoo's database list. Rename and delete them from their right-click menu.
```

Under `### Changed` (create it after `### Added` if missing), append:

```markdown
- **Clone Database and Templates copy the filestore.** They used `createdb -T`, which copies no attachments: a clone's attachments and stored asset bundles pointed at files that did not exist. They also failed while a server was connected. Now they copy the filestore, and ask to stop the server or end the connections first. Delete Database removes the database's filestore too, as Odoo does.
```

- [ ] **Step 3: Full verification**

Run: `npx tsc -p . --noEmit && npm run lint`. Expected: 0 errors, and no new warnings beyond 117.

Run, outside the sandbox: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npm test`. Expected: 0 failing. Passing should be at least 862 plus the new tests; the gated integration suite counts as pending.

Run, outside the sandbox: `ODT_PG_TEST=1 ODT_PG_TEST_ODOO=/home/odoo/odoo-dev/odoo-17.0,/home/odoo/odoo-dev/odoo-18.0,/home/odoo/odoo-dev/odoo-19.0 env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Checkpoints on a real PostgreSQL"`. Expected: 4 passing.

Then `npm run compile` to rebuild `dist/`.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md dist
git commit -m "[DOC] Describe database checkpoints; rebuild

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## After the tasks (the controller does this, not a task implementer)

1. **Final whole-branch review**, on the most capable model, of `b0002ee..HEAD`.
2. **Live window under Xvfb**, with the recipe in `odoo-debugger-verification.md` and the fixture at `/tmp/claude/odt5`, plus a real PostgreSQL database (`odt_cp_live_*`). Use a stub `odoo-bin` that opens a psql connection to its `-d` and sleeps, so a "server" really holds the database. Check:
   - a. The inline bookmark and the right-click Create Checkpoint, with the label prompt pre-filled.
   - b. The row turns collapsible with "1 checkpoint". Expanding it shows the label, the age and the size.
   - c. With the stub server running from this window: the stop modal; the server stops, then comes back (`running :port` again).
   - d. A held external psql session: the End Them modal names it.
   - e. Restore, with data changed in between: the data is back, and so is the server.
   - f. Checkpoint Current State, then Restore: two checkpoints after it.
   - g. Rename and Delete Checkpoint.
   - h. Delete Database with checkpoints: two buttons.
   - i. Reconcile lists an orphan, unticked.
   - j. Clone keeps the filestore links.
3. Drop every `odt_cp_*` database made during the check. Write a handover note.
