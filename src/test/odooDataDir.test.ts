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
