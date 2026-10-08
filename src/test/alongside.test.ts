import * as assert from 'assert';
import {
    alongsideArgs, alongsideName, checkoutConflicts, pickFreePort, realtimePortFlag, reservePort, reservedPorts, workersOf
} from '../services/alongside';

suite('Alongside helpers', () => {
    test('the name is the debugger name and the database', () => {
        assert.strictEqual(alongsideName('odoo:17.0', 'demo'), 'odoo:17.0 · demo');
    });

    test('the first port from 8100 that is neither open nor taken', async () => {
        const open = new Set([8100, 8102]);
        const port = await pickFreePort(async p => open.has(p), new Set([8101]));
        assert.strictEqual(port, 8103);
    });

    test('no free port in the range is an error that says so', async () => {
        await assert.rejects(pickFreePort(async () => true, new Set(), 8100, 8102), /8100.*8102/);
    });

    test('a reserved port is taken until released', () => {
        const release = reservePort(8105, 60000);
        assert.ok(reservedPorts().has(8105));
        release();
        assert.ok(!reservedPorts().has(8105));
    });

    test('a reservation expires on its own', async () => {
        reservePort(8106, 10);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.ok(!reservedPorts().has(8106));
    });

    test('workers from the extra params', () => {
        assert.strictEqual(workersOf('--log-handler,odoo:WARNING'), 0);
        assert.strictEqual(workersOf('--workers=4'), 4);
        assert.strictEqual(workersOf('--workers,2'), 2);
        assert.strictEqual(workersOf('--workers 3'), 3);
        assert.strictEqual(workersOf('--workers=junk'), 0);
    });

    test('the realtime port flag follows the series', () => {
        assert.strictEqual(realtimePortFlag('15.0'), '--longpolling-port');
        assert.strictEqual(realtimePortFlag('16.0'), '--gevent-port');
        assert.strictEqual(realtimePortFlag('saas-17.4'), '--gevent-port');
        assert.strictEqual(realtimePortFlag('master'), '--gevent-port');
        assert.strictEqual(realtimePortFlag(undefined), '--gevent-port');
    });

    test('the args listen on the alongside port, and nothing in them overrides it', () => {
        const base = ['-p', '8017', '--addons-path', 'a,b', '-d', 'demo', '--http-port=9000', '--gevent-port', '8072', '--dev=all'];
        assert.deepStrictEqual(alongsideArgs(base, 8100), ['-p', '8100', '--addons-path', 'a,b', '-d', 'demo', '--dev=all']);
        assert.deepStrictEqual(
            alongsideArgs(['-d', 'demo'], 8101, { flag: '--gevent-port', port: 8102 }),
            ['-p', '8101', '-d', 'demo', '--gevent-port', '8102']
        );
        assert.deepStrictEqual(alongsideArgs(['-p', '8017', '-p', '9999', '-d', 'x'], 8100), ['-p', '8100', '-d', 'x'], 'a second -p from extra params goes');
        assert.ok(!alongsideArgs(['--longpolling-port=8072', '-d', 'x'], 8100).some(a => a.includes('8072')));
    });

    test('a single checkout on another branch is a conflict; a copy per branch is not', () => {
        const resolved = [
            { repo: { name: 'acme' }, path: '/r/acme', branch: '17.0-fix', mode: 'checkout', isWorktree: false },
            { repo: { name: 'tools' }, path: '/r/tools', branch: '17.0', mode: 'checkout', isWorktree: false },
            { repo: { name: 'wt' }, path: '/root/wt@feature', branch: 'feature', mode: 'worktree', isWorktree: true },
            { repo: { name: 'fallback' }, path: '/r/fallback', branch: 'other', mode: 'worktree', isWorktree: false },
            { repo: { name: 'nobranch' }, path: '/r/nobranch', mode: 'checkout', isWorktree: false }
        ];
        const current = new Map<string, string | null>([
            ['/r/acme', '17.0'], ['/r/tools', '17.0'], ['/root/wt@feature', 'feature'], ['/r/fallback', 'main'], ['/r/nobranch', 'x']
        ]);
        assert.deepStrictEqual(checkoutConflicts(resolved, current), [
            { repo: 'acme', path: '/r/acme', current: '17.0', needed: '17.0-fix', mode: 'checkout' },
            { repo: 'fallback', path: '/r/fallback', current: 'main', needed: 'other', mode: 'worktree' }
        ]);
    });

    test('an unreadable current branch is not reported as a conflict', () => {
        const resolved = [{ repo: { name: 'acme' }, path: '/r/acme', branch: 'x', mode: 'checkout', isWorktree: false }];
        assert.deepStrictEqual(checkoutConflicts(resolved, new Map([['/r/acme', null]])), []);
    });
});
