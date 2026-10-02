# View Doctor Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Views" tree that lists the views the selected database has turned off, grouped as "disabled by the upgrade" first and then "other inactive", and let the user open, edit and save any view's arch as an XML file. Saving writes the arch back through Odoo, and enables the view when Odoo can compose it.

**Architecture:**
- **Listing** uses `psql`, with JSON output.
- **Arch read/write and activation** go through one long-lived `odoo-bin shell` per database.
  - The shell runs `resources/scripts/view_worker.py`.
  - It speaks JSON lines on fd 3 (requests) and fd 4 (replies). It cannot use stdin, because the shell `exec()`s all of stdin before it starts.
- **Editing** is a `FileSystemProvider` (`odoo-view:` scheme), so VS Code's own XML editor is the edit surface.
- There is no webserver and no webview.

**Tech Stack:**
- TypeScript, VS Code API ^1.101.
- Node built-ins only: `child_process`, `net`. No new runtime dependency.
- Python 3 inside the Odoo shell, for Odoo 15–19.
- Mocha (`suite`/`test`) in the Extension Host via `@vscode/test-cli`.

**Spec:** `docs/superpowers/specs/2026-10-02-view-doctor-design.md`, stage 1: "Worker + tree + edit/activate". Stages 2 (compare/render) and 3 (script) get their own plans.

**Left to later stages:**
- **Stage 2:**
  - Compare with Original.
  - Render in Browser.
  - Opening the From side read-only, with `allowEditOriginal`.
  - The `make_action` worker command.
- **Stage 3:**
  - The "Edited here" group.
  - Notes and the journal.
  - `get_arches`.
  - Add to Upgrade Script.
  - Script generation.

## Global Constraints

- `engines.vscode` stays `^1.101.0`. Do not add a runtime dependency: `package.json` `dependencies` stays `jsonc-parser` only.
- The worker shell must **never** get `-i`, `-u`, `--init`, `--update`, test flags, `--stop-after-init`, a port, or `--dev`. That includes anything typed into the version's `extraParams`.
- The worker's Postgres connections carry `application_name = 'odoo-devtools-view-worker'`, so the running-database probe ignores them.
- Every child process is spawned with argument arrays and `shell: false`, as in `src/services/process.ts`.
- **Commands:**
  - Register them with `registerCommand` from `src/commands/registerCommand.ts`, never with `vscode.commands.registerCommand`.
  - Destructive actions (Deactivate) go in the right-click menu only, behind a modal confirmation, never as an inline hover icon.
- **Projects from `SettingsStore`** are plain JSON. Read upgrade config only through `ensureUpgradeConfigModel` (`src/models/upgrade.ts`).
- **Every `getChildren(element)`** handles `element` before it builds the root list. A provider that ignores `element` recurses on collapsible rows.
- **The worker is Linux/macOS only** (fd 3/4 pipes). On Windows the feature says so instead of spawning.
- **Lint:**
  - Rules: `curly`, `eqeqeq`, `semi`, `no-empty`.
  - Unused parameters are prefixed `_`.
  - `tsconfig` is strict, with `noUnusedLocals`/`noUnusedParameters`, target ES2022.
- **Commits:**
  - Odoo-style prefixes `[ADD]`, `[IMP]`, `[FIX]`, `[REF]`, `[DOC]`, with a body.
  - The last line is `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - Work on branch `v-1.5`.
- **Tests:**
  - Compile with `npm run compile-tests`.
  - Run outside the sandbox with `env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "<suite name>"`. A sandboxed run dies with SIGTRAP.

## Review Focus

1. **The Odoo shell dies or hangs in the middle of a request** (a crash, an OOM kill, an infinite loop in a custom module). Every pending action must fail with a readable message, and the next action must start a fresh shell. Tests: Task 4.
2. **A database is dropped, renamed or used as a `createdb -T` template while its worker holds a connection.** The worker must let go first, otherwise Postgres refuses with "database is being accessed by other users". Test: Task 5, dropping the copy with the worker open.
3. **An arch with non-ASCII text or a multi-megabyte body** must round-trip byte-exact through the pipes. Tests: Task 4 (2 MB unicode echo) and Task 5 (real save of `Prénom ✓`).
4. **The database's version is not provisioned, the database is not in the project, or the platform is Windows.** The user must see a named reason, not `spawn ENOENT`. Test: Task 5 (`viewWorkerUnavailableReason`).
5. **A view changed in Odoo's UI after it was opened, or deleted.** `stat().mtime` follows `write_date` and `size` stays constant, so VS Code's "file is newer" check fires. A deleted view is `FileNotFound`. Test: Task 7.

---

### Task 1: Worker command line, and keeping the worker out of the running-database probe

**Files:**
- Create: `src/services/views/viewWorkerArgs.ts`
- Modify: `src/debugger.ts`
  - `runDirectory` at line 87 becomes exported.
  - Extract `collectAddonsPaths` from `prepareArgs` at lines 264–413.
- Modify: `src/services/database.ts` (lines 34–39, `ACTIVE_DATABASES_QUERY`)
- Test: `src/test/viewWorkerArgs.test.ts`

**Interfaces:**
- Produces:
  - `VIEW_WORKER_APP_NAME: string`
  - `buildViewWorkerArgs(input: ViewWorkerArgsInput): string[]`
  - `viewWorkerEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv`
  - `collectAddonsPaths(project: ProjectModel, settings: SettingsModel, db: DatabaseModel, versionId: string | undefined): Promise<string[]>`, exported from `src/debugger.ts`
  - `runDirectory(workspacePath: string): string`, exported from `src/debugger.ts`
  - `ACTIVE_DATABASES_QUERY`, exported from `src/services/database.ts`

- [ ] **Step 1: Write the failing test** in `src/test/viewWorkerArgs.test.ts`

```ts
import * as assert from 'assert';
import { buildViewWorkerArgs, viewWorkerEnv, VIEW_WORKER_APP_NAME } from '../services/views/viewWorkerArgs';
import { ACTIVE_DATABASES_QUERY } from '../services/database';

suite('View worker arguments', () => {
    const base = { odooBinPath: '/odoo/odoo-bin', addonsPaths: ['/odoo/addons', '/custom'], dbName: 'shop-18' };

    test('runs a shell with no http on the database and addons path', () => {
        assert.deepStrictEqual(buildViewWorkerArgs(base), [
            '/odoo/odoo-bin', 'shell', '--no-http', '--addons-path', '/odoo/addons,/custom', '-d', 'shop-18'
        ]);
    });

    test('keeps connection parameters from extraParams', () => {
        const args = buildViewWorkerArgs({ ...base, extraParams: '--db_host=localhost, --db_user=odoo' });
        assert.deepStrictEqual(args.slice(-2), ['--db_host=localhost', '--db_user=odoo']);
    });

    test('never passes install, update, test, port or dev flags, in any spelling', () => {
        const args = buildViewWorkerArgs({
            ...base,
            extraParams: '-u,sale,--update=stock,-i base,--init=crm,--test-enable,--test-tags=/sale,'
                + '--test-file=x.py,--stop-after-init,-p,8070,--http-port=9000,--xmlrpc-port=9001,--dev=all,--log-level=warn'
        });
        const leaked = ['-u', 'sale', '--update=stock', '-i base', '--init=crm', '--test-enable', '--test-tags=/sale',
            '--test-file=x.py', '--stop-after-init', '-p', '8070', '--http-port=9000', '--xmlrpc-port=9001', '--dev=all']
            .filter(flag => args.includes(flag));
        assert.deepStrictEqual(leaked, []);
        assert.strictEqual(args[args.length - 1], '--log-level=warn');
    });

    test('names its connections for every Odoo spelling', () => {
        const env = viewWorkerEnv({ PATH: '/usr/bin' });
        assert.strictEqual(env.PATH, '/usr/bin');
        assert.strictEqual(env.PGAPPNAME, VIEW_WORKER_APP_NAME);
        assert.strictEqual(env.ODOO_PGAPPNAME, VIEW_WORKER_APP_NAME);
    });

    test('the running-database probe skips the worker', () => {
        assert.ok(ACTIVE_DATABASES_QUERY.includes(`application_name IS DISTINCT FROM '${VIEW_WORKER_APP_NAME}'`));
    });
});
```

- [ ] **Step 2: Run it and check it fails**

Run: `npm run compile-tests`
Expected: FAIL with `Cannot find module '../services/views/viewWorkerArgs'`.

- [ ] **Step 3: Create `src/services/views/viewWorkerArgs.ts`**

```ts
/**
 * The command line of the View Doctor's Odoo shell. It shares the server's
 * addons path and database but none of what makes a launch *do* something:
 * no -i/-u (a shell that installs is not a reader), no test flags, no port.
 * extraParams is filtered too, since anything can be typed there.
 */

/** application_name the worker's connections carry, so probes can skip them. */
export const VIEW_WORKER_APP_NAME = 'odoo-devtools-view-worker';

const REFUSED_FLAGS = new Set([
    '-i', '--init', '-u', '--update',
    '--test-enable', '--test-file', '--test-tags', '--stop-after-init',
    '-p', '--http-port', '--xmlrpc-port', '--dev'
]);

export interface ViewWorkerArgsInput {
    odooBinPath: string;
    addonsPaths: string[];
    dbName: string;
    /** The version's comma-separated extra parameters, as the server gets them. */
    extraParams?: string;
}

export function buildViewWorkerArgs(input: ViewWorkerArgsInput): string[] {
    const extras = (input.extraParams ?? '')
        .split(',')
        .map(part => part.trim())
        .filter(Boolean);

    const kept: string[] = [];
    for (let index = 0; index < extras.length; index++) {
        const arg = extras[index];
        const name = arg.split(/[=\s]/, 1)[0];
        if (!REFUSED_FLAGS.has(name)) {
            kept.push(arg);
            continue;
        }
        // A bare flag ("-u") took its value as the next part ("sale").
        const next = extras[index + 1];
        if (arg === name && next !== undefined && !next.startsWith('-')) {
            index++;
        }
    }

    return [
        input.odooBinPath,
        'shell',
        '--no-http',
        '--addons-path', input.addonsPaths.join(','),
        '-d', input.dbName,
        ...kept
    ];
}

/**
 * The worker's environment. Odoo 15 leaves application_name to libpq
 * (PGAPPNAME), 16-18 read ODOO_PGAPPNAME, 19 deprecates that for PGAPPNAME:
 * setting both names the connections on every version.
 */
export function viewWorkerEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...base, PGAPPNAME: VIEW_WORKER_APP_NAME, ODOO_PGAPPNAME: VIEW_WORKER_APP_NAME };
}
```

- [ ] **Step 4: Make the probe skip the worker** in `src/services/database.ts`

Replace the `ACTIVE_DATABASES_QUERY` constant (lines 34–39) with the exported version below, and add the import:

```ts
import { VIEW_WORKER_APP_NAME } from './views/viewWorkerArgs';

// The View Doctor's shell holds a connection while it is open; that is not
// a server running, so it must not light the database up as one.
export const ACTIVE_DATABASES_QUERY = `
    SELECT datname
    FROM pg_stat_activity
    WHERE datname IS NOT NULL
      AND application_name IS DISTINCT FROM '${VIEW_WORKER_APP_NAME}'
    GROUP BY datname;
`.trim();
```

- [ ] **Step 5: Extract `collectAddonsPaths` and export `runDirectory`** in `src/debugger.ts`

1. Change `function runDirectory(` (line 87) to `export function runDirectory(`.
2. Add `import type { DatabaseModel } from './models/db';` next to the other model imports, if it is not already imported.
3. Move the addons-path half of `prepareArgs` into this new exported function, placed directly above `prepareArgs`. The body is the existing code verbatim from line 270 to the end of the `subModulesPaths` block. Only the source of `db` and `versionId` changes.

```ts
/**
 * The --addons-path a version runs `db` with: core, enterprise and themes,
 * the project's repositories as this database's version sees them, the
 * included psae-internal folders and the legacy submodule paths. Shared by the
 * server launch and the View Doctor's shell, so both load the same code.
 */
export async function collectAddonsPaths(
    project: ProjectModel,
    settings: SettingsModel,
    db: DatabaseModel,
    versionId: string | undefined
): Promise<string[]> {
    const addonsPaths: string[] = [];
    const addonPathSet = new Set<string>();

    const addAddonPath = (rawPath: string | undefined) => {
        if (!rawPath) {
            return;
        }
        const normalized = normalizePath(rawPath);
        const resolved = path.resolve(normalized);
        if (addonPathSet.has(resolved)) {
            return;
        }
        addonPathSet.add(resolved);
        addonsPaths.push(normalized);
    };

    if (settings.enterprisePath) {
        addAddonPath(settings.enterprisePath);
    }
    if (settings.designThemesPath) {
        addAddonPath(settings.designThemesPath);
    }
    if (settings.odooPath) {
        addAddonPath(`${settings.odooPath}/odoo/addons`);
        addAddonPath(`${settings.odooPath}/addons`);
    }

    const projectModules = db.modules ?? [];

    // psae-internal directories: resolved through the shared service so the
    // Modules tree and the launch args always agree on what is included.
    // Resolve every project repo to the directory this version runs from, so
    // two versions on different branches never share one copy of the code.
    const resolvedRepos = await resolveReposForDatabase(project, db, {
        version: versionId ? VersionsService.getInstance().getVersion(versionId) : undefined
    });
    const discovery = collectModuleDiscovery(project, resolvedRepos);

    const containerPathMap = new Map<string, string>();
    const recordContainerPath = (rawContainerPath: string) => {
        const normalized = normalizePath(rawContainerPath);
        const resolved = path.resolve(normalized);
        if (!containerPathMap.has(resolved)) {
            containerPathMap.set(resolved, normalized);
        }
    };

    for (const moduleInfo of discovery.modules) {
        const resolvedModulePath = path.resolve(moduleInfo.path);
        const resolvedRepoPath = path.resolve(moduleInfo.repoPath);
        if (resolvedModulePath === resolvedRepoPath) {
            recordContainerPath(moduleInfo.path);
        } else {
            recordContainerPath(path.dirname(moduleInfo.path));
        }
    }
    for (const containerPath of containerPathMap.values()) {
        addAddonPath(containerPath);
    }

    const selectedModuleNames = new Set(
        projectModules
            .filter(module => module.state === 'install' || module.state === 'upgrade')
            .map(module => module.name)
    );

    let installedModuleNames: Set<string> = new Set();
    try {
        installedModuleNames = await getInstalledModuleNames(db.id);
    } catch (error) {
        logger.warn('Failed to get installed modules from database:', error);
    }

    const psaeStates = resolvePsaeDirectories({
        psaeDirectories: discovery.psaeDirectories,
        includedPsaeInternalPaths: project.includedPsaeInternalPaths,
        selectedModuleNames,
        installedModuleNames
    });
    for (const psaeState of psaeStates) {
        if (psaeState.isIncluded) {
            addAddonPath(psaeState.path);
        }
    }

    // Global submodules paths from settings (for backward compatibility)
    if (settings.subModulesPaths) {
        const normalizedSubModulePaths = settings.subModulesPaths
            .split(',')
            .map(p => p.trim())
            .filter(Boolean)
            .map(p => normalizePath(p));
        for (const subModulePath of normalizedSubModulePaths) {
            addAddonPath(subModulePath);
        }
    }

    return addonsPaths;
}
```

4. The start of `prepareArgs` then becomes the following. Delete the moved block and keep everything from `let installs = …` onwards unchanged.

```ts
async function prepareArgs(
    project: ProjectModel,
    settings: SettingsModel,
    options: { isShell?: boolean; versionId?: string } = {}
): Promise<string[]> {
    const isShell = options.isShell === true;

    const db = dbForVersion(project, options.versionId);
    if (!db) {
        throw new Error(NO_DATABASE);
    }
    const projectModules = db.modules ?? [];
    const addonsPaths = await collectAddonsPaths(project, settings, db, options.versionId);

    let installs = projectModules
    // … unchanged from here
```

If TypeScript complains that `dbForVersion`'s return type is not a `DatabaseModel`, cast at the call: `collectAddonsPaths(project, settings, db as DatabaseModel, options.versionId)`.

- [ ] **Step 6: Run the type check, lint and this suite**

Run: `npx tsc -p . --noEmit && npm run lint && npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "View worker arguments"`
Expected: no tsc or lint errors, and 5 passing.

- [ ] **Step 7: Run the whole suite to prove the extraction changed nothing**

Run: `env -u ELECTRON_RUN_AS_NODE npm test`
Expected: all suites pass, with the same count as before this task plus 5.

- [ ] **Step 8: Commit**

```bash
git add src/services/views/viewWorkerArgs.ts src/debugger.ts src/services/database.ts src/test/viewWorkerArgs.test.ts
git commit -m "[REF] Share the addons path with a shell that never installs" -m "collectAddonsPaths moves out of prepareArgs so the View Doctor's shell loads the
same code as the server. Its command line refuses -i/-u, test, port and dev
flags, extraParams included, and names its connections so the running-database
probe does not take it for a server.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: View queries over psql

**Files:**
- Create: `src/services/views/viewQueries.ts`
- Test: `src/test/viewQueries.test.ts`

**Interfaces:**
- Consumes: `runSql(dbName, sql): Promise<string>` from `src/services/postgres.ts`.
- Produces:
  - `ViewRow`
  - `ReportMessage`
  - `sqlIdList(ids: number[]): string`
  - `viewRowsSql(where: string): string`
  - `parseViewRows(output: string): ViewRow[]`
  - `parseReportMessages(output: string): ReportMessage[]`
  - `parseWriteDates(output: string): Map<number, number>`
  - `listInactiveViews(dbName): Promise<ViewRow[]>`
  - `getViewRows(dbName, ids): Promise<ViewRow[]>`
  - `getReportMessages(dbName): Promise<ReportMessage[]>`
  - `getWriteDates(dbName, ids): Promise<Map<number, number>>`

- [ ] **Step 1: Write the failing test** in `src/test/viewQueries.test.ts`

```ts
import * as assert from 'assert';
import { parseReportMessages, parseViewRows, parseWriteDates, sqlIdList, viewRowsSql } from '../services/views/viewQueries';

suite('View queries', () => {
    test('embeds only positive integer ids', () => {
        assert.strictEqual(sqlIdList([3, 17, 4096]), '3,17,4096');
        for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
            assert.throws(() => sqlIdList([bad]), /Not a view id/);
        }
    });

    test('bounds the walk to the root so a cycle cannot hang the query', () => {
        const sql = viewRowsSql('v.active = false');
        assert.ok(sql.includes('FROM ir_ui_view v WHERE v.active = false'));
        assert.ok(sql.includes('c.depth < 50'));
        assert.ok(sql.includes("ORDER BY d.module, d.name LIMIT 1"), 'the xmlid Odoo shows');
    });

    test('parses rows, defaulting what the database left null', () => {
        const rows = parseViewRows(JSON.stringify([
            { id: 12, name: 'partner.form.custom', model: 'res.partner', type: 'form', active: false,
                inherit_id: 7, xmlid: 'studio_customization.x', root_id: 7, is_report: false, write_date: 1727000000123 },
            { id: 13, name: 'report_x', model: '', type: 'qweb', active: true,
                inherit_id: null, xmlid: null, root_id: null, is_report: true, write_date: null }
        ]));
        assert.deepStrictEqual(rows[0], {
            id: 12, name: 'partner.form.custom', model: 'res.partner', type: 'form', active: false,
            inheritId: 7, xmlid: 'studio_customization.x', rootId: 7, isReport: false, writeDate: 1727000000123
        });
        assert.strictEqual(rows[1].inheritId, null);
        assert.strictEqual(rows[1].xmlid, null);
        assert.strictEqual(rows[1].rootId, 13, 'a view with no parent is its own root');
        assert.strictEqual(rows[1].writeDate, 0);
        assert.deepStrictEqual(parseViewRows(''), []);
        assert.throws(() => parseViewRows('{"id": 1}'), /Unexpected/);
    });

    test('parses report messages and write dates', () => {
        assert.deepStrictEqual(
            parseReportMessages('[{"id": 4, "date": "2026-10-01", "body": "<h3>Disabled views</h3>"}]'),
            [{ id: 4, body: '<h3>Disabled views</h3>' }]
        );
        assert.deepStrictEqual(parseReportMessages(''), []);
        assert.deepStrictEqual([...parseWriteDates('{"12": 1727000000123, "13": null}')], [[12, 1727000000123], [13, 0]]);
        assert.deepStrictEqual([...parseWriteDates('')], []);
    });
});
```

- [ ] **Step 2: Run it and check it fails**

Run: `npm run compile-tests`
Expected: FAIL with `Cannot find module '../services/views/viewQueries'`.

- [ ] **Step 3: Create `src/services/views/viewQueries.ts`**

```ts
/**
 * Read-only SQL for the View Doctor, through psql. Every query returns one
 * JSON value (json_agg / json_object_agg): view names and Discuss bodies are
 * free text with tabs and newlines, which the `|`-separated readers in
 * database.ts would split. Ported from odoo-manager's docker_manager.py
 * (list_disabled_views, _first_xmlid, the Discuss report query). Ids are
 * validated integers; nothing else is ever interpolated.
 */
import { runSql } from '../postgres';

export interface ViewRow {
    id: number;
    name: string;
    model: string;
    type: string;
    active: boolean;
    inheritId: number | null;
    /** The view's first external id, the one Odoo shows; null when it has none. */
    xmlid: string | null;
    /** The view at the top of its inherit_id chain (itself when it inherits nothing). */
    rootId: number;
    /** Whether the root is the template of an ir.actions.report. */
    isReport: boolean;
    /** write_date in epoch milliseconds; 0 when unset. */
    writeDate: number;
}

export interface ReportMessage {
    id: number;
    body: string;
}

/** Ids for embedding in SQL; throws on anything that is not a positive integer. */
export function sqlIdList(ids: number[]): string {
    for (const id of ids) {
        if (!Number.isSafeInteger(id) || id <= 0) {
            throw new Error(`Not a view id: ${id}`);
        }
    }
    return ids.join(',');
}

/**
 * The view rows matching `where`, an expression over ir_ui_view aliased `v`.
 * The root comes from a walk up inherit_id bounded at 50 steps, so a corrupt
 * cycle cannot hang the query. A root counts as a report when any of its
 * external ids is an ir.actions.report's report_name.
 */
export function viewRowsSql(where: string): string {
    return `
WITH RECURSIVE chain AS (
    SELECT v.id AS start_id, v.id AS cur_id, v.inherit_id, 0 AS depth
    FROM ir_ui_view v WHERE ${where}
    UNION ALL
    SELECT c.start_id, p.id, p.inherit_id, c.depth + 1
    FROM chain c JOIN ir_ui_view p ON p.id = c.inherit_id
    WHERE c.depth < 50
), roots AS (
    SELECT DISTINCT ON (start_id) start_id, cur_id AS root_id
    FROM chain ORDER BY start_id, depth DESC
)
SELECT coalesce(json_agg(json_build_object(
    'id', v.id,
    'name', coalesce(v.name, v.type),
    'model', coalesce(v.model, ''),
    'type', v.type,
    'active', v.active,
    'inherit_id', v.inherit_id,
    'xmlid', (SELECT d.module || '.' || d.name FROM ir_model_data d
              WHERE d.model = 'ir.ui.view' AND d.res_id = v.id
              ORDER BY d.module, d.name LIMIT 1),
    'root_id', r.root_id,
    'is_report', EXISTS (
        SELECT 1 FROM ir_model_data rd
        JOIN ir_act_report_xml a ON a.report_name = rd.module || '.' || rd.name
        WHERE rd.model = 'ir.ui.view' AND rd.res_id = r.root_id),
    'write_date', floor(extract(epoch FROM v.write_date) * 1000)
) ORDER BY v.model, v.id), '[]'::json)
FROM ir_ui_view v JOIN roots r ON r.start_id = v.id;`.trim();
}

const REPORT_MESSAGES_SQL = `
SELECT coalesce(json_agg(json_build_object('id', id, 'date', create_date, 'body', body) ORDER BY id), '[]'::json)
FROM mail_message
WHERE model IN ('discuss.channel', 'mail.channel') AND body LIKE '%Disabled views%';`.trim();

function parseJson(output: string, fallback: string): unknown {
    return JSON.parse(output.trim() || fallback);
}

export function parseViewRows(output: string): ViewRow[] {
    const raw = parseJson(output, '[]');
    if (!Array.isArray(raw)) {
        throw new Error('Unexpected output from the view query.');
    }
    return raw.map(entry => {
        const row = entry as Record<string, unknown>;
        const id = Number(row.id);
        return {
            id,
            name: String(row.name ?? ''),
            model: String(row.model ?? ''),
            type: String(row.type ?? ''),
            active: row.active === true,
            inheritId: typeof row.inherit_id === 'number' ? row.inherit_id : null,
            xmlid: typeof row.xmlid === 'string' ? row.xmlid : null,
            rootId: typeof row.root_id === 'number' ? row.root_id : id,
            isReport: row.is_report === true,
            writeDate: typeof row.write_date === 'number' ? row.write_date : 0
        };
    });
}

export function parseReportMessages(output: string): ReportMessage[] {
    const raw = parseJson(output, '[]');
    if (!Array.isArray(raw)) {
        throw new Error('Unexpected output from the report query.');
    }
    return raw.map(entry => {
        const message = entry as Record<string, unknown>;
        return { id: Number(message.id), body: String(message.body ?? '') };
    });
}

export function parseWriteDates(output: string): Map<number, number> {
    const raw = parseJson(output, '{}') as Record<string, unknown>;
    return new Map(Object.entries(raw).map(([id, ms]) => [Number(id), typeof ms === 'number' ? ms : 0]));
}

/** Every view that is off right now, whatever turned it off. */
export async function listInactiveViews(dbName: string): Promise<ViewRow[]> {
    return parseViewRows(await runSql(dbName, viewRowsSql('v.active = false')));
}

/** The rows for these ids; an id with no view is absent. */
export async function getViewRows(dbName: string, ids: number[]): Promise<ViewRow[]> {
    if (ids.length === 0) {
        return [];
    }
    return parseViewRows(await runSql(dbName, viewRowsSql(`v.id IN (${sqlIdList(ids)})`)));
}

/** upgrade-util's post-upgrade report messages; none on a database without Discuss. */
export async function getReportMessages(dbName: string): Promise<ReportMessage[]> {
    const hasTable = await runSql(dbName, "SELECT to_regclass('mail_message') IS NOT NULL;");
    if (hasTable !== 't') {
        return [];
    }
    return parseReportMessages(await runSql(dbName, REPORT_MESSAGES_SQL));
}

/** write_date of each view in epoch ms; an id with no view is absent. */
export async function getWriteDates(dbName: string, ids: number[]): Promise<Map<number, number>> {
    if (ids.length === 0) {
        return new Map();
    }
    const sql = 'SELECT coalesce(json_object_agg(id, floor(extract(epoch FROM write_date) * 1000)), \'{}\'::json) '
        + `FROM ir_ui_view WHERE id IN (${sqlIdList(ids)});`;
    return parseWriteDates(await runSql(dbName, sql));
}
```

- [ ] **Step 4: Run it and check it passes**

Run: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "View queries"`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/services/views/viewQueries.ts src/test/viewQueries.test.ts
git commit -m "[ADD] Read a database's inactive views and upgrade reports over psql" -m "One JSON value per query, so free-text names and Discuss bodies survive; ids are
the only thing interpolated and are validated. Each row carries its root and
whether that root is a report template, worked out in SQL rather than a shell.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: What the upgrade disabled, and the tree's groups

**Files:**
- Create: `src/services/views/disabledReport.ts`
- Create: `src/services/views/viewGroups.ts`
- Test: `src/test/disabledReport.test.ts`
- Test: `src/test/viewGroups.test.ts`

**Interfaces:**
- Consumes: `ViewRow` (Task 2).
- Produces:
  - `DisabledReport { odooVersion?: string; viewIds: number[] }`
  - `decodeEntities(text: string): string`
  - `viewIdFromHref(href: string | null | undefined): number | undefined`
  - `parseDisabledViews(body: string | null | undefined): DisabledReport`
  - `mergeReports(reports: DisabledReport[]): Map<number, string[]>`
  - `UpgradeDisabledView = ViewRow & { versions: string[] }`
  - `ViewGroups { upgradeDisabled: UpgradeDisabledView[]; upgradeVersions: string[]; otherInactive: ViewRow[]; missingIds: number[] }`
  - `groupViews(inactive: ViewRow[], reported: Map<number, string[]>, reportedRows: ViewRow[]): ViewGroups`

- [ ] **Step 1: Write the failing report test** in `src/test/disabledReport.test.ts`

The fixtures are odoo-manager's (`tests/test_migration_report.py`). They have the exact shapes upgrade-util renders.

```ts
import * as assert from 'assert';
import { mergeReports, parseDisabledViews, viewIdFromHref } from '../services/views/disabledReport';

const OLD_STYLE = `
<h2> Congratulations, you have just upgraded to Odoo 17.0 </h2>
<p>Want to know more? Check out the <a href="https://www.odoo.com/odoo-17-release-notes">release note</a>.</p>
<h3>Fields renamed</h3>
<ul><li><details><summary>Models <kbd>a.b</kbd>: renamed.</summary><ul>
<li><a target="_blank" href="/web?debug=1#view_type=form&amp;model=ir.actions.server&amp;action=&amp;id=885">Some server action</a></li>
</ul></details></li></ul>
<h3>Disabled views</h3>
<ul><li><details><summary>The below custom views have been disabled during the migration because they were no longer valid.</summary>
<ul>
<li><a target="_blank" href="/web?debug=1#view_type=form&amp;model=ir.ui.view&amp;action=29&amp;id=1818">Odoo Studio: account.move.form customization</a></li>
<li><a target="_blank" href="/web?debug=1#view_type=form&amp;model=ir.ui.view&amp;action=29&amp;id=1788">report_invoice_with_payments</a></li>
</ul></details></li></ul>
<h3>Overridden views</h3>
<ul><li><details><summary>The below standard views have been overridden.</summary><ul>
<li>hr.some_view <a target="_blank" href="/web?debug=1#view_type=form&amp;model=ir.ui.view&amp;action=29&amp;id=4174">Original</a>
<a target="_blank" href="/web?debug=1#view_type=form&amp;model=ir.ui.view&amp;action=29&amp;id=4223">Copy</a></li>
</ul></details></li></ul>
`;

const NEW_STYLE = `
<h2> Congratulations, you have just upgraded to Odoo 18.0 </h2>
<h3>Disabled views</h3>
<ul><li><details><summary>The below custom views have been disabled during the migration because they were no longer valid.</summary>
<ul>
<li><a target="_blank" href="/odoo/action-29/1830?debug=1">Odoo Studio: res.partner.form customization</a></li>
<li><a target="_blank" href="/odoo/action-29/1863?debug=1">approval.request.view.form</a></li>
</ul></details></li></ul>
<h3>Overridden views</h3>
<ul><li>hr.some_view <a href="/odoo/action-29/4174?debug=1">Original</a> <a href="/odoo/action-29/4223?debug=1">Copy</a></li></ul>
`;

const PRE_2024_LAYOUT = `
<h2> Upgrade report: 16 </h2>
<h3>Fields renamed</h3>
<ul><li>something <a href="web?debug=1#view_type=form&amp;model=ir.actions.server&amp;action=&amp;id=885">action</a></li></ul>
<h3>Disabled views</h3>
<ul>
<div>The below custom views have been disabled during the migration because they were no longer valid.
<li><a href="web?debug=1#view_type=form&amp;model=ir.ui.view&amp;action=29&amp;id=812" target="_blank">sale.order.form.custom</a></li>
<li><a href="web?debug=1#view_type=form&amp;model=ir.ui.view&amp;action=29&amp;id=815" target="_blank">Odoo Studio: res.partner.form customization</a></li>
</div>
</ul>
<h3>Overridden views</h3>
<ul><div>The below standard views have been overriden.
<li>sale.view_order_form <a href="web?debug=1#view_type=form&amp;model=ir.ui.view&amp;action=29&amp;id=901">Original</a>
<a href="web?debug=1#view_type=form&amp;model=ir.ui.view&amp;action=29&amp;id=902">Copy</a></li></div></ul>
`;

suite('Upgrade report: disabled views', () => {
    test('reads the view id from both anchor shapes', () => {
        const cases: Array<[string | null | undefined, number | undefined]> = [
            ['/web?debug=1#view_type=form&model=ir.ui.view&action=29&id=1818', 1818],
            ['/web?debug=1#view_type=form&model=ir.ui.view&action=&id=7', 7],
            ['/odoo/action-29/1830?debug=1', 1830],
            ['/odoo/ir.ui.view/1830?debug=1', 1830],
            ['/odoo/action-29/1830', 1830],
            ['web?debug=1#view_type=form&model=ir.ui.view&action=29&id=812', 812],
            ['/odoo/action-29/new?debug=1', undefined],
            ['https://www.odoo.com/odoo-17-release-notes', undefined],
            ['', undefined],
            [null, undefined],
            [undefined, undefined]
        ];
        for (const [href, expected] of cases) {
            assert.strictEqual(viewIdFromHref(href), expected, String(href));
        }
    });

    test('parses the hash style used up to 17.0, ignoring the other sections', () => {
        assert.deepStrictEqual(parseDisabledViews(OLD_STYLE), { odooVersion: '17.0', viewIds: [1818, 1788] });
    });

    test('parses the path style used from saas~17.2', () => {
        assert.deepStrictEqual(parseDisabledViews(NEW_STYLE), { odooVersion: '18.0', viewIds: [1830, 1863] });
    });

    test('parses the layout from before 2024, which names no version', () => {
        assert.deepStrictEqual(parseDisabledViews(PRE_2024_LAYOUT), { viewIds: [812, 815] });
    });

    test('a message that only mentions the phrase is not a report', () => {
        assert.deepStrictEqual(parseDisabledViews('<p>Disabled views are listed in the report.</p>'), { viewIds: [] });
        assert.deepStrictEqual(parseDisabledViews(''), { viewIds: [] });
        assert.deepStrictEqual(parseDisabledViews(undefined), { viewIds: [] });
    });

    test('lists each view once, with every upgrade that disabled it', () => {
        const merged = mergeReports([
            { odooVersion: '17.0', viewIds: [1818, 1788] },
            { odooVersion: '18.0', viewIds: [1818, 1830] },
            { viewIds: [1830] }
        ]);
        assert.deepStrictEqual([...merged], [[1818, ['17.0', '18.0']], [1788, ['17.0']], [1830, ['18.0']]]);
    });
});
```

- [ ] **Step 2: Write the failing groups test** in `src/test/viewGroups.test.ts`

```ts
import * as assert from 'assert';
import { groupViews } from '../services/views/viewGroups';
import type { ViewRow } from '../services/views/viewQueries';

function row(id: number, overrides: Partial<ViewRow> = {}): ViewRow {
    return {
        id, name: `view ${id}`, model: 'res.partner', type: 'form', active: false,
        inheritId: 1, xmlid: null, rootId: 1, isReport: false, writeDate: 0, ...overrides
    };
}

suite('View Doctor groups', () => {
    test('puts what the upgrade disabled first: still off, then re-enabled', () => {
        const inactive = [row(10), row(11), row(20)];
        const reported = new Map([[11, ['17.0']], [12, ['17.0', '18.0']], [10, ['18.0']]]);
        const groups = groupViews(inactive, reported, [row(12, { active: true })]);

        assert.deepStrictEqual(groups.upgradeDisabled.map(view => [view.id, view.active, view.versions]), [
            [10, false, ['18.0']],
            [11, false, ['17.0']],
            [12, true, ['17.0', '18.0']]
        ]);
        assert.deepStrictEqual(groups.upgradeVersions, ['17.0', '18.0']);
        assert.deepStrictEqual(groups.otherInactive.map(view => view.id), [20]);
        assert.deepStrictEqual(groups.missingIds, []);
    });

    test('keeps report fragments the upgrade broke, but hides them among the other inactive views', () => {
        const fragment = row(30, { type: 'qweb', isReport: false });
        const report = row(31, { type: 'qweb', isReport: true });
        const brokenFragment = row(32, { type: 'qweb', isReport: false });
        const groups = groupViews([fragment, report, brokenFragment], new Map([[32, ['18.0']]]), []);

        assert.deepStrictEqual(groups.upgradeDisabled.map(view => view.id), [32]);
        assert.deepStrictEqual(groups.otherInactive.map(view => view.id), [31]);
    });

    test('reports listed views that no longer exist', () => {
        const groups = groupViews([], new Map([[40, ['17.0']]]), []);
        assert.deepStrictEqual(groups.upgradeDisabled, []);
        assert.deepStrictEqual(groups.missingIds, [40]);
    });
});
```

- [ ] **Step 3: Run both and check they fail**

Run: `npm run compile-tests`
Expected: FAIL with `Cannot find module '../services/views/disabledReport'` and `'../services/views/viewGroups'`.

- [ ] **Step 4: Create `src/services/views/disabledReport.ts`**

```ts
/**
 * The "Disabled views" list of upgrade-util's post-upgrade report, which it
 * posts to Discuss: the only record of which views an upgrade turned off - a
 * view that is inactive now may have been inactive all along. Port of
 * odoo-manager's migration_report.py, without an HTML parser: the report is
 * generated markup, and only headings and anchors matter.
 */

const SECTION_TITLE = 'Disabled views';
const VERSION_RE = /upgraded to Odoo\s+(\S+)/;
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
const HEADING_RE = /^h[1-6]$/;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

export interface DisabledReport {
    odooVersion?: string;
    viewIds: number[];
}

export function decodeEntities(text: string): string {
    return text
        .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)))
        .replace(/&quot;/g, '"')
        .replace(/&(?:#39|apos);/g, '\'')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
}

/**
 * The record id an upgrade-util anchor points at. It switched shapes at
 * saas~17.2:
 *   /web?debug=1#view_type=form&model=ir.ui.view&action=29&id=1818   id in the hash
 *   /odoo/action-29/1830?debug=1                                     id is the last path segment
 */
export function viewIdFromHref(href: string | null | undefined): number | undefined {
    if (!href) {
        return undefined;
    }
    const hashAt = href.indexOf('#');
    const fragment = hashAt >= 0 ? href.slice(hashAt + 1) : '';
    const beforeHash = hashAt >= 0 ? href.slice(0, hashAt) : href;
    const queryAt = beforeHash.indexOf('?');
    const query = queryAt >= 0 ? beforeHash.slice(queryAt + 1) : '';
    const pathPart = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;

    for (const part of [fragment, query]) {
        const id = new URLSearchParams(part).get('id');
        if (id && /^\d+$/.test(id)) {
            return Number(id);
        }
    }
    const last = pathPart.replace(/\/+$/, '').split('/').pop() ?? '';
    return /^\d+$/.test(last) ? Number(last) : undefined;
}

/**
 * The view ids under the report's "Disabled views" heading, in order, each
 * once. Anchors elsewhere in the message (server actions, "Overridden views")
 * are not views the upgrade disabled. Any heading ends the section.
 */
export function parseDisabledViews(body: string | null | undefined): DisabledReport {
    const result: DisabledReport = { viewIds: [] };
    if (!body || !body.trim()) {
        return result;
    }

    const seen = new Set<number>();
    let heading: { tag: string; textStart: number } | undefined;
    let inSection = false;

    for (const match of body.matchAll(TAG_RE)) {
        const [whole, closing, rawTag, attributes] = match;
        const tag = rawTag.toLowerCase();
        const at = match.index ?? 0;

        if (HEADING_RE.test(tag)) {
            if (!closing) {
                inSection = false;
                heading = { tag, textStart: at + whole.length };
            } else if (heading && heading.tag === tag) {
                const text = decodeEntities(body.slice(heading.textStart, at).replace(/<[^>]*>/g, ''))
                    .replace(/\s+/g, ' ')
                    .trim();
                if (tag === 'h2' && result.odooVersion === undefined) {
                    const version = VERSION_RE.exec(text);
                    if (version) {
                        result.odooVersion = version[1];
                    }
                }
                inSection = text === SECTION_TITLE;
                heading = undefined;
            }
            continue;
        }

        if (inSection && !closing && tag === 'a') {
            const href = HREF_RE.exec(attributes);
            const id = viewIdFromHref(decodeEntities(href?.[1] ?? href?.[2] ?? href?.[3] ?? ''));
            if (id !== undefined && !seen.has(id)) {
                seen.add(id);
                result.viewIds.push(id);
            }
        }
    }
    return result;
}

/** Every listed view, with the versions whose upgrade disabled it, in report order. */
export function mergeReports(reports: DisabledReport[]): Map<number, string[]> {
    const merged = new Map<number, string[]>();
    for (const report of reports) {
        for (const id of report.viewIds) {
            const versions = merged.get(id) ?? [];
            if (report.odooVersion && !versions.includes(report.odooVersion)) {
                versions.push(report.odooVersion);
            }
            merged.set(id, versions);
        }
    }
    return merged;
}
```

- [ ] **Step 5: Create `src/services/views/viewGroups.ts`**

```ts
/**
 * How the View Doctor sorts a database's views: what an upgrade disabled
 * first, since those are the ones to fix, then every other inactive view.
 */
import type { ViewRow } from './viewQueries';

export type UpgradeDisabledView = ViewRow & { versions: string[] };

export interface ViewGroups {
    /** Listed by an upgrade report: still off first, then re-enabled. */
    upgradeDisabled: UpgradeDisabledView[];
    /** Every version whose upgrade report listed a view, in first-seen order. */
    upgradeVersions: string[];
    /**
     * Inactive views no report lists. A qweb view shows only when it is a
     * report's template: inactive website and report *fragments* are inactive
     * by design and would bury the rest.
     */
    otherInactive: ViewRow[];
    /** Listed by a report, but no longer in the database. */
    missingIds: number[];
}

export function groupViews(inactive: ViewRow[], reported: Map<number, string[]>, reportedRows: ViewRow[]): ViewGroups {
    const byId = new Map<number, ViewRow>();
    for (const view of [...inactive, ...reportedRows]) {
        byId.set(view.id, view);
    }

    const upgradeDisabled: UpgradeDisabledView[] = [];
    const missingIds: number[] = [];
    const upgradeVersions: string[] = [];
    for (const [id, versions] of reported) {
        for (const version of versions) {
            if (!upgradeVersions.includes(version)) {
                upgradeVersions.push(version);
            }
        }
        const view = byId.get(id);
        if (view) {
            upgradeDisabled.push({ ...view, versions });
        } else {
            missingIds.push(id);
        }
    }
    upgradeDisabled.sort((a, b) =>
        Number(a.active) - Number(b.active) || a.model.localeCompare(b.model) || a.id - b.id);
    upgradeVersions.sort();

    const otherInactive = inactive.filter(view =>
        !reported.has(view.id) && (view.type !== 'qweb' || view.isReport));

    return { upgradeDisabled, upgradeVersions, otherInactive, missingIds };
}
```

- [ ] **Step 6: Run both suites and check they pass**

Run: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Upgrade report: disabled views|View Doctor groups"`
Expected: 9 passing.

- [ ] **Step 7: Commit**

```bash
git add src/services/views/disabledReport.ts src/services/views/viewGroups.ts src/test/disabledReport.test.ts src/test/viewGroups.test.ts
git commit -m "[ADD] Tell the views an upgrade disabled from the ones that were always off" -m "upgrade-util's Discuss report is the only record of what an upgrade turned off;
its 'Disabled views' section is read in both anchor shapes and both layouts.
Those views come first, still-off before re-enabled, and the other inactive
views follow without the qweb fragments that are inactive by design.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The Odoo shell worker and its pool

**Files:**
- Create: `resources/scripts/view_worker.py`
- Create: `src/services/views/viewWorker.ts`
- Create: `src/services/views/viewWorkerPool.ts`
- Modify: `src/services/postgres.ts`
  - Add the release hook.
  - Call it from `createDatabase` (with a template), `dropDatabase` and `renameDatabase`.
- Create: `src/test/helpers/fakeViewWorker.ts`
- Test: `src/test/viewWorker.test.ts`
- Test: `src/test/viewWorkerPool.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. This is the protocol layer only.
- Produces:
  - `WorkerSpawnSpec { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; bootstrap: string }`
  - `ViewWorkerOptions { startTimeoutMs?: number; requestTimeoutMs?: number }`
  - `ViewWorkerError extends Error { trace?: string }`
  - `workerBootstrap(scriptPath: string): string`
  - `PooledWorker { start(): Promise<unknown>; request<T>(cmd: string, args?: Record<string, unknown>): Promise<T>; dispose(): Promise<void>; onDidExit: vscode.Event<void> }`
  - `class ViewWorker implements PooledWorker, with isAlive: boolean`
  - `class ViewWorkerPool(factory: (dbName: string) => Promise<PooledWorker>, options?: { idleMs?: number; onStarting?: (dbName: string, ready: Promise<unknown>) => void })`, with:
    - `run<T>(dbName, cmd, args?): Promise<T>`
    - `release(dbName): Promise<void>`
    - `has(dbName): boolean`
    - `dispose(): void`
  - In `postgres.ts`:
    - `onBeforeDatabaseRelease(listener: (dbName: string) => Promise<void>): { dispose(): void }`
    - `releaseDatabase(dbName: string): Promise<void>`
  - **Worker commands** (Python side; Task 5 wraps them). Each reply's `result`:

    | Command | Arguments | Reply `result` |
    |---|---|---|
    | `get_arch` | `{view_id}` | `{arch: string, active: boolean}` |
    | `save` | `{view_id, arch, activate: boolean}` | `{active: boolean, activated: boolean, activationError: string \| null}` |
    | `activate` | `{view_id}` | `{active: true}` |
    | `deactivate` | `{view_id}` | `{active: false}` |

- [ ] **Step 1: Write the fake shell** in `src/test/helpers/fakeViewWorker.ts`

```ts
/**
 * A stand-in for `odoo-bin shell` running view_worker.py, for the worker
 * client's tests. Like the real shell it reads stdin to EOF before doing
 * anything; then it speaks the worker protocol: requests on fd 3, replies on
 * fd 4, log noise on stdout. Spawned, never run as a test.
 *
 * argv: <mode> - 'ok', 'never-ready' or 'crash'
 */
import * as net from 'node:net';

const mode = process.argv[2] ?? 'ok';
let bootstrap = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => {
    bootstrap += chunk;
});
process.stdin.on('end', () => {
    if (mode === 'crash') {
        process.stderr.write('Traceback (most recent call last):\nKeyError: odoo.addons.missing_module\n');
        process.exit(1);
    }

    const requests = new net.Socket({ fd: 3, readable: true, writable: false });
    const replies = new net.Socket({ fd: 4, readable: false, writable: true });
    const reply = (payload: unknown) => replies.write(JSON.stringify(payload) + '\n');

    process.stdout.write('2026-10-02 INFO odoo: a log line that is not a reply\n');
    if (mode !== 'never-ready') {
        reply({ id: 0, ok: true, result: { series: '17.0', bootstrap } });
    }

    let buffer = '';
    requests.setEncoding('utf-8');
    requests.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
            const request = JSON.parse(line) as { id: number; cmd: string; args: Record<string, unknown> };
            switch (request.cmd) {
                case 'echo':
                    reply({ id: request.id, ok: true, result: request.args });
                    break;
                case 'fail':
                    reply({ id: request.id, ok: false, error: 'boom', trace: 'Traceback: boom' });
                    break;
                case 'hang':
                    break;
                case 'die':
                    process.exit(3);
                    break;
                default:
                    reply({ id: request.id, ok: false, error: `unknown command ${request.cmd}` });
            }
        }
    });
    requests.on('end', () => process.exit(0));
});
```

- [ ] **Step 2: Write the failing worker test** in `src/test/viewWorker.test.ts`

```ts
import * as assert from 'assert';
import * as path from 'node:path';
import { ViewWorker, ViewWorkerError, workerBootstrap, type WorkerSpawnSpec } from '../services/views/viewWorker';

function fakeSpec(mode: string): WorkerSpawnSpec {
    return {
        command: process.execPath,
        args: [path.join(__dirname, 'helpers', 'fakeViewWorker.js'), mode],
        // The Extension Host's execPath is Electron; this makes it plain Node.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        bootstrap: workerBootstrap('/tmp/view_worker.py')
    };
}

suite('View worker', function () {
    this.timeout(20000);

    test('pipes the bootstrap to stdin and waits for the ready reply', async () => {
        const worker = new ViewWorker(fakeSpec('ok'));
        try {
            const ready = await worker.start() as { series: string; bootstrap: string };
            assert.strictEqual(ready.series, '17.0');
            assert.ok(ready.bootstrap.includes('exec(compile(open("/tmp/view_worker.py"'));
            assert.strictEqual(worker.isAlive, true);
        } finally {
            await worker.dispose();
        }
    });

    test('round-trips a 2 MB non-ASCII arch byte for byte', async () => {
        const worker = new ViewWorker(fakeSpec('ok'));
        try {
            const arch = '<form string="Prénom ✓ 日本">' + 'x'.repeat(2 * 1024 * 1024) + '<![CDATA[a\nb]]></form>';
            const result = await worker.request<{ arch: string }>('echo', { arch });
            assert.strictEqual(result.arch, arch);
        } finally {
            await worker.dispose();
        }
    });

    test('an error reply rejects with the message and keeps the worker', async () => {
        const worker = new ViewWorker(fakeSpec('ok'));
        try {
            await assert.rejects(worker.request('fail'), (error: unknown) =>
                error instanceof ViewWorkerError && error.message === 'boom' && error.trace === 'Traceback: boom');
            assert.deepStrictEqual(await worker.request('echo', { a: 1 }), { a: 1 });
        } finally {
            await worker.dispose();
        }
    });

    test('a shell that dies mid-request fails it and says it stopped', async () => {
        const worker = new ViewWorker(fakeSpec('ok'));
        await worker.start();
        let exited = false;
        worker.onDidExit(() => (exited = true));
        await assert.rejects(worker.request('die'), /stopped \(exit code 3\)/);
        assert.strictEqual(exited, true);
        assert.strictEqual(worker.isAlive, false);
        await assert.rejects(worker.request('echo'), /not running/);
    });

    test('a shell that crashes on start shows the end of its traceback', async () => {
        const worker = new ViewWorker(fakeSpec('crash'));
        await assert.rejects(worker.start(), /KeyError: odoo\.addons\.missing_module/);
    });

    test('a shell that never gets ready times out and is killed', async () => {
        const worker = new ViewWorker(fakeSpec('never-ready'), { startTimeoutMs: 500 });
        await assert.rejects(worker.start(), /did not start within/);
        // The kill is asynchronous: wait for the exit before asserting it.
        await new Promise(resolve => setTimeout(resolve, 1000));
        assert.strictEqual(worker.isAlive, false);
    });

    test('a request with no answer times out and the shell is replaced, not reused', async () => {
        const worker = new ViewWorker(fakeSpec('ok'), { requestTimeoutMs: 300 });
        await worker.start();
        await assert.rejects(worker.request('hang'), /did not answer "hang"/);
        await new Promise(resolve => setTimeout(resolve, 3500));
        assert.strictEqual(worker.isAlive, false);
    });

    test('a missing python is a named error, not a hang', async () => {
        const worker = new ViewWorker({ ...fakeSpec('ok'), command: '/nonexistent/python3' }, { startTimeoutMs: 5000 });
        await assert.rejects(worker.start(), /Could not start \/nonexistent\/python3/);
    });

    test('the bootstrap quotes any path as a Python literal', () => {
        assert.strictEqual(
            workerBootstrap('/a b/it\'s "x".py'),
            'exec(compile(open("/a b/it\'s \\"x\\".py", encoding=\'utf-8\').read(), "/a b/it\'s \\"x\\".py", \'exec\'))\n'
        );
    });
});
```

- [ ] **Step 3: Write the failing pool test** in `src/test/viewWorkerPool.test.ts`

```ts
import * as assert from 'assert';
import * as vscode from 'vscode';
import { ViewWorkerPool } from '../services/views/viewWorkerPool';
import type { PooledWorker } from '../services/views/viewWorker';
import { onBeforeDatabaseRelease, releaseDatabase } from '../services/postgres';

class FakeWorker implements PooledWorker {
    started = 0;
    disposed = 0;
    readonly exit = new vscode.EventEmitter<void>();
    readonly onDidExit = this.exit.event;
    // A function, not a promise: a rejection made before start() is called
    // would be reported as unhandled.
    constructor(readonly db: string, private readonly startResult: () => Promise<unknown> = async () => ({ series: '17.0' })) {}
    start(): Promise<unknown> {
        this.started++;
        return this.startResult();
    }
    async request<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
        return { db: this.db, cmd, args } as T;
    }
    async dispose(): Promise<void> {
        this.disposed++;
        this.exit.fire();
    }
}

suite('View worker pool', () => {
    test('one worker per database, reused', async () => {
        const created: FakeWorker[] = [];
        const pool = new ViewWorkerPool(async db => {
            const worker = new FakeWorker(db);
            created.push(worker);
            return worker;
        });
        await pool.run('a', 'echo');
        await pool.run('a', 'echo');
        assert.deepStrictEqual(await pool.run('b', 'get_arch', { view_id: 3 }), { db: 'b', cmd: 'get_arch', args: { view_id: 3 } });
        assert.deepStrictEqual(created.map(worker => worker.db), ['a', 'b']);
        pool.dispose();
    });

    test('a worker that exited is replaced on the next run', async () => {
        const created: FakeWorker[] = [];
        const pool = new ViewWorkerPool(async db => {
            const worker = new FakeWorker(db);
            created.push(worker);
            return worker;
        });
        await pool.run('a', 'echo');
        created[0].exit.fire();
        assert.strictEqual(pool.has('a'), false);
        await pool.run('a', 'echo');
        assert.strictEqual(created.length, 2);
        pool.dispose();
    });

    test('a failed start is forgotten, so the next run tries again', async () => {
        let attempt = 0;
        const pool = new ViewWorkerPool(async db => {
            attempt++;
            return new FakeWorker(db, attempt === 1 ? async () => { throw new Error('no python'); } : undefined);
        });
        await assert.rejects(pool.run('a', 'echo'), /no python/);
        await pool.run('a', 'echo');
        assert.strictEqual(attempt, 2);
        pool.dispose();
    });

    test('release disposes even a worker that is still starting', async () => {
        const worker = new FakeWorker('a', () => new Promise(() => undefined));
        const pool = new ViewWorkerPool(async () => worker);
        void pool.run('a', 'echo').catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 10));
        await pool.release('a');
        assert.strictEqual(worker.disposed, 1);
        assert.strictEqual(pool.has('a'), false);
    });

    test('an idle worker is released', async () => {
        const worker = new FakeWorker('a');
        const pool = new ViewWorkerPool(async () => worker, { idleMs: 50 });
        await pool.run('a', 'echo');
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.strictEqual(worker.disposed, 1);
        pool.dispose();
    });

    test('announces each start once', async () => {
        const announced: string[] = [];
        const pool = new ViewWorkerPool(async db => new FakeWorker(db), { onStarting: db => announced.push(db) });
        await pool.run('a', 'echo');
        await pool.run('a', 'echo');
        assert.deepStrictEqual(announced, ['a']);
        pool.dispose();
    });

    test('database release listeners run before Postgres is asked, and their failures do not block it', async () => {
        const released: string[] = [];
        const first = onBeforeDatabaseRelease(async db => {
            released.push(db);
        });
        const failing = onBeforeDatabaseRelease(async () => {
            throw new Error('ignored');
        });
        await releaseDatabase('shop');
        first.dispose();
        failing.dispose();
        await releaseDatabase('other');
        assert.deepStrictEqual(released, ['shop']);
    });
});
```

- [ ] **Step 4: Run both and check they fail**

Run: `npm run compile-tests`
Expected: FAIL with `Cannot find module '../services/views/viewWorker'`, `'../services/views/viewWorkerPool'`, and no exported member `onBeforeDatabaseRelease`.

- [ ] **Step 5: Create `src/services/views/viewWorker.ts`**

```ts
/**
 * One long-lived `odoo-bin shell` on one database, running view_worker.py.
 *
 * The shell exec()s all of stdin once it reaches EOF, so stdin carries only
 * a one-line bootstrap and is then closed. Requests go out on fd 3 and replies
 * come back on fd 4, one JSON object per line. That also keeps Odoo's logging
 * on stdout/stderr out of the replies; its last lines are kept, to explain a
 * shell that dies.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import * as vscode from 'vscode';

export interface WorkerSpawnSpec {
    command: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Python piped to the shell's stdin, which the shell exec()s whole. */
    bootstrap: string;
}

export interface ViewWorkerOptions {
    /** The first start loads the whole registry: minutes on a large database. */
    startTimeoutMs?: number;
    requestTimeoutMs?: number;
}

/** What a pool needs from a worker; ViewWorker is the real one. */
export interface PooledWorker {
    start(): Promise<unknown>;
    request<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
    dispose(): Promise<void>;
    readonly onDidExit: vscode.Event<void>;
}

export class ViewWorkerError extends Error {
    constructor(message: string, readonly trace?: string) {
        super(message);
        this.name = 'ViewWorkerError';
    }
}

/** A JSON string literal is a valid Python string literal, whatever the path holds. */
export function workerBootstrap(scriptPath: string): string {
    const literal = JSON.stringify(scriptPath);
    return `exec(compile(open(${literal}, encoding='utf-8').read(), ${literal}, 'exec'))\n`;
}

interface Pending {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
}

interface Reply {
    id?: number;
    ok?: boolean;
    result?: unknown;
    error?: string;
    trace?: string;
}

const TAIL_LINES = 30;
const DEFAULT_START_TIMEOUT_MS = 180_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const KILL_AFTER_MS = 3000;

export class ViewWorker implements PooledWorker {
    private child: ChildProcess | undefined;
    private requests: Writable | undefined;
    private readonly pending = new Map<number, Pending>();
    private nextId = 1;
    private ready: Promise<unknown> | undefined;
    private exited = false;
    private readonly tail: string[] = [];
    private readonly exitEmitter = new vscode.EventEmitter<void>();
    readonly onDidExit = this.exitEmitter.event;

    constructor(private readonly spec: WorkerSpawnSpec, private readonly options: ViewWorkerOptions = {}) {}

    get isAlive(): boolean {
        return !!this.child && !this.exited;
    }

    start(): Promise<unknown> {
        if (!this.ready) {
            this.ready = this.spawn();
        }
        return this.ready;
    }

    async request<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
        await this.start();
        const requests = this.requests;
        if (!this.isAlive || !requests) {
            throw new ViewWorkerError('The Odoo shell is not running.');
        }
        const id = this.nextId++;
        const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, {
                resolve: value => resolve(value as T),
                reject,
                timer: setTimeout(() => {
                    this.pending.delete(id);
                    reject(new ViewWorkerError(`The Odoo shell did not answer "${cmd}" within ${Math.round(timeoutMs / 1000)} s.`));
                    // It answers in order: one stuck request blocks every later one.
                    void this.dispose();
                }, timeoutMs)
            });
            requests.write(JSON.stringify({ id, cmd, args }) + '\n');
        });
    }

    /** EOF on the request pipe lets Python finish cleanly; a kill follows if it does not. */
    dispose(): Promise<void> {
        const child = this.child;
        if (!child || this.exited) {
            return Promise.resolve();
        }
        return new Promise<void>(resolve => {
            const killer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS);
            child.once('exit', () => {
                clearTimeout(killer);
                resolve();
            });
            this.requests?.end();
        });
    }

    private spawn(): Promise<unknown> {
        return new Promise<unknown>((resolve, reject) => {
            const startTimeoutMs = this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
            this.pending.set(0, {
                resolve,
                reject,
                timer: setTimeout(() => {
                    this.failAll(new ViewWorkerError(
                        `The Odoo shell did not start within ${Math.round(startTimeoutMs / 1000)} s.${this.tailText()}`));
                    this.child?.kill('SIGKILL');
                }, startTimeoutMs)
            });

            const child = spawn(this.spec.command, this.spec.args, {
                cwd: this.spec.cwd,
                env: this.spec.env,
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe']
            });
            this.child = child;
            // Null when the spawn itself failed; 'error' below reports that.
            this.requests = (child.stdio[3] ?? undefined) as Writable | undefined;
            const replies = (child.stdio[4] ?? undefined) as Readable | undefined;

            const remember = (chunk: Buffer) => {
                this.tail.push(...chunk.toString('utf-8').split('\n').filter(line => line.trim()));
                if (this.tail.length > TAIL_LINES) {
                    this.tail.splice(0, this.tail.length - TAIL_LINES);
                }
            };
            child.stdout?.on('data', remember);
            child.stderr?.on('data', remember);

            let buffer = '';
            replies?.setEncoding('utf-8');
            replies?.on('data', (chunk: string) => {
                buffer += chunk;
                let newline = buffer.indexOf('\n');
                while (newline >= 0) {
                    const line = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    newline = buffer.indexOf('\n');
                    this.handleReply(line);
                }
            });

            child.on('error', error => {
                this.exited = true;
                this.failAll(new ViewWorkerError(`Could not start ${this.spec.command}: ${error.message}`));
            });
            child.on('exit', code => {
                this.exited = true;
                const status = code === null ? '' : ` (exit code ${code})`;
                this.failAll(new ViewWorkerError(`The Odoo shell stopped${status}.${this.tailText()}`));
                this.exitEmitter.fire();
            });
            // A failed write after an early exit is reported by 'exit'; do not crash on EPIPE.
            child.stdin?.on('error', () => undefined);
            this.requests?.on('error', () => undefined);
            child.stdin?.end(this.spec.bootstrap);
        });
    }

    private handleReply(line: string): void {
        let reply: Reply;
        try {
            reply = JSON.parse(line) as Reply;
        } catch {
            return;
        }
        if (typeof reply.id !== 'number') {
            return;
        }
        const pending = this.pending.get(reply.id);
        if (!pending) {
            return;
        }
        this.pending.delete(reply.id);
        clearTimeout(pending.timer);
        if (reply.ok) {
            pending.resolve(reply.result);
        } else {
            pending.reject(new ViewWorkerError(reply.error || 'The Odoo shell reported an error.', reply.trace));
        }
    }

    private failAll(error: ViewWorkerError): void {
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            this.pending.delete(id);
            pending.reject(error);
        }
    }

    private tailText(): string {
        return this.tail.length > 0 ? `\n${this.tail.slice(-8).join('\n')}` : '';
    }
}
```

- [ ] **Step 6: Create `src/services/views/viewWorkerPool.ts`**

```ts
/**
 * At most one Odoo shell per database, started on first use and stopped
 * after ten idle minutes, on release (before the database is dropped, renamed
 * or copied) and with the extension.
 */
import type * as vscode from 'vscode';
import type { PooledWorker } from './viewWorker';

export type WorkerFactory = (dbName: string) => Promise<PooledWorker>;

export interface ViewWorkerPoolOptions {
    idleMs?: number;
    /** Called once per spawn, with the start in flight: progress UI hooks in here. */
    onStarting?: (dbName: string, ready: Promise<unknown>) => void;
}

interface Entry {
    created: Promise<PooledWorker>;
    ready: Promise<PooledWorker>;
    worker?: PooledWorker;
    idle?: NodeJS.Timeout;
}

const DEFAULT_IDLE_MS = 10 * 60_000;

export class ViewWorkerPool implements vscode.Disposable {
    private readonly entries = new Map<string, Entry>();

    constructor(private readonly factory: WorkerFactory, private readonly options: ViewWorkerPoolOptions = {}) {}

    has(dbName: string): boolean {
        return this.entries.has(dbName);
    }

    /** Runs one command on the database's shell, starting it on first use. */
    async run<T>(dbName: string, cmd: string, args: Record<string, unknown> = {}): Promise<T> {
        const worker = await this.workerFor(dbName);
        this.touch(dbName);
        try {
            return await worker.request<T>(cmd, args);
        } finally {
            this.touch(dbName);
        }
    }

    /** Stops the database's shell now, even mid-start, and waits for it to exit. */
    async release(dbName: string): Promise<void> {
        const entry = this.entries.get(dbName);
        if (!entry) {
            return;
        }
        this.forget(dbName, entry);
        const worker = entry.worker ?? await entry.created.catch(() => undefined);
        await worker?.dispose();
    }

    dispose(): void {
        for (const dbName of [...this.entries.keys()]) {
            void this.release(dbName);
        }
    }

    private workerFor(dbName: string): Promise<PooledWorker> {
        const existing = this.entries.get(dbName);
        if (existing) {
            return existing.ready;
        }
        const entry = {} as Entry;
        entry.created = this.factory(dbName).then(worker => {
            entry.worker = worker;
            worker.onDidExit(() => this.forget(dbName, entry));
            return worker;
        });
        entry.ready = entry.created.then(async worker => {
            const started = worker.start();
            this.options.onStarting?.(dbName, started);
            await started;
            return worker;
        });
        entry.ready.catch(() => this.forget(dbName, entry));
        this.entries.set(dbName, entry);
        return entry.ready;
    }

    private touch(dbName: string): void {
        const entry = this.entries.get(dbName);
        if (!entry) {
            return;
        }
        if (entry.idle) {
            clearTimeout(entry.idle);
        }
        entry.idle = setTimeout(() => void this.release(dbName), this.options.idleMs ?? DEFAULT_IDLE_MS);
        entry.idle.unref?.();
    }

    private forget(dbName: string, entry: Entry): void {
        if (entry.idle) {
            clearTimeout(entry.idle);
        }
        if (this.entries.get(dbName) === entry) {
            this.entries.delete(dbName);
        }
    }
}
```

- [ ] **Step 7: Add the release hook** to `src/services/postgres.ts`

Add this below `quotePgIdentifier`:

```ts
type DatabaseReleaseListener = (dbName: string) => Promise<void>;
const releaseListeners = new Set<DatabaseReleaseListener>();

/**
 * Registers something that holds connections to databases (the View
 * Doctor's shells). Postgres refuses to drop, rename or copy a database that
 * has other sessions, so each listener lets go of `dbName` first.
 */
export function onBeforeDatabaseRelease(listener: DatabaseReleaseListener): { dispose(): void } {
    releaseListeners.add(listener);
    return { dispose: () => releaseListeners.delete(listener) };
}

/** Asks every listener to let go of `dbName`; a failing listener never blocks the caller. */
export async function releaseDatabase(dbName: string): Promise<void> {
    await Promise.all([...releaseListeners].map(listener =>
        listener(dbName).catch(error => logger.warn(`Could not release ${dbName}:`, error))));
}
```

Then make the three helpers call it before running Postgres:

```ts
export async function createDatabase(dbName: string, templateDbName?: string): Promise<void> {
    if (templateDbName) {
        await releaseDatabase(templateDbName);
    }
    const args = templateDbName ? ['-T', templateDbName, dbName] : [dbName];
    await runCommand('createdb', args);
    clearInstalledModuleCache(dbName);
}

export async function dropDatabase(dbName: string, options: { ifExists?: boolean } = {}): Promise<void> {
    await releaseDatabase(dbName);
    const args = options.ifExists ? ['--if-exists', dbName] : [dbName];
    await runCommand('dropdb', args);
    clearInstalledModuleCache(dbName);
}

export async function renameDatabase(oldName: string, newName: string): Promise<void> {
    await releaseDatabase(oldName);
    const sql = `ALTER DATABASE ${quotePgIdentifier(oldName)} RENAME TO ${quotePgIdentifier(newName)};`;
    await runCommand('psql', ['-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
    clearInstalledModuleCache(oldName);
    clearInstalledModuleCache(newName);
}
```

Also check whether `dumpImport.ts` drops databases with its own `dropdb`/`psql` command rather than through these helpers:

```bash
grep -n "dropdb\|DROP DATABASE\|createdb" src/services/*.ts | grep -v postgres.ts
```

For every hit, add `await releaseDatabase(<that db>)` immediately before it, importing from `./postgres`.

- [ ] **Step 8: Create `resources/scripts/view_worker.py`**

```python
# Odoo DevTools - View Doctor worker.
#
# Loaded inside `odoo-bin shell` by the one-line bootstrap the extension pipes
# to stdin (the shell exec()s all of stdin at EOF, so requests cannot come that
# way). Requests arrive on fd 3 and replies leave on fd 4, one JSON object per
# line: {"id": n, "cmd": "...", "args": {...}} -> {"id": n, "ok": true,
# "result": ...} or {"id": n, "ok": false, "error": "...", "trace": "..."}.
# Runs on Odoo 15 to 19: every API that moved is looked up, not assumed.
import json
import os
import traceback

import odoo

ENV = env  # noqa: F821 - provided by `odoo-bin shell`


class Refused(Exception):
    """An error whose message is already what the user should read."""


def _invalidate(env):
    if hasattr(env, 'invalidate_all'):
        env.invalidate_all()
    else:
        env.cache.invalidate()


def _fresh(env):
    # A new transaction per request: Odoo cursors are REPEATABLE READ, so the
    # worker would otherwise keep seeing the database as it was at startup
    # rather than what the running server has written since.
    env.cr.rollback()
    _invalidate(env)


def _flush(env):
    if hasattr(env, 'flush_all'):
        env.flush_all()
    else:
        env['base'].flush()


def _signal(env):
    # A running server only drops its view caches when told through the
    # registry sequences; the shell has no request lifecycle doing it.
    registry = env.registry
    if hasattr(registry, 'signal_changes'):
        registry.signal_changes()


def _view(env, view_id):
    view = env['ir.ui.view'].browse(int(view_id)).exists()
    if not view:
        raise Refused('View %s no longer exists.' % view_id)
    return view


def _root(view):
    root = view
    seen = set()
    while root.inherit_id and root.id not in seen:
        seen.add(root.id)
        root = root.inherit_id
    return root


def _compose(env, view):
    """Composes the view's root the way opening it does, raising when the
    combined arch is broken. A saved arch is not checked against its parent's
    current structure until then."""
    root = _root(view)
    if root.type == 'qweb' or not root.model or root.model not in env:
        if hasattr(root, '_get_combined_arch'):
            root._get_combined_arch()
        else:
            root.read_combined(['arch'])
        return
    target = env[root.model]
    if hasattr(target, 'get_view'):
        target.get_view(view_id=root.id, view_type=root.type)
    else:
        target.fields_view_get(view_id=root.id, view_type=root.type)


def _message(error):
    text = str(error).strip()
    if isinstance(error, (Refused, odoo.exceptions.UserError)) and text:
        return text
    return '%s: %s' % (type(error).__name__, text) if text else type(error).__name__


def cmd_get_arch(env, view_id):
    view = _view(env, view_id)
    return {'arch': view.arch or '', 'active': view.active}


def cmd_save(env, view_id, arch, activate=True):
    """Writes the arch; when the view is off, also tries to turn it on. A
    failed activation keeps the new arch - fixing it takes several saves -
    and reports why the view stays off."""
    view = _view(env, view_id)
    view.write({'arch': arch})
    _flush(env)
    activated = False
    activation_error = None
    if activate and not view.active:
        try:
            with env.cr.savepoint():
                view.write({'active': True})
                _flush(env)
                _compose(env, view)
            activated = True
        except Exception as error:  # noqa: BLE001 - reported to the user
            activation_error = _message(error)
            _invalidate(env)
    env.cr.commit()
    _signal(env)
    return {'active': bool(view.active), 'activated': activated, 'activationError': activation_error}


def cmd_activate(env, view_id):
    view = _view(env, view_id)
    view.write({'active': True})
    _flush(env)
    _compose(env, view)
    env.cr.commit()
    _signal(env)
    return {'active': True}


def cmd_deactivate(env, view_id):
    view = _view(env, view_id)
    view.write({'active': False})
    _flush(env)
    env.cr.commit()
    _signal(env)
    return {'active': False}


COMMANDS = {
    'get_arch': cmd_get_arch,
    'save': cmd_save,
    'activate': cmd_activate,
    'deactivate': cmd_deactivate,
}


def main(env):
    requests = os.fdopen(3, 'r', encoding='utf-8')
    replies = os.fdopen(4, 'w', encoding='utf-8')

    def reply(payload):
        replies.write(json.dumps(payload) + '\n')
        replies.flush()

    reply({'id': 0, 'ok': True, 'result': {'series': odoo.release.serie}})
    for line in requests:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get('id')
            handler = COMMANDS.get(request.get('cmd'))
            if handler is None:
                raise Refused('Unknown command: %s' % request.get('cmd'))
            _fresh(env)
            result = handler(env, **(request.get('args') or {}))
            reply({'id': request_id, 'ok': True, 'result': result})
        except Exception as error:  # noqa: BLE001 - every failure is a reply
            try:
                env.cr.rollback()
            except Exception:  # noqa: BLE001
                pass
            reply({'id': request_id, 'ok': False, 'error': _message(error), 'trace': traceback.format_exc()[-4000:]})


main(ENV)
```

- [ ] **Step 9: Run both suites and check they pass**

Run: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "View worker|View worker pool"`
Expected: 16 passing. The "replaced, not reused" test takes about 4 s.

- [ ] **Step 10: Commit**

```bash
git add resources/scripts/view_worker.py src/services/views/viewWorker.ts src/services/views/viewWorkerPool.ts src/services/postgres.ts src/services/dumpImport.ts src/test/helpers/fakeViewWorker.ts src/test/viewWorker.test.ts src/test/viewWorkerPool.test.ts
git commit -m "[ADD] Keep one Odoo shell per database for reading and writing views" -m "The shell exec()s all of stdin, so it gets a one-line bootstrap and then talks
JSON lines on fd 3 and 4, away from Odoo's logging. Each request starts a fresh
transaction, writes signal the running server's caches, and activation composes
the root and rolls back when it fails. A shell that dies, hangs or never starts
fails its requests with its last log lines and is replaced on the next one;
databases are released before they are dropped, renamed or copied.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

(Drop `src/services/dumpImport.ts` from the `git add` if Step 7's grep found nothing to change there.)

---

### Task 5: ViewService, worker launch, and a real-Odoo integration test

**Files:**
- Create: `src/services/views/viewWorkerSpec.ts`
- Create: `src/services/views/viewService.ts`
- Test: `src/test/viewWorkerSpec.test.ts`
- Test: `src/test/viewWorker.integration.test.ts`

**Interfaces:**
- Consumes:
  - `collectAddonsPaths`, `runDirectory` (Task 1)
  - `buildViewWorkerArgs`, `viewWorkerEnv` (Task 1)
  - `listInactiveViews`, `getViewRows`, `getReportMessages`, `getWriteDates`, `ViewRow` (Task 2)
  - `parseDisabledViews`, `mergeReports`, `groupViews`, `ViewGroups` (Task 3)
  - `ViewWorker`, `ViewWorkerPool`, `workerBootstrap`, `WorkerSpawnSpec` (Task 4)
- Produces:
  - `viewWorkerUnavailableReason(input: { dbName: string; inProject: boolean; versionName?: string; provisioned: boolean; platform: NodeJS.Platform }): string | undefined`
  - `resolveViewWorkerSpec(dbName: string, scriptPath: string): Promise<WorkerSpawnSpec>`, which throws `Error(reason)`
  - `SaveResult { active: boolean; activated: boolean; activationError: string | null }`
  - `ViewBackend { writeDate(dbName, viewId): Promise<number | undefined>; getArch(dbName, viewId): Promise<string>; save(dbName, viewId, arch): Promise<SaveResult> }`
  - `class ViewService implements ViewBackend`, with:
    - `constructor(pool: ViewWorkerPool)`
    - `activate(dbName, viewId): Promise<void>`
    - `deactivate(dbName, viewId): Promise<void>`
    - `rows(dbName, ids): Promise<ViewRow[]>`
    - `doctorGroups(dbName): Promise<ViewGroups>`

- [ ] **Step 1: Write the failing test** in `src/test/viewWorkerSpec.test.ts`

```ts
import * as assert from 'assert';
import { viewWorkerUnavailableReason } from '../services/views/viewWorkerSpec';

suite('View worker availability', () => {
    const ok = { dbName: 'shop-18', inProject: true, versionName: '18.0', provisioned: true, platform: 'linux' as NodeJS.Platform };

    test('runs on a provisioned version of a project database', () => {
        assert.strictEqual(viewWorkerUnavailableReason(ok), undefined);
        assert.strictEqual(viewWorkerUnavailableReason({ ...ok, platform: 'darwin' }), undefined);
    });

    test('names the reason instead of failing to spawn', () => {
        assert.match(viewWorkerUnavailableReason({ ...ok, inProject: false }) ?? '', /"shop-18" is not a database of the selected project/);
        assert.match(viewWorkerUnavailableReason({ ...ok, versionName: undefined }) ?? '', /"shop-18" has no version/);
        assert.match(viewWorkerUnavailableReason({ ...ok, provisioned: false }) ?? '', /"18.0" has no environment to run/);
        assert.match(viewWorkerUnavailableReason({ ...ok, platform: 'win32' }) ?? '', /Linux or macOS/);
    });
});
```

- [ ] **Step 2: Run it and check it fails**

Run: `npm run compile-tests`
Expected: FAIL with `Cannot find module '../services/views/viewWorkerSpec'`.

- [ ] **Step 3: Create `src/services/views/viewWorkerSpec.ts`**

```ts
/**
 * How the View Doctor's shell is launched for a database: that database's
 * own version - its python, odoo-bin, addons path and extraParams - so a 17.0
 * database is read by 17.0 code even while 19.0 is the active version.
 */
import { SettingsStore } from '../../settingsStore';
import { SettingsModel } from '../../models/settings';
import type { DatabaseModel } from '../../models/db';
import { collectAddonsPaths, runDirectory } from '../../debugger';
import { getWorkspacePath, normalizePath, resolveOptionalPath } from '../../utils';
import { isVersionProvisioned } from '../provisioning';
import { versionOfDatabase } from '../versionRepos';
import { buildViewWorkerArgs, viewWorkerEnv } from './viewWorkerArgs';
import { workerBootstrap, type WorkerSpawnSpec } from './viewWorker';

export interface WorkerAvailabilityInput {
    dbName: string;
    inProject: boolean;
    versionName?: string;
    provisioned: boolean;
    platform: NodeJS.Platform;
}

/** Why no shell can be started for this database, or undefined when one can. */
export function viewWorkerUnavailableReason(input: WorkerAvailabilityInput): string | undefined {
    if (input.platform === 'win32') {
        return 'The View Doctor needs Linux or macOS: it talks to the Odoo shell over extra pipes Windows does not pass on.';
    }
    if (!input.inProject) {
        return `"${input.dbName}" is not a database of the selected project.`;
    }
    if (!input.versionName) {
        return `"${input.dbName}" has no version to run its code.`;
    }
    if (!input.provisioned) {
        return `"${input.versionName}" has no environment to run.`;
    }
    return undefined;
}

export async function resolveViewWorkerSpec(dbName: string, scriptPath: string): Promise<WorkerSpawnSpec> {
    const result = await SettingsStore.peekSelectedProject();
    const db = (result?.project.dbs as DatabaseModel[] | undefined)?.find(entry => entry.id === dbName);
    const version = db ? versionOfDatabase(db) : undefined;
    const settings = version ? new SettingsModel(version.settings) : undefined;

    const reason = viewWorkerUnavailableReason({
        dbName,
        inProject: !!db,
        versionName: version?.name,
        provisioned: !!settings && isVersionProvisioned(resolveOptionalPath(settings.pythonPath)),
        platform: process.platform
    });
    if (reason || !result || !db || !version || !settings) {
        throw new Error(reason ?? `Cannot start an Odoo shell for "${dbName}".`);
    }

    const addonsPaths = await collectAddonsPaths(result.project, settings, db, version.id);
    const workspacePath = getWorkspacePath();
    return {
        command: normalizePath(settings.pythonPath),
        args: buildViewWorkerArgs({
            odooBinPath: `${normalizePath(settings.odooPath)}/odoo-bin`,
            addonsPaths,
            dbName,
            extraParams: settings.extraParams
        }),
        cwd: workspacePath ? runDirectory(workspacePath) : undefined,
        env: viewWorkerEnv(process.env),
        bootstrap: workerBootstrap(scriptPath)
    };
}
```

- [ ] **Step 4: Create `src/services/views/viewService.ts`**

```ts
/**
 * Everything the View Doctor's UI asks of a database: listings over psql,
 * arches and writes through the database's Odoo shell.
 */
import type { ViewWorkerPool } from './viewWorkerPool';
import { getReportMessages, getViewRows, getWriteDates, listInactiveViews, type ViewRow } from './viewQueries';
import { mergeReports, parseDisabledViews } from './disabledReport';
import { groupViews, type ViewGroups } from './viewGroups';

export interface SaveResult {
    active: boolean;
    /** The save turned the view on. */
    activated: boolean;
    /** The view was off and stays off: Odoo's reason. The arch is saved regardless. */
    activationError: string | null;
}

/** What the arch file system needs; ViewService is the real one. */
export interface ViewBackend {
    /** write_date in epoch ms, or undefined when the view is gone. */
    writeDate(dbName: string, viewId: number): Promise<number | undefined>;
    getArch(dbName: string, viewId: number): Promise<string>;
    save(dbName: string, viewId: number, arch: string): Promise<SaveResult>;
}

export class ViewService implements ViewBackend {
    constructor(private readonly pool: ViewWorkerPool) {}

    async writeDate(dbName: string, viewId: number): Promise<number | undefined> {
        return (await getWriteDates(dbName, [viewId])).get(viewId);
    }

    async getArch(dbName: string, viewId: number): Promise<string> {
        return (await this.pool.run<{ arch: string }>(dbName, 'get_arch', { view_id: viewId })).arch;
    }

    save(dbName: string, viewId: number, arch: string): Promise<SaveResult> {
        return this.pool.run<SaveResult>(dbName, 'save', { view_id: viewId, arch, activate: true });
    }

    async activate(dbName: string, viewId: number): Promise<void> {
        await this.pool.run(dbName, 'activate', { view_id: viewId });
    }

    async deactivate(dbName: string, viewId: number): Promise<void> {
        await this.pool.run(dbName, 'deactivate', { view_id: viewId });
    }

    rows(dbName: string, ids: number[]): Promise<ViewRow[]> {
        return getViewRows(dbName, ids);
    }

    /** The tree's content: psql only, so it shows without waiting for a shell. */
    async doctorGroups(dbName: string): Promise<ViewGroups> {
        const [inactive, messages] = await Promise.all([listInactiveViews(dbName), getReportMessages(dbName)]);
        const reported = mergeReports(messages.map(message => parseDisabledViews(message.body)));
        const inactiveIds = new Set(inactive.map(view => view.id));
        const reEnabled = await getViewRows(dbName, [...reported.keys()].filter(id => !inactiveIds.has(id)));
        return groupViews(inactive, reported, reEnabled);
    }
}
```

- [ ] **Step 5: Write the gated integration test** in `src/test/viewWorker.integration.test.ts`

It runs only when three environment variables point at a real Odoo checkout, its python, and a database with `base` installed. It works on a copy of that database, so the database itself is never modified.

```ts
/**
 * The View Doctor's shell against a real Odoo. Skipped unless
 * ODT_VIEW_TEST_PYTHON, ODT_VIEW_TEST_ODOO (an odoo checkout) and
 * ODT_VIEW_TEST_DB (a database with base installed, for that checkout's
 * version) are set. Works on a copy of ODT_VIEW_TEST_DB, dropped afterwards.
 */
import * as assert from 'assert';
import * as path from 'node:path';
import { runCommand } from '../services/process';
import { createDatabase, dropDatabaseIfExists, onBeforeDatabaseRelease, runSql } from '../services/postgres';
import { getActiveDatabaseNames } from '../services/database';
import { invalidateActiveDatabasesCache } from '../services/runtimeCache';
import { buildViewWorkerArgs, viewWorkerEnv } from '../services/views/viewWorkerArgs';
import { ViewWorker, workerBootstrap } from '../services/views/viewWorker';
import { ViewWorkerPool } from '../services/views/viewWorkerPool';
import { ViewService } from '../services/views/viewService';

const python = process.env.ODT_VIEW_TEST_PYTHON;
const odoo = process.env.ODT_VIEW_TEST_ODOO;
const sourceDb = process.env.ODT_VIEW_TEST_DB;
const enabled = !!(python && odoo && sourceDb) && process.platform !== 'win32';

const SETUP = `
broken = '<data><xpath expr="//field[@name=\\'odt_does_not_exist\\']" position="after"><field name="ref"/></xpath></data>'
parent = env.ref('base.view_partner_form')
view = env['ir.ui.view'].create({
    'name': 'odt.view.doctor.test', 'type': 'form', 'model': 'res.partner', 'inherit_id': parent.id,
    'mode': 'extension', 'active': False,
    'arch': '<data><xpath expr="//field[@name=\\'name\\']" position="after"><field name="ref"/></xpath></data>',
})
if env['ir.ui.view']._fields['arch_db'].column_type[0] == 'jsonb':
    env.cr.execute("UPDATE ir_ui_view SET arch_db = jsonb_build_object('en_US', %s::text) WHERE id = %s", [broken, view.id])
else:
    env.cr.execute("UPDATE ir_ui_view SET arch_db = %s WHERE id = %s", [broken, view.id])
env.cr.commit()
print('ODT_VIEW_ID:%d' % view.id)
`;

const FIXED = '<data><xpath expr="//field[@name=\'name\']" position="after"><field name="ref" string="Prénom ✓"/></xpath></data>';

(enabled ? suite : suite.skip)('View worker against a real Odoo', function () {
    this.timeout(600000);
    const copy = `${sourceDb}_odt_view_test`;
    const addonsPaths = [`${odoo}/odoo/addons`, `${odoo}/addons`];
    const scriptPath = path.resolve(__dirname, '..', '..', 'resources', 'scripts', 'view_worker.py');
    let viewId = 0;
    let pool: ViewWorkerPool;
    let service: ViewService;
    let release: { dispose(): void };

    suiteSetup(async () => {
        await dropDatabaseIfExists(copy);
        await createDatabase(copy, sourceDb);
        const { stdout } = await runCommand(python!, [`${odoo}/odoo-bin`, 'shell', '--no-http', '--addons-path', addonsPaths.join(','), '-d', copy], { input: SETUP });
        viewId = Number(/ODT_VIEW_ID:(\d+)/.exec(stdout)?.[1]);
        assert.ok(viewId > 0, `setup printed no view id:\n${stdout}`);

        pool = new ViewWorkerPool(async dbName => new ViewWorker({
            command: python!,
            args: buildViewWorkerArgs({ odooBinPath: `${odoo}/odoo-bin`, addonsPaths, dbName }),
            env: viewWorkerEnv(process.env),
            bootstrap: workerBootstrap(scriptPath)
        }));
        service = new ViewService(pool);
        release = onBeforeDatabaseRelease(dbName => pool.release(dbName));
    });

    suiteTeardown(async () => {
        // No explicit pool.release: the drop itself must make the worker let go.
        await dropDatabaseIfExists(copy);
        release?.dispose();
        pool?.dispose();
    });

    test('reads the arch through the ORM, whatever the column type', async () => {
        assert.ok((await service.getArch(copy, viewId)).includes('odt_does_not_exist'));
    });

    test('its connection does not make the database look like a running server', async () => {
        invalidateActiveDatabasesCache();
        assert.ok(!(await getActiveDatabaseNames()).includes(copy));
    });

    test('lists the broken view among the inactive ones', async () => {
        const groups = await service.doctorGroups(copy);
        assert.ok(groups.otherInactive.some(view => view.id === viewId && view.rootId !== viewId));
    });

    test('activation that cannot compose is rolled back and says why', async () => {
        await assert.rejects(service.activate(copy, viewId), /odt_does_not_exist|cannot be located/);
        assert.strictEqual(await runSql(copy, `SELECT active FROM ir_ui_view WHERE id = ${viewId};`), 'f');
    });

    test('an arch Odoo rejects is not saved', async () => {
        await assert.rejects(service.save(copy, viewId, '<data><xpath expr="//field[@name=\'name\']"'));
        assert.ok((await service.getArch(copy, viewId)).includes('odt_does_not_exist'));
    });

    test('a fixed arch saves, turns the view on, and keeps its non-ASCII text', async () => {
        const before = await service.writeDate(copy, viewId);
        const result = await service.save(copy, viewId, FIXED);
        assert.deepStrictEqual(result, { active: true, activated: true, activationError: null });
        assert.strictEqual(await runSql(copy, `SELECT active FROM ir_ui_view WHERE id = ${viewId};`), 't');
        assert.ok((await service.getArch(copy, viewId)).includes('Prénom ✓'));
        assert.notStrictEqual(await service.writeDate(copy, viewId), before);
    });

    test('deactivate turns it back off', async () => {
        await service.deactivate(copy, viewId);
        assert.strictEqual(await runSql(copy, `SELECT active FROM ir_ui_view WHERE id = ${viewId};`), 'f');
    });
});
```

- [ ] **Step 6: Run the unit suite and check it passes**

Run: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "View worker availability"`
Expected: 2 passing.

- [ ] **Step 7: Build fresh test databases and run the integration test on three versions**

This covers three cases: Odoo 15 (text arch, `fields_view_get`, libpq `PGAPPNAME`), Odoo 17 (jsonb, `get_view`, `ODOO_PGAPPNAME`), and Odoo 19 (`PGAPPNAME` again).

```bash
for v in 15.0 17.0 19.0; do
  /home/odoo/odoo-dev/venv-$v/bin/python /home/odoo/odoo-dev/odoo-$v/odoo-bin \
    --addons-path=/home/odoo/odoo-dev/odoo-$v/odoo/addons,/home/odoo/odoo-dev/odoo-$v/addons \
    -d odt_view_base_${v%%.*} -i base --stop-after-init --without-demo=all
done
for v in 15.0 17.0 19.0; do
  ODT_VIEW_TEST_PYTHON=/home/odoo/odoo-dev/venv-$v/bin/python \
  ODT_VIEW_TEST_ODOO=/home/odoo/odoo-dev/odoo-$v \
  ODT_VIEW_TEST_DB=odt_view_base_${v%%.*} \
  env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "View worker against a real Odoo" || break
done
```

Expected: 7 passing for each version, with no `${db}_odt_view_test` database left afterwards (`psql -l | grep odt_view_test` prints nothing).

If a version fails, fix `view_worker.py` (the API lookups are the likely place) and re-run that version. Keep the `odt_view_base_*` databases; Task 8 reuses them.

- [ ] **Step 8: Commit**

```bash
git add src/services/views/viewWorkerSpec.ts src/services/views/viewService.ts src/test/viewWorkerSpec.test.ts src/test/viewWorker.integration.test.ts
git commit -m "[ADD] Launch each database's view shell with its own version's code" -m "The shell runs the database's version - python, odoo-bin, addons path - not
the active one, and says why when it cannot: another project's database, no
version, nothing provisioned, Windows. ViewService puts psql listings and shell
writes behind one interface. The integration test runs against a copy of a
real database on 15.0, 17.0 and 19.0.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The Views tree

**Files:**
- Create: `src/views/viewDoctorView.ts`
- Modify: `src/extension.ts`
  - Build the pool, the service and the provider.
  - Register the tree and the release hook.
- Modify: `src/commands/index.ts` (`Providers.views` and `CommandDeps.viewService`)
- Modify: `package.json`
  - The `viewDoctor` view.
  - `viewsWelcome`.
  - The refresh command and title menu.
  - `activationEvents`.
- Test: `src/test/viewDoctorView.test.ts`

**Interfaces:**
- Consumes:
  - `ViewService.doctorGroups`, `ViewGroups`, `UpgradeDisabledView`, `ViewRow` (Tasks 3, 5)
  - `ensureUpgradeConfigModel` (`src/models/upgrade.ts`)
- Produces:
  - `ViewDoctorTarget { dbName: string; side?: 'to' }`
  - `resolveViewDoctorTarget(project: { dbs?: Array<{ id: string; isSelected?: boolean }>; upgradeConfig?: unknown } | undefined): ViewDoctorTarget | undefined`
  - `class ViewItem extends vscode.TreeItem`, with `readonly dbName: string; readonly view: ViewRow`
  - `class ViewGroupItem extends vscode.TreeItem`, with `readonly children: vscode.TreeItem[]`
  - `buildDoctorRows(dbName: string, groups: ViewGroups): vscode.TreeItem[]`
  - `class ViewDoctorTreeProvider extends BaseTreeProvider<vscode.TreeItem>`, with `constructor(service: Pick<ViewService, 'doctorGroups'>, describe?: (text: string | undefined) => void)`
  - In `CommandDeps`: `viewService: ViewService`. In `Providers`: `views: ViewDoctorTreeProvider`.
  - Command ids: `viewDoctor.refresh`, plus `viewDoctor.openArch`, which the row click uses and Task 7 registers.

- [ ] **Step 1: Write the failing test** in `src/test/viewDoctorView.test.ts`

```ts
import * as assert from 'assert';
import * as vscode from 'vscode';
import { ViewDoctorTreeProvider, ViewGroupItem, ViewItem, buildDoctorRows, resolveViewDoctorTarget } from '../views/viewDoctorView';
import type { ViewGroups } from '../services/views/viewGroups';
import type { ViewRow } from '../services/views/viewQueries';

function row(id: number, overrides: Partial<ViewRow> = {}): ViewRow {
    return {
        id, name: `view ${id}`, model: 'res.partner', type: 'form', active: false,
        inheritId: 1, xmlid: null, rootId: 1, isReport: false, writeDate: 0, ...overrides
    };
}

const groups: ViewGroups = {
    upgradeDisabled: [
        { ...row(10, { xmlid: 'studio_customization.odoo_studio_partner' }), versions: ['18.0'] },
        { ...row(12, { active: true }), versions: ['17.0', '18.0'] }
    ],
    upgradeVersions: ['17.0', '18.0'],
    otherInactive: [row(20, { inheritId: null, rootId: 20 })],
    missingIds: [99]
};

suite('Views tree', () => {
    test('shows the upgrade side of an active upgrade, else the selected database', () => {
        const dbs = [{ id: 'shop-17', isSelected: true }, { id: 'shop-18' }];
        assert.deepStrictEqual(resolveViewDoctorTarget({ dbs }), { dbName: 'shop-17' });
        assert.deepStrictEqual(resolveViewDoctorTarget({
            dbs,
            upgradeConfig: { isEnabled: true, from: { dbId: 'shop-17', series: '17.0' }, to: { dbId: 'shop-18', series: '18.0' } }
        }), { dbName: 'shop-18', side: 'to' });
        assert.strictEqual(resolveViewDoctorTarget({ dbs: [{ id: 'x' }] }), undefined);
        assert.strictEqual(resolveViewDoctorTarget(undefined), undefined);
    });

    test('groups what the upgrade disabled ahead of the rest', () => {
        const rows = buildDoctorRows('shop-18', groups);
        assert.deepStrictEqual(rows.map(item => item.label), ['Disabled by upgrade', 'Other inactive views']);
        const [upgrade, other] = rows as ViewGroupItem[];
        assert.strictEqual(upgrade.description, '1 off · 1 re-enabled · 17.0, 18.0');
        assert.strictEqual(upgrade.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
        assert.strictEqual(other.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
        assert.deepStrictEqual(upgrade.children.map(item => item.label), ['view 10', 'view 12', '1 listed view no longer exists']);
    });

    test('rows say what they are and open their arch', () => {
        const [upgrade, other] = buildDoctorRows('shop-18', groups) as ViewGroupItem[];
        const off = upgrade.children[0] as ViewItem;
        assert.strictEqual(off.description, 'res.partner · studio_customization.odoo_studio_partner');
        assert.strictEqual(off.contextValue, 'odooView.inactive.hasParent');
        assert.strictEqual(off.command?.command, 'viewDoctor.openArch');
        assert.strictEqual(off.command?.arguments?.[0], off);
        assert.strictEqual((upgrade.children[1] as ViewItem).contextValue, 'odooView.active.hasParent');
        assert.strictEqual((other.children[0] as ViewItem).contextValue, 'odooView.inactive.root');
        assert.strictEqual((other.children[0] as ViewItem).description, 'res.partner · #20');
        assert.notStrictEqual(off.id, (upgrade.children[1] as ViewItem).id);
    });

    test('a database with nothing off says so', () => {
        const rows = buildDoctorRows('shop-18', { upgradeDisabled: [], upgradeVersions: [], otherInactive: [], missingIds: [] });
        assert.deepStrictEqual(rows.map(item => item.label), ['No views are turned off in shop-18.']);
    });

    test('children follow the element asked about, so rows never recurse', async () => {
        const provider = new ViewDoctorTreeProvider({ doctorGroups: async () => groups });
        const [upgrade] = buildDoctorRows('shop-18', groups) as ViewGroupItem[];
        assert.strictEqual(await provider.getChildren(upgrade), upgrade.children);
        assert.deepStrictEqual(await provider.getChildren(upgrade.children[0]), []);
        provider.dispose();
    });
});
```

- [ ] **Step 2: Run it and check it fails**

Run: `npm run compile-tests`
Expected: FAIL with `Cannot find module '../views/viewDoctorView'`.

- [ ] **Step 3: Create `src/views/viewDoctorView.ts`**

```ts
/**
 * The Views tree: the views a database has turned off, what an upgrade
 * disabled first. It shows the selected database, or the upgraded side while
 * an upgrade is set up, since that is where views get disabled.
 */
import * as vscode from 'vscode';
import { SettingsStore } from '../settingsStore';
import { ensureUpgradeConfigModel } from '../models/upgrade';
import { errorMessage, logger } from '../services/logger';
import type { ViewService } from '../services/views/viewService';
import type { ViewGroups } from '../services/views/viewGroups';
import type { ViewRow } from '../services/views/viewQueries';
import { BaseTreeProvider } from './baseTreeProvider';

export interface ViewDoctorTarget {
    dbName: string;
    side?: 'to';
}

export function resolveViewDoctorTarget(
    project: { dbs?: Array<{ id: string; isSelected?: boolean }>; upgradeConfig?: unknown } | undefined
): ViewDoctorTarget | undefined {
    if (!project) {
        return undefined;
    }
    const config = ensureUpgradeConfigModel(project.upgradeConfig as Parameters<typeof ensureUpgradeConfigModel>[0]);
    if (config.isActive() && config.to?.dbId) {
        return { dbName: config.to.dbId, side: 'to' };
    }
    const selected = (project.dbs ?? []).find(db => db.isSelected);
    return selected ? { dbName: selected.id } : undefined;
}

export class ViewItem extends vscode.TreeItem {
    constructor(readonly dbName: string, readonly view: ViewRow, section: 'upgrade' | 'other', versions: string[] = []) {
        super(view.name, vscode.TreeItemCollapsibleState.None);
        // Keyed by state too: a row that changes state is a different row.
        this.id = `${dbName}:${section}:${view.id}:${view.active ? 'on' : 'off'}`;
        this.description = `${view.model || view.type} · ${view.xmlid ?? `#${view.id}`}`;
        this.iconPath = new vscode.ThemeIcon(view.active ? 'pass' : 'circle-slash');
        this.contextValue = ['odooView', view.active ? 'active' : 'inactive', view.inheritId ? 'hasParent' : 'root'].join('.');
        const tooltip = new vscode.MarkdownString(undefined, true);
        tooltip.appendMarkdown(`**${view.name}** (${view.type}, id ${view.id})\n\n`);
        tooltip.appendMarkdown(`${view.xmlid ? `\`${view.xmlid}\`` : 'No external id'}\n\n`);
        if (view.inheritId) {
            tooltip.appendMarkdown(`Inherits view ${view.inheritId}, root ${view.rootId}\n\n`);
        }
        if (versions.length > 0) {
            tooltip.appendMarkdown(`Disabled by the ${versions.join(' and ')} upgrade${versions.length > 1 ? 's' : ''}\n\n`);
        }
        tooltip.appendMarkdown(view.active ? 'On now' : 'Off');
        this.tooltip = tooltip;
        this.command = { command: 'viewDoctor.openArch', title: 'Open Arch', arguments: [this] };
    }
}

export class ViewGroupItem extends vscode.TreeItem {
    constructor(label: string, id: string, readonly children: vscode.TreeItem[], expanded: boolean, description: string) {
        super(label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        this.id = id;
        this.description = description;
        this.contextValue = 'odooViewGroup';
    }
}

function messageItem(text: string, icon: string): vscode.TreeItem {
    const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
}

export function buildDoctorRows(dbName: string, groups: ViewGroups): vscode.TreeItem[] {
    const rows: vscode.TreeItem[] = [];

    if (groups.upgradeDisabled.length > 0 || groups.missingIds.length > 0) {
        const off = groups.upgradeDisabled.filter(view => !view.active).length;
        const on = groups.upgradeDisabled.length - off;
        const children: vscode.TreeItem[] = groups.upgradeDisabled.map(view => new ViewItem(dbName, view, 'upgrade', view.versions));
        if (groups.missingIds.length > 0) {
            const count = groups.missingIds.length;
            children.push(messageItem(`${count} listed view${count === 1 ? ' no longer exists' : 's no longer exist'}`, 'trash'));
        }
        const parts = [`${off} off`, ...(on > 0 ? [`${on} re-enabled`] : []), ...(groups.upgradeVersions.length > 0 ? [groups.upgradeVersions.join(', ')] : [])];
        rows.push(new ViewGroupItem('Disabled by upgrade', `${dbName}:group:upgrade`, children, true, parts.join(' · ')));
    }

    if (groups.otherInactive.length > 0) {
        rows.push(new ViewGroupItem(
            'Other inactive views',
            `${dbName}:group:other`,
            groups.otherInactive.map(view => new ViewItem(dbName, view, 'other')),
            false,
            String(groups.otherInactive.length)
        ));
    }

    if (rows.length === 0) {
        rows.push(messageItem(`No views are turned off in ${dbName}.`, 'check'));
    }
    return rows;
}

export class ViewDoctorTreeProvider extends BaseTreeProvider<vscode.TreeItem> {
    private loaded: Promise<vscode.TreeItem[]> | undefined;

    constructor(
        private readonly service: Pick<ViewService, 'doctorGroups'>,
        private readonly describe?: (text: string | undefined) => void
    ) {
        super();
    }

    refresh(element?: vscode.TreeItem): void {
        if (!element) {
            this.loaded = undefined;
        }
        super.refresh(element);
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (element instanceof ViewGroupItem) {
            return element.children;
        }
        if (element) {
            return [];
        }
        if (!this.loaded) {
            this.loaded = this.load();
        }
        return this.loaded;
    }

    private async load(): Promise<vscode.TreeItem[]> {
        const result = await SettingsStore.peekSelectedProject().catch(() => null);
        const target = resolveViewDoctorTarget(result?.project as Parameters<typeof resolveViewDoctorTarget>[0]);
        this.describe?.(target?.dbName);
        if (!target) {
            return [];
        }
        try {
            return buildDoctorRows(target.dbName, await this.service.doctorGroups(target.dbName));
        } catch (error) {
            logger.warn(`Could not read the views of ${target.dbName}:`, error);
            return [messageItem(`Could not read the views of ${target.dbName}: ${errorMessage(error)}`, 'error')];
        }
    }
}
```

If `errorMessage` is not exported from `src/services/logger.ts` (`src/debugger.ts` imports it from there, so it should be), use `error instanceof Error ? error.message : String(error)`.

- [ ] **Step 4: Run it and check it passes**

Run: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Views tree"`
Expected: 5 passing.

- [ ] **Step 5: Wire it into the extension**

In `src/commands/index.ts`:
- Add `import type { ViewDoctorTreeProvider } from '../views/viewDoctorView';` and `import type { ViewService } from '../services/views/viewService';`.
- Add `views: ViewDoctorTreeProvider;` to `Providers`.
- Add this to `CommandDeps`:

```ts
    /** Arch reads/writes and activation for the View Doctor. */
    viewService: ViewService;
```

In `src/extension.ts`, add the imports:

```ts
import { ViewDoctorTreeProvider } from './views/viewDoctorView';
import { ViewService } from './services/views/viewService';
import { ViewWorker } from './services/views/viewWorker';
import { ViewWorkerPool } from './services/views/viewWorkerPool';
import { resolveViewWorkerSpec } from './services/views/viewWorkerSpec';
import { onBeforeDatabaseRelease } from './services/postgres';
```

Directly before `const providers = {`, add:

```ts
    // The View Doctor's shells: one per database, started on first use.
    const viewWorkerScript = context.asAbsolutePath(path.join('resources', 'scripts', 'view_worker.py'));
    const viewWorkers = new ViewWorkerPool(
        async dbName => new ViewWorker(await resolveViewWorkerSpec(dbName, viewWorkerScript)),
        {
            onStarting: (dbName, ready) => void vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: `Starting an Odoo shell on ${dbName}…` },
                () => ready.catch(() => undefined)
            )
        }
    );
    const viewService = new ViewService(viewWorkers);
    context.subscriptions.push(viewWorkers, onBeforeDatabaseRelease(dbName => viewWorkers.release(dbName)));
    let viewDoctorTreeView: vscode.TreeView<vscode.TreeItem> | undefined;
```

Add `views` to the `providers` object:

```ts
        views: new ViewDoctorTreeProvider(viewService, dbName => {
            if (viewDoctorTreeView) {
                viewDoctorTreeView.description = dbName;
            }
        }),
```

After the `upgradeSelector` registration line, add:

```ts
    viewDoctorTreeView = vscode.window.createTreeView('viewDoctor', { treeDataProvider: providers.views, showCollapseAll: true });
    context.subscriptions.push(viewDoctorTreeView);
```

Change the `registerAllCommands({ … })` call to also pass `viewService`.

`refreshViews` already refreshes every provider, so a database switch or upgrade toggle reloads the tree.

- [ ] **Step 6: Contribute the view, its welcome text and its refresh** in `package.json`

1. In `contributes.views["odoo-devtools"]`, after the `upgradeSelector` entry, add:

```json
        {
          "id": "viewDoctor",
          "name": "Views",
          "icon": "$(symbol-structure)",
          "visibility": "collapsed"
        },
```

2. In `contributes.commands`, add:

```json
      {
        "command": "viewDoctor.refresh",
        "title": "Refresh Views",
        "category": "Odoo DevTools",
        "icon": "$(refresh)"
      },
```

3. In `contributes.menus["view/title"]`, add:

```json
        {
          "command": "viewDoctor.refresh",
          "when": "view == viewDoctor",
          "group": "navigation@1"
        },
```

4. In `contributes.viewsWelcome`, add:

```json
      {
        "view": "viewDoctor",
        "when": "odoo-debugger.is_active",
        "contents": "Select a database to see the views it has turned off. While an upgrade is set up, this shows the upgraded database.\n[Switch Database](command:dbSelector.quickSearch)"
      },
```

5. In `activationEvents`, add `"onFileSystem:odoo-view"` after `"onStartupFinished"`, so a reopened window can restore arch tabs. Task 7 registers that scheme.

- [ ] **Step 7: Register the refresh command**

Create `src/commands/viewDoctorCommands.ts` with only refresh for now. Task 7 adds the rest.

```ts
import type { CommandDeps } from './index';
import { registerCommand } from './registerCommand';

export function registerViewDoctorCommands(deps: CommandDeps): void {
    const { context, providers } = deps;

    context.subscriptions.push(registerCommand('viewDoctor.refresh', () => providers.views.refresh()));
}
```

In `src/commands/index.ts`, import it and call `registerViewDoctorCommands(deps);` at the end of `registerAllCommands`.

- [ ] **Step 8: Type check, lint, and run the full suite**

Run: `npx tsc -p . --noEmit && npm run lint && npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npm test`
Expected: everything passes, including the existing activation smoke test in `extension.test.ts`. That test proves the new view, its command and the activation event register cleanly.

- [ ] **Step 9: Commit**

```bash
git add src/views/viewDoctorView.ts src/commands/viewDoctorCommands.ts src/commands/index.ts src/extension.ts package.json src/test/viewDoctorView.test.ts
git commit -m "[ADD] A Views tree listing what a database has turned off" -m "What an upgrade disabled comes first, still-off before re-enabled, with the
versions that disabled it; every other inactive view follows, collapsed. It
shows the selected database, or the upgraded one while an upgrade is set up,
and reads over psql only, so no shell is started just to look.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Editing the arch, and the row actions

**Files:**
- Create: `src/views/viewFileSystem.ts`
- Create: `src/services/views/archErrors.ts`
- Modify: `src/commands/viewDoctorCommands.ts`
- Modify: `src/extension.ts` (register the file system provider and the diagnostics collection)
- Modify: `package.json` (commands, item menus, command palette hiding)
- Test: `src/test/viewFileSystem.test.ts`
- Test: `src/test/archErrors.test.ts`

**Interfaces:**
- Consumes:
  - `ViewBackend`, `SaveResult`, `ViewService` (Task 5)
  - `ViewItem` (Task 6)
- Produces:
  - `VIEW_SCHEME = 'odoo-view'`
  - `ViewRef { dbName: string; viewId: number }`
  - `viewUri(dbName: string, viewId: number, label: string): vscode.Uri`
  - `parseViewUri(uri: vscode.Uri): ViewRef | undefined`
  - `ViewFileHooks { onSaved(ref: ViewRef, result: SaveResult, uri: vscode.Uri, text: string): void }`
  - `class ViewFileSystemProvider implements vscode.FileSystemProvider`, with `constructor(backend: ViewBackend, hooks: ViewFileHooks)`
  - `ArchErrorLocation { line: number; start: number; end: number }`
  - `locateArchError(arch: string, message: string): ArchErrorLocation`
  - Command ids:
    - `viewDoctor.openArch`
    - `viewDoctor.activate`
    - `viewDoctor.deactivate`
    - `viewDoctor.copyXmlid`
    - `viewDoctor.openParent`
  - Stage 2 will add `viewDoctor.compareWithOriginal` and `viewDoctor.renderInBrowser`. Do not add them now.

- [ ] **Step 1: Write the failing tests**

`src/test/archErrors.test.ts`:

```ts
import * as assert from 'assert';
import { locateArchError } from '../services/views/archErrors';

const ARCH = [
    '<data>',
    '    <xpath expr="//field[@name=\'partner_id\']" position="after">',
    '        <field name="x_custom"/>',
    '    </xpath>',
    '</data>'
].join('\n');

suite('Arch error location', () => {
    test('points at the xpath Odoo could not locate', () => {
        const message = 'Element \'<xpath expr="//field[@name=\'partner_id\']">\' cannot be located in parent view';
        assert.deepStrictEqual(locateArchError(ARCH, message), { line: 1, start: 17, end: 44 });
    });

    test('points at a field Odoo does not know', () => {
        assert.deepStrictEqual(
            locateArchError(ARCH, 'Field "x_custom" does not exist in model "res.partner"'),
            { line: 2, start: 21, end: 29 }
        );
    });

    test('uses the line of an XML syntax error', () => {
        assert.deepStrictEqual(
            locateArchError(ARCH, 'Opening and ending tag mismatch: xpath line 2 and data, line 4, column 9'),
            { line: 3, start: 0, end: 12 }
        );
    });

    test('falls back to the first line', () => {
        assert.deepStrictEqual(locateArchError(ARCH, 'Something else broke'), { line: 0, start: 0, end: 6 });
    });
});
```

The "field Odoo does not know" case needs the needle to match `name="x_custom"` and `"x_custom"` alike. The implementation below extracts quoted values from the message: anything inside `"…"` that is at least 3 characters long. Then it searches the arch for each value, in message order.

`src/test/viewFileSystem.test.ts`:

```ts
import * as assert from 'assert';
import * as vscode from 'vscode';
import { ViewFileSystemProvider, parseViewUri, viewUri, type ViewRef } from '../views/viewFileSystem';
import type { SaveResult, ViewBackend } from '../services/views/viewService';

class FakeBackend implements ViewBackend {
    writeDates = new Map<number, number>([[12, 1000]]);
    arches = new Map<number, string>([[12, '<data>é</data>']]);
    saveResult: SaveResult = { active: true, activated: true, activationError: null };
    saveError: Error | undefined;
    async writeDate(_db: string, viewId: number) {
        return this.writeDates.get(viewId);
    }
    async getArch(_db: string, viewId: number) {
        return this.arches.get(viewId) ?? '';
    }
    async save(_db: string, viewId: number, arch: string) {
        if (this.saveError) {
            throw this.saveError;
        }
        this.arches.set(viewId, arch);
        this.writeDates.set(viewId, (this.writeDates.get(viewId) ?? 0) + 1);
        return this.saveResult;
    }
}

suite('View arch files', () => {
    const uri = viewUri('shop-18', 12, 'studio_customization.odoo studio/partner');

    test('a view is addressed by database and id, with a readable xml name', () => {
        assert.strictEqual(uri.scheme, 'odoo-view');
        assert.strictEqual(uri.path, '/shop-18/12/studio_customization.odoo_studio_partner.xml');
        assert.deepStrictEqual(parseViewUri(uri), { dbName: 'shop-18', viewId: 12 });
        assert.strictEqual(parseViewUri(vscode.Uri.parse('odoo-view:/shop-18/zero/x.xml')), undefined);
        assert.strictEqual(parseViewUri(vscode.Uri.parse('odoo-view:/')), undefined);
    });

    test('reads the arch as UTF-8 and dates it by write_date, at a constant size', async () => {
        const backend = new FakeBackend();
        const provider = new ViewFileSystemProvider(backend, { onSaved: () => undefined });
        assert.strictEqual(Buffer.from(await provider.readFile(uri)).toString('utf-8'), '<data>é</data>');
        const before = await provider.stat(uri);
        assert.deepStrictEqual([before.type, before.mtime, before.size], [vscode.FileType.File, 1000, 0]);

        // Edited in Odoo's own UI meanwhile: the date moves, so VS Code sees a newer file.
        backend.writeDates.set(12, 2000);
        assert.strictEqual((await provider.stat(uri)).mtime, 2000);
        assert.strictEqual((await provider.stat(uri)).size, 0, 'a size that changed after reading would fake a conflict');
    });

    test('a deleted view is not found', async () => {
        const backend = new FakeBackend();
        backend.writeDates.delete(12);
        const provider = new ViewFileSystemProvider(backend, { onSaved: () => undefined });
        await assert.rejects(Promise.resolve(provider.stat(uri)), (error: unknown) =>
            error instanceof vscode.FileSystemError && error.code === 'FileNotFound');
    });

    test('saving writes through Odoo and reports what happened', async () => {
        const backend = new FakeBackend();
        const saved: Array<[ViewRef, SaveResult, string]> = [];
        const provider = new ViewFileSystemProvider(backend, { onSaved: (ref, result, _uri, text) => saved.push([ref, result, text]) });
        const changed: vscode.FileChangeEvent[][] = [];
        provider.onDidChangeFile(events => changed.push(events));

        await provider.writeFile(uri, Buffer.from('<data>✓</data>'), { create: false, overwrite: true });
        assert.strictEqual(backend.arches.get(12), '<data>✓</data>');
        assert.deepStrictEqual(saved, [[{ dbName: 'shop-18', viewId: 12 }, backend.saveResult, '<data>✓</data>']]);
        assert.strictEqual(changed.length, 1);
    });

    test('an arch Odoo rejects fails the save and reports nothing', async () => {
        const backend = new FakeBackend();
        backend.saveError = new Error('Invalid view definition');
        let saved = 0;
        const provider = new ViewFileSystemProvider(backend, { onSaved: () => saved++ });
        await assert.rejects(Promise.resolve(provider.writeFile(uri, Buffer.from('<data'), { create: false, overwrite: true })), /Invalid view definition/);
        assert.strictEqual(saved, 0);
    });

    test('views cannot be created, deleted, renamed or listed', () => {
        const provider = new ViewFileSystemProvider(new FakeBackend(), { onSaved: () => undefined });
        assert.throws(() => provider.delete(uri), vscode.FileSystemError);
        assert.throws(() => provider.rename(uri, uri), vscode.FileSystemError);
        assert.throws(() => provider.createDirectory(uri), vscode.FileSystemError);
        assert.throws(() => provider.readDirectory(uri), vscode.FileSystemError);
    });
});
```

- [ ] **Step 2: Run them and check they fail**

Run: `npm run compile-tests`
Expected: FAIL with `Cannot find module '../services/views/archErrors'` and `'../views/viewFileSystem'`.

- [ ] **Step 3: Create `src/services/views/archErrors.ts`**

```ts
/**
 * Where in an arch Odoo's error points, for a diagnostic. Odoo names the
 * failing locator or field in quotes, or (for XML syntax) a line; an error
 * that names neither lands on the first line.
 */

export interface ArchErrorLocation {
    line: number;
    start: number;
    end: number;
}

export function locateArchError(arch: string, message: string): ArchErrorLocation {
    const lines = arch.split('\n');
    const whole = (line: number): ArchErrorLocation => ({ line, start: 0, end: lines[line]?.length ?? 0 });

    const syntaxLine = /line (\d+), column \d+/.exec(message);
    if (syntaxLine) {
        return whole(Math.max(0, Math.min(Number(syntaxLine[1]) - 1, lines.length - 1)));
    }

    const needles = [...message.matchAll(/"([^"]{3,})"/g)].map(match => match[1]);
    for (const needle of needles) {
        for (let line = 0; line < lines.length; line++) {
            const start = lines[line].indexOf(needle);
            if (start >= 0) {
                return { line, start, end: start + needle.length };
            }
        }
    }
    return whole(0);
}
```

Check the first test by hand. The message's first quoted run is `//field[@name='partner_id']`. Line 1 is `    <xpath expr="//field[@name='partner_id']" position="after">`, and the expression starts at column 17 and is 27 characters long, so the location is `{1, 17, 44}`. If your count differs, fix the test's numbers to match the arch; do not change the algorithm.

- [ ] **Step 4: Create `src/views/viewFileSystem.ts`**

```ts
/**
 * Views as files: odoo-view:/<db>/<id>/<xmlid>.xml. VS Code's own editor
 * is the arch editor - XML highlighting, search, multi-cursor - and saving
 * writes through the database's Odoo shell.
 *
 * mtime is the view's write_date, so a view edited in Odoo's UI after it was
 * opened makes VS Code's save report a newer file. Size is always 0: VS Code
 * compares mtime *and* size before saving, and a size learnt only after the
 * first read would look like a change on every first save.
 */
import * as vscode from 'vscode';
import type { SaveResult, ViewBackend } from '../services/views/viewService';

export const VIEW_SCHEME = 'odoo-view';

export interface ViewRef {
    dbName: string;
    viewId: number;
}

export interface ViewFileHooks {
    onSaved(ref: ViewRef, result: SaveResult, uri: vscode.Uri, text: string): void;
}

export function viewUri(dbName: string, viewId: number, label: string): vscode.Uri {
    const safe = label.replace(/[^\w.-]+/g, '_') || `view-${viewId}`;
    return vscode.Uri.from({ scheme: VIEW_SCHEME, path: `/${encodeURIComponent(dbName)}/${viewId}/${safe}.xml` });
}

export function parseViewUri(uri: vscode.Uri): ViewRef | undefined {
    const [, db, id] = uri.path.split('/');
    const viewId = Number(id);
    if (!db || !Number.isSafeInteger(viewId) || viewId <= 0) {
        return undefined;
    }
    return { dbName: decodeURIComponent(db), viewId };
}

export class ViewFileSystemProvider implements vscode.FileSystemProvider {
    private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.changes.event;

    constructor(private readonly backend: ViewBackend, private readonly hooks: ViewFileHooks) {}

    watch(): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const ref = this.ref(uri);
        const mtime = await this.backend.writeDate(ref.dbName, ref.viewId);
        if (mtime === undefined) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return { type: vscode.FileType.File, ctime: 0, mtime, size: 0 };
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const ref = this.ref(uri);
        return Buffer.from(await this.backend.getArch(ref.dbName, ref.viewId), 'utf-8');
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean }): Promise<void> {
        const ref = this.ref(uri);
        const text = Buffer.from(content).toString('utf-8');
        // Throws when Odoo rejects the arch: VS Code shows the message and keeps the editor dirty.
        const result = await this.backend.save(ref.dbName, ref.viewId, text);
        this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        this.hooks.onSaved(ref, result, uri, text);
    }

    readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
        throw vscode.FileSystemError.NoPermissions('Views are opened from the Views tree, one at a time.');
    }

    createDirectory(_uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions('Views cannot be created here.');
    }

    delete(_uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions('Views cannot be deleted here.');
    }

    rename(_oldUri: vscode.Uri, _newUri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions('Views cannot be renamed here.');
    }

    private ref(uri: vscode.Uri): ViewRef {
        const ref = parseViewUri(uri);
        if (!ref) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return ref;
    }
}
```

- [ ] **Step 5: Run both suites and check they pass**

Run: `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Arch error location|View arch files"`
Expected: 10 passing. After Step 6b adds its test, 11.

- [ ] **Step 6: Register the file system and the save feedback** in `src/extension.ts`

Add the imports:

```ts
import { VIEW_SCHEME, ViewFileSystemProvider } from './views/viewFileSystem';
import { locateArchError } from './services/views/archErrors';
import { showBriefStatus, showWarning } from './services/notifications';
```

Use the `showWarning` from `services/notifications`. If `extension.ts` already imports `showInfo` from there, merge it into that import line.

After the `viewDoctorTreeView` registration from Task 6, add:

```ts
    // Odoo's reason a saved view stays off, on the line it is about.
    const viewDiagnostics = vscode.languages.createDiagnosticCollection('odoo-views');
    context.subscriptions.push(viewDiagnostics);
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider(VIEW_SCHEME, new ViewFileSystemProvider(viewService, {
        onSaved: (_ref, result, uri, text) => {
            if (result.activationError) {
                const where = locateArchError(text, result.activationError);
                const diagnostic = new vscode.Diagnostic(
                    new vscode.Range(where.line, where.start, where.line, where.end),
                    result.activationError,
                    vscode.DiagnosticSeverity.Error
                );
                diagnostic.source = 'Odoo';
                viewDiagnostics.set(uri, [diagnostic]);
                void showWarning(`Saved. The view stays off: ${result.activationError.split('\n')[0]}`);
            } else {
                viewDiagnostics.delete(uri);
                showBriefStatus(result.activated ? 'Saved, and the view is on.' : 'Saved.');
            }
            providers.views.refresh();
        }
    }), { isCaseSensitive: true }));
```

- [ ] **Step 6b: Follow edits made in Odoo's own UI**

The spec asks for a 3 s `write_date` poll for open arch tabs. Without it, an editor with no unsaved changes keeps showing the old arch after someone saves the view in Odoo. Firing `onDidChangeFile` makes VS Code reload a clean editor by itself; a dirty one gets the "newer file" check on save.

1. Add this method to `ViewFileSystemProvider` in `src/views/viewFileSystem.ts`:

```ts
    /** Tells VS Code these files changed elsewhere; clean editors reload. */
    notifyChanged(uris: vscode.Uri[]): void {
        if (uris.length > 0) {
            this.changes.fire(uris.map(uri => ({ type: vscode.FileChangeType.Changed, uri })));
        }
    }
```

2. Add this test to the `View arch files` suite in `src/test/viewFileSystem.test.ts`:

```ts
    test('reports views changed elsewhere so clean editors reload', () => {
        const provider = new ViewFileSystemProvider(new FakeBackend(), { onSaved: () => undefined });
        const changed: vscode.FileChangeEvent[][] = [];
        provider.onDidChangeFile(events => changed.push(events));
        provider.notifyChanged([]);
        provider.notifyChanged([uri]);
        assert.deepStrictEqual(changed.map(events => events.map(event => event.uri.toString())), [[uri.toString()]]);
    });
```

3. In `src/extension.ts`, keep the provider in a const and start a poll that runs only while arch tabs are open. Replace the `registerFileSystemProvider(VIEW_SCHEME, new ViewFileSystemProvider(viewService, {…}), …)` call from Step 6 with:

```ts
    const viewFiles = new ViewFileSystemProvider(viewService, {
        onSaved: (_ref, result, uri, text) => {
            // … the same body as in Step 6
        }
    });
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider(VIEW_SCHEME, viewFiles, { isCaseSensitive: true }));

    // Edits made in Odoo's own UI: one psql query per database every 3 s,
    // and only while an arch tab is open.
    const seenWriteDates = new Map<string, number>();
    const viewPoll = setInterval(() => {
        const open = vscode.workspace.textDocuments
            .filter(document => document.uri.scheme === VIEW_SCHEME)
            .map(document => ({ uri: document.uri, ref: parseViewUri(document.uri) }))
            .filter((entry): entry is { uri: vscode.Uri; ref: ViewRef } => !!entry.ref);
        const byDb = new Map<string, typeof open>();
        for (const entry of open) {
            byDb.set(entry.ref.dbName, [...(byDb.get(entry.ref.dbName) ?? []), entry]);
        }
        for (const [dbName, entries] of byDb) {
            void getWriteDates(dbName, entries.map(entry => entry.ref.viewId)).then(dates => {
                const changed = entries.filter(entry => {
                    const key = entry.uri.toString();
                    const date = dates.get(entry.ref.viewId);
                    const previous = seenWriteDates.get(key);
                    if (date !== undefined) {
                        seenWriteDates.set(key, date);
                    }
                    return previous !== undefined && date !== undefined && date !== previous;
                });
                if (changed.length > 0) {
                    viewFiles.notifyChanged(changed.map(entry => entry.uri));
                    providers.views.refresh();
                }
            }).catch(error => logger.debug(`Could not poll the views of ${dbName}:`, error));
        }
    }, 3000);
    context.subscriptions.push(new vscode.Disposable(() => clearInterval(viewPoll)));
```

   Add `parseViewUri` and `type ViewRef` to the `./views/viewFileSystem` import, and `import { getWriteDates } from './services/views/viewQueries';`.

   A save made from VS Code also moves `write_date`. The poll then fires one extra change for a clean editor, which reloads identical text. That is harmless, so it is not suppressed.

- [ ] **Step 7: Add the row commands** to `src/commands/viewDoctorCommands.ts`

Replace the file with:

```ts
import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { registerCommand } from './registerCommand';
import { ViewItem } from '../views/viewDoctorView';
import { viewUri } from '../views/viewFileSystem';
import { showBriefStatus, showError, showModalWarning } from '../services/notifications';
import { errorMessage } from '../services/logger';

function viewItem(arg: unknown): ViewItem | undefined {
    return arg instanceof ViewItem ? arg : undefined;
}

async function openArch(dbName: string, viewId: number, xmlid: string | null): Promise<void> {
    await vscode.window.showTextDocument(viewUri(dbName, viewId, xmlid ?? `view-${viewId}`), { preview: true });
}

export function registerViewDoctorCommands(deps: CommandDeps): void {
    const { context, providers, viewService } = deps;

    context.subscriptions.push(registerCommand('viewDoctor.refresh', () => providers.views.refresh()));

    context.subscriptions.push(registerCommand('viewDoctor.openArch', async (arg: unknown) => {
        const item = viewItem(arg);
        if (item) {
            await openArch(item.dbName, item.view.id, item.view.xmlid);
        }
    }));

    context.subscriptions.push(registerCommand('viewDoctor.openParent', async (arg: unknown) => {
        const item = viewItem(arg);
        if (!item?.view.inheritId) {
            return;
        }
        const [parent] = await viewService.rows(item.dbName, [item.view.inheritId]);
        await openArch(item.dbName, item.view.inheritId, parent?.xmlid ?? null);
    }));

    context.subscriptions.push(registerCommand('viewDoctor.activate', async (arg: unknown) => {
        const item = viewItem(arg);
        if (!item) {
            return;
        }
        try {
            await viewService.activate(item.dbName, item.view.id);
            showBriefStatus(`${item.view.name} is on.`);
        } catch (error) {
            const choice = await showError(`${item.view.name} cannot be turned on: ${errorMessage(error)}`, 'Open Arch');
            if (choice === 'Open Arch') {
                await openArch(item.dbName, item.view.id, item.view.xmlid);
            }
        } finally {
            providers.views.refresh();
        }
    }));

    context.subscriptions.push(registerCommand('viewDoctor.deactivate', async (arg: unknown) => {
        const item = viewItem(arg);
        if (!item) {
            return;
        }
        const choice = await showModalWarning(`Turn off ${item.view.name} in ${item.dbName}?`, 'Turn Off');
        if (choice !== 'Turn Off') {
            return;
        }
        try {
            await viewService.deactivate(item.dbName, item.view.id);
            showBriefStatus(`${item.view.name} is off.`);
        } catch (error) {
            void showError(`${item.view.name} could not be turned off: ${errorMessage(error)}`);
        } finally {
            providers.views.refresh();
        }
    }));

    context.subscriptions.push(registerCommand('viewDoctor.copyXmlid', async (arg: unknown) => {
        const item = viewItem(arg);
        if (item) {
            await vscode.env.clipboard.writeText(item.view.xmlid ?? String(item.view.id));
            showBriefStatus('Copied.');
        }
    }));
}
```

- [ ] **Step 8: Contribute the commands and menus** in `package.json`

1. In `contributes.commands`, add:

```json
      { "command": "viewDoctor.openArch", "title": "Open Arch", "category": "Odoo DevTools", "icon": "$(go-to-file)" },
      { "command": "viewDoctor.openParent", "title": "Open Parent View", "category": "Odoo DevTools" },
      { "command": "viewDoctor.activate", "title": "Turn On", "category": "Odoo DevTools" },
      { "command": "viewDoctor.deactivate", "title": "Turn Off…", "category": "Odoo DevTools" },
      { "command": "viewDoctor.copyXmlid", "title": "Copy External ID", "category": "Odoo DevTools" },
```

2. In `contributes.menus["view/item/context"]`, add:

```json
        { "command": "viewDoctor.openArch", "when": "view == viewDoctor && viewItem =~ /^odooView\\./", "group": "inline@1" },
        { "command": "viewDoctor.openArch", "when": "view == viewDoctor && viewItem =~ /^odooView\\./", "group": "1_open@1" },
        { "command": "viewDoctor.openParent", "when": "view == viewDoctor && viewItem =~ /\\.hasParent$/", "group": "1_open@2" },
        { "command": "viewDoctor.activate", "when": "view == viewDoctor && viewItem =~ /^odooView\\.inactive/", "group": "2_state@1" },
        { "command": "viewDoctor.copyXmlid", "when": "view == viewDoctor && viewItem =~ /^odooView\\./", "group": "3_copy@1" },
        { "command": "viewDoctor.deactivate", "when": "view == viewDoctor && viewItem =~ /^odooView\\.active/", "group": "9_danger@1" },
```

3. In `contributes.menus.commandPalette`, hide every row command (they need a row):

```json
        { "command": "viewDoctor.openArch", "when": "false" },
        { "command": "viewDoctor.openParent", "when": "false" },
        { "command": "viewDoctor.activate", "when": "false" },
        { "command": "viewDoctor.deactivate", "when": "false" },
        { "command": "viewDoctor.copyXmlid", "when": "false" },
```

Deactivate is on the right-click menu only, behind a modal, per the global constraints. The only inline icon is Open Arch.

- [ ] **Step 9: Type check, lint, and run the full suite**

Run: `npx tsc -p . --noEmit && npm run lint && npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npm test`
Expected: everything passes.

- [ ] **Step 10: Commit**

```bash
git add src/views/viewFileSystem.ts src/services/views/archErrors.ts src/commands/viewDoctorCommands.ts src/extension.ts package.json src/test/viewFileSystem.test.ts src/test/archErrors.test.ts
git commit -m "[ADD] Edit a view's arch in the editor and save it through Odoo" -m "Views open as odoo-view: XML files. Saving writes through the database's shell
and turns an off view on when Odoo can compose it; when it cannot, the arch is
kept and Odoo's reason sits on the line it is about. An arch Odoo rejects fails
the save. A view edited in Odoo meanwhile makes the save report a newer file.
Rows can be turned on, turned off (with confirmation), copied and walked to
their parent.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Real-window check, docs and build

**Files:**
- Modify: `CHANGELOG.md` (new `## [Unreleased]` section above `## [1.4.0]`)
- Modify: `README.md` (a short "Views" section next to the Upgrade section)
- Modify: `dist/` (rebuilt and committed, per the repo convention)

- [ ] **Step 1: Prepare a database with an upgrade-disabled view**

Reuse `odt_view_base_17` from Task 5 and make a copy that looks upgraded:

```bash
createdb -T odt_view_base_17 odt_view_doctor_demo
/home/odoo/odoo-dev/venv-17.0/bin/python /home/odoo/odoo-dev/odoo-17.0/odoo-bin shell --no-http \
  --addons-path=/home/odoo/odoo-dev/odoo-17.0/odoo/addons,/home/odoo/odoo-dev/odoo-17.0/addons \
  -d odt_view_doctor_demo -i mail --stop-after-init
```

Then pipe a script into the shell. It creates the broken inactive view from Task 5's `SETUP`, and posts a fake report message with `env['mail.message'].create({'model': 'discuss.channel', 'res_id': 1, 'body': '<h2>Congratulations, you have just upgraded to Odoo 17.0</h2><h3>Disabled views</h3><ul><li><a href="/odoo/action-29/%d">x</a></li></ul>' % view.id})`. It finishes with `env.cr.commit()`.

If `discuss.channel` id 1 does not exist, create a channel first with `env['discuss.channel'].create({'name': 'odt'})`.

- [ ] **Step 2: Drive the real window**

Follow `docs/manual-test-brief.md`, "Driving the window on this machine". Set up as follows:
- Use Xvfb plus `code --extensionDevelopmentPath`.
- Run in a scratch HOME, launched with `env -i`.
- Seed `<ws>/.vscode/odoo-debugger-data.json`: a project with `odt_view_doctor_demo` selected, and a version whose `pythonPath`/`odooPath` point at the 17.0 venv and checkout.

Check each of these and take a screenshot for each:

1. The **Views** view shows **Disabled by upgrade** with the test view (off, `17.0`). The view's description is `odt_view_doctor_demo`.
2. Clicking the row opens `odt-view…/view-<id>.xml` with XML highlighting, after the status bar shows "Starting an Odoo shell on odt_view_doctor_demo…".
3. Saving it unchanged shows the warning "Saved. The view stays off: …". An error squiggle sits on the `odt_does_not_exist` xpath line.
4. Fixing the xpath to `//field[@name='name']` and saving shows "Saved, and the view is on." The row moves to re-enabled (✓) and the squiggle clears.
5. Right-click → **Turn Off…** asks in a modal, then the row is off again. **Turn On** works.
6. In Odoo's own UI (or `psql -c "UPDATE ir_ui_view SET write_date = now() WHERE id = <id>"`), change the view while it is open:
   - With no unsaved edit, the editor reloads within about 3 s.
   - With an unsaved edit, saving reports that the file is newer.
7. The Databases view does **not** show `odt_view_doctor_demo` as running while the shell is open. Run `psql -c "SELECT application_name FROM pg_stat_activity WHERE datname = 'odt_view_doctor_demo'"`: it shows `odoo-devtools-view-worker`.
8. Dropping `odt_view_doctor_demo` from the Databases view succeeds with the shell open.

Fix anything that fails in the task that owns it, add a test there if possible, and re-run.

- [ ] **Step 3: Write the changelog entry** in `CHANGELOG.md`, directly above `## [1.4.0] - 2026-10-02`

```markdown
## [Unreleased]

### Added

- **A Views view for fixing the views a database has turned off.** It lists what an upgrade disabled first — read from upgrade-util's report in Discuss, still-off before re-enabled, with the versions that disabled each — then every other inactive view. It shows the selected database, or the upgraded one while an upgrade is set up.
- **Edit a view's arch in the editor and save it straight to the database.** A view opens as an XML file; saving writes it through an Odoo shell running that database's own version, and turns the view on when Odoo can build it. When it cannot, your arch is kept, the view stays off, and Odoo's reason is shown on the line it is about. The running server picks the change up without a restart. Right-click a view to turn it on or off, copy its external id, or open its parent. Linux and macOS only.
```

- [ ] **Step 4: Add the README section**

Find the Upgrade section with `grep -n "^## \|^### " README.md`, and add this as a sibling section directly after it:

```markdown
### Views

The **Views** view lists the views the selected database has turned off — while an upgrade is set up, the upgraded database. What the upgrade disabled comes first, then every other inactive view.

Click a view to open its arch as an XML file. Saving writes it to the database through an Odoo shell that runs the database's own version (started on first use, stopped after ten idle minutes). A view that was off is turned on when Odoo can build it; otherwise the arch is still saved and Odoo's reason shows as an error in the editor. Right-click a view to turn it on or off, copy its external id, or open its parent.
```

- [ ] **Step 5: Run the full verification recipe**

Run: `npx tsc -p . --noEmit && npm run lint && npm run compile && npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npm test`
Expected: no errors, and every suite passing (the integration suite is skipped without its variables).

Also check that the packaged extension ships the worker:

```bash
npx vsce ls --no-dependencies | grep view_worker.py
```

Expected: `resources/scripts/view_worker.py`.

- [ ] **Step 6: Commit the docs and the build**

```bash
git add CHANGELOG.md README.md dist/
git commit -m "[DOC] Describe the Views view and arch editing; rebuild" -m "Changelog and README for stage 1 of the View Doctor, checked in a real window
against a 17.0 database with an upgrade-disabled view.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Clean up the test databases**

```bash
dropdb --if-exists odt_view_doctor_demo
for v in 15 17 19; do dropdb --if-exists odt_view_base_$v; done
```
