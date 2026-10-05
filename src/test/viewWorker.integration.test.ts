/**
 * The View Doctor's shell against a real Odoo. Skipped unless
 * ODT_VIEW_TEST_PYTHON, ODT_VIEW_TEST_ODOO (an odoo checkout) and
 * ODT_VIEW_TEST_DB (a database with base installed, for that checkout's
 * version) are set. Works on a copy of ODT_VIEW_TEST_DB, dropped afterwards.
 * ODT_VIEW_TEST_TRANSPORT=tcp runs it over the loopback port Windows uses.
 */
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { waitForPort } from '../services/server';
import * as path from 'node:path';
import { runCommand } from '../services/process';
import { createDatabase, databaseExists, dropDatabase, dropDatabaseIfExists, onBeforeDatabaseRelease, runSql } from '../services/postgres';
import { getActiveDatabaseNames } from '../services/database';
import { invalidateActiveDatabasesCache } from '../services/runtimeCache';
import { buildViewWorkerArgs, viewWorkerEnv, VIEW_WORKER_APP_NAME } from '../services/views/viewWorkerArgs';
import { ViewWorker, workerBootstrap, type WorkerTransport } from '../services/views/viewWorker';
import { ViewWorkerPool } from '../services/views/viewWorkerPool';
import { ViewService } from '../services/views/viewService';
import { OdooFrameProxy } from '../services/views/odooFrameProxy';

const python = process.env.ODT_VIEW_TEST_PYTHON;
const odoo = process.env.ODT_VIEW_TEST_ODOO;
const sourceDb = process.env.ODT_VIEW_TEST_DB;
const enabled = !!(python && odoo && sourceDb);
const transport = process.env.ODT_VIEW_TEST_TRANSPORT as WorkerTransport | undefined;

// OdooBot is made French, the language `odoo-bin shell` then runs in, and
// the arch gets a French translation: the shell must still read and write
// the en_US source.
const SETUP = `
broken = '<data><xpath expr="//field[@name=\\'odt_does_not_exist\\']" position="after"><field name="ref" string="Reference"/></xpath></data>'
french = broken.replace('Reference', 'R\\u00e9f\\u00e9rence')
parent = env.ref('base.view_partner_form')
view = env['ir.ui.view'].create({
    'name': 'odt.view.doctor.test', 'type': 'form', 'model': 'res.partner', 'inherit_id': parent.id,
    'mode': 'extension', 'active': False,
    'arch': '<data><xpath expr="//field[@name=\\'name\\']" position="after"><field name="ref"/></xpath></data>',
})
if env['ir.ui.view']._fields['arch_db'].column_type[0] == 'jsonb':
    env.cr.execute("UPDATE ir_ui_view SET arch_db = jsonb_build_object('en_US', %s::text, 'fr_FR', %s::text) WHERE id = %s", [broken, french, view.id])
else:
    env.cr.execute("UPDATE ir_ui_view SET arch_db = %s WHERE id = %s", [broken, view.id])
    env.cr.execute(
        "INSERT INTO ir_translation (name, res_id, lang, type, src, value, state)"
        " VALUES ('ir.ui.view,arch_db', %s, 'fr_FR', 'model_terms', 'Reference', 'R\\u00e9f\\u00e9rence', 'translated')", [view.id])
env['res.lang']._activate_lang('fr_FR')
env.ref('base.partner_root').lang = 'fr_FR'
env.cr.commit()
print('ODT_VIEW_ID:%d' % view.id)
`;

const FIXED = '<data><xpath expr="//field[@name=\'name\']" position="after"><field name="ref" string="Reference" placeholder="Prénom ✓"/></xpath></data>';
/** Still points at a field the parent does not have. */
const STILL_BROKEN = '<data><xpath expr="//field[@name=\'odt_does_not_exist_2\']" position="after"><field name="ref" string="Reference"/></xpath></data>';

/** Bump the registry signal the way this version's Registry.signal_changes does. */
const SIGNAL_REGISTRY_RELOAD = `
DO $$
BEGIN
    IF to_regclass('orm_signaling_registry') IS NOT NULL THEN
        INSERT INTO orm_signaling_registry DEFAULT VALUES;
    ELSE
        PERFORM nextval('base_registry_signaling');
    END IF;
END $$;
`;

/** A database name as a SQL literal, for the test's own psql queries. */
function sqlLiteral(name: string): string {
    assert.match(name, /^[\w.-]+$/);
    return `'${name}'`;
}

/** Whether arch_db holds every language in one jsonb (16 and later) or the source only (15). */
async function archIsJsonb(dbName: string): Promise<boolean> {
    return await runSql(dbName, "SELECT data_type FROM information_schema.columns WHERE table_name = 'ir_ui_view' AND column_name = 'arch_db';") === 'jsonb';
}

/**
 * The mark that makes running servers drop their view caches (a view write
 * clears 'templates'), as Registry.get_sequences reads it: an insert-only
 * table on 19, a sequence per cache on 17 and 18, one sequence on 15 and 16.
 */
async function templatesCacheSignal(dbName: string): Promise<number> {
    if (await runSql(dbName, "SELECT to_regclass('orm_signaling_templates') IS NOT NULL;") === 't') {
        return Number(await runSql(dbName, 'SELECT coalesce(max(id), 0) FROM orm_signaling_templates;'));
    }
    const sequence = await runSql(dbName, "SELECT coalesce(to_regclass('base_cache_signaling_templates'), to_regclass('base_cache_signaling'))::text;");
    assert.ok(sequence, 'no cache signaling sequence');
    return Number(await runSql(dbName, `SELECT last_value FROM ${sequence};`));
}

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

interface SessionInfo { is_admin?: boolean; user_context?: { lang?: string } }

/** A JSON-RPC call with this session; resolves with `result`, rejects with Odoo's error. */
function jsonRpc(port: number, route: string, sid: string, extraCookie = ''): Promise<SessionInfo> {
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
                } catch {
                    reject(new Error(`${response.statusCode}: ${text.slice(0, 300)}`));
                }
            });
        });
        request.on('error', reject);
        request.end(body);
    });
}

(enabled ? suite : suite.skip)('View worker against a real Odoo', function () {
    this.timeout(600000);
    const copy = `${sourceDb}_odt_view_test`;
    const addonsPaths = [`${odoo}/odoo/addons`, `${odoo}/addons`];
    const scriptPath = path.resolve(__dirname, '..', '..', 'resources', 'scripts', 'view_worker.py');
    let viewId = 0;
    let pool: ViewWorkerPool;
    let service: ViewService;
    let release: { dispose(): void };
    let workersStarted = 0;
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
    const newWorker = (dbName: string) => new ViewWorker({
        command: python!,
        args: buildViewWorkerArgs({ odooBinPath: `${odoo}/odoo-bin`, addonsPaths, dbName }),
        env: viewWorkerEnv(process.env),
        bootstrap: workerBootstrap(scriptPath)
    }, { transport });

    suiteSetup(async () => {
        await dropDatabaseIfExists(copy);
        await createDatabase(copy, sourceDb);
        const { stdout } = await runCommand(python!, [`${odoo}/odoo-bin`, 'shell', '--no-http', '--addons-path', addonsPaths.join(','), '-d', copy], { input: SETUP });
        viewId = Number(/ODT_VIEW_ID:(\d+)/.exec(stdout)?.[1]);
        assert.ok(viewId > 0, `setup printed no view id:\n${stdout}`);

        pool = new ViewWorkerPool(async dbName => {
            workersStarted++;
            return newWorker(dbName);
        });
        service = new ViewService(pool);
        release = onBeforeDatabaseRelease(dbName => pool.release(dbName));
    });

    suiteTeardown(async () => {
        forgetSessions();
        // The last test drops the copy with the shells open; this is for a run that failed earlier.
        await dropDatabaseIfExists(copy);
        release?.dispose();
        pool?.dispose();
    });

    test('reads the arch through the ORM, whatever the column type', async () => {
        assert.ok((await service.getArch(copy, viewId)).includes('odt_does_not_exist'));
    });

    test('reads the en_US source, not the translation in OdooBot\'s language', async () => {
        assert.strictEqual(await runSql(copy, "SELECT lang FROM res_partner WHERE id = (SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'partner_root');"), 'fr_FR');
        const arch = await service.getArch(copy, viewId);
        assert.ok(arch.includes('string="Reference"'), arch);
        assert.ok(!arch.includes('Référence'), arch);
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

    test('an arch that still cannot compose is saved, and the view stays off with Odoo\'s reason', async () => {
        const result = await service.save(copy, viewId, STILL_BROKEN);
        assert.strictEqual(result.active, false);
        assert.strictEqual(result.activated, false);
        assert.match(result.activationError ?? '', /odt_does_not_exist_2/);
        assert.ok((await service.getArch(copy, viewId)).includes('odt_does_not_exist_2'));
        assert.strictEqual(await runSql(copy, `SELECT active FROM ir_ui_view WHERE id = ${viewId};`), 'f');
    });

    test('a fixed arch saves, turns the view on, and keeps its non-ASCII text', async () => {
        const before = await service.writeDate(copy, viewId);
        const signalBefore = await templatesCacheSignal(copy);
        const result = await service.save(copy, viewId, FIXED);
        assert.deepStrictEqual(result, { active: true, activated: true, activationError: null });
        // What makes a running server show the change without a restart.
        assert.ok(await templatesCacheSignal(copy) > signalBefore, 'the view caches of a running server were not signalled');
        assert.strictEqual(await runSql(copy, `SELECT active FROM ir_ui_view WHERE id = ${viewId};`), 't');
        assert.ok((await service.getArch(copy, viewId)).includes('Prénom ✓'));
        assert.notStrictEqual(await service.writeDate(copy, viewId), before);
    });

    test('the save wrote the source and kept the French translation apart', async () => {
        if (await archIsJsonb(copy)) {
            const source = await runSql(copy, `SELECT arch_db->>'en_US' FROM ir_ui_view WHERE id = ${viewId};`);
            const french = await runSql(copy, `SELECT arch_db->>'fr_FR' FROM ir_ui_view WHERE id = ${viewId};`);
            assert.ok(source.includes('string="Reference"') && !source.includes('Référence'), source);
            assert.ok(french.includes('Référence') && !french.includes('odt_does_not_exist'), french);
        } else {
            const source = await runSql(copy, `SELECT arch_db FROM ir_ui_view WHERE id = ${viewId};`);
            assert.ok(source.includes('string="Reference"') && !source.includes('Référence'), source);
            assert.strictEqual(await runSql(copy,
                `SELECT value FROM ir_translation WHERE name = 'ir.ui.view,arch_db' AND res_id = ${viewId} AND lang = 'fr_FR' AND src = 'Reference';`), 'Référence');
        }
    });

    test('deactivate turns it back off', async () => {
        await service.deactivate(copy, viewId);
        assert.strictEqual(await runSql(copy, `SELECT active FROM ir_ui_view WHERE id = ${viewId};`), 'f');
    });

    test('a registry reload in the running server restarts the shell and the request still succeeds', async () => {
        const startedBefore = workersStarted;
        await runSql(copy, SIGNAL_REGISTRY_RELOAD);
        assert.ok((await service.getArch(copy, viewId)).includes('Prénom ✓'));
        assert.strictEqual(workersStarted, startedBefore + 1);
    });

    test('a lost database connection restarts the shell and the request still succeeds', async () => {
        const startedBefore = workersStarted;
        const ended = await runSql('postgres', `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
            WHERE datname = ${sqlLiteral(copy)} AND application_name = '${VIEW_WORKER_APP_NAME}';`);
        assert.ok(Number(ended) > 0, 'the shell had no connection to end');
        assert.ok((await service.getArch(copy, viewId)).includes('Prénom ✓'));
        assert.strictEqual(workersStarted, startedBefore + 1);
    });

    test('make_action opens the view\'s root, reused, with the record left to the URL', async () => {
        const rootId = Number(await runSql(copy, "SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'view_partner_form';"));
        const first = await service.makeAction(copy, viewId);
        assert.deepStrictEqual([first.model, first.viewType, first.rootId], ['res.partner', 'form', rootId]);
        assert.match(first.series, /\d+\.\d+/);
        const stamp = () => runSql(copy, `SELECT write_date FROM ir_act_window WHERE id = ${first.actionId};`);
        const written = await stamp();
        const again = await service.makeAction(copy, viewId);
        assert.strictEqual(again.actionId, first.actionId);
        assert.strictEqual(await stamp(), written, 'a second make_action rewrote the action');
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
            assert.strictEqual(info.user_context?.lang, 'en_US');
        } finally {
            await server.stop();
        }
    });

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

    test('dropping the database ends another window\'s shell on it too', async () => {
        // Another window's pool: no release hook of this one knows about it.
        const otherWindow = new ViewWorkerPool(async dbName => newWorker(dbName));
        try {
            assert.ok((await new ViewService(otherWindow).getArch(copy, viewId)).includes('Prénom ✓'));
            assert.ok(pool.has(copy), 'this window\'s shell should be open too');
            await dropDatabase(copy);
            assert.strictEqual(await databaseExists(copy), false);
            await assert.rejects(new ViewService(otherWindow).getArch(copy, viewId));
        } finally {
            otherWindow.dispose();
        }
    });
});
