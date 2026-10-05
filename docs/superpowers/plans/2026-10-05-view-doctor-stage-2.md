# View Doctor Stage 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compare a view with the same view in the original database (diff editor, original read-only), and render one or both databases' Odoo web clients side by side, on the same record, in a VS Code tab.

**Architecture:** Matching runs over psql (`viewQueries.ts`) and a pure `viewMatch.ts`; the diff reuses the stage 1 `odoo-view:` file system with an injected read-only predicate. Rendering adds three worker commands (`new_session`, `make_action`, `recent_ids`), a cookie-gated per-database proxy (`odooFrameProxy.ts`) that injects the minted admin session and strips framing headers, a `RenderSession` that turns both sides into frame URLs on a common record, and a `WebviewPanel` that shows the frames and reloads them on save.

**Tech Stack:** TypeScript (VS Code ^1.101 API), Node `http`/`net`/`crypto` (no new dependencies), Python inside `odoo-bin shell` (Odoo 15–19), mocha in a real Extension Host (`@vscode/test-cli`).

**Spec:** `docs/superpowers/specs/2026-10-02-view-doctor-design.md` §4 (as amended 2026-10-05), with the stage 2 brief in `docs/superpowers/notes/2026-10-05-view-doctor-handover.md` §3–§5 and the frame spike in `docs/superpowers/notes/2026-10-05-frame-spike.md`. Executors read all three.

## Global Constraints

- Branch `v-1.5` only. **Never merge it into anything, never push, never offer to.**
- Commits: Odoo-style prefix (`[ADD]`/`[IMP]`/`[FIX]`/`[REF]`/`[DOC]`), a subject in plain words, a body, and the trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. **Never `git add -A` or `git add .`**: add the files you touched by name (the repo root has unrelated untracked dotfiles).
- `dist/` is committed **only in the last task**. `npm test` rebuilds it: run `git checkout -- dist` before every other commit.
- Engine stays `"vscode": "^1.101.0"`. No new npm dependencies.
- Every psql call goes through `runSql` (it carries `ownQueryEnv()`). Only validated integers and `sqlText()` hex literals are interpolated into SQL.
- The worker never gets `-i`/`-u`/test/port flags. New worker commands take `env` (which is `ENV`, forced to `lang='en_US'`). Only commands that write call `env.cr.commit()` and then `_signal(env)`; the main loop already rolls back around every request.
- The frame proxy binds `127.0.0.1` only and **never forwards or upgrades a request without its gate cookie**.
- Destructive actions stay right-click-only behind a modal. Stage 2 adds none.
- Copy: plain, short sentences, matching the existing CHANGELOG and README voice.
- Type check: `npx tsc -p . --noEmit`. Lint: `npm run lint` must report **0 errors** (117 warnings are pre-existing). IDE diagnostics `OWL000` in TS files are false positives.
- Tests run in a real Extension Host and **outside the Bash sandbox** (`dangerouslyDisableSandbox: true`), with `env -u ELECTRON_RUN_AS_NODE`:
  - `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "<suite name>"` for one suite (re-run `compile-tests` after adding a file);
  - `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npm test` for everything (623 passing, 13 pending at the start of stage 2).
- Real-Odoo integration (`src/test/viewWorker.integration.test.ts`) is skipped unless `ODT_VIEW_TEST_PYTHON`, `ODT_VIEW_TEST_ODOO`, `ODT_VIEW_TEST_DB` are set. Build a base DB per version (handover §5), run on 17.0, 18.0 and 19.0, drop your `odt_view_*` databases afterwards, touch no other database. `venv-15.0` and `venv-16.0` cannot start Odoo: do not modify them; 15/16 stay untested and must be reported as such.

## Rulings made for this plan (unattended; recorded per the handover)

Format: `Ruling: <decision> — <why> — <cost if wrong>`.

1. Ruling: `make_action` returns `series` in its result instead of the pool exposing the worker's ready reply — the same `odoo.release.serie` value, with no pool API change — an extra field on one reply.
2. Ruling: one action per (model, root view), named `[View Doctor] <model> #<root id>`, with `res_id` always `False`; the record goes in the URL (`/odoo/action-<id>/<res_id>`, or `#action=<id>&id=<res_id>` before saas~17.2) — odoo-manager's `render_view` docstring records that the web client caches actions by id, so a `res_id` written onto a reused action shows a stale record; keying by `res_id` instead piles up actions — if some version ignores the URL's record for a form action, that side shows a new record; the live check in Task 8 covers both URL forms (17.0 and 19.0).
3. Ruling: every QWeb view gets a message instead of a frame, not only report templates ("Reports need a record to render; open the report from Odoo." for reports, "QWeb templates render inside the page that uses them; open it from Odoo." otherwise) — a QWeb template has no act_window to open — none: they could not render before either.
4. Ruling: a search view renders as the model's list view with that search view (`search_view_id`) — a search view cannot be opened on its own — a user expecting something else sees a list.
5. Ruling: the render user is the first active internal user with `base.group_system`, lowest id first, found through whichever of `all_group_ids` (19), `groups_id` (15–18) or `group_ids` exists; `recent_ids` searches **as that user**, so the ids it returns are ones the frames can open — `has_group` changed semantics across versions; a superuser search can return records the admin's record rules hide — a database whose first admin has odd rules shows fewer records.
6. Ruling: `new_session` builds the session context with `user.with_user(user).context_get()` — `context_get()` reads `env.user`, which in the shell is OdooBot, so the spike's code would put OdooBot's language in the session (the integration test makes OdooBot French on purpose) — none.
7. Ruling: the gate cookie is named `odt_gate_<proxy port>` — cookies ignore ports, so two proxies on 127.0.0.1 sharing one name would overwrite each other's secret and lock one frame out — none.
8. Ruling: the gate URL also opens when the request already carries this proxy's gate cookie (the token is single-use only without it) — the panel reloads a frame by re-setting its `src`, which is the gate URL; a cross-origin frame's current location cannot be read — "Reload" takes a frame back to the rendered record, not to wherever the user had navigated inside Odoo.
9. Ruling: when Odoo refuses the injected session (401, or a redirect to `/web/login` for a GET), the proxy mints a new one and answers `302` to the same URL, **at most once per 30 s**; otherwise Odoo's response passes through — a server that never accepts the shell's session (another data dir, a db-filter) would otherwise loop forever — the login page shows in that frame, and the panel says nothing more specific.
10. Ruling: a `Location` pointing at the backend's own loopback origin is rewritten to a relative path — Odoo already builds URLs on the passed-through `Host`; a relative path stays right behind `asExternalUri` forwarding — an absolute redirect to another host is left alone.
11. Ruling: text interpolated into SQL is hex-encoded (`convert_from(decode('<hex>', 'hex'), 'UTF8')`) — hex digits cannot close a literal, so a view name or external id can never change the query — slightly longer SQL.
12. Ruling: match tier 3 (same model, type and name) applies only when exactly one view has that name; several namesakes go to the QuickPick, namesakes first — picking one of several silently is a guess — one more pick in rare cases.
13. Ruling: outside Upgrade mode, Compare's left side is the database the user picks and the right side is the tree's database; neither is read-only — read-only is defined only for the Upgrade-mode From database — none.
14. Ruling: one render tab at a time, reused by the next Render; `retainContextWhenHidden: true`; the HTML is rebuilt for every state change (new render, record step, server started) and frames reload by `postMessage`; a save reloads only the frames of the saved view's database — switching tabs must not reload two Odoo clients; the other side keeps whatever the user was doing — more memory while the tab is hidden.
15. Ruling: the toolbar has Reload, Previous record, Next record and New record (the last three for form views only); "Previous" is the newer record — the brief's "Same record / next record" leaves the controls open, and both sides always show the same record by construction — none.
16. Ruling: outside Upgrade mode a side with no server offers **Start Server** (`odoo.startServer`, which serves the selected database); in Upgrade mode **Start Both Servers** — `odoo.startBothServers` refuses outside Upgrade mode — none.
17. Ruling: in Upgrade mode, Render on a view with no counterpart in the original database renders the upgraded side alone with a notice; dismissing the counterpart QuickPick cancels the render — a view the upgrade created still deserves a render — none.
18. Ruling: the Render action stays visible on QWeb rows and answers with the message of ruling 3; the row `contextValue` is unchanged — adding the type to it would break every existing menu regex — one click to learn it does not render.
19. Ruling: "no record in both databases" is tested at the `RenderSession` level with fakes; the real-Odoo tests cover `recent_ids` agreeing on a database and its copy, and `make_action` — disjoint ids are hard to produce on a copy without writing records into it — none.
20. Ruling: changing `odooDebugger.views.allowEditOriginal` fires a change event for every open arch, so VS Code re-reads their permissions — otherwise only newly opened arches follow the setting — none.
21. Ruling: work directly on `v-1.5`, no worktree — it is already the feature branch and is never merged — none.
22. Ruling: Compare and Render catch their own errors and show them with `showError` — `registerCommand` only reports store refusals — none.

## Review Focus

The five uncovered-by-spec conditions most likely to bite, each pinned by a test in the owning task:

1. **Two proxies on one loopback address share a cookie jar.** A gate cookie from the original side's proxy must not open the upgraded side's, and must not overwrite it (Task 3, test "a gate cookie for another proxy opens nothing").
2. **Reloading a frame re-requests its used gate URL.** It must land on the page again, not on a 403 (Task 3, test "the gate opens once, then again only with its cookie").
3. **OdooBot's language leaks into the minted session.** With a French OdooBot, the admin session's `user_context.lang` must be the admin's `en_US` (Task 1, integration test "new_session mints an admin session a running server accepts").
4. **A server that never accepts the minted session.** The proxy must re-mint once, then let the login page through rather than loop (Task 3, test "a refused session is minted again once, then passes through").
5. **View names with markup or quotes** in the panel header and in SQL. They must be escaped in HTML (Task 7, test "escapes names") and must not change SQL (Task 2, test "text is hex-encoded").

---

## File structure

**Create:**
- `src/services/views/viewMatch.ts`: pure. Which row in the other database is "the same view".
- `src/services/views/odooFrameProxy.ts`: the gated per-database reverse proxy. Node only, no `vscode` import.
- `src/services/views/renderPlan.ts`: pure. Frame paths per series, common record ids, QWeb messages.
- `src/services/views/renderSession.ts`: turns render targets into panel state; deps injected.
- `src/views/viewPairing.ts`: Upgrade-mode pair, read-only rule, other-database pick, counterpart lookup (QuickPick), diff arguments.
- `src/views/viewRenderPanel.ts`: the panel HTML (pure) and the `WebviewPanel` wrapper.
- Tests: `src/test/viewMatch.test.ts`, `src/test/odooFrameProxy.test.ts`, `src/test/renderPlan.test.ts`, `src/test/renderSession.test.ts`, `src/test/viewPairing.test.ts`, `src/test/viewRenderPanel.test.ts`, `src/test/viewService.test.ts`.

**Modify:**
- `resources/scripts/view_worker.py`: `new_session`, `make_action`, `recent_ids`.
- `src/services/views/viewService.ts`: `newSession`, `makeAction`, `recentIds`, `RenderAction`.
- `src/services/views/viewQueries.ts`: `sqlText`, `viewByXmlidSql`/`findViewByXmlid`, `viewsLikeSql`/`findViewsLike`.
- `src/views/viewFileSystem.ts`: injected `isReadOnly`.
- `src/commands/viewDoctorCommands.ts`, `src/commands/index.ts`: `viewDoctor.compare`, `viewDoctor.render`, `viewRender` dep.
- `src/extension.ts`: read-only predicate, setting listener, render panel, reload on save.
- `package.json`: two commands, menus, the setting.
- `src/test/viewWorker.integration.test.ts`, `src/test/viewFileSystem.test.ts`, `src/test/viewQueries.test.ts`, `src/test/viewDoctorView.test.ts`.
- `CHANGELOG.md`, `README.md`, `dist/` (last task).

---

### Task 1: Worker commands for rendering

**Files:**
- Modify: `resources/scripts/view_worker.py` (new functions before `COMMANDS`, entries in `COMMANDS`)
- Modify: `src/services/views/viewService.ts`
- Create: `src/test/viewService.test.ts`
- Modify: `src/test/viewWorker.integration.test.ts`

**Interfaces:**
- Consumes: `ViewWorkerPool.run<T>(dbName, cmd, args)`; worker helpers `_view`, `_root`, `_signal`, `Refused`.
- Produces:
  - Worker commands: `new_session {}` → `{ sid }`; `make_action { view_id }` → `{ action_id, model, view_type, root_id, series }`; `recent_ids { model, limit=200 }` → `{ ids }` (newest first).
  - `export interface RenderAction { actionId: number; model: string; viewType: string; rootId: number; series: string }` in `viewService.ts`.
  - `ViewService.newSession(dbName): Promise<string>`, `ViewService.makeAction(dbName, viewId): Promise<RenderAction>`, `ViewService.recentIds(dbName, model, limit = 200): Promise<number[]>`.
  - In the integration test file: helpers `freePort()`, `startOdooServer(dbName)`, `jsonRpc(port, route, sid)`, `forgetSessions()`, and the suite-level array `mintedSids` (Task 3 reuses them).

- [ ] **Step 1: Write the failing unit test** — `src/test/viewService.test.ts`:

```ts
import * as assert from 'assert';
import { ViewService } from '../services/views/viewService';
import type { ViewWorkerPool } from '../services/views/viewWorkerPool';

function fakePool(replies: Record<string, unknown>, calls: Array<[string, string, unknown]>): ViewWorkerPool {
    return {
        run: async (dbName: string, cmd: string, args: Record<string, unknown> = {}) => {
            calls.push([dbName, cmd, args]);
            return replies[cmd];
        }
    } as unknown as ViewWorkerPool;
}

suite('View service render commands', () => {
    test('mints a session, makes an action and lists recent ids through the shell', async () => {
        const calls: Array<[string, string, unknown]> = [];
        const service = new ViewService(fakePool({
            new_session: { sid: 'abc' },
            make_action: { action_id: 41, model: 'res.partner', view_type: 'form', root_id: 7, series: 'saas~17.2' },
            recent_ids: { ids: [9, 5] }
        }, calls));
        assert.strictEqual(await service.newSession('shop-18'), 'abc');
        assert.deepStrictEqual(await service.makeAction('shop-18', 12),
            { actionId: 41, model: 'res.partner', viewType: 'form', rootId: 7, series: 'saas~17.2' });
        assert.deepStrictEqual(await service.recentIds('shop-18', 'res.partner'), [9, 5]);
        assert.deepStrictEqual(calls, [
            ['shop-18', 'new_session', {}],
            ['shop-18', 'make_action', { view_id: 12 }],
            ['shop-18', 'recent_ids', { model: 'res.partner', limit: 200 }]
        ]);
    });
});
```

- [ ] **Step 2: Run it and see it fail**

Run (outside the sandbox): `npm run compile-tests` → expected: TS errors `Property 'newSession' does not exist on type 'ViewService'` (compile-tests fails, which counts as the failing run).

- [ ] **Step 3: Add the ViewService methods** — in `src/services/views/viewService.ts`, after `SaveResult`:

```ts
/** A window action that opens a view's root, made by the database's shell. */
export interface RenderAction {
    actionId: number;
    model: string;
    /** The root's view type, or the list type for a search view. */
    viewType: string;
    rootId: number;
    /** odoo.release.serie of the database's code, e.g. "17.0" or "saas~17.2". */
    series: string;
}
```

and in `ViewService`, after `deactivate`:

```ts
    /** An admin session id the database's running server accepts. */
    async newSession(dbName: string): Promise<string> {
        return (await this.pool.run<{ sid: string }>(dbName, 'new_session')).sid;
    }

    async makeAction(dbName: string, viewId: number): Promise<RenderAction> {
        const raw = await this.pool.run<{ action_id: number; model: string; view_type: string; root_id: number; series: string }>(
            dbName, 'make_action', { view_id: viewId });
        return { actionId: raw.action_id, model: raw.model, viewType: raw.view_type, rootId: raw.root_id, series: raw.series };
    }

    /** The newest ids of a model the render user can open, newest first. */
    async recentIds(dbName: string, model: string, limit = 200): Promise<number[]> {
        return (await this.pool.run<{ ids: number[] }>(dbName, 'recent_ids', { model, limit })).ids;
    }
```

Note `pool.run(dbName, 'new_session')` passes the default `{}`; the fake records it as `{}` because the fake's default is `{}` too.

- [ ] **Step 4: Add the worker commands** — in `resources/scripts/view_worker.py`, after `cmd_deactivate`:

```python
def _render_user(env):
    """The user the render frames act as: the first active internal user
    with Settings access, lowest id first - `admin` on most databases. The
    group field moved: all_group_ids on 19, groups_id before."""
    users = env['res.users']
    field = next((name for name in ('all_group_ids', 'groups_id', 'group_ids') if name in users._fields), None)
    user = users.browse()
    if field:
        group = env.ref('base.group_system')
        user = users.search([(field, 'in', group.ids), ('share', '=', False)], order='id', limit=1)
    if not user:
        raise Refused('No active user of this database has the Settings access a render needs.')
    return user


def cmd_new_session(env):
    """An admin session saved in the session store the database's server
    reads (both use the version's data dir), as odoo-manager's connect_as
    mints one. context_get() reads env.user, which here is OdooBot: it runs
    as the user, so the session gets the user's own language."""
    from odoo.http import root
    user = _render_user(env)
    store = root.session_store
    session = store.new()
    session.db = env.cr.dbname
    session.uid = user.id
    session.login = user.login
    session.session_token = user._compute_session_token(session.sid)
    session.context = dict(user.with_user(user).context_get() or {})
    store.save(session)
    return {'sid': session.sid}


def _list_type(env):
    # 18.0 renamed the list view type from 'tree' to 'list'.
    types = dict(env['ir.ui.view']._fields['type'].selection)
    return 'list' if 'list' in types else 'tree'


def cmd_make_action(env, view_id):
    """A window action opening the view's root, made once per (model, view)
    and reused; never deleted. The record goes in the URL, never on the
    action: the web client caches actions by id, so a res_id written onto a
    reused action can show a stale record."""
    root = _root(_view(env, view_id))
    if root.type == 'qweb':
        raise Refused('QWeb templates render inside the page that uses them; open it from Odoo.')
    if not root.model:
        raise Refused('This view has no model to render.')
    if root.model not in env:
        raise Refused('Model %s is not installed in this database.' % root.model)
    name = '[View Doctor] %s #%d' % (root.model, root.id)
    vals = {'name': name, 'res_model': root.model, 'res_id': False, 'target': 'current'}
    if root.type == 'search':
        view_type = _list_type(env)
        vals.update(view_mode=view_type, view_id=False, search_view_id=root.id)
    else:
        view_type = root.type
        vals.update(view_mode=view_type, view_id=root.id, search_view_id=False)
    actions = env['ir.actions.act_window']
    action = actions.search([('name', '=', name), ('res_model', '=', root.model)], limit=1)
    if action:
        action.write(vals)
    else:
        action = actions.create(vals)
    env.cr.commit()
    _signal(env)
    return {'action_id': action.id, 'model': root.model, 'view_type': view_type, 'root_id': root.id,
            'series': odoo.release.serie}


def cmd_recent_ids(env, model, limit=200):
    """The newest records of a model that the render user can open, newest
    first; none for a model this database does not have."""
    if model not in env or env[model]._abstract:
        return {'ids': []}
    user = _render_user(env)
    try:
        records = env[model].with_user(user).search([], order='id desc', limit=int(limit))
    except odoo.exceptions.AccessError:
        return {'ids': []}
    return {'ids': records.ids}
```

(`selection` is a static list on `ir.ui.view.type` in 15–19.) Then extend `COMMANDS`:

```python
COMMANDS = {
    'get_arch': cmd_get_arch,
    'save': cmd_save,
    'activate': cmd_activate,
    'deactivate': cmd_deactivate,
    'new_session': cmd_new_session,
    'make_action': cmd_make_action,
    'recent_ids': cmd_recent_ids,
}
```

- [ ] **Step 5: Run the unit test and see it pass**

Run (outside the sandbox): `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "View service render commands"` → expected: 1 passing.

- [ ] **Step 6: Write the integration tests** — in `src/test/viewWorker.integration.test.ts`:

Add imports at the top:

```ts
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { waitForPort } from '../services/server';
```

Add these helpers after `templatesCacheSignal`:

```ts
/** A loopback port nothing listens on right now. */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as net.AddressInfo;
            probe.close(() => resolve(port));
        });
    });
}

/** A JSON-RPC call with this session; resolves with `result`, rejects with Odoo's error. */
function jsonRpc(port: number, route: string, sid: string, extraCookie = ''): Promise<any> {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {} });
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1', port, path: route, method: 'POST',
            headers: { 'content-type': 'application/json', cookie: [extraCookie, `session_id=${sid}`].filter(Boolean).join('; ') }
        }, response => {
            let text = '';
            response.setEncoding('utf-8');
            response.on('data', chunk => text += chunk);
            response.on('end', () => {
                try {
                    const parsed = JSON.parse(text);
                    if (parsed.error) {
                        reject(new Error(JSON.stringify(parsed.error)));
                    } else {
                        resolve(parsed.result);
                    }
                } catch (error) {
                    reject(new Error(`${response.statusCode}: ${text.slice(0, 300)}`));
                }
            });
        });
        request.on('error', reject);
        request.end(body);
    });
}
```

Inside the suite, next to `let workersStarted = 0;`, add:

```ts
    /** Sessions the tests minted, removed from Odoo's session store afterwards. */
    const mintedSids: string[] = [];

    /** Removes the session files this suite minted: sessions/<sid[:2]>/<prefix of sid> (16+) or werkzeug_<sid>.sess (15). */
    const forgetSessions = () => {
        const store = path.join(os.homedir(), '.local', 'share', 'Odoo', 'sessions');
        for (const sid of mintedSids.splice(0)) {
            fs.rmSync(path.join(store, `werkzeug_${sid}.sess`), { force: true });
            const folder = path.join(store, sid.slice(0, 2));
            for (const name of fs.existsSync(folder) ? fs.readdirSync(folder) : []) {
                if (sid.startsWith(name)) {
                    fs.rmSync(path.join(folder, name), { force: true });
                }
            }
        }
    };

    /** An Odoo server on the database, on a free loopback port, with no cron. */
    const startOdooServer = async (dbName: string) => {
        const port = await freePort();
        const server = spawn(python!, [
            `${odoo}/odoo-bin`, '--addons-path', addonsPaths.join(','), '-d', dbName, `--db-filter=^${dbName}$`,
            '--http-interface=127.0.0.1', '-p', String(port), '--max-cron-threads=0'
        ], { stdio: 'ignore' });
        const exited = once(server, 'exit');
        if (!await waitForPort(port, 120000)) {
            server.kill();
            await exited;
            assert.fail('the Odoo server did not start');
        }
        return { port, stop: async () => { server.kill(); await exited; } };
    };
```

In `suiteTeardown`, add `forgetSessions();` as its first line.

Insert these tests **before** the test `'dropping the database ends another window\'s shell on it too'` (it must stay last):

```ts
    test('make_action opens the view\'s root, reused, with the record left to the URL', async () => {
        const rootId = Number(await runSql(copy, "SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'view_partner_form';"));
        const first = await service.makeAction(copy, viewId);
        assert.deepStrictEqual([first.model, first.viewType, first.rootId], ['res.partner', 'form', rootId]);
        assert.match(first.series, /\d+\.\d+/);
        const again = await service.makeAction(copy, viewId);
        assert.strictEqual(again.actionId, first.actionId);
        // A res_id on a reused action goes stale in the web client's cache.
        assert.strictEqual(await runSql(copy,
            `SELECT view_id || ':' || coalesce(res_id, 0) || ':' || view_mode FROM ir_act_window WHERE id = ${first.actionId};`), `${rootId}:0:form`);
    });

    test('make_action refuses a QWeb template and opens a search view as a list', async () => {
        const qweb = Number(await runSql(copy, "SELECT id FROM ir_ui_view WHERE type = 'qweb' ORDER BY id LIMIT 1;"));
        await assert.rejects(service.makeAction(copy, qweb), /QWeb templates/);
        const search = Number(await runSql(copy, "SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'view_res_partner_filter';"));
        const action = await service.makeAction(copy, search);
        assert.ok(['list', 'tree'].includes(action.viewType), action.viewType);
        assert.strictEqual(await runSql(copy, `SELECT search_view_id FROM ir_act_window WHERE id = ${action.actionId};`), String(search));
    });

    test('recent_ids gives the same newest records in a database and its copy', async () => {
        try {
            const [original, copied] = await Promise.all([service.recentIds(sourceDb!, 'res.partner'), service.recentIds(copy, 'res.partner')]);
            assert.ok(original.length > 0, 'no partner in the source database');
            assert.deepStrictEqual(copied, original);
            assert.deepStrictEqual([...original].sort((a, b) => b - a), original, 'newest first');
            assert.deepStrictEqual(await service.recentIds(copy, 'odt.no.such.model'), []);
        } finally {
            // A shell left on the source database blocks the next run's copy of it.
            await pool.release(sourceDb!);
        }
    });

    test('new_session mints an admin session a running server accepts, in the admin\'s language', async () => {
        const sid = await service.newSession(copy);
        mintedSids.push(sid);
        const server = await startOdooServer(copy);
        try {
            const info = await jsonRpc(server.port, '/web/session/get_session_info', sid);
            assert.strictEqual(info.is_admin, true);
            // OdooBot, whose language the shell runs in, is French here.
            assert.strictEqual(info.user_context.lang, 'en_US');
        } finally {
            await server.stop();
        }
    });
```

- [ ] **Step 7: Run the integration suite on 17, 18 and 19**

Build the base DBs if `psql -lqt | cut -d'|' -f1 | grep -w odt_view_base_$v` shows none (handover §5 command, per `v`). Then, outside the sandbox, for each `v` in 17 18 19:

```bash
npm run compile-tests && ODT_VIEW_TEST_PYTHON=/home/odoo/odoo-dev/venv-$v.0/bin/python ODT_VIEW_TEST_ODOO=/home/odoo/odoo-dev/odoo-$v.0 \
  ODT_VIEW_TEST_DB=odt_view_base_$v env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "View worker against a real Odoo"
```

Expected: every test passes on each version (17 tests). If `new_session` fails on one version, fix the worker for that version (look the API up in `/home/odoo/odoo-dev/odoo-$v.0/odoo/http.py`), never by skipping. Report the exact counts per version.

- [ ] **Step 8: Type check, lint, commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist
git add resources/scripts/view_worker.py src/services/views/viewService.ts src/test/viewService.test.ts src/test/viewWorker.integration.test.ts
git commit -m "[ADD] Mint an admin session and a render action from a database's shell

The render tab needs three things from each database: an admin session the
running server accepts, a window action that opens the view's root, and the
newest records the admin can open, so both sides can show the same one.
The record goes in the frame's URL, never on the reused action: the web
client caches actions by id.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Find the same view in another database

**Files:**
- Modify: `src/services/views/viewQueries.ts`
- Create: `src/services/views/viewMatch.ts`
- Create: `src/test/viewMatch.test.ts`
- Modify: `src/test/viewQueries.test.ts`

**Interfaces:**
- Consumes: `ViewRow`, `viewRowsSql`, `parseViewRows`, `sqlIdList`, `runSql`.
- Produces:
  - `sqlText(value: string): string`
  - `viewByXmlidSql(xmlid: string): string | undefined`, `findViewByXmlid(dbName, xmlid): Promise<ViewRow | undefined>`
  - `viewsLikeSql(view: Pick<ViewRow, 'id' | 'model' | 'type'>): string`, `findViewsLike(dbName, view): Promise<ViewRow[]>`
  - `viewMatch.ts`: `export interface CounterpartRows { byXmlid?: ViewRow; rows: ViewRow[] }`, `export type ViewMatch = { kind: 'xmlid' | 'id' | 'name'; view: ViewRow } | { kind: 'pick'; candidates: ViewRow[] } | { kind: 'none' }`, `export function matchView(source: ViewRow, found: CounterpartRows): ViewMatch`.

- [ ] **Step 1: Write the failing tests**

`src/test/viewMatch.test.ts`:

```ts
import * as assert from 'assert';
import { matchView } from '../services/views/viewMatch';
import type { ViewRow } from '../services/views/viewQueries';

function row(id: number, overrides: Partial<ViewRow> = {}): ViewRow {
    return {
        id, name: `view ${id}`, model: 'res.partner', type: 'form', active: true,
        inheritId: 1, xmlid: null, rootId: 1, isReport: false, writeDate: 0, ...overrides
    };
}

suite('Matching a view across databases', () => {
    const source = row(40, { name: 'partner.custom', xmlid: 'acme.partner_custom' });

    test('the same external id wins over everything', () => {
        const byXmlid = row(77, { name: 'renamed', model: 'res.partner' });
        assert.deepStrictEqual(matchView(source, { byXmlid, rows: [row(40), byXmlid] }), { kind: 'xmlid', view: byXmlid });
    });

    test('then the same id, when its model and type agree', () => {
        const same = row(40, { name: 'whatever' });
        assert.deepStrictEqual(matchView(source, { rows: [row(41, { name: 'partner.custom' }), same] }), { kind: 'id', view: same });
        // Id 40 is another model's view in that database: not the same view.
        const other = row(40, { model: 'res.users' });
        assert.strictEqual(matchView(source, { rows: [other] }).kind, 'none');
    });

    test('then the one view with the same model, type and name', () => {
        const named = row(52, { name: 'partner.custom' });
        assert.deepStrictEqual(matchView(source, { rows: [row(51), named] }), { kind: 'name', view: named });
    });

    test('several namesakes, or none, go to a pick, namesakes and the same kind of view first', () => {
        const a = row(60, { name: 'partner.custom' });
        const b = row(61, { name: 'partner.custom' });
        const other = row(59);
        assert.deepStrictEqual(matchView(source, { rows: [b, other, a] }), { kind: 'pick', candidates: [a, b, other] });

        const base = row(70, { inheritId: null, rootId: 70 });
        const extension = row(71);
        const listView = row(72, { type: 'list' });
        assert.deepStrictEqual(matchView(source, { rows: [base, listView, extension] }), { kind: 'pick', candidates: [extension, base] });
    });

    test('nothing of that model and type means no match', () => {
        assert.deepStrictEqual(matchView(source, { rows: [row(80, { type: 'kanban' })] }), { kind: 'none' });
        assert.deepStrictEqual(matchView(source, { rows: [] }), { kind: 'none' });
    });
});
```

Append to `src/test/viewQueries.test.ts` (extend the import with `runSql` from `'../services/postgres'` and `sqlText, viewByXmlidSql, viewsLikeSql` from the queries module):

```ts
suite('View queries over text', () => {
    test('text is hex-encoded, so no quote in it reaches the SQL', () => {
        const evil = "x'); DROP TABLE ir_ui_view; --";
        const sql = viewsLikeSql({ id: 5, model: evil, type: 'form' });
        assert.ok(!sql.includes("x'"), sql);
        assert.ok(sql.includes(`decode('${Buffer.from(evil, 'utf-8').toString('hex')}', 'hex')`));
        assert.ok(sql.includes('v.id = 5 OR'));
        assert.throws(() => viewsLikeSql({ id: -1, model: 'res.partner', type: 'form' }), /Not a view id/);
    });

    test('an external id is split into module and name, and needs both', () => {
        const sql = viewByXmlidSql('studio_customization.odoo_studio_x.y');
        assert.ok(sql?.includes(`d.module = ${sqlText('studio_customization')}`));
        assert.ok(sql?.includes(`d.name = ${sqlText('odoo_studio_x.y')}`));
        assert.strictEqual(viewByXmlidSql('no_dot'), undefined);
        assert.strictEqual(viewByXmlidSql('.name'), undefined);
    });

    test('PostgreSQL reads the text back exactly', async function () {
        const value = "it's — ✓ \\ \"q\"";
        let output: string;
        try {
            output = await runSql('postgres', `SELECT ${sqlText(value)};`);
        } catch {
            this.skip();
            return;
        }
        assert.strictEqual(output, value);
    });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npm run compile-tests` → expected: errors, `Cannot find module '../services/views/viewMatch'` and missing exports `sqlText`, `viewByXmlidSql`, `viewsLikeSql`.

- [ ] **Step 3: Implement the queries** — in `src/services/views/viewQueries.ts`:

Change the header's last two sentences to: `Ids are validated integers and text goes in hex-encoded (sqlText); nothing else is ever interpolated.`

After `sqlIdList`, add:

```ts
/**
 * Text for embedding in SQL. Hex digits cannot close a literal, so no value
 * - a model, a view name, an external id - can change the query.
 */
export function sqlText(value: string): string {
    return `convert_from(decode('${Buffer.from(value, 'utf-8').toString('hex')}', 'hex'), 'UTF8')`;
}
```

After `getWriteDates`, add:

```ts
/** The query for the view with this external id; undefined for a string that is not module.name. */
export function viewByXmlidSql(xmlid: string): string | undefined {
    const dot = xmlid.indexOf('.');
    if (dot <= 0 || dot === xmlid.length - 1) {
        return undefined;
    }
    return viewRowsSql(`v.id IN (SELECT d.res_id FROM ir_model_data d WHERE d.model = 'ir.ui.view'
        AND d.module = ${sqlText(xmlid.slice(0, dot))} AND d.name = ${sqlText(xmlid.slice(dot + 1))})`);
}

/** The view with this external id, if the database has one. */
export async function findViewByXmlid(dbName: string, xmlid: string): Promise<ViewRow | undefined> {
    const sql = viewByXmlidSql(xmlid);
    return sql ? parseViewRows(await runSql(dbName, sql))[0] : undefined;
}

/** The query for the view with this id and every view of the same model and type. */
export function viewsLikeSql(view: Pick<ViewRow, 'id' | 'model' | 'type'>): string {
    return viewRowsSql(`(v.id = ${sqlIdList([view.id])} OR (v.model = ${sqlText(view.model)} AND v.type = ${sqlText(view.type)}))`);
}

/** What matching a view of another database picks from: the same id, and its model and type's views. */
export async function findViewsLike(dbName: string, view: Pick<ViewRow, 'id' | 'model' | 'type'>): Promise<ViewRow[]> {
    return parseViewRows(await runSql(dbName, viewsLikeSql(view)));
}
```

- [ ] **Step 4: Implement the matching** — `src/services/views/viewMatch.ts`:

```ts
/**
 * Which view of another database is "the same view": by external id, then
 * by id when the model and type agree (an upgraded database is a copy, so
 * ids carry over), then by the one view with the same model, type and name.
 * Anything less certain is left to the user, likeliest first.
 */
import type { ViewRow } from './viewQueries';

export interface CounterpartRows {
    /** The view with the source's external id there, if any. */
    byXmlid?: ViewRow;
    /** The view with the source's id, and every view of its model and type. */
    rows: ViewRow[];
}

export type ViewMatch =
    | { kind: 'xmlid' | 'id' | 'name'; view: ViewRow }
    | { kind: 'pick'; candidates: ViewRow[] }
    | { kind: 'none' };

export function matchView(source: ViewRow, found: CounterpartRows): ViewMatch {
    if (found.byXmlid) {
        return { kind: 'xmlid', view: found.byXmlid };
    }
    const similar = found.rows.filter(view => view.model === source.model && view.type === source.type);
    const sameId = similar.find(view => view.id === source.id);
    if (sameId) {
        return { kind: 'id', view: sameId };
    }
    const named = similar.filter(view => view.name === source.name);
    if (named.length === 1) {
        return { kind: 'name', view: named[0] };
    }
    if (similar.length === 0) {
        return { kind: 'none' };
    }
    const isBase = (view: ViewRow) => view.inheritId === null;
    const likeness = (view: ViewRow) => (view.name === source.name ? 2 : 0) + (isBase(view) === isBase(source) ? 1 : 0);
    return { kind: 'pick', candidates: [...similar].sort((a, b) => likeness(b) - likeness(a) || a.id - b.id) };
}
```

- [ ] **Step 5: Run the tests and see them pass**

Run (outside the sandbox): `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Matching a view|View queries"` → expected: all pass (the PostgreSQL test passes or is pending if psql is unreachable; it is reachable on this machine, so expect a pass).

- [ ] **Step 6: Type check, lint, commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist
git add src/services/views/viewQueries.ts src/services/views/viewMatch.ts src/test/viewMatch.test.ts src/test/viewQueries.test.ts
git commit -m "[ADD] Find a view's counterpart in another database

By external id first, then the same id when model and type agree, then the
one view with the same model, type and name; anything less certain becomes
a pick, likeliest first. Text reaches SQL hex-encoded, so a view name can
never change the query.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The gated frame proxy

**Files:**
- Create: `src/services/views/odooFrameProxy.ts`
- Create: `src/test/odooFrameProxy.test.ts`
- Modify: `src/test/viewWorker.integration.test.ts` (one end-to-end test)

**Interfaces:**
- Consumes: nothing from earlier tasks in the class itself; the integration test uses Task 1's `service.newSession`, `startOdooServer`, `jsonRpc`, `mintedSids`.
- Produces (`odooFrameProxy.ts`):
  - `export const GATE_PATH = '/__odt/open'`
  - `export interface FrameProxyOptions { targetPort: number; mintSession(): Promise<string>; refreshIntervalMs?: number }`
  - `export class OdooFrameProxy { readonly targetPort: number; get port(): number; listen(): Promise<number>; session(): Promise<string>; gatePath(next: string): string; close(): Promise<void> }`
  - `export function rewriteLocation(location: string, targetPort: number): string`, `export function withoutFrameAncestors(csp: string): string | undefined`, `export function forwardedCookie(header: string | undefined, sid: string): string`

- [ ] **Step 1: Write the failing unit tests** — `src/test/odooFrameProxy.test.ts`:

```ts
import * as assert from 'assert';
import * as http from 'node:http';
import * as net from 'node:net';
import { OdooFrameProxy, forwardedCookie, rewriteLocation, withoutFrameAncestors } from '../services/views/odooFrameProxy';

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, path: string, options: { cookie?: string; method?: string } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.cookie ? { cookie: options.cookie } : {} }, res => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

/** The gate cookie a proxy hands out, as a Cookie header value. */
async function openGate(proxy: OdooFrameProxy, next = '/odoo'): Promise<string> {
    const reply = await request(proxy.port, proxy.gatePath(next));
    assert.strictEqual(reply.status, 302);
    return String(reply.headers['set-cookie']?.[0]).split(';')[0];
}

suite('Odoo frame proxy', () => {
    let upstream: http.Server;
    let upstreamPort: number;
    let seen: http.IncomingHttpHeaders[];
    let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void;
    let proxies: OdooFrameProxy[];
    let mints: number;

    const makeProxy = async (sids: string[] = ['sid-1', 'sid-2', 'sid-3'], options: { refreshIntervalMs?: number; targetPort?: number } = {}) => {
        const proxy = new OdooFrameProxy({
            targetPort: options.targetPort ?? upstreamPort,
            mintSession: async () => sids[Math.min(mints++, sids.length - 1)],
            refreshIntervalMs: options.refreshIntervalMs
        });
        proxies.push(proxy);
        await proxy.listen();
        return proxy;
    };

    setup(async () => {
        seen = [];
        mints = 0;
        proxies = [];
        respond = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('odoo'); };
        upstream = http.createServer((req, res) => { seen.push(req.headers); respond(req, res); });
        upstream.on('upgrade', (req, socket) => {
            seen.push(req.headers);
            socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
            socket.pipe(socket);
        });
        await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
        upstreamPort = (upstream.address() as net.AddressInfo).port;
    });

    teardown(async () => {
        await Promise.all(proxies.map(proxy => proxy.close()));
        upstream.closeAllConnections?.();
        await new Promise<void>(resolve => upstream.close(() => resolve()));
    });

    test('refuses everything without the gate cookie, and injects nothing', async () => {
        const proxy = await makeProxy();
        const reply = await request(proxy.port, '/web', { cookie: 'session_id=stolen' });
        assert.strictEqual(reply.status, 403);
        assert.strictEqual(seen.length, 0);
        assert.strictEqual(mints, 0);
    });

    test('the gate opens once, then again only with its cookie', async () => {
        const proxy = await makeProxy();
        const gate = proxy.gatePath('/odoo/action-5/7?debug=1');
        const first = await request(proxy.port, gate);
        assert.strictEqual(first.status, 302);
        assert.strictEqual(first.headers.location, '/odoo/action-5/7?debug=1');
        const cookie = String(first.headers['set-cookie']?.[0]);
        assert.match(cookie, new RegExp(`^odt_gate_${proxy.port}=[0-9a-f]{64}; Path=/; HttpOnly; Secure; SameSite=None$`));
        // Replayed by anything else: the token is spent.
        assert.strictEqual((await request(proxy.port, gate)).status, 403);
        // A frame reloading its src carries the cookie, and lands on the page again.
        assert.strictEqual((await request(proxy.port, gate, { cookie: cookie.split(';')[0] })).status, 302);
        assert.strictEqual(seen.length, 0, 'the gate itself never reaches Odoo');
    });

    test('a gate that leads off this origin is refused', async () => {
        const proxy = await makeProxy();
        for (const next of ['//evil.example/', 'https://evil.example/', '/\\evil.example', 'odoo']) {
            assert.strictEqual((await request(proxy.port, proxy.gatePath(next))).status, 403, next);
        }
    });

    test('a gate cookie for another proxy opens nothing', async () => {
        const first = await makeProxy();
        const second = await makeProxy();
        const firstCookie = await openGate(first);
        assert.strictEqual((await request(second.port, '/odoo', { cookie: firstCookie })).status, 403);
        const secondCookie = await openGate(second);
        // Both cookies reach both proxies (cookies ignore ports): each still opens only its own.
        assert.strictEqual((await request(first.port, '/odoo', { cookie: `${firstCookie}; ${secondCookie}` })).status, 200);
        assert.strictEqual((await request(second.port, '/odoo', { cookie: `${firstCookie}; ${secondCookie}` })).status, 200);
    });

    test('injects the session in place of the browser\'s own, keeps other cookies, hides the gate from Odoo', async () => {
        const proxy = await makeProxy();
        const gate = await openGate(proxy);
        const reply = await request(proxy.port, '/odoo', { cookie: `session_id=browser; cids=1; ${gate}` });
        assert.strictEqual(reply.status, 200);
        assert.strictEqual(seen[0].cookie, 'cids=1; session_id=sid-1');
        assert.strictEqual(seen[0].host, `127.0.0.1:${proxy.port}`, 'Host passes through, so Odoo builds URLs on the proxy');
    });

    test('strips the framing headers and Odoo\'s session cookie, following a rotation', async () => {
        respond = (_req, res) => {
            res.writeHead(200, {
                'x-frame-options': 'DENY',
                'content-security-policy': "frame-ancestors 'self'; default-src 'self'",
                'set-cookie': ['session_id=rotated; Path=/; HttpOnly', 'tz=UTC; Path=/']
            });
            res.end('odoo');
        };
        const proxy = await makeProxy();
        const gate = await openGate(proxy);
        const reply = await request(proxy.port, '/odoo', { cookie: gate });
        assert.strictEqual(reply.headers['x-frame-options'], undefined);
        assert.strictEqual(reply.headers['content-security-policy'], "default-src 'self'");
        assert.deepStrictEqual(reply.headers['set-cookie'], ['tz=UTC; Path=/']);
        await request(proxy.port, '/odoo', { cookie: gate });
        assert.strictEqual(seen[1].cookie, 'session_id=rotated');
    });

    test('a redirect to the backend\'s own address becomes a path', async () => {
        respond = (_req, res) => { res.writeHead(303, { location: `http://localhost:${upstreamPort}/odoo/discuss?x=1` }); res.end(); };
        const proxy = await makeProxy();
        const reply = await request(proxy.port, '/web', { cookie: await openGate(proxy) });
        assert.strictEqual(reply.headers.location, '/odoo/discuss?x=1');
        assert.strictEqual(rewriteLocation('http://example.com/odoo', upstreamPort), 'http://example.com/odoo');
        assert.strictEqual(rewriteLocation(`http://127.0.0.1:${upstreamPort}`, upstreamPort), '/');
        assert.strictEqual(rewriteLocation(`http://127.0.0.1:${upstreamPort + 1}/x`, upstreamPort), `http://127.0.0.1:${upstreamPort + 1}/x`);
    });

    test('a refused session is minted again once, then passes through', async () => {
        let accepted = 'sid-2';
        respond = (req, res) => {
            if (String(req.headers.cookie).includes(`session_id=${accepted}`)) {
                res.writeHead(200);
                res.end('in');
            } else {
                res.writeHead(303, { location: '/web/login?redirect=%2Fodoo' });
                res.end();
            }
        };
        const proxy = await makeProxy();
        const gate = await openGate(proxy);
        const retry = await request(proxy.port, '/odoo?debug=1', { cookie: gate });
        assert.deepStrictEqual([retry.status, retry.headers.location], [302, '/odoo?debug=1']);
        assert.strictEqual((await request(proxy.port, '/odoo?debug=1', { cookie: gate })).body, 'in');
        assert.strictEqual(mints, 2);

        // A server that refuses every session: one more mint, then Odoo's answer as is.
        accepted = 'never';
        assert.strictEqual((await request(proxy.port, '/odoo', { cookie: gate })).status, 303);
        assert.strictEqual(mints, 2, 'no second refresh within the interval');
    });

    test('a refused POST is not retried', async () => {
        respond = (_req, res) => { res.writeHead(401); res.end(); };
        const proxy = await makeProxy();
        const gate = await openGate(proxy);
        assert.strictEqual((await request(proxy.port, '/web/dataset/call_kw', { cookie: gate, method: 'POST' })).status, 401);
        assert.strictEqual(mints, 1);
    });

    test('pipes a websocket upgrade with the session, and refuses one without the gate', async () => {
        const proxy = await makeProxy();
        const gate = await openGate(proxy);
        const talk = (cookie: string) => new Promise<string>((resolve, reject) => {
            const socket = net.connect(proxy.port, '127.0.0.1', () => {
                socket.write(`GET /websocket HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}\r\n`);
            });
            let received = '';
            socket.setEncoding('utf-8');
            socket.on('data', chunk => {
                received += chunk;
                if (received.includes('\r\n\r\n') && received.startsWith('HTTP/1.1 101') && !received.includes('ping')) {
                    socket.write('ping');
                }
                if (received.includes('ping') || received.startsWith('HTTP/1.1 403')) {
                    socket.destroy();
                    resolve(received);
                }
            });
            socket.on('error', reject);
        });
        const piped = await talk(gate);
        assert.ok(piped.startsWith('HTTP/1.1 101') && piped.endsWith('ping'), piped);
        assert.strictEqual(seen[0].cookie, 'session_id=sid-1');
        assert.ok((await talk('')).startsWith('HTTP/1.1 403'));
        assert.strictEqual(seen.length, 1);
    });

    test('says so when no server answers, or when no session can be minted', async () => {
        const closed = await new Promise<number>(resolve => {
            const probe = net.createServer().listen(0, '127.0.0.1', () => {
                const { port } = probe.address() as net.AddressInfo;
                probe.close(() => resolve(port));
            });
        });
        const dead = await makeProxy(undefined, { targetPort: closed });
        const reply = await request(dead.port, '/odoo', { cookie: await openGate(dead) });
        assert.strictEqual(reply.status, 502);
        assert.ok(reply.body.includes(String(closed)), reply.body);

        const failing = new OdooFrameProxy({ targetPort: upstreamPort, mintSession: async () => { throw new Error('no admin'); } });
        proxies.push(failing);
        await failing.listen();
        await assert.rejects(failing.session(), /no admin/);
        const refused = await request(failing.port, '/odoo', { cookie: await openGate(failing) });
        assert.strictEqual(refused.status, 502);
        assert.ok(refused.body.includes('no admin'));
    });

    test('header helpers', () => {
        assert.strictEqual(withoutFrameAncestors("frame-ancestors 'self'"), undefined);
        assert.strictEqual(withoutFrameAncestors("default-src 'self'; frame-ancestors 'none'; img-src *"), "default-src 'self'; img-src *");
        assert.strictEqual(forwardedCookie(undefined, 's'), 'session_id=s');
        assert.strictEqual(forwardedCookie('Session_ID=x; odt_gate_123=y; frontend_lang=fr_FR', 's'), 'frontend_lang=fr_FR; session_id=s');
    });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npm run compile-tests` → expected: `Cannot find module '../services/views/odooFrameProxy'`.

- [ ] **Step 3: Implement the proxy** — `src/services/views/odooFrameProxy.ts`:

```ts
/**
 * A reverse proxy to one database's Odoo server, for the render tab's frames.
 *
 * A webview's origin is never the same site as the server, so Odoo's own
 * session cookie cannot work there: the proxy injects an admin session the
 * database's shell minted instead, strips the headers that forbid framing,
 * and hides Odoo's session cookie from the frame. Host passes through, so
 * Odoo builds its URLs on the proxy's origin.
 *
 * That makes the proxy admin for anyone who reaches its port, so it is
 * gated: the frame's first URL carries a one-time token, answered with a
 * cookie only VS Code's webview ever holds, and every request or websocket
 * without that cookie is refused before anything is forwarded. The cookie is
 * named after the proxy's port, because cookies ignore ports and the two
 * sides' proxies share 127.0.0.1.
 */
import * as http from 'node:http';
import * as net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const GATE_PATH = '/__odt/open';

export interface FrameProxyOptions {
    /** The port of the Odoo server that serves the database. */
    targetPort: number;
    /** An admin session id on the database; called again when Odoo stops accepting the current one. */
    mintSession(): Promise<string>;
    /** At most one new session per this interval after a refusal. Default 30 s. */
    refreshIntervalMs?: number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 30_000;
const LOOPBACK_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?(?=[/?#]|$)/i;

/** A redirect to the backend's own loopback origin, as a path; anything else as is. */
export function rewriteLocation(location: string, targetPort: number): string {
    const match = LOOPBACK_ORIGIN.exec(location);
    if (!match || Number(match[1] ?? 80) !== targetPort) {
        return location;
    }
    const rest = location.slice(match[0].length);
    return rest.startsWith('/') ? rest : `/${rest}`;
}

/** The policy without frame-ancestors; undefined when nothing else is left. */
export function withoutFrameAncestors(csp: string): string | undefined {
    const kept = csp.split(';').map(part => part.trim()).filter(part => part && !/^frame-ancestors\b/i.test(part));
    return kept.length > 0 ? kept.join('; ') : undefined;
}

/** The browser's cookies minus its own session and every gate, plus the injected session. */
export function forwardedCookie(header: string | undefined, sid: string): string {
    const kept = (header ?? '').split(';').map(part => part.trim())
        .filter(part => part && !/^session_id=/i.test(part) && !/^odt_gate_\d+=/i.test(part));
    return [...kept, `session_id=${sid}`].join('; ');
}

function cookieValue(header: string | undefined, name: string): string | undefined {
    for (const part of (header ?? '').split(';')) {
        const [key, ...value] = part.trim().split('=');
        if (key === name) {
            return value.join('=');
        }
    }
    return undefined;
}

function sameSecret(candidate: string | undefined, secret: string): boolean {
    if (candidate === undefined) {
        return false;
    }
    const given = Buffer.from(candidate, 'utf-8');
    const expected = Buffer.from(secret, 'utf-8');
    return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A path on this origin: not protocol-relative, not a backslash trick, not absolute. */
function isLocalPath(next: string): boolean {
    return next.startsWith('/') && !next.startsWith('//') && !next.includes('\\');
}

function plain(res: http.ServerResponse, status: number, text: string): void {
    if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    }
    res.end(text);
}

const REFUSED = 'This address only opens from the View Doctor in VS Code.';

export class OdooFrameProxy {
    private readonly server: http.Server;
    private readonly secret = randomBytes(32).toString('hex');
    private readonly tokens = new Set<string>();
    private readonly sockets = new Set<net.Socket>();
    private sid: string | undefined;
    private minting: Promise<string> | undefined;
    private lastRefresh = Number.NEGATIVE_INFINITY;
    private listening: Promise<number> | undefined;
    private boundPort = 0;

    constructor(private readonly options: FrameProxyOptions) {
        this.server = http.createServer((req, res) => void this.handle(req, res));
        this.server.on('connection', socket => this.track(socket));
        this.server.on('upgrade', (req, socket, head) => void this.upgrade(req, socket as net.Socket, head));
    }

    get targetPort(): number {
        return this.options.targetPort;
    }

    get port(): number {
        return this.boundPort;
    }

    private get gateCookie(): string {
        return `odt_gate_${this.boundPort}`;
    }

    listen(): Promise<number> {
        this.listening ??= new Promise<number>((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => {
                this.server.off('error', reject);
                this.server.on('error', () => undefined);
                this.boundPort = (this.server.address() as net.AddressInfo).port;
                resolve(this.boundPort);
            });
        });
        return this.listening;
    }

    /** The session to inject, minted on first use; call it early to surface a failure. */
    session(): Promise<string> {
        if (this.sid) {
            return Promise.resolve(this.sid);
        }
        this.minting ??= this.options.mintSession()
            .then(sid => {
                this.sid = sid;
                return sid;
            })
            .finally(() => {
                this.minting = undefined;
            });
        return this.minting;
    }

    /** A frame's first URL path: the token works once, and sends the frame on to `next`. */
    gatePath(next: string): string {
        const token = randomBytes(24).toString('hex');
        this.tokens.add(token);
        return `${GATE_PATH}?t=${token}&next=${encodeURIComponent(next)}`;
    }

    /** Stops listening and ends every open connection, websockets included. */
    close(): Promise<void> {
        for (const socket of this.sockets) {
            socket.destroy();
        }
        return new Promise<void>(resolve => this.server.close(() => resolve()));
    }

    private track(socket: net.Socket): void {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
    }

    private gated(cookie: string | undefined): boolean {
        return sameSecret(cookieValue(cookie, this.gateCookie), this.secret);
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://proxy');
        const gated = this.gated(req.headers.cookie);
        if (url.pathname === GATE_PATH) {
            req.resume();
            this.open(url, gated, res);
            return;
        }
        if (!gated) {
            req.resume();
            plain(res, 403, REFUSED);
            return;
        }
        let sid: string;
        try {
            sid = await this.session();
        } catch (error) {
            req.resume();
            plain(res, 502, `Could not open an Odoo session: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const upstream = http.request({
            host: '127.0.0.1',
            port: this.options.targetPort,
            method: req.method,
            path: req.url,
            headers: { ...req.headers, cookie: forwardedCookie(req.headers.cookie, sid) }
        }, up => {
            if (this.refusedSession(req, up)) {
                up.resume();
                void this.retry(req, res, sid);
                return;
            }
            res.writeHead(up.statusCode ?? 502, this.responseHeaders(up.headers));
            up.pipe(res);
        });
        upstream.on('error', error => plain(res, 502, `No Odoo server answers on port ${this.options.targetPort}: ${error.message}`));
        req.pipe(upstream);
    }

    private open(url: URL, gated: boolean, res: http.ServerResponse): void {
        const token = url.searchParams.get('t') ?? '';
        const next = url.searchParams.get('next') ?? '/';
        // A spent token still opens for the frame that holds the cookie: that is a reload.
        const allowed = this.tokens.delete(token) || gated;
        if (!allowed || !isLocalPath(next)) {
            plain(res, 403, REFUSED);
            return;
        }
        res.writeHead(302, {
            location: next,
            'set-cookie': `${this.gateCookie}=${this.secret}; Path=/; HttpOnly; Secure; SameSite=None`,
            'cache-control': 'no-store'
        });
        res.end();
    }

    /** Odoo turned the session away on a page load: worth one new session, now and then. */
    private refusedSession(req: http.IncomingMessage, up: http.IncomingMessage): boolean {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return false;
        }
        if (Date.now() - this.lastRefresh < (this.options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS)) {
            return false;
        }
        const status = up.statusCode ?? 0;
        if (status === 401) {
            return true;
        }
        const location = up.headers.location;
        return status >= 300 && status < 400 && !!location && new URL(location, 'http://proxy').pathname === '/web/login';
    }

    private async retry(req: http.IncomingMessage, res: http.ServerResponse, refused: string): Promise<void> {
        this.lastRefresh = Date.now();
        if (this.sid === refused) {
            this.sid = undefined;
        }
        try {
            await this.session();
        } catch (error) {
            plain(res, 502, `Could not open an Odoo session: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        res.writeHead(302, { location: req.url ?? '/', 'cache-control': 'no-store' });
        res.end();
    }

    private responseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
        const out: http.OutgoingHttpHeaders = { ...headers };
        delete out['x-frame-options'];
        const csp = headers['content-security-policy'];
        if (csp !== undefined) {
            const kept = withoutFrameAncestors(String(csp));
            if (kept) {
                out['content-security-policy'] = kept;
            } else {
                delete out['content-security-policy'];
            }
        }
        const cookies = headers['set-cookie'];
        if (cookies) {
            const kept = cookies.filter(cookie => {
                const match = /^\s*session_id=([^;]*)/i.exec(cookie);
                if (!match) {
                    return true;
                }
                // Odoo rotated the session: keep injecting the one it now expects.
                if (match[1]) {
                    this.sid = match[1];
                }
                return false;
            });
            if (kept.length > 0) {
                out['set-cookie'] = kept;
            } else {
                delete out['set-cookie'];
            }
        }
        if (typeof headers.location === 'string') {
            out.location = rewriteLocation(headers.location, this.options.targetPort);
        }
        return out;
    }

    private async upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
        socket.on('error', () => undefined);
        if (!this.gated(req.headers.cookie)) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            return;
        }
        let sid: string;
        try {
            sid = await this.session();
        } catch {
            socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            return;
        }
        const upstream = net.connect(this.options.targetPort, '127.0.0.1', () => {
            const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                if (req.rawHeaders[i].toLowerCase() !== 'cookie') {
                    lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
                }
            }
            lines.push(`Cookie: ${forwardedCookie(req.headers.cookie, sid)}`);
            upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
            if (head.length > 0) {
                upstream.write(head);
            }
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
        this.track(upstream);
        upstream.on('error', () => socket.destroy());
        socket.on('close', () => upstream.destroy());
    }
}
```

- [ ] **Step 4: Run the unit tests and see them pass**

Run (outside the sandbox): `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Odoo frame proxy"` → expected: 12 passing. A failure is a bug in the proxy, not in the test, unless the test contradicts the Interfaces block; fix the code.

- [ ] **Step 5: Add the end-to-end test through a real Odoo** — in `src/test/viewWorker.integration.test.ts`, import `OdooFrameProxy` from `'../services/views/odooFrameProxy'`, add this helper next to `jsonRpc`:

```ts
/** A GET through the proxy, following redirects on its origin, with the cookie jar the webview would keep. */
async function frameGet(port: number, path: string, cookies: string[]): Promise<{ status: number; headers: http.IncomingHttpHeaders; path: string }> {
    for (let hop = 0; hop < 5; hop++) {
        const reply = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
            const request = http.request({ host: '127.0.0.1', port, path, headers: { cookie: cookies.join('; ') } }, response => {
                response.resume();
                response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers }));
            });
            request.on('error', reject);
            request.end();
        });
        for (const cookie of reply.headers['set-cookie'] ?? []) {
            cookies.push(cookie.split(';')[0]);
        }
        const location = reply.headers.location;
        if (reply.status < 300 || reply.status >= 400 || !location) {
            return { ...reply, path };
        }
        assert.ok(location.startsWith('/'), `a redirect off the proxy: ${location}`);
        path = location.split('#')[0];
    }
    throw new Error('too many redirects');
}
```

and this test right after the `new_session` test:

```ts
    test('the frame proxy opens the rendered view on a real server, as admin, framable', async () => {
        const action = await service.makeAction(copy, viewId);
        const [record] = await service.recentIds(copy, 'res.partner');
        const server = await startOdooServer(copy);
        const proxy = new OdooFrameProxy({
            targetPort: server.port,
            mintSession: async () => {
                const sid = await service.newSession(copy);
                mintedSids.push(sid);
                return sid;
            }
        });
        try {
            await proxy.listen();
            const modern = !/^(1[0-6]\.|17\.0|saas~17\.1)/.test(action.series);
            const next = modern ? `/odoo/action-${action.actionId}/${record}?debug=1` : `/web?debug=1#action=${action.actionId}&id=${record}&view_type=form`;
            const cookies: string[] = [];
            const page = await frameGet(proxy.port, proxy.gatePath(next), cookies);
            assert.strictEqual(page.status, 200, `ended on ${page.path}`);
            assert.ok(!page.path.startsWith('/web/login'), 'Odoo did not accept the minted session');
            assert.strictEqual(page.headers['x-frame-options'], undefined);
            assert.ok(!/frame-ancestors/.test(String(page.headers['content-security-policy'] ?? '')));
            assert.ok(!cookies.some(cookie => cookie.startsWith('session_id=')), 'Odoo\'s session cookie reached the frame');
            const gate = cookies.find(cookie => cookie.startsWith('odt_gate_'))!;
            const info = await jsonRpc(proxy.port, '/web/session/get_session_info', 'ignored-by-the-proxy', gate);
            assert.strictEqual(info.is_admin, true);
        } finally {
            await proxy.close();
            await server.stop();
        }
    });
```

(`jsonRpc` sends `session_id=ignored-by-the-proxy`; the proxy replaces it, which is the point.)

- [ ] **Step 6: Run the integration suite on 17, 18, 19** — the Task 1 Step 7 command per version. Expected: all pass (18 tests).

- [ ] **Step 7: Type check, lint, commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist
git add src/services/views/odooFrameProxy.ts src/test/odooFrameProxy.test.ts src/test/viewWorker.integration.test.ts
git commit -m "[ADD] Proxy a database's Odoo for a VS Code frame, behind a gate

A webview frame cannot use Odoo's own session cookie, and Odoo forbids
framing. The proxy injects the shell's admin session, strips the framing
headers, hides Odoo's session cookie and follows its rotation, and pipes
websockets. It refuses every request without a cookie that only the
webview receives, named after its port since cookies ignore ports.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Render plan and render session

**Files:**
- Create: `src/services/views/renderPlan.ts`, `src/services/views/renderSession.ts`
- Create: `src/test/renderPlan.test.ts`, `src/test/renderSession.test.ts`

**Interfaces:**
- Consumes: `RenderAction` (Task 1), `errorMessage` from `src/services/logger.ts`.
- Produces:
  - `renderPlan.ts`: `usesOdooRouter(series: string): boolean`; `export interface FramePathInput { series: string; actionId: number; model: string; viewType: string; resId?: number }`; `framePath(input): string`; `commonIds(a: number[], b: number[]): number[]`; `qwebMessage(isReport: boolean): string`; `NO_COMMON_RECORD`.
  - `renderSession.ts`: `RenderTarget { dbName; versionId?; viewId; title }`, `RenderBackend { newSession; makeAction; recentIds }`, `FrameProxyHandle { readonly port; session(); gatePath(next) }`, `FrameHost { portFor; isPortOpen; proxyFor; externalOrigin }`, `RenderSideState { key; title; detail?; url?; message?; offerStart? }`, `RenderRecordState { label; canPrevious; canNext; canNew }`, `RenderState { sides; notice?; record? }`, `class RenderSession { static prepare(targets, backend, host); state(): Promise<RenderState>; previous(): boolean; next(): boolean; newRecord(): boolean; shows(dbName): boolean; ports(): number[] }`, `RECENT_LIMIT = 200`.

- [ ] **Step 1: Write the failing tests**

`src/test/renderPlan.test.ts`:

```ts
import * as assert from 'assert';
import { commonIds, framePath, qwebMessage, usesOdooRouter } from '../services/views/renderPlan';

suite('Render plan', () => {
    test('saas~17.2 brought the /odoo URLs', () => {
        for (const series of ['saas~17.2', 'saas~17.4', '18.0', 'saas~18.3', '19.0', 'master']) {
            assert.strictEqual(usesOdooRouter(series), true, series);
        }
        for (const series of ['15.0', '16.0', 'saas~16.4', '17.0', 'saas~17.1']) {
            assert.strictEqual(usesOdooRouter(series), false, series);
        }
    });

    test('frame paths, with debug on, for a record, a new record and a list', () => {
        const base = { actionId: 41, model: 'res.partner', viewType: 'form' };
        assert.strictEqual(framePath({ ...base, series: '19.0', resId: 7 }), '/odoo/action-41/7?debug=1');
        assert.strictEqual(framePath({ ...base, series: '19.0' }), '/odoo/action-41?debug=1');
        assert.strictEqual(framePath({ ...base, series: '17.0', resId: 7 }), '/web?debug=1#action=41&model=res.partner&view_type=form&id=7');
        assert.strictEqual(framePath({ ...base, series: '17.0' }), '/web?debug=1#action=41&model=res.partner&view_type=form');
        assert.strictEqual(framePath({ ...base, viewType: 'list', series: '18.0', resId: 7 }), '/odoo/action-41?debug=1');
        assert.strictEqual(framePath({ ...base, viewType: 'tree', series: '16.0', resId: 7 }), '/web?debug=1#action=41&model=res.partner&view_type=tree');
    });

    test('common ids, newest first', () => {
        assert.deepStrictEqual(commonIds([9, 7, 5, 5], [8, 5, 7]), [7, 5]);
        assert.deepStrictEqual(commonIds([9], [8]), []);
    });

    test('QWeb says where to look instead', () => {
        assert.match(qwebMessage(true), /^Reports need a record to render/);
        assert.match(qwebMessage(false), /^QWeb templates render inside the page/);
    });
});
```

`src/test/renderSession.test.ts`:

```ts
import * as assert from 'assert';
import { NO_COMMON_RECORD } from '../services/views/renderPlan';
import { RenderSession, type FrameHost, type RenderBackend, type RenderTarget } from '../services/views/renderSession';
import type { RenderAction } from '../services/views/viewService';

const original: RenderTarget = { dbName: 'shop-17', versionId: 'v17', viewId: 40, title: 'Original · shop-17' };
const upgraded: RenderTarget = { dbName: 'shop-18', versionId: 'v18', viewId: 40, title: 'Upgraded · shop-18' };

function backend(ids: Record<string, number[]>, actions: Record<string, Partial<RenderAction> | Error> = {}): RenderBackend & { recentCalls: string[] } {
    const recentCalls: string[] = [];
    return {
        recentCalls,
        newSession: async dbName => `sid-${dbName}`,
        makeAction: async dbName => {
            const action = actions[dbName];
            if (action instanceof Error) {
                throw action;
            }
            return { actionId: dbName === 'shop-17' ? 11 : 21, model: 'res.partner', viewType: 'form', rootId: 7, series: dbName === 'shop-17' ? '17.0' : '18.0', ...action };
        },
        recentIds: async dbName => {
            recentCalls.push(dbName);
            return ids[dbName] ?? [];
        }
    };
}

function host(closedPorts: number[] = []): FrameHost {
    const ports: Record<string, number> = { 'shop-17': 8017, 'shop-18': 8018 };
    return {
        portFor: async dbName => ports[dbName],
        isPortOpen: async port => !closedPorts.includes(port),
        proxyFor: async (_dbName, port, mint) => ({
            port: port + 1000,
            session: mint,
            gatePath: next => `/__odt/open?t=x&next=${encodeURIComponent(next)}`
        }),
        externalOrigin: async origin => origin.replace('127.0.0.1', 'forwarded.example')
    };
}

const nextOf = (url: string | undefined) => decodeURIComponent(/next=([^&]*)/.exec(url ?? '')?.[1] ?? '');

suite('Render session', () => {
    test('both sides open the newest record they share, and step through the shared ones', async () => {
        const session = await RenderSession.prepare([original, upgraded], backend({ 'shop-17': [9, 7, 5], 'shop-18': [8, 7, 5] }), host());
        let state = await session.state();
        assert.deepStrictEqual(state.sides.map(side => nextOf(side.url)), [
            '/web?debug=1#action=11&model=res.partner&view_type=form&id=7',
            '/odoo/action-21/7?debug=1'
        ]);
        assert.ok(state.sides[1].url?.startsWith('http://forwarded.example:9018/__odt/open'), state.sides[1].url);
        assert.deepStrictEqual(state.record, { label: 'Record 7', canPrevious: false, canNext: true, canNew: true });
        assert.strictEqual(state.notice, undefined);
        assert.strictEqual(state.sides[0].detail, 'Odoo 17.0 · res.partner · record 7');

        assert.strictEqual(session.next(), true);
        state = await session.state();
        assert.ok(state.sides.every(side => nextOf(side.url).includes('5')));
        assert.strictEqual(session.next(), false, 'no older shared record');
        assert.strictEqual(session.newRecord(), true);
        state = await session.state();
        assert.deepStrictEqual(state.sides.map(side => nextOf(side.url)), [
            '/web?debug=1#action=11&model=res.partner&view_type=form',
            '/odoo/action-21?debug=1'
        ]);
        assert.strictEqual(state.record?.label, 'New record');
        assert.strictEqual(session.previous(), true, 'back to the newest shared record');
        assert.strictEqual(state.record?.canPrevious, true);
    });

    test('with no record in both, both sides open a new one and say so', async () => {
        const session = await RenderSession.prepare([original, upgraded], backend({ 'shop-17': [9], 'shop-18': [8] }), host());
        const state = await session.state();
        assert.strictEqual(state.notice, NO_COMMON_RECORD);
        assert.deepStrictEqual(state.sides.map(side => nextOf(side.url)), [
            '/web?debug=1#action=11&model=res.partner&view_type=form',
            '/odoo/action-21?debug=1'
        ]);
        assert.deepStrictEqual(state.record, { label: 'New record', canPrevious: false, canNext: false, canNew: false });
    });

    test('one side alone uses its newest record, or a new one', async () => {
        let state = await (await RenderSession.prepare([upgraded], backend({ 'shop-18': [8, 3] }), host())).state();
        assert.strictEqual(nextOf(state.sides[0].url), '/odoo/action-21/8?debug=1');
        assert.strictEqual(state.notice, undefined);
        state = await (await RenderSession.prepare([upgraded], backend({}), host())).state();
        assert.strictEqual(nextOf(state.sides[0].url), '/odoo/action-21?debug=1');
        assert.strictEqual(state.notice, 'res.partner has no record yet; showing a new one.');
    });

    test('a list opens as is, without looking for records', async () => {
        const fake = backend({ 'shop-18': [8] }, { 'shop-18': { viewType: 'list' } });
        const state = await (await RenderSession.prepare([upgraded], fake, host())).state();
        assert.strictEqual(nextOf(state.sides[0].url), '/odoo/action-21?debug=1');
        assert.strictEqual(state.record, undefined);
        assert.deepStrictEqual(fake.recentCalls, []);
    });

    test('a side with no server says so and offers to start it; the other still renders', async () => {
        const session = await RenderSession.prepare([original, upgraded], backend({ 'shop-17': [7], 'shop-18': [7] }), host([8017]));
        const state = await session.state();
        assert.strictEqual(state.sides[0].url, undefined);
        assert.strictEqual(state.sides[0].offerStart, true);
        assert.strictEqual(state.sides[0].message, 'No Odoo server is answering on port 8017.');
        assert.strictEqual(nextOf(state.sides[1].url), '/odoo/action-21/7?debug=1');
        assert.deepStrictEqual(session.ports(), [8017, 8018]);
        assert.strictEqual(session.shows('shop-17'), true);
        assert.strictEqual(session.shows('shop-19'), false);
    });

    test('a side that cannot render shows why; the other uses its own records', async () => {
        const fake = backend({ 'shop-17': [9], 'shop-18': [8] }, { 'shop-17': new Error('Model res.partner is not installed in this database.') });
        const state = await (await RenderSession.prepare([original, upgraded], fake, host())).state();
        assert.strictEqual(state.sides[0].message, 'Model res.partner is not installed in this database.');
        assert.strictEqual(state.sides[0].url, undefined);
        assert.strictEqual(nextOf(state.sides[1].url), '/odoo/action-21/8?debug=1');
        assert.strictEqual(state.notice, undefined);
    });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npm run compile-tests` → expected: `Cannot find module '../services/views/renderPlan'` and `'../services/views/renderSession'`.

- [ ] **Step 3: Implement `renderPlan.ts`**

```ts
/**
 * Where a render frame points: the URL of a view-doctor action on one
 * database's web client, per the series' router, and which record both
 * sides of a comparison show.
 */

export const NO_COMMON_RECORD = 'No record exists in both databases; showing a new one.';

/** saas~17.2 moved the web client to /odoo/... URLs; before it, the hash carries the state. */
export function usesOdooRouter(series: string): boolean {
    const match = /(\d+)\.(\d+)/.exec(series);
    if (!match) {
        return true;
    }
    const [major, minor] = [Number(match[1]), Number(match[2])];
    return major > 17 || (major === 17 && minor >= 2);
}

export interface FramePathInput {
    series: string;
    actionId: number;
    model: string;
    viewType: string;
    /** The record a form shows; none for a new record or a multi-record view. */
    resId?: number;
}

export function framePath(input: FramePathInput): string {
    const record = input.viewType === 'form' ? input.resId : undefined;
    if (usesOdooRouter(input.series)) {
        return `/odoo/action-${input.actionId}${record ? `/${record}` : ''}?debug=1`;
    }
    const hash = [`action=${input.actionId}`, `model=${encodeURIComponent(input.model)}`, `view_type=${encodeURIComponent(input.viewType)}`];
    if (record) {
        hash.push(`id=${record}`);
    }
    return `/web?debug=1#${hash.join('&')}`;
}

/** Ids in both lists, newest first. */
export function commonIds(a: number[], b: number[]): number[] {
    const other = new Set(b);
    return [...new Set(a)].filter(id => other.has(id)).sort((x, y) => y - x);
}

/** What to say instead of rendering a QWeb view. */
export function qwebMessage(isReport: boolean): string {
    return isReport
        ? 'Reports need a record to render; open the report from Odoo.'
        : 'QWeb templates render inside the page that uses them; open it from Odoo.';
}
```

- [ ] **Step 4: Implement `renderSession.ts`**

```ts
/**
 * One render: for each database shown, the action that opens the view, the
 * proxy its frame goes through and the records it has; then, for the record
 * being shown, what each frame loads. Both sides always show the same record
 * - the newest both databases have - or both a new one, so the two renders
 * compare; never a different record on each side.
 */
import { errorMessage } from '../logger';
import type { RenderAction } from './viewService';
import { NO_COMMON_RECORD, commonIds, framePath } from './renderPlan';

export const RECENT_LIMIT = 200;

export interface RenderTarget {
    dbName: string;
    versionId?: string;
    viewId: number;
    /** The frame header's first part, e.g. "Original · shop-17". */
    title: string;
}

export interface RenderBackend {
    newSession(dbName: string): Promise<string>;
    makeAction(dbName: string, viewId: number): Promise<RenderAction>;
    recentIds(dbName: string, model: string, limit?: number): Promise<number[]>;
}

export interface FrameProxyHandle {
    readonly port: number;
    session(): Promise<string>;
    gatePath(next: string): string;
}

export interface FrameHost {
    portFor(dbName: string, versionId?: string): Promise<number>;
    isPortOpen(port: number): Promise<boolean>;
    /** The database's proxy to this port, listening, started on first use. */
    proxyFor(dbName: string, port: number, mint: () => Promise<string>): Promise<FrameProxyHandle>;
    /** The origin the webview reaches a local origin at (port forwarding in remote windows). */
    externalOrigin(localOrigin: string): Promise<string>;
}

export interface RenderSideState {
    key: string;
    title: string;
    detail?: string;
    url?: string;
    message?: string;
    offerStart?: boolean;
}

export interface RenderRecordState {
    label: string;
    canPrevious: boolean;
    canNext: boolean;
    canNew: boolean;
}

export interface RenderState {
    sides: RenderSideState[];
    notice?: string;
    /** Present for form views only. */
    record?: RenderRecordState;
}

interface PreparedSide {
    target: RenderTarget;
    port?: number;
    action?: RenderAction;
    proxy?: FrameProxyHandle;
    origin?: string;
    ids: number[];
    error?: string;
}

async function prepareSide(target: RenderTarget, backend: RenderBackend, host: FrameHost): Promise<PreparedSide> {
    try {
        const action = await backend.makeAction(target.dbName, target.viewId);
        const port = await host.portFor(target.dbName, target.versionId);
        const proxy = await host.proxyFor(target.dbName, port, () => backend.newSession(target.dbName));
        const [, origin, ids] = await Promise.all([
            proxy.session(),
            host.externalOrigin(`http://127.0.0.1:${proxy.port}`),
            action.viewType === 'form' ? backend.recentIds(target.dbName, action.model, RECENT_LIMIT) : Promise.resolve([])
        ]);
        return { target, port, action, proxy, origin, ids };
    } catch (error) {
        return { target, ids: [], error: errorMessage(error) };
    }
}

export class RenderSession {
    /** Position in `records`; -1 is a new record. */
    private index: number;

    private constructor(
        private readonly sides: PreparedSide[],
        private readonly host: FrameHost,
        private readonly records: number[],
        private readonly isForm: boolean,
        private readonly notice: string | undefined
    ) {
        this.index = records.length > 0 ? 0 : -1;
    }

    static async prepare(targets: RenderTarget[], backend: RenderBackend, host: FrameHost): Promise<RenderSession> {
        const sides = await Promise.all(targets.map(target => prepareSide(target, backend, host)));
        const ready = sides.filter(side => side.action);
        const isForm = ready.length > 0 && ready.every(side => side.action?.viewType === 'form');
        let records: number[] = [];
        let notice: string | undefined;
        if (isForm) {
            records = ready.map(side => side.ids).reduce((a, b) => commonIds(a, b));
            if (records.length === 0) {
                notice = ready.length > 1 ? NO_COMMON_RECORD : `${ready[0].action?.model} has no record yet; showing a new one.`;
            }
        }
        return new RenderSession(sides, host, records, isForm, notice);
    }

    async state(): Promise<RenderState> {
        const resId = this.index >= 0 ? this.records[this.index] : undefined;
        const sides = await Promise.all(this.sides.map(side => this.sideState(side, resId)));
        const record = this.isForm ? {
            label: resId ? `Record ${resId}` : 'New record',
            canPrevious: this.index > 0 || (this.index === -1 && this.records.length > 0),
            canNext: this.index >= 0 && this.index < this.records.length - 1,
            canNew: this.index !== -1
        } : undefined;
        return { sides, notice: this.notice, record };
    }

    /** The newer shared record, or back from a new record to the newest. */
    previous(): boolean {
        if (this.index > 0 || (this.index === -1 && this.records.length > 0)) {
            this.index = this.index === -1 ? 0 : this.index - 1;
            return true;
        }
        return false;
    }

    /** The older shared record. */
    next(): boolean {
        if (this.index >= 0 && this.index < this.records.length - 1) {
            this.index++;
            return true;
        }
        return false;
    }

    newRecord(): boolean {
        if (!this.isForm || this.index === -1) {
            return false;
        }
        this.index = -1;
        return true;
    }

    shows(dbName: string): boolean {
        return this.sides.some(side => side.target.dbName === dbName);
    }

    /** The server ports the sides point at, for waiting on a start. */
    ports(): number[] {
        return this.sides.flatMap(side => side.port === undefined ? [] : [side.port]);
    }

    private async sideState(side: PreparedSide, resId: number | undefined): Promise<RenderSideState> {
        const base = { key: side.target.dbName, title: side.target.title };
        const { action, proxy, port, origin } = side;
        if (side.error || !action || !proxy || port === undefined || !origin) {
            return { ...base, message: side.error ?? 'This side cannot render.' };
        }
        const what = action.viewType === 'form' ? (resId ? `record ${resId}` : 'new record') : action.viewType;
        const detail = `Odoo ${action.series} · ${action.model} · ${what}`;
        if (!await this.host.isPortOpen(port)) {
            return { ...base, detail, message: `No Odoo server is answering on port ${port}.`, offerStart: true };
        }
        const path = framePath({ series: action.series, actionId: action.actionId, model: action.model, viewType: action.viewType, resId });
        return { ...base, detail, url: `${origin}${proxy.gatePath(path)}` };
    }
}
```

Check `errorMessage` is exported from `src/services/logger.ts` (it is imported that way in `viewDoctorView.ts`).

- [ ] **Step 5: Run the tests and see them pass**

Run (outside the sandbox): `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Render plan|Render session"` → expected: 10 passing.

- [ ] **Step 6: Type check, lint, commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist
git add src/services/views/renderPlan.ts src/services/views/renderSession.ts src/test/renderPlan.test.ts src/test/renderSession.test.ts
git commit -m "[ADD] Plan a render: both sides on the newest record they share

Each side gets its action, its proxy and its newest records; both frames
then show the newest record the two databases share, or both a new one
with a notice, never a different record on each side. Frame URLs follow
the series' router: /odoo/action-N/ID from saas~17.2, the hash before.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The original database opens read-only

**Files:**
- Create: `src/views/viewPairing.ts` (first part)
- Create: `src/test/viewPairing.test.ts` (first part)
- Modify: `src/views/viewFileSystem.ts`, `src/test/viewFileSystem.test.ts`
- Modify: `src/extension.ts` (the `ViewFileSystemProvider` construction, near line 212, and a configuration listener)
- Modify: `package.json` (setting, next to `odooDebugger.server.openBrowserOnStart`)

**Interfaces:**
- Consumes: `ensureUpgradeConfigModel` (`src/models/upgrade.ts`), `SettingsStore.peekSelectedProject()`.
- Produces:
  - `viewPairing.ts`: `export interface PairProject { dbs?: Array<{ id: string; versionId?: string; isSelected?: boolean }>; upgradeConfig?: unknown }`, `export interface PairSide { dbName: string; versionId?: string; series?: string }`, `export interface UpgradePair { original: PairSide; upgraded: PairSide }`, `upgradePair(project): UpgradePair | undefined`, `isReadOnlyOriginal(project, dbName, allowEditOriginal: boolean): boolean`.
  - `ViewFileSystemProvider` constructor gains a third parameter `isReadOnly: (dbName: string) => boolean | Promise<boolean> = () => false`.

- [ ] **Step 1: Write the failing tests**

`src/test/viewPairing.test.ts`:

```ts
import * as assert from 'assert';
import { isReadOnlyOriginal, upgradePair } from '../views/viewPairing';

const upgrading = {
    dbs: [{ id: 'shop-17', versionId: 'v17' }, { id: 'shop-18', versionId: 'v18', isSelected: true }],
    upgradeConfig: { isEnabled: true, from: { dbId: 'shop-17', versionId: 'v17', series: '17.0' }, to: { dbId: 'shop-18', versionId: 'v18', series: '18.0' } }
};

suite('View pairing', () => {
    test('the pair is the upgrade\'s From and To, read from plain JSON', () => {
        assert.deepStrictEqual(upgradePair(upgrading), {
            original: { dbName: 'shop-17', versionId: 'v17', series: '17.0' },
            upgraded: { dbName: 'shop-18', versionId: 'v18', series: '18.0' }
        });
        assert.strictEqual(upgradePair({ ...upgrading, upgradeConfig: { ...upgrading.upgradeConfig, isEnabled: false } }), undefined);
        assert.strictEqual(upgradePair({ dbs: upgrading.dbs }), undefined);
        assert.strictEqual(upgradePair(undefined), undefined);
    });

    test('only the upgrade\'s original opens read-only, unless the setting allows edits', () => {
        assert.strictEqual(isReadOnlyOriginal(upgrading, 'shop-17', false), true);
        assert.strictEqual(isReadOnlyOriginal(upgrading, 'shop-18', false), false);
        assert.strictEqual(isReadOnlyOriginal(upgrading, 'shop-17', true), false);
        assert.strictEqual(isReadOnlyOriginal({ dbs: upgrading.dbs }, 'shop-17', false), false);
    });
});
```

Append to the `'View arch files'` suite in `src/test/viewFileSystem.test.ts`:

```ts
    test('a read-only database\'s views stat read-only and refuse a save', async () => {
        const backend = new FakeBackend();
        const original = viewUri('shop-17', 12, 'x');
        const provider = new ViewFileSystemProvider(backend, { onSaved: () => undefined }, async dbName => dbName === 'shop-17');
        assert.strictEqual((await provider.stat(original)).permissions, vscode.FilePermission.Readonly);
        assert.strictEqual((await provider.stat(uri)).permissions, undefined);
        await assert.rejects(provider.writeFile(original, Buffer.from('<data/>'), { create: false, overwrite: true }), /read-only/);
        assert.strictEqual(backend.arches.get(12), '<data>é</data>', 'nothing reached the database');
    });
```

- [ ] **Step 2: Run them and see them fail**

Run: `npm run compile-tests` → expected: `Cannot find module '../views/viewPairing'` and `Expected 2 arguments, but got 3`.

- [ ] **Step 3: Implement** 

`src/views/viewPairing.ts`:

```ts
/**
 * Which two databases a view is compared or rendered across: in Upgrade
 * mode the original (From) and the upgraded (To) database, otherwise the
 * tree's database and one the user picks.
 */
import { ensureUpgradeConfigModel } from '../models/upgrade';

/** The project as SettingsStore returns it: plain JSON, not hydrated models. */
export interface PairProject {
    dbs?: Array<{ id: string; versionId?: string; isSelected?: boolean }>;
    upgradeConfig?: unknown;
}

export interface PairSide {
    dbName: string;
    versionId?: string;
    series?: string;
}

export interface UpgradePair {
    original: PairSide;
    upgraded: PairSide;
}

export function upgradePair(project: PairProject | undefined): UpgradePair | undefined {
    if (!project) {
        return undefined;
    }
    const config = ensureUpgradeConfigModel(project.upgradeConfig);
    if (!config.isActive() || !config.from?.dbId || !config.to?.dbId) {
        return undefined;
    }
    return {
        original: { dbName: config.from.dbId, versionId: config.from.versionId, series: config.from.series },
        upgraded: { dbName: config.to.dbId, versionId: config.to.versionId, series: config.to.series }
    };
}

/** The upgrade's original database stays as it was, unless odooDebugger.views.allowEditOriginal is on. */
export function isReadOnlyOriginal(project: PairProject | undefined, dbName: string, allowEditOriginal: boolean): boolean {
    return !allowEditOriginal && upgradePair(project)?.original.dbName === dbName;
}
```

In `src/views/viewFileSystem.ts`, change the constructor and `stat`/`writeFile`:

```ts
    constructor(
        private readonly backend: ViewBackend,
        private readonly hooks: ViewFileHooks,
        /** Views of such a database open read-only; kept out of the provider so it needs no settings. */
        private readonly isReadOnly: (dbName: string) => boolean | Promise<boolean> = () => false
    ) {}
```

```ts
    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const ref = this.ref(uri);
        const [mtime, readOnly] = await Promise.all([this.backend.writeDate(ref.dbName, ref.viewId), this.isReadOnly(ref.dbName)]);
        if (mtime === undefined) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return {
            type: vscode.FileType.File, ctime: 0, mtime, size: viewFileSize(mtime),
            ...(readOnly ? { permissions: vscode.FilePermission.Readonly } : {})
        };
    }
```

At the top of `writeFile`, after `const ref = this.ref(uri);`:

```ts
        if (await this.isReadOnly(ref.dbName)) {
            throw vscode.FileSystemError.NoPermissions(
                `${ref.dbName} is the upgrade's original database, so its views are read-only. Turn on odooDebugger.views.allowEditOriginal to edit them.`);
        }
```

`FileSystemError.NoPermissions(message)` keeps the message; the test matches `/read-only/`.

In `package.json`, after the `odooDebugger.server.openBrowserOnStart` block:

```json
        "odooDebugger.views.allowEditOriginal": {
          "type": "boolean",
          "default": false,
          "description": "Allow saving views of the upgrade's original database. Off by default, so the original stays as it was before the upgrade."
        },
```

In `src/extension.ts`, add imports `import { isReadOnlyOriginal, type PairProject } from './views/viewPairing';`, pass the predicate as the provider's third argument:

```ts
    }, async dbName => {
        const allowEdit = vscode.workspace.getConfiguration('odooDebugger').get<boolean>('views.allowEditOriginal', false);
        const result = await SettingsStore.peekSelectedProject().catch(() => null);
        return isReadOnlyOriginal(result?.project as PairProject | undefined, dbName, allowEdit);
    });
```

and after `registerFileSystemProvider(...)`:

```ts
    // Open arches re-read their permissions when the setting flips.
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('odooDebugger.views.allowEditOriginal')) {
            viewFiles.notifyChanged(vscode.workspace.textDocuments
                .filter(document => document.uri.scheme === VIEW_SCHEME)
                .map(document => document.uri));
        }
    }));
```

- [ ] **Step 4: Run the tests and see them pass**

Run (outside the sandbox): `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "View pairing|View arch files"` → expected: all pass.

- [ ] **Step 5: Type check, lint, commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist
git add src/views/viewPairing.ts src/test/viewPairing.test.ts src/views/viewFileSystem.ts src/test/viewFileSystem.test.ts src/extension.ts package.json
git commit -m "[ADD] Open the upgrade's original views read-only

The original database is the reference an upgrade is checked against, so
its arches open read-only and refuse a save. The setting
odooDebugger.views.allowEditOriginal lifts that, and open arches follow
it when it changes.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Compare with Original

**Files:**
- Modify: `src/views/viewPairing.ts`, `src/test/viewPairing.test.ts`
- Modify: `src/commands/viewDoctorCommands.ts`
- Modify: `package.json` (command, menus, commandPalette)
- Modify: `src/test/viewDoctorView.test.ts` (the menu test)

**Interfaces:**
- Consumes: `findViewByXmlid`, `findViewsLike` (Task 2), `matchView` (Task 2), `upgradePair` (Task 5), `viewUri` (stage 1), `getRunningInstances` (`src/services/runningState.ts`), `showError`/`showInfo` (`src/services/notifications.ts`), `SettingsStore.peekSelectedProject()`.
- Produces (`viewPairing.ts`):
  - `export interface DatabaseChoice { dbName: string; versionId?: string; running: boolean }`
  - `otherDatabaseChoices(project, current: string, running: ReadonlySet<string>): DatabaseChoice[]`
  - `pickOtherDatabase(project, current: string): Promise<DatabaseChoice | undefined>`
  - `findCounterpart(view: ViewRow, dbName: string): Promise<ViewRow | 'none' | undefined>` (`undefined` = the user dismissed the pick)
  - `diffArguments(original: { dbName: string; view: ViewRow }, upgraded: { dbName: string; view: ViewRow }): [vscode.Uri, vscode.Uri, string]`
  - `compareTargets(project, item: { dbName: string }): Promise<string | undefined>` — the database to put on the left.
  - Command `viewDoctor.compare`.

- [ ] **Step 1: Write the failing tests** — append to `src/test/viewPairing.test.ts` (extend the import with `diffArguments, otherDatabaseChoices`, and import `ViewRow`):

```ts
suite('Comparing across databases', () => {
    const view = (id: number, name: string, xmlid: string | null) => ({
        id, name, model: 'res.partner', type: 'form', active: true, inheritId: 1, xmlid, rootId: 1, isReport: false, writeDate: 0
    });

    test('offers the project\'s other databases, running ones first', () => {
        const project = { dbs: [{ id: 'a' }, { id: 'b', versionId: 'v' }, { id: 'c' }, { id: 'd' }] };
        assert.deepStrictEqual(otherDatabaseChoices(project, 'a', new Set(['d'])), [
            { dbName: 'd', versionId: undefined, running: true },
            { dbName: 'b', versionId: 'v', running: false },
            { dbName: 'c', versionId: undefined, running: false }
        ]);
        assert.deepStrictEqual(otherDatabaseChoices({ dbs: [{ id: 'a' }] }, 'a', new Set()), []);
        assert.deepStrictEqual(otherDatabaseChoices(undefined, 'a', new Set()), []);
    });

    test('the diff puts the original left and the upgraded right, named after both', () => {
        const [left, right, title] = diffArguments(
            { dbName: 'shop-17', view: view(40, 'partner.custom', 'acme.partner_custom') },
            { dbName: 'shop-18', view: view(41, 'partner.custom', null) });
        assert.strictEqual(left.toString(), 'odoo-view:/shop-17/40/acme.partner_custom.xml');
        assert.strictEqual(right.toString(), 'odoo-view:/shop-18/41/view-41.xml');
        assert.strictEqual(title, 'partner.custom: shop-17 ↔ shop-18');
    });
});
```

In `src/test/viewDoctorView.test.ts`, change the menu test's filter and expectations to:

```ts
            .filter(entry => entry.command.startsWith('viewDoctor.') && !(entry.group ?? '').startsWith('inline'));
```

```ts
        assert.deepStrictEqual(offered('odooView.inactive.hasParent'), ['openArch', 'openParent', 'compare', 'activate', 'copyXmlid']);
        assert.deepStrictEqual(offered('odooView.active.hasParent.noXmlid'), ['openArch', 'openParent', 'compare', 'deactivate']);
        assert.deepStrictEqual(offered('odooView.inactive.root.noXmlid'), ['openArch', 'compare', 'activate']);
        assert.deepStrictEqual(offered('odooView.active.root'), ['openArch', 'compare', 'copyXmlid', 'deactivate']);
```

and add, in the same suite:

```ts
    test('every view row has its open and compare actions inline, and no destructive one', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
        const inline = (manifest.contributes.menus['view/item/context'] as Array<{ command: string; group?: string }>)
            .filter(entry => entry.command.startsWith('viewDoctor.') && (entry.group ?? '').startsWith('inline'));
        assert.deepStrictEqual(inline.map(entry => [entry.command, entry.group]), [
            ['viewDoctor.openArch', 'inline@1'],
            ['viewDoctor.compare', 'inline@2']
        ]);
    });
```

- [ ] **Step 2: Run them and see them fail**

Run: `npm run compile-tests` → expected: missing exports `diffArguments`, `otherDatabaseChoices`. (The menu tests fail at run time until Step 4.)

- [ ] **Step 3: Implement the pairing helpers** — append to `src/views/viewPairing.ts` (add imports `import * as vscode from 'vscode';`, `import { getRunningInstances } from '../services/runningState';`, `import { showInfo } from '../services/notifications';`, `import { findViewByXmlid, findViewsLike, type ViewRow } from '../services/views/viewQueries';`, `import { matchView } from '../services/views/viewMatch';`, `import { viewUri } from './viewFileSystem';`):

```ts
export interface DatabaseChoice {
    dbName: string;
    versionId?: string;
    running: boolean;
}

/** The project's other databases, running ones first, so the default pick is one a server has open. */
export function otherDatabaseChoices(project: PairProject | undefined, current: string, running: ReadonlySet<string>): DatabaseChoice[] {
    return (project?.dbs ?? [])
        .filter(db => db.id !== current)
        .map(db => ({ dbName: db.id, versionId: db.versionId, running: running.has(db.id) }))
        .sort((a, b) => Number(b.running) - Number(a.running));
}

export async function pickOtherDatabase(project: PairProject | undefined, current: string): Promise<DatabaseChoice | undefined> {
    const running = new Set((await getRunningInstances()).map(instance => instance.dbName));
    const choices = otherDatabaseChoices(project, current, running);
    if (choices.length === 0) {
        void showInfo(`The project has no other database to compare ${current} with.`);
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(
        choices.map(choice => ({ label: choice.dbName, description: choice.running ? 'running' : undefined, choice })),
        { title: `Compare with ${current}`, placeHolder: 'The database to show on the left' }
    );
    return picked?.choice;
}

/** The left side of a comparison with this tree row: the upgrade's original, or a database the user picks. */
export async function compareTargets(project: PairProject | undefined, item: { dbName: string }): Promise<string | undefined> {
    const pair = upgradePair(project);
    if (pair && pair.upgraded.dbName === item.dbName) {
        return pair.original.dbName;
    }
    return (await pickOtherDatabase(project, item.dbName))?.dbName;
}

/**
 * The same view in another database. 'none' when that database has no view
 * of its model and type; undefined when the user dismissed the pick.
 */
export async function findCounterpart(view: ViewRow, dbName: string): Promise<ViewRow | 'none' | undefined> {
    const [byXmlid, rows] = await Promise.all([
        view.xmlid ? findViewByXmlid(dbName, view.xmlid) : Promise.resolve(undefined),
        findViewsLike(dbName, view)
    ]);
    const match = matchView(view, { byXmlid, rows });
    if (match.kind === 'none') {
        return 'none';
    }
    if (match.kind !== 'pick') {
        return match.view;
    }
    const picked = await vscode.window.showQuickPick(match.candidates.map(candidate => ({
        label: candidate.name,
        description: `${candidate.xmlid ?? `#${candidate.id}`}${candidate.active ? '' : ' · off'}`,
        detail: candidate.inheritId ? `Inherits view ${candidate.inheritId}` : 'Base view',
        candidate
    })), { title: `${view.name} in ${dbName}`, placeHolder: `No view in ${dbName} is certainly the same one: pick it`, matchOnDescription: true });
    return picked?.candidate;
}

export function diffArguments(
    original: { dbName: string; view: ViewRow },
    upgraded: { dbName: string; view: ViewRow }
): [vscode.Uri, vscode.Uri, string] {
    const uriOf = (side: { dbName: string; view: ViewRow }) => viewUri(side.dbName, side.view.id, side.view.xmlid ?? `view-${side.view.id}`);
    return [uriOf(original), uriOf(upgraded), `${upgraded.view.name}: ${original.dbName} ↔ ${upgraded.dbName}`];
}
```

(`viewFileSystem.ts` does not import `viewPairing.ts`, so there is no import cycle.)

- [ ] **Step 4: Add the command and its menus**

In `src/commands/viewDoctorCommands.ts`, add imports `import { SettingsStore } from '../settingsStore';`, `import { compareTargets, diffArguments, findCounterpart, type PairProject } from '../views/viewPairing';`, extend the notifications import with `showInfo`, and register after `viewDoctor.openParent`:

```ts
    context.subscriptions.push(registerCommand('viewDoctor.compare', async (arg: unknown) => {
        const item = viewItem(arg);
        if (!item) {
            return;
        }
        try {
            const project = (await SettingsStore.peekSelectedProject().catch(() => null))?.project as PairProject | undefined;
            const originalDb = await compareTargets(project, item);
            if (!originalDb) {
                return;
            }
            const counterpart = await findCounterpart(item.view, originalDb);
            if (counterpart === 'none') {
                void showInfo(`${originalDb} has no ${item.view.type} view of ${item.view.model || 'this model'} to compare with.`);
                return;
            }
            if (!counterpart) {
                return;
            }
            await vscode.commands.executeCommand('vscode.diff',
                ...diffArguments({ dbName: originalDb, view: counterpart }, { dbName: item.dbName, view: item.view }));
        } catch (error) {
            void showError(`Could not compare ${item.view.name}: ${errorMessage(error)}`);
        }
    }));
```

In `package.json`:
- `commands`, after `viewDoctor.openParent`: `{ "command": "viewDoctor.compare", "title": "Compare with Original", "category": "Odoo DevTools", "icon": "$(diff)" },`
- `view/item/context`, after the `viewDoctor.openArch` `inline@1` entry: `{ "command": "viewDoctor.compare", "when": "view == viewDoctor && viewItem =~ /^odooView\\./", "group": "inline@2" },`, and after the `viewDoctor.openParent` `1_open@2` entry: `{ "command": "viewDoctor.compare", "when": "view == viewDoctor && viewItem =~ /^odooView\\./", "group": "1_open@3" },`
- `commandPalette`, after `viewDoctor.openParent`: `{ "command": "viewDoctor.compare", "when": "false" },`

- [ ] **Step 5: Run the tests and see them pass**

Run (outside the sandbox): `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "View pairing|Comparing across databases|Views tree"` → expected: all pass.

- [ ] **Step 6: Type check, lint, commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist
git add src/views/viewPairing.ts src/test/viewPairing.test.ts src/commands/viewDoctorCommands.ts package.json src/test/viewDoctorView.test.ts
git commit -m "[ADD] Compare a view with the same view in the original database

Compare with Original opens the diff editor: the upgrade's original
database on the left, read-only, and the upgraded one on the right, where
saving fixes the view. Outside Upgrade mode the left side is a database
you pick, running ones first. The view is matched by external id, id or
name, or picked when that is not certain.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The render tab

**Files:**
- Create: `src/views/viewRenderPanel.ts`, `src/test/viewRenderPanel.test.ts`
- Modify: `src/commands/viewDoctorCommands.ts`, `src/commands/index.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify: `src/test/viewDoctorView.test.ts` (menu expectations)

**Interfaces:**
- Consumes: `RenderSession`, `RenderBackend`, `FrameHost`, `RenderState`, `RenderTarget` (Task 4); `OdooFrameProxy` (Task 3); `qwebMessage` (Task 4); `upgradePair`, `findCounterpart`, `PairProject` (Tasks 5–6); `resolvePortForDatabase`, `isPortOpen`, `waitForPort` (`src/services/server.ts`); `ViewService` (implements `RenderBackend`).
- Produces:
  - `viewRenderPanel.ts`: `escapeHtml(text): string`; `renderPanelHtml(state: RenderState, options: { nonce: string; cspSource: string }): string`; `export interface RenderRequest { title: string; targets: RenderTarget[]; startCommand: string; notice?: string }`; `class ViewRenderPanel implements vscode.Disposable { constructor(backend: RenderBackend, host?: FrameHost); show(request): Promise<void>; reloadDatabase(dbName): void; get isOpen(): boolean; dispose(): void }`.
  - `CommandDeps.viewRender: ViewRenderPanel`.
  - Command `viewDoctor.render`.

- [ ] **Step 1: Write the failing tests** — `src/test/viewRenderPanel.test.ts`:

```ts
import * as assert from 'assert';
import { ViewRenderPanel, escapeHtml, renderPanelHtml } from '../views/viewRenderPanel';
import type { FrameHost, RenderBackend, RenderState } from '../services/views/renderSession';

const state: RenderState = {
    sides: [
        { key: 'shop-17', title: 'Original · shop-17', detail: 'Odoo 17.0 · res.partner · record 7', url: 'http://127.0.0.1:40001/__odt/open?t=a&next=%2Fweb' },
        { key: 'shop-18', title: 'Upgraded · <img src=x onerror=alert(1)>', message: 'No Odoo server is answering on port 8018.', offerStart: true }
    ],
    notice: 'No record exists in both databases; showing a new one.',
    record: { label: 'Record 7', canPrevious: false, canNext: true, canNew: true }
};

suite('Render tab', () => {
    test('frames only the proxy origins, and runs only its own nonced script', () => {
        const html = renderPanelHtml(state, { nonce: 'n0nce', cspSource: 'vscode-resource:' });
        const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? '';
        assert.ok(csp.includes("default-src 'none'"), csp);
        assert.ok(csp.includes('frame-src http://127.0.0.1:40001;'), csp);
        assert.ok(csp.includes("script-src 'nonce-n0nce'"), csp);
        assert.ok(!html.includes('unsafe-inline'));
        assert.strictEqual((html.match(/<script /g) ?? []).length, 1);
        assert.ok(html.includes('<script nonce="n0nce">'));
    });

    test('escapes names', () => {
        const html = renderPanelHtml(state, { nonce: 'n', cspSource: 'x' });
        assert.ok(!html.includes('<img src=x'), 'markup from a name reached the page');
        assert.ok(html.includes('Upgraded · &lt;img src=x onerror=alert(1)&gt;'));
        assert.strictEqual(escapeHtml(`"a" & 'b'`), '&quot;a&quot; &amp; &#39;b&#39;');
    });

    test('a side without a frame says why and offers to start its server', () => {
        const html = renderPanelHtml(state, { nonce: 'n', cspSource: 'x' });
        assert.strictEqual((html.match(/<iframe /g) ?? []).length, 1);
        assert.ok(html.includes('data-src="http://127.0.0.1:40001/__odt/open?t=a&amp;next=%2Fweb"'));
        assert.ok(html.includes('No Odoo server is answering on port 8018.'));
        assert.ok(html.includes('data-action="start"'));
        assert.ok(html.includes('No record exists in both databases; showing a new one.'));
    });

    test('the record buttons follow what can be shown', () => {
        const html = renderPanelHtml(state, { nonce: 'n', cspSource: 'x' });
        assert.ok(/<button data-action="previous" disabled>/.test(html));
        assert.ok(/<button data-action="next">/.test(html));
        assert.ok(/<button data-action="new">/.test(html));
        const list = renderPanelHtml({ sides: state.sides }, { nonce: 'n', cspSource: 'x' });
        assert.ok(!list.includes('data-action="next"'), 'no record buttons for a list');
        assert.ok(list.includes('data-action="reload"'));
    });

    test('opens one tab, reuses it, and closes it', async () => {
        const backend: RenderBackend = {
            newSession: async () => 'sid',
            makeAction: async () => ({ actionId: 3, model: 'res.partner', viewType: 'list', rootId: 1, series: '18.0' }),
            recentIds: async () => []
        };
        const host: FrameHost = {
            portFor: async () => 8018,
            isPortOpen: async () => false,
            proxyFor: async () => ({ port: 40002, session: async () => 'sid', gatePath: next => next }),
            externalOrigin: async origin => origin
        };
        const panel = new ViewRenderPanel(backend, host);
        const request = { title: 'partner.custom', targets: [{ dbName: 'shop-18', viewId: 4, title: 'shop-18' }], startCommand: 'odoo.startServer' };
        await panel.show(request);
        assert.strictEqual(panel.isOpen, true);
        await panel.show(request);
        panel.reloadDatabase('shop-18');
        panel.dispose();
        assert.strictEqual(panel.isOpen, false);
    });
});
```

Update `src/test/viewDoctorView.test.ts` menu expectations: `render` follows `compare` in every `offered(...)` list (e.g. `['openArch', 'openParent', 'compare', 'render', 'activate', 'copyXmlid']`), and the inline list gains `['viewDoctor.render', 'inline@3']`.

- [ ] **Step 2: Run them and see them fail**

Run: `npm run compile-tests` → expected: `Cannot find module '../views/viewRenderPanel'`.

- [ ] **Step 3: Implement the panel** — `src/views/viewRenderPanel.ts`:

```ts
/**
 * The render tab: one or two Odoo web clients side by side, each in a frame
 * behind its database's gated proxy. The page is rebuilt whenever what it
 * shows changes; a save reloads the frames of its database by message, so
 * the other side keeps whatever the user was doing in it.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { OdooFrameProxy } from '../services/views/odooFrameProxy';
import { RenderSession, type FrameHost, type RenderBackend, type RenderState, type RenderTarget } from '../services/views/renderSession';
import { isPortOpen, resolvePortForDatabase, waitForPort } from '../services/server';
import { errorMessage, logger } from '../services/logger';
import { showError } from '../services/notifications';

export interface RenderRequest {
    title: string;
    /** The original side first. */
    targets: RenderTarget[];
    /** What a side with no server offers to run. */
    startCommand: string;
    notice?: string;
}

export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

const STYLE = `
body { margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.toolbar .notice { color: var(--vscode-descriptionForeground); }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 10px; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
.sides { flex: 1; display: flex; min-height: 0; }
.side { flex: 1; display: flex; flex-direction: column; min-width: 0; border-right: 1px solid var(--vscode-panel-border); }
.side:last-child { border-right: none; }
.side header { padding: 4px 8px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.side header .detail { color: var(--vscode-descriptionForeground); }
.side .message { color: var(--vscode-errorForeground); }
iframe { flex: 1; width: 100%; border: none; background: #fff; }
.empty { flex: 1; display: flex; align-items: center; justify-content: center; padding: 16px; color: var(--vscode-descriptionForeground); text-align: center; }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
for (const button of document.querySelectorAll('button[data-action]')) {
    button.addEventListener('click', () => vscode.postMessage({ type: 'action', action: button.dataset.action }));
}
window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.type !== 'reload') {
        return;
    }
    for (const frame of document.querySelectorAll('iframe[data-key]')) {
        if (!message.keys || message.keys.includes(frame.dataset.key)) {
            frame.src = frame.dataset.src;
        }
    }
});
`;

function button(action: string, label: string, enabled = true): string {
    return `<button data-action="${action}"${enabled ? '' : ' disabled'}>${escapeHtml(label)}</button>`;
}

export function renderPanelHtml(state: RenderState, options: { nonce: string; cspSource: string }): string {
    const origins = [...new Set(state.sides.flatMap(side => side.url ? [new URL(side.url).origin] : []))];
    const csp = [
        "default-src 'none'",
        ...(origins.length > 0 ? [`frame-src ${origins.join(' ')}`] : []),
        `style-src ${options.cspSource} 'nonce-${options.nonce}'`,
        `script-src 'nonce-${options.nonce}'`
    ].join('; ') + ';';
    const record = state.record;
    const toolbar = [
        button('reload', 'Reload'),
        ...(record ? [
            button('previous', 'Previous record', record.canPrevious),
            `<span>${escapeHtml(record.label)}</span>`,
            button('next', 'Next record', record.canNext),
            button('new', 'New record', record.canNew)
        ] : []),
        ...(state.notice ? [`<span class="notice">${escapeHtml(state.notice)}</span>`] : [])
    ].join('\n');
    const sides = state.sides.map(side => {
        const header = [
            `<strong>${escapeHtml(side.title)}</strong>`,
            ...(side.detail ? [`<span class="detail">${escapeHtml(side.detail)}</span>`] : []),
            ...(side.url && side.message ? [`<span class="message">${escapeHtml(side.message)}</span>`] : []),
            ...(side.offerStart ? [button('start', state.sides.length > 1 ? 'Start Both Servers' : 'Start Server')] : [])
        ].join(' ');
        const body = side.url
            ? `<iframe data-key="${escapeHtml(side.key)}" data-src="${escapeHtml(side.url)}" src="${escapeHtml(side.url)}"></iframe>`
            : `<div class="empty">${escapeHtml(side.message ?? 'Nothing to show.')}</div>`;
        return `<section class="side"><header>${header}</header>${body}</section>`;
    }).join('\n');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${options.nonce}">${STYLE}</style>
</head>
<body>
<div class="toolbar">${toolbar}</div>
<div class="sides">${sides}</div>
<script nonce="${options.nonce}">${SCRIPT}</script>
</body>
</html>`;
}
```

The CSP is not escaped: it holds no `"` or `<`, only origins built by the extension. Then the wrapper, in the same file:

```ts
export class ViewRenderPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private session: RenderSession | undefined;
    private request: RenderRequest | undefined;
    private readonly proxies = new Map<string, Promise<OdooFrameProxy>>();
    private readonly host: FrameHost;

    constructor(private readonly backend: RenderBackend, host?: FrameHost) {
        this.host = host ?? {
            portFor: async (dbName, versionId) => (await resolvePortForDatabase(dbName, versionId)).port,
            isPortOpen,
            proxyFor: (dbName, port, mint) => this.proxyFor(dbName, port, mint),
            externalOrigin: async origin => {
                const uri = await vscode.env.asExternalUri(vscode.Uri.parse(origin));
                return `${uri.scheme}://${uri.authority}`;
            }
        };
    }

    get isOpen(): boolean {
        return !!this.panel;
    }

    async show(request: RenderRequest): Promise<void> {
        const session = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Preparing the render of ${request.title}…` },
            () => RenderSession.prepare(request.targets, this.backend, this.host)
        );
        this.session = session;
        this.request = request;
        const panel = this.ensurePanel();
        panel.title = `Render: ${request.title}`;
        await this.update();
        panel.reveal(undefined, false);
    }

    /** A save in this database: its frames load the new arch. */
    reloadDatabase(dbName: string): void {
        if (this.panel && this.session?.shows(dbName)) {
            void this.panel.webview.postMessage({ type: 'reload', keys: [dbName] });
        }
    }

    dispose(): void {
        const panel = this.panel;
        this.panel = undefined;
        this.session = undefined;
        panel?.dispose();
        void this.closeProxies();
    }

    private ensurePanel(): vscode.WebviewPanel {
        if (this.panel) {
            return this.panel;
        }
        const panel = vscode.window.createWebviewPanel('odooViewRender', 'Render', vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: []
        });
        panel.onDidDispose(() => {
            this.panel = undefined;
            this.session = undefined;
            this.request = undefined;
            void this.closeProxies();
        });
        panel.webview.onDidReceiveMessage(message => void this.onMessage(message));
        this.panel = panel;
        return panel;
    }

    private async update(): Promise<void> {
        const panel = this.panel;
        const session = this.session;
        if (!panel || !session) {
            return;
        }
        const state = await session.state();
        const notice = [this.request?.notice, state.notice].filter(Boolean).join(' ');
        panel.webview.html = renderPanelHtml({ ...state, notice: notice || undefined }, {
            nonce: randomBytes(16).toString('base64'),
            cspSource: panel.webview.cspSource
        });
    }

    private async onMessage(message: unknown): Promise<void> {
        const action = (message as { type?: string; action?: string } | undefined)?.type === 'action'
            ? (message as { action?: string }).action
            : undefined;
        const session = this.session;
        if (!session || !action) {
            return;
        }
        try {
            switch (action) {
                case 'reload':
                    void this.panel?.webview.postMessage({ type: 'reload' });
                    return;
                case 'previous':
                    if (session.previous()) {
                        await this.update();
                    }
                    return;
                case 'next':
                    if (session.next()) {
                        await this.update();
                    }
                    return;
                case 'new':
                    if (session.newRecord()) {
                        await this.update();
                    }
                    return;
                case 'start':
                    await this.startServers(session);
                    return;
            }
        } catch (error) {
            logger.warn('The render tab could not handle an action:', error);
            void showError(`The render could not ${action}: ${errorMessage(error)}`);
        }
    }

    private async startServers(session: RenderSession): Promise<void> {
        if (!this.request) {
            return;
        }
        await vscode.commands.executeCommand(this.request.startCommand);
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Waiting for the Odoo servers…' },
            () => Promise.all(session.ports().map(port => waitForPort(port, 120_000)))
        );
        if (this.session === session) {
            await this.update();
        }
    }

    private proxyFor(dbName: string, port: number, mint: () => Promise<string>): Promise<OdooFrameProxy> {
        const key = `${dbName}:${port}`;
        let proxy = this.proxies.get(key);
        if (!proxy) {
            const created = new OdooFrameProxy({ targetPort: port, mintSession: mint });
            proxy = created.listen().then(() => created);
            proxy.catch(() => this.proxies.delete(key));
            this.proxies.set(key, proxy);
        }
        return proxy;
    }

    private async closeProxies(): Promise<void> {
        const proxies = [...this.proxies.values()];
        this.proxies.clear();
        await Promise.all(proxies.map(async proxy => (await proxy.catch(() => undefined))?.close()));
    }
}
```

`proxyFor` returns `Promise<OdooFrameProxy>`, which satisfies `FrameProxyHandle` structurally (`port`, `session()`, `gatePath()`).

- [ ] **Step 4: Add the command, the dep and the wiring**

`src/commands/index.ts`: `import type { ViewRenderPanel } from '../views/viewRenderPanel';` and in `CommandDeps`, after `viewDiagnostics`:

```ts
    /** The render tab, reused by every Render. */
    viewRender: ViewRenderPanel;
```

`src/commands/viewDoctorCommands.ts`: destructure `viewRender` from deps; import `qwebMessage` from `'../services/views/renderPlan'`, `upgradePair` and `type RenderTarget` (`'../services/views/renderSession'`); register after `viewDoctor.compare`:

```ts
    context.subscriptions.push(registerCommand('viewDoctor.render', async (arg: unknown) => {
        const item = viewItem(arg);
        if (!item) {
            return;
        }
        if (item.view.type === 'qweb') {
            void showInfo(qwebMessage(item.view.isReport));
            return;
        }
        try {
            const project = (await SettingsStore.peekSelectedProject().catch(() => null))?.project as PairProject | undefined;
            const pair = upgradePair(project);
            if (pair && pair.upgraded.dbName === item.dbName) {
                const counterpart = await findCounterpart(item.view, pair.original.dbName);
                if (counterpart === undefined) {
                    return;
                }
                const targets: RenderTarget[] = [];
                if (counterpart !== 'none') {
                    targets.push({ dbName: pair.original.dbName, versionId: pair.original.versionId, viewId: counterpart.id, title: `Original · ${pair.original.dbName}` });
                }
                targets.push({ dbName: item.dbName, versionId: pair.upgraded.versionId, viewId: item.view.id, title: `Upgraded · ${item.dbName}` });
                await viewRender.show({
                    title: item.view.name,
                    targets,
                    startCommand: 'odoo.startBothServers',
                    notice: counterpart === 'none' ? `${pair.original.dbName} has no matching view; showing the upgraded side only.` : undefined
                });
                return;
            }
            const db = project?.dbs?.find(entry => entry.id === item.dbName);
            await viewRender.show({
                title: item.view.name,
                targets: [{ dbName: item.dbName, versionId: db?.versionId, viewId: item.view.id, title: item.dbName }],
                startCommand: 'odoo.startServer'
            });
        } catch (error) {
            void showError(`Could not render ${item.view.name}: ${errorMessage(error)}`);
        }
    }));
```

`src/extension.ts`: `import { ViewRenderPanel } from './views/viewRenderPanel';`; right after `const viewService = new ViewService(viewWorkers);` add `const viewRender = new ViewRenderPanel(viewService); context.subscriptions.push(viewRender);`; in `onSaved` add `viewRender.reloadDatabase(ref.dbName);` (rename the `_ref` parameter to `ref`) right before `providers.views.refresh();`; and add `viewRender` to the `registerAllCommands({ ... })` object.

`package.json`:
- `commands`, after `viewDoctor.compare`: `{ "command": "viewDoctor.render", "title": "Render", "category": "Odoo DevTools", "icon": "$(preview)" },`
- `view/item/context`, after the `viewDoctor.compare` `inline@2` entry: `{ "command": "viewDoctor.render", "when": "view == viewDoctor && viewItem =~ /^odooView\\./", "group": "inline@3" },`; after the `viewDoctor.compare` `1_open@3` entry: `{ "command": "viewDoctor.render", "when": "view == viewDoctor && viewItem =~ /^odooView\\./", "group": "1_open@4" },`
- `commandPalette`: `{ "command": "viewDoctor.render", "when": "false" },`

Search the tests for other places that build a `CommandDeps` object (`grep -rn "viewDiagnostics" src/test`); add `viewRender` there too if any exist.

- [ ] **Step 5: Run the tests and see them pass**

Run (outside the sandbox): `npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npx vscode-test --grep "Render tab|Views tree"` → expected: all pass. Then the whole suite: `env -u ELECTRON_RUN_AS_NODE npm test` → expected: 623 + the new tests passing, 13 pending, 0 failing.

- [ ] **Step 6: Type check, lint, commit**

```bash
npx tsc -p . --noEmit && npm run lint
git checkout -- dist
git add src/views/viewRenderPanel.ts src/test/viewRenderPanel.test.ts src/commands/viewDoctorCommands.ts src/commands/index.ts src/extension.ts package.json src/test/viewDoctorView.test.ts
git commit -m "[ADD] Render a view in Odoo inside VS Code, both sides on one record

Render opens a tab with the database's Odoo web client on the view, logged
in as admin through the gated proxy. In Upgrade mode it shows the original
and the upgraded database side by side, on the same record, and steps
through the records they share. Saving an arch reloads that database's
frame. A side with no server says so and offers to start it.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Docs, rebuild, and the live check

**Files:**
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Added`), `README.md` ("Disabled views (View Doctor)"), `dist/`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: CHANGELOG** — append to `[Unreleased]` → `### Added`, after the arch-editing bullet:

```markdown
- **Compare a view with the original database.** Compare with Original opens the diff editor with the same view in both databases: the upgrade's original on the left, read-only, and the upgraded one on the right, where saving fixes it. The view is matched by external id, id or name; when that is not certain, you pick it. Outside Upgrade mode you pick the other database. The setting `odooDebugger.views.allowEditOriginal` lets you edit the original too.
- **Render a view in Odoo, inside VS Code.** Render opens a tab with the database's Odoo web client on that view, logged in as admin. In Upgrade mode it shows the original and the upgraded database side by side, on the same record, and steps through the records both have. Saving an arch reloads its side. A side with no server running offers to start it. QWeb templates and reports are not rendered here.
```

- [ ] **Step 2: README** — append to the "Disabled views (View Doctor)" section, after its second paragraph:

```markdown
**Compare with Original** (on a view's row) opens the same view of the original database next to it in the diff editor. In Upgrade mode the original is the upgrade's From database and opens read-only; fix the right side and save. Outside Upgrade mode you pick the database to compare with. The view is found by external id, then id, then name; when none is certain, you pick it.

**Render** opens the view in Odoo, inside a VS Code tab, logged in as the database's first administrator. In Upgrade mode both databases show side by side, on the newest record they both have; step to older records, or a new one, from the toolbar. Saving an arch reloads that side. The tab talks to Odoo through a local proxy that only that tab can use. A side whose server is not running offers to start it. QWeb templates and reports are not rendered; open them from Odoo.
```

- [ ] **Step 3: Rebuild and run everything**

```bash
npx tsc -p . --noEmit && npm run lint && npm run compile
npm run compile-tests && env -u ELECTRON_RUN_AS_NODE npm test   # outside the sandbox
```

Expected: tsc clean, 0 lint errors, webpack builds, all tests pass (report the count). Then `npm run compile` once more, so `dist/` is the production build rather than whatever `npm test` left.

- [ ] **Step 4: Live check in a real window** (the handover §5 "Real window" recipe; `docs/manual-test-brief.md` "Driving the window on this machine"; memory `odoo-debugger-verification.md`). Set up:
  - base DBs `odt_view_base_17` and `odt_view_base_19` (Task 1), plus `odt_view_live_17` and `odt_view_live_19` created as copies (`createdb -T`), each with a broken extension view of `res.partner`'s form (the integration test's `SETUP` script, run with `odoo-bin shell`) so the tree has a row;
  - a scratch HOME with Xvfb, `code --extensionDevelopmentPath=<repo>`, and a seeded `<fixture>/.vscode/odoo-debugger-data.json` with a project, profile-only versions 17.0 and 19.0 (pointing at `/home/odoo/odoo-dev/odoo-$v.0` and `venv-$v.0`, with ports 18017/18019), both databases, and an active `upgradeConfig` from `odt_view_live_17` (17.0) to `odt_view_live_19` (19.0);
  - two Odoo servers started by hand on 18017/18019 (`--db-filter`, `--http-interface=127.0.0.1`, `--max-cron-threads=0`), and later one of them stopped.

  Check and screenshot each:
  1. The Views tree lists the broken view with Open Arch, Compare and Render icons inline.
  2. Compare opens a diff titled `<name>: odt_view_live_17 ↔ odt_view_live_19`; the left side refuses typing (read-only); the right side is editable.
  3. Render opens one tab with two frames, both logged in, both on the same partner record; 17.0 uses the `/web#…` URL and 19.0 `/odoo/action-…`.
  4. Next record moves both frames to the same older record.
  5. Fixing the arch on the right side and saving reloads the right frame (screenshot before and after).
  6. With the 17.0 server stopped, Reload leaves that side showing "No Odoo server is answering on port 18017." and a Start Both Servers button (do not click it; it would launch the seeded versions' debugger).
  7. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<proxy port>/odoo` from a shell answers `403` (find the port with `ss -ltnp | grep code`).

  Afterwards: stop both servers, close the window, kill Xvfb (filter `ps -eo pid,comm,args` on `comm != bash`), drop every `odt_view_*` database you created, and delete the session files minted under `~/.local/share/Odoo/sessions/` during the check (those newer than the check's start, `find … -newer <marker>`). Record each result in the commit body; a failed check is a bug to fix before committing, with its own `[FIX]` commit.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md README.md dist
git commit -m "[DOC] Describe Compare with Original and Render; rebuild

<one line per live check from Step 4 and its result>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec §4 / handover §3 coverage: Compare (Task 6), match order (Task 2), outside-Upgrade pick (Task 6), read-only original + setting + injected predicate (Task 5), panel with headers/toolbar/CSP/nonce/one frame outside Upgrade/reload on save (Task 7), proxy cookie/Host/headers/Set-Cookie/Location/websocket/close/gate (Task 3), `new_session` + re-mint on 401 or login redirect (Tasks 1, 3), `make_action` on the root with the series and both URL forms (Tasks 1, 4), port missing → header + Start (Tasks 4, 7), remote via `asExternalUri` (Task 7), same record via `recent_ids` + highest common id + new-record fallback with the exact message (Tasks 1, 4), single-frame newest record (Task 4), multi-record types as is (Task 4), QWeb message (Tasks 4, 7), integration tests (Tasks 1, 3), tree inline actions (Tasks 6, 7), docs and dist (Task 8).
- Not done here, by design: stage 3 (upgrade script), the "view vs its parent" diff, Windows and Odoo 15/16 verification (no runnable environment).
