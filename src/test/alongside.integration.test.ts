/**
 * Two databases of one Odoo version running at once, on a real Odoo. Skipped
 * unless ODT_ALONGSIDE_TEST_PYTHON (a venv python) and ODT_ALONGSIDE_TEST_ODOO
 * (an Odoo checkout) are set. ODT_ALONGSIDE_TEST_DB may name a database with
 * base installed; otherwise one is built. Every database it makes is named
 * odt_al_<run>* and dropped afterwards.
 */
import * as assert from 'assert';
import * as http from 'node:http';
import * as path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { runSql } from '../services/postgres';
import { copyDatabase, discardDatabase } from '../services/databaseCopy';
import { realCopyBackend } from '../services/copyRuntime';
import { alongsideArgs, pickFreePort } from '../services/alongside';
import { isPortOpen, waitForPort } from '../services/server';
import { sqlText } from '../services/views/viewQueries';

const python = process.env.ODT_ALONGSIDE_TEST_PYTHON;
const odoo = process.env.ODT_ALONGSIDE_TEST_ODOO;
const enabled = Boolean(python && odoo);

function get(port: number, db: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/web/login?db=${db}`, res => {
            res.resume();
            resolve(res.statusCode ?? 0);
        });
        req.setTimeout(30000, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

function exited(child: ChildProcess): Promise<void> {
    return new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
        } else {
            child.once('exit', () => resolve());
        }
    });
}

async function stop(child: ChildProcess | undefined): Promise<void> {
    if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    await exited(child);
    clearTimeout(timer);
}

(enabled ? suite : suite.skip)('Alongside on a real Odoo', function () {
    this.timeout(330000);
    const suffix = `${process.pid}_${Date.now().toString(36)}`;
    const prefix = `odt_al_${suffix}`;
    const given = process.env.ODT_ALONGSIDE_TEST_DB;
    const a = given ?? `${prefix}_a`;
    const b = `${prefix}_b`;
    const backend = realCopyBackend();
    const servers: ChildProcess[] = [];
    let portA = 0;
    let portB = 0;

    const base = (db: string) => ['--addons-path', `${odoo}/odoo/addons,${odoo}/addons`, '-d', db, '--max-cron-threads', '0'];
    const env = { ...process.env, PGAPPNAME: 'odt-alongside-test' };
    const launch = (db: string, port: number): ChildProcess => {
        const child = spawn(python!, [path.join(odoo!, 'odoo-bin'), ...alongsideArgs(base(db), port)], { env, stdio: 'ignore' });
        servers.push(child);
        return child;
    };

    suiteSetup(async function () {
        if (!given) {
            const build = spawn(python!, [path.join(odoo!, 'odoo-bin'), '-d', a, '-i', 'base', '--stop-after-init',
                '--addons-path', `${odoo}/odoo/addons,${odoo}/addons`, '--without-demo=all', '--max-cron-threads', '0'], { env, stdio: 'ignore' });
            servers.push(build);
            const code = await new Promise<number | null>((resolve, reject) => {
                build.once('error', reject);
                build.once('exit', resolve);
            });
            assert.strictEqual(code, 0, 'installing base');
        }
        await copyDatabase(backend, a, b, {});
    });

    suiteTeardown(async () => {
        await Promise.all(servers.map(stop));
        const mine = prefix.replace(/[\\_%]/g, '\\$&') + '%';
        const names = (await runSql('postgres', `SELECT datname FROM pg_database WHERE datname LIKE ${sqlText(mine)};`)).split('\n').filter(Boolean);
        for (const name of names) {
            await discardDatabase(backend, name).catch(() => undefined);
        }
    });

    test('two databases of one version answer on their own ports', async () => {
        portA = await pickFreePort(isPortOpen, new Set());
        launch(a, portA);
        assert.ok(await waitForPort(portA, 120000), 'server A listens');
        portB = await pickFreePort(isPortOpen, new Set());
        assert.notStrictEqual(portB, portA);
        launch(b, portB);
        assert.ok(await waitForPort(portB, 120000), 'server B listens');
        assert.ok([200, 303].includes(await get(portA, a)));
        assert.ok([200, 303].includes(await get(portB, b)));
    });

    test('stopping one leaves the other running', async () => {
        await stop(servers[servers.length - 2]);
        assert.strictEqual(await isPortOpen(portA), false);
        assert.ok([200, 303].includes(await get(portB, b)));
    });
});
