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

    suiteSetup(async () => {
        await dropDatabaseIfExists(copy);
        await createDatabase(copy, sourceDb);
        const { stdout } = await runCommand(python!, [`${odoo}/odoo-bin`, 'shell', '--no-http', '--addons-path', addonsPaths.join(','), '-d', copy], { input: SETUP });
        viewId = Number(/ODT_VIEW_ID:(\d+)/.exec(stdout)?.[1]);
        assert.ok(viewId > 0, `setup printed no view id:\n${stdout}`);

        pool = new ViewWorkerPool(async dbName => {
            workersStarted++;
            return new ViewWorker({
                command: python!,
                args: buildViewWorkerArgs({ odooBinPath: `${odoo}/odoo-bin`, addonsPaths, dbName }),
                env: viewWorkerEnv(process.env),
                bootstrap: workerBootstrap(scriptPath)
            });
        });
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

    test('a registry reload in the running server restarts the shell and the request still succeeds', async () => {
        const startedBefore = workersStarted;
        await runSql(copy, SIGNAL_REGISTRY_RELOAD);
        assert.ok((await service.getArch(copy, viewId)).includes('Prénom ✓'));
        assert.strictEqual(workersStarted, startedBefore + 1);
    });
});
