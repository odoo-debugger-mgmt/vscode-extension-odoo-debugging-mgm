import * as assert from 'assert';
import {
    describeConnection, parseConnections, releaseForCopy, DbConnection, ManagedRun, ReleaseHost, ReleaseUi
} from '../services/connectionRelease';

const RUN: ManagedRun = { versionId: 'v17', debuggerName: 'Odoo 17', noDebug: true, dbName: 'shop' };
const PSQL: DbConnection = { pid: 41, application: 'psql', client: '', user: 'odoo' };
const ODOO: DbConnection = { pid: 42, application: 'odoo-1234', client: '127.0.0.1', user: 'odoo' };

function host(opts: { run?: ManagedRun; connections?: DbConnection[][]; endFails?: boolean; connectionsFail?: boolean; startFails?: boolean } = {}) {
    const calls: string[] = [];
    // Each connections() call takes the next snapshot; the last one repeats.
    const snapshots = opts.connections ?? [[]];
    let read = 0;
    const restartFailures: unknown[] = [];
    const h: ReleaseHost = {
        letGo: async db => { calls.push(`letGo ${db}`); },
        ownRun: async () => opts.run,
        stop: async run => { calls.push(`stop ${run.debuggerName}`); },
        start: async run => { if (opts.startFails) { throw new Error('start broke'); } calls.push(`start ${run.debuggerName} noDebug=${run.noDebug}`); },
        connections: async () => { if (opts.connectionsFail) { throw new Error('connections broke'); } return snapshots[Math.min(read++, snapshots.length - 1)]; },
        endOwnQueries: async db => { calls.push(`endOwn ${db}`); },
        end: async (db, pids) => { if (opts.endFails) { throw new Error('end broke'); } calls.push(`end ${db} ${pids.join(',')}`); },
        sleep: async () => undefined,
        restartFailed: (_run, error) => { restartFailures.push(error); }
    };
    return { h, calls, restartFailures };
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

    test('end throwing after a stop still restarts, and the original error wins', async () => {
        const { h, calls } = host({ run: RUN, connections: [[PSQL]], endFails: true });
        const { u } = ui();
        await assert.rejects(releaseForCopy('shop', h, u), /end broke/);
        assert.ok(calls.includes('start Odoo 17 noDebug=true'));
    });

    test('connections throwing after a stop still restarts, and the original error wins', async () => {
        const { h, calls } = host({ run: RUN, connectionsFail: true });
        const { u } = ui();
        await assert.rejects(releaseForCopy('shop', h, u), /connections broke/);
        assert.ok(calls.includes('start Odoo 17 noDebug=true'));
    });

    test('a restart that fails while declining is reported, and declining still returns undefined', async () => {
        const { h, restartFailures } = host({ run: RUN, connections: [[PSQL]], startFails: true });
        const { u } = ui({ end: false });
        assert.strictEqual(await releaseForCopy('shop', h, u), undefined);
        assert.strictEqual(restartFailures.length, 1);
    });

    test('parses the connection query and describes each one', () => {
        const rows = parseConnections(`41\x1fpsql\x1f\x1fodoo\n42\x1fodoo-1234\x1f127.0.0.1\x1fodoo\n\n`);
        assert.deepStrictEqual(rows, [PSQL, ODOO]);
        assert.strictEqual(describeConnection(PSQL), 'psql (local socket)');
        assert.strictEqual(describeConnection(ODOO), 'odoo-1234 (127.0.0.1)');
        assert.strictEqual(describeConnection({ pid: 1, application: '', client: '10.0.0.2', user: 'x' }), 'an unnamed client (10.0.0.2)');
    });
});
