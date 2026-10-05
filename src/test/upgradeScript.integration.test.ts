/**
 * The upgrade script the View Doctor writes, run by a real Odoo with
 * upgrade-util. Skipped unless ODT_VIEW_TEST_PYTHON, ODT_VIEW_TEST_ODOO (an
 * odoo checkout), ODT_VIEW_TEST_DB (a database with base installed, for that
 * checkout's version) and ODT_VIEW_TEST_UPGRADE_UTIL (upgrade-util's src
 * folder) are set. Works on a copy of ODT_VIEW_TEST_DB, dropped afterwards.
 *
 * Three views are fixed through the extension's own shell: a module view
 * whose arch was edited, a view with no external id (as Studio makes them)
 * and a module view that was only turned off. They are scripted into the
 * module's migrations/1.0.1/, broken again, and `-u` must bring them back.
 */
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCommand } from '../services/process';
import { createDatabase, dropDatabaseIfExists, onBeforeDatabaseRelease, runSql } from '../services/postgres';
import { buildViewWorkerArgs, viewWorkerEnv } from '../services/views/viewWorkerArgs';
import { ViewWorker, workerBootstrap } from '../services/views/viewWorker';
import { ViewWorkerPool } from '../services/views/viewWorkerPool';
import { ViewService } from '../services/views/viewService';
import { ViewNoteStore } from '../services/views/viewNotes';
import { psqlNoteQueries, ViewNoteService } from '../services/views/viewNoteService';
import { buildScriptViews } from '../services/views/scriptBuilder';
import { setManifestVersion, writeScriptToFolder } from '../services/views/migrationsFolder';

const python = process.env.ODT_VIEW_TEST_PYTHON;
const odoo = process.env.ODT_VIEW_TEST_ODOO;
const sourceDb = process.env.ODT_VIEW_TEST_DB;
const upgradeUtil = process.env.ODT_VIEW_TEST_UPGRADE_UTIL;
const enabled = !!(python && odoo && sourceDb && upgradeUtil);

const MODULE = 'odt_vd_script';

const MANIFEST = `{
    'name': 'ODT View Doctor script test',
    'version': '1.0.0',
    'depends': ['base'],
    'data': ['views.xml'],
    'license': 'LGPL-3',
}
`;

const VIEWS_XML = `<?xml version="1.0" encoding="utf-8"?>
<odoo>
    <record id="view_partner_form_fixed" model="ir.ui.view">
        <field name="name">odt.vd.script.fixed</field>
        <field name="model">res.partner</field>
        <field name="inherit_id" ref="base.view_partner_form"/>
        <field name="arch" type="xml">
            <xpath expr="//field[@name='name']" position="after"><field name="ref"/></xpath>
        </field>
    </record>
    <record id="view_partner_form_reenabled" model="ir.ui.view">
        <field name="name">odt.vd.script.reenabled</field>
        <field name="model">res.partner</field>
        <field name="inherit_id" ref="base.view_partner_form"/>
        <field name="arch" type="xml">
            <xpath expr="//field[@name='email']" position="after"><field name="website"/></xpath>
        </field>
    </record>
</odoo>
`;

/** A view with no external id, the way Studio makes them. */
const STUDIO_SETUP = `
parent = env.ref('base.view_partner_form')
view = env['ir.ui.view'].create({
    'name': 'odt.vd.script.studio', 'type': 'form', 'model': 'res.partner', 'inherit_id': parent.id,
    'mode': 'extension',
    'arch': '<data><xpath expr="//field[@name=\\'name\\']" position="after"><field name="comment"/></xpath></data>',
})
env.cr.commit()
print('ODT_STUDIO_VIEW_ID:%d' % view.id)
`;

const brokenArch = (field: string) => `<data><xpath expr="//field[@name='odt_missing']" position="after"><field name="${field}"/></xpath></data>`;
const FIXED_ARCH = '<data><xpath expr="//field[@name=\'name\']" position="after"><field name="ref" string="ODT fixed"/></xpath></data>';
const STUDIO_ARCH = '<data><xpath expr="//field[@name=\'name\']" position="after"><field name="comment" string="ODT studio fixed"/></xpath></data>';

/** Whether arch_db holds every language in one jsonb (16 and later) or the source only (15). */
async function archIsJsonb(dbName: string): Promise<boolean> {
    return await runSql(dbName, "SELECT data_type FROM information_schema.columns WHERE table_name = 'ir_ui_view' AND column_name = 'arch_db';") === 'jsonb';
}

/** `text` as a SQL string literal. */
function sqlString(text: string): string {
    return `'${text.replace(/'/g, "''")}'`;
}

(enabled ? suite : suite.skip)('Upgrade script against a real Odoo', function () {
    this.timeout(900000);
    const copy = `${sourceDb}_odt_script_test`;
    const scriptPath = path.resolve(__dirname, '..', '..', 'resources', 'scripts', 'view_worker.py');
    let tempAddons = '';
    let noteDir = '';
    let moduleDir = '';
    let addonsPaths: string[] = [];
    let fixedId = 0;
    let reenabledId = 0;
    let studioId = 0;
    let pool: ViewWorkerPool | undefined;
    let release: { dispose(): void } | undefined;

    const odooBin = (...args: string[]) => runCommand(python!, [`${odoo}/odoo-bin`, '--addons-path', addonsPaths.join(','), ...args]);

    /** The three views as the upgrade left them: off, the edited two with an arch that cannot compose. */
    const breakViews = async () => {
        const archValue = await archIsJsonb(copy)
            ? (arch: string) => `jsonb_build_object('en_US', ${sqlString(arch)}::text)`
            : (arch: string) => sqlString(arch);
        await runSql(copy, `UPDATE ir_ui_view SET arch_db = ${archValue(brokenArch('ref'))}, active = false, arch_updated = false WHERE id = ${fixedId};`);
        await runSql(copy, `UPDATE ir_ui_view SET arch_db = ${archValue(brokenArch('comment'))}, active = false WHERE id = ${studioId};`);
        await runSql(copy, `UPDATE ir_ui_view SET active = false WHERE id = ${reenabledId};`);
    };

    suiteSetup(async () => {
        await dropDatabaseIfExists(copy);
        await createDatabase(copy, sourceDb);
        tempAddons = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-vd-addons-'));
        noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-vd-notes-'));
        moduleDir = path.join(tempAddons, MODULE);
        fs.mkdirSync(moduleDir);
        fs.writeFileSync(path.join(moduleDir, '__init__.py'), '');
        fs.writeFileSync(path.join(moduleDir, '__manifest__.py'), MANIFEST);
        fs.writeFileSync(path.join(moduleDir, 'views.xml'), VIEWS_XML);
        addonsPaths = [`${odoo}/odoo/addons`, `${odoo}/addons`, tempAddons];

        await odooBin('-d', copy, '-i', MODULE, '--stop-after-init', '--no-http');
        const { stdout } = await runCommand(python!, [`${odoo}/odoo-bin`, 'shell', '--no-http', '--addons-path', addonsPaths.join(','), '-d', copy], { input: STUDIO_SETUP });
        studioId = Number(/ODT_STUDIO_VIEW_ID:(\d+)/.exec(stdout)?.[1]);
        assert.ok(studioId > 0, `setup printed no view id:\n${stdout}`);
        const moduleView = async (name: string) => Number(await runSql(copy,
            `SELECT res_id FROM ir_model_data WHERE module = '${MODULE}' AND name = '${name}' AND model = 'ir.ui.view';`));
        fixedId = await moduleView('view_partner_form_fixed');
        reenabledId = await moduleView('view_partner_form_reenabled');
        assert.ok(fixedId > 0 && reenabledId > 0, 'the module views were not installed');

        pool = new ViewWorkerPool(async dbName => new ViewWorker({
            command: python!,
            args: buildViewWorkerArgs({ odooBinPath: `${odoo}/odoo-bin`, addonsPaths, dbName }),
            env: viewWorkerEnv(process.env),
            bootstrap: workerBootstrap(scriptPath)
        }));
        release = onBeforeDatabaseRelease(dbName => pool!.release(dbName));
    });

    suiteTeardown(async () => {
        release?.dispose();
        pool?.dispose();
        await dropDatabaseIfExists(copy);
        for (const dir of [tempAddons, noteDir]) {
            if (dir) {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    test('views fixed through the extension are scripted, and -u with upgrade-util brings them back', async () => {
        await breakViews();

        // Fixed through the extension's own shell, and noted as the UI notes them.
        const service = new ViewService(pool!);
        const notes = new ViewNoteService(new ViewNoteStore(noteDir), psqlNoteQueries);
        const fixed = await service.save(copy, fixedId, FIXED_ARCH);
        assert.strictEqual(fixed.activated, true, fixed.activationError ?? 'the fixed view did not turn on');
        const studio = await service.save(copy, studioId, STUDIO_ARCH);
        assert.strictEqual(studio.activated, true, studio.activationError ?? 'the Studio view did not turn on');
        await service.activate(copy, reenabledId);
        await notes.recordSave(copy, fixedId, true);
        await notes.recordSave(copy, studioId, true);
        await notes.recordActivate(copy, reenabledId);

        const build = await buildScriptViews({
            prepare: async db => ({ note: await notes.read(db), reEnabled: [] }),
            rows: (db, ids) => service.rows(db, ids),
            fingerprints: (db, ids) => psqlNoteQueries.fingerprints(db, ids),
            arch: (db, id) => service.getArch(db, id)
        }, copy);
        assert.strictEqual(build.views.length, 3, JSON.stringify(build, null, 2));
        const byId = new Map(build.views.map(view => [view.id, view]));
        const fixedView = byId.get(fixedId);
        const studioView = byId.get(studioId);
        const reenabledView = byId.get(reenabledId);
        assert.ok(fixedView && studioView && reenabledView, 'a view is missing from the script');
        assert.strictEqual(fixedView.xmlid, `${MODULE}.view_partner_form_fixed`);
        assert.ok(fixedView.arch?.includes('ODT fixed'), fixedView.arch ?? 'no arch');
        assert.strictEqual(studioView.xmlid, null);
        assert.ok(studioView.arch?.includes('ODT studio fixed'), studioView.arch ?? 'no arch');
        assert.strictEqual(reenabledView.arch, null);
        assert.strictEqual(reenabledView.why, 'not-edited');

        const written = await writeScriptToFolder(path.join(moduleDir, 'migrations', '1.0.1'), build.views);
        const manifestPath = path.join(moduleDir, '__manifest__.py');
        fs.writeFileSync(manifestPath, setManifestVersion(fs.readFileSync(manifestPath, 'utf-8'), '1.0.1'));
        const script = fs.readFileSync(written.path, 'utf-8');

        // Back to what the upgrade left; the installed version is still 1.0.0, so the folder is pending.
        await pool!.release(copy);
        await breakViews();

        let output: string;
        try {
            const result = await odooBin(`--upgrade-path=${upgradeUtil}`, '-d', copy, '-u', MODULE, '--stop-after-init', '--no-http');
            output = `${result.stdout}\n${result.stderr}`;
        } catch (error) {
            assert.fail(`-u failed with this script:\n${script}\n${error instanceof Error ? error.message : String(error)}`);
        }
        const context = `script:\n${script}\nOdoo:\n${output.split('\n').filter(line => /odt_vd_script|migration|ERROR|WARNING/i.test(line)).join('\n')}`;
        assert.match(output, /end-update_views/, context);

        assert.strictEqual(await runSql(copy, `SELECT active FROM ir_ui_view WHERE id = ${fixedId};`), 't', context);
        assert.strictEqual(await runSql(copy, `SELECT count(*) FROM ir_ui_view WHERE id = ${fixedId} AND arch_db::text LIKE '%ODT fixed%';`), '1', context);
        assert.strictEqual(await runSql(copy, `SELECT active FROM ir_ui_view WHERE id = ${studioId};`), 't', context);
        assert.strictEqual(await runSql(copy, `SELECT count(*) FROM ir_ui_view WHERE id = ${studioId} AND arch_db::text LIKE '%ODT studio fixed%';`), '1', context);
        assert.strictEqual(await runSql(copy, `SELECT active FROM ir_ui_view WHERE id = ${reenabledId};`), 't', context);
        // Odoo stores the version with the series in front (adapt_version): 18.0.1.0.1.
        assert.match(await runSql(copy, `SELECT latest_version FROM ir_module_module WHERE name = '${MODULE}';`), /^((saas~)?\d+\.\d+\.)?1\.0\.1$/, context);
    });
});
