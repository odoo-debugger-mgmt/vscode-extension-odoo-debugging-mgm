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

    test('refuses every optparse spelling and cannot be redirected by extraParams', () => {
        const refusedParts = ['-uall', '-ibase', '-p8070', '-dother', '--upd=x', '--ini=crm', '--stop-after',
            '--test-en', '--http-p=9000', '-d,other', '--database=other', '--addons-path=/evil',
            '-u,sale,--update,stock', '--addons,/evil'];
        for (const part of refusedParts) {
            const args = buildViewWorkerArgs({ ...base, extraParams: part });
            assert.deepStrictEqual(args, buildViewWorkerArgs(base), `leaked: ${part}`);
        }
    });

    test('keeps unrelated long options', () => {
        const kept = ['--db_host=localhost', '--data-dir=/x', '--limit-time-real=100', '--log-level=warn'];
        assert.deepStrictEqual(buildViewWorkerArgs({ ...base, extraParams: kept.join(',') }).slice(-4), kept);
    });

    test('a boolean refused flag does not eat the next part', () => {
        const args = buildViewWorkerArgs({ ...base, extraParams: '--test-enable,somevalue' });
        assert.strictEqual(args[args.length - 1], 'somevalue');
        assert.ok(!args.includes('--test-enable'));
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
