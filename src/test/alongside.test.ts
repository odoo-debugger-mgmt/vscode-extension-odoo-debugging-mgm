import * as assert from 'assert';
import {
    alongsideArgs, alongsideName, checkoutConflicts, describeHeldBack, heldBackCheckouts, pickFreePort, realtimePortFlag, reservePort, reservedPorts, workersOf
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

    test('port flags given as one token (space or equals) are stripped', () => {
        assert.deepStrictEqual(
            alongsideArgs(['-d', 'x', '--http-port 9000', '-p 9001', '-p9002', '-p=9003', '--gevent-port 8072'], 8100),
            ['-p', '8100', '-d', 'x']
        );
    });

    test('non-port flags with equals or spaces in the value are kept', () => {
        const result = alongsideArgs(['--dev=all', '--db-filter=^x$', '-d', 'demo'], 8100);
        assert.ok(result.some(a => a === '--dev=all'));
        assert.ok(result.some(a => a === '--db-filter=^x$'));
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

    test('a checkout an alongside run uses on another branch is held back; the rest proceed', () => {
        const runs = [{
            dbId: 'demo',
            entries: [
                { repoName: 'shared', path: '/repos/shared', branch: '17.0-a', isWorktree: false },
                { repoName: 'copied', path: '/wt/copied@17.0-a', branch: '17.0-a', isWorktree: true },
                { repoName: 'same', path: '/repos/same', branch: '17.0-x', isWorktree: false },
                { repoName: 'loose', path: '/repos/loose', isWorktree: false }
            ]
        }];
        const held = heldBackCheckouts([
            { path: '/repos/shared/', branch: '17.0-b' },
            { path: '/repos/copied', branch: '17.0-b' },
            { path: '/repos/same', branch: '17.0-x' },
            { path: '/repos/loose', branch: '17.0-b' },
            { path: '/repos/other', branch: '17.0-b' }
        ], runs);
        assert.deepStrictEqual(held, [
            { path: '/repos/shared/', branch: '17.0-b', repoName: 'shared', keptBranch: '17.0-a', dbId: 'demo' }
        ]);
        assert.deepStrictEqual(heldBackCheckouts([{ path: '/repos/shared', branch: '17.0-b' }], []), []);
    });

    test('a held-back checkout is explained in one sentence naming the repo and the run', () => {
        assert.strictEqual(
            describeHeldBack([{ path: '/r/a', branch: 'b2', repoName: 'a', keptBranch: 'b1', dbId: 'demo' }]),
            'Kept "a" on b1: "demo" runs alongside from that checkout. Use one copy per branch to run both.'
        );
        assert.strictEqual(
            describeHeldBack([
                { path: '/r/a', branch: 'b2', repoName: 'a', keptBranch: 'b1', dbId: 'demo' },
                { path: '/r/c', branch: 'b2', repoName: 'c', keptBranch: 'b1', dbId: 'shop' }
            ]),
            'Kept "a" on b1 and "c" on b1: "demo" and "shop" run alongside from those checkouts. Use one copy per branch to run both.'
        );
    });
});
