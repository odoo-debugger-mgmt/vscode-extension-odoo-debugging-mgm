/**
 * One window builds queued versions at a time (design §9, problem 5): two
 * windows draining the shared queue built the same branch twice.
 */
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LEASE_FILE, STALE_MS, acquireLease, mayTakeLease, parseLease } from '../services/provisionLease';

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
});
