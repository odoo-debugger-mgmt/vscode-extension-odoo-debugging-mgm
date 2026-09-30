/**
 * One window builds queued versions at a time (design §9, problem 5): two
 * windows draining the shared queue built the same branch twice.
 */
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LEASE_FILE, STALE_MS, acquireLease, mayTakeLease, parseLease, withLease } from '../services/provisionLease';

suite('The provisioning lease', () => {
    const alive = () => true;
    const dead = () => false;

    test('free, or already this window\'s: it may drain', () => {
        assert.strictEqual(mayTakeLease(undefined, 'a', 0, alive), true);
        assert.strictEqual(mayTakeLease({ owner: 'a', pid: 1, heartbeat: 0 }, 'a', 10 * STALE_MS, alive), true);
    });

    test('held by a live window that said so recently: it may not', () => {
        assert.strictEqual(mayTakeLease({ owner: 'b', pid: 1, heartbeat: 1000 }, 'a', 1000 + STALE_MS - 1, alive), false);
    });

    test('a holder whose process is gone, or silent too long, is taken over', () => {
        assert.strictEqual(mayTakeLease({ owner: 'b', pid: 1, heartbeat: 1000 }, 'a', 1001, dead), true);
        assert.strictEqual(mayTakeLease({ owner: 'b', pid: 1, heartbeat: 1000 }, 'a', 1000 + STALE_MS + 1, alive), true);
    });

    test('an unreadable lease file is no lease', () => {
        assert.strictEqual(parseLease('{ not json'), undefined);
        assert.strictEqual(parseLease('{"owner": 3}'), undefined);
    });

    test('two windows on one provisioning root: the second waits, then gets it once released', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-lease-'));
        try {
            const first = acquireLease(root, 'window-a');
            assert.ok(first, 'the first window takes the free lease');
            // This process is alive and just wrote a heartbeat.
            assert.strictEqual(acquireLease(root, 'window-b'), undefined);

            first!.release();
            assert.ok(!fs.existsSync(path.join(root, LEASE_FILE)));
            const second = acquireLease(root, 'window-b');
            assert.ok(second, 'released, it can be taken');
            // Releasing someone else's lease does nothing.
            first!.release();
            assert.ok(fs.existsSync(path.join(root, LEASE_FILE)));
            second!.release();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('a holder that stalled knows it lost the lease once another window took over', () => {
        // Thirteenth run: a frozen window resumed and finished a build the
        // other window had already redone, saving a second Odoo 9.0.
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-lease-'));
        try {
            const frozen = acquireLease(root, 'window-a', () => 1000);
            assert.strictEqual(frozen!.held(), true);
            // Silent past the stale limit: the other window takes over.
            const other = acquireLease(root, 'window-b', () => 1000 + STALE_MS + 1);
            assert.ok(other);
            assert.strictEqual(frozen!.held(), false);
            other!.release();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('a build started by hand while this window\'s queue holds it does not release the queue\'s lease', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-lease-'));
        try {
            const queue = acquireLease(root, 'window-a');
            const byHand = acquireLease(root, 'window-a');
            assert.ok(byHand, 'the same window may take it again');
            byHand!.release();
            assert.strictEqual(queue!.held(), true);
            queue!.release();
            assert.ok(!fs.existsSync(path.join(root, LEASE_FILE)));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('a build by hand waits while another window builds, then runs', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-lease-'));
        try {
            const elsewhere = acquireLease(root, 'another-window');
            let waited = false;
            const running = withLease(root, async () => 'built', {
                onWait: () => {
                    waited = true;
                    setTimeout(() => elsewhere!.release(), 20);
                },
                pollMs: 10
            });
            assert.strictEqual(await running, 'built');
            assert.strictEqual(waited, true);
            assert.ok(!fs.existsSync(path.join(root, LEASE_FILE)), 'released after the build');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('cancelled while waiting, nothing runs', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-lease-'));
        try {
            const elsewhere = acquireLease(root, 'another-window');
            let ran = false;
            const result = await withLease(root, async () => {
                ran = true;
            }, { isCancelled: () => true, pollMs: 10 });
            assert.strictEqual(result, undefined);
            assert.strictEqual(ran, false);
            elsewhere!.release();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
