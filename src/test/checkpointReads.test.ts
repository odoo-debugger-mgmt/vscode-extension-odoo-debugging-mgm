import * as assert from 'assert';
import { withCheckpointOpen, closeOpenCheckpointsWith, CheckpointOpener } from '../services/checkpointReads';

function opener() {
    const calls: string[] = [];
    const o: CheckpointOpener = {
        open: async db => { calls.push(`open ${db}`); },
        close: async db => { calls.push(`close ${db}`); }
    };
    return { o, calls };
}

function deferred() {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); } };

suite('Reading a checkpoint', () => {
    test('opens for the read and closes after', async () => {
        const { o, calls } = opener();
        const value = await withCheckpointOpen('cp', async () => { calls.push('read'); return 42; }, o);
        assert.strictEqual(value, 42);
        assert.deepStrictEqual(calls, ['open cp', 'read', 'close cp']);
    });

    test('two reads at once share one opening, and the last closes it', async () => {
        const { o, calls } = opener();
        const gate = deferred();
        const started = deferred();
        const a = withCheckpointOpen('cp', async () => { calls.push('a start'); started.resolve(); await gate.promise; calls.push('a end'); }, o);
        await started.promise;
        const b = withCheckpointOpen('cp', async () => { calls.push('b'); }, o);
        await b;
        assert.ok(!calls.includes('close cp'), 'b must not close it under a');
        gate.resolve();
        await a;
        assert.deepStrictEqual(calls.filter(c => c.startsWith('open') || c.startsWith('close')), ['open cp', 'close cp']);
    });

    test('a read that throws still closes it', async () => {
        const { o, calls } = opener();
        await assert.rejects(withCheckpointOpen('cp', async () => { throw new Error('boom'); }, o), /boom/);
        assert.deepStrictEqual(calls, ['open cp', 'close cp']);
    });

    test('a failed open does not count as opened', async () => {
        const calls: string[] = [];
        const o: CheckpointOpener = { open: async () => { throw new Error('denied'); }, close: async db => { calls.push(`close ${db}`); } };
        await assert.rejects(withCheckpointOpen('cp', async () => 1, o), /denied/);
        assert.deepStrictEqual(calls, []);
        const ok = opener();
        assert.strictEqual(await withCheckpointOpen('cp', async () => 2, ok.o), 2, 'the count is back to zero');
        assert.deepStrictEqual(ok.calls, ['open cp', 'close cp']);
    });

    test('different checkpoints are counted apart', async () => {
        const { o, calls } = opener();
        await Promise.all([withCheckpointOpen('a', async () => 1, o), withCheckpointOpen('b', async () => 2, o)]);
        assert.deepStrictEqual(calls.sort(), ['close a', 'close b', 'open a', 'open b']);
    });

    test('a read arriving while the last one is closing opens only after the close finished', async () => {
        const calls: string[] = [];
        const closeGate = deferred();
        const o: CheckpointOpener = {
            open: async db => { calls.push(`open ${db}`); },
            close: async db => { calls.push(`close ${db}`); await closeGate.promise; calls.push(`closed ${db}`); }
        };
        const a = withCheckpointOpen('cp', async () => 1, o);
        await flush();
        assert.deepStrictEqual(calls, ['open cp', 'close cp']);
        const b = withCheckpointOpen('cp', async () => 2, o);
        await flush();
        assert.deepStrictEqual(calls, ['open cp', 'close cp'], 'the second open waits for the close');
        closeGate.resolve();
        assert.strictEqual(await a, 1);
        assert.strictEqual(await b, 2);
        assert.deepStrictEqual(calls, ['open cp', 'close cp', 'closed cp', 'open cp', 'close cp', 'closed cp']);
    });

    test('an open that fails rejects every read waiting on it, and a later read opens again', async () => {
        const calls: string[] = [];
        const gate = deferred();
        let fail = true;
        const o: CheckpointOpener = {
            open: async db => { calls.push(`open ${db}`); if (fail) { await gate.promise; throw new Error('denied'); } },
            close: async db => { calls.push(`close ${db}`); }
        };
        const a = withCheckpointOpen('cp', async () => 1, o);
        const b = withCheckpointOpen('cp', async () => 2, o);
        const checks = Promise.all([assert.rejects(a, /denied/), assert.rejects(b, /denied/)]);
        gate.reject(new Error('denied'));
        await checks.catch(() => undefined);
        fail = false;
        assert.strictEqual(await withCheckpointOpen('cp', async () => 3, o), 3);
        assert.deepStrictEqual(calls, ['open cp', 'open cp', 'close cp']);
    });

    test('a close that fails does not fail the read, and the next read opens and closes normally', async () => {
        const calls: string[] = [];
        let failClose = true;
        const o: CheckpointOpener = {
            open: async db => { calls.push(`open ${db}`); },
            close: async db => { calls.push(`close ${db}`); if (failClose) { throw new Error('nope'); } }
        };
        assert.strictEqual(await withCheckpointOpen('cp', async () => 7, o), 7);
        failClose = false;
        assert.strictEqual(await withCheckpointOpen('cp', async () => 8, o), 8);
        assert.deepStrictEqual(calls, ['open cp', 'close cp', 'open cp', 'close cp']);
    });

    const refused = () => new Error('psql --no-psqlrc -v ON_ERROR_STOP=1 -d cp failed (exit code 2): psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  database "cp" is not currently accepting connections');

    test('a read refused because another window closed it meanwhile opens it again and retries once', async () => {
        const { o, calls } = opener();
        let tries = 0;
        const value = await withCheckpointOpen('cp', async () => {
            tries++;
            calls.push(`read ${tries}`);
            if (tries === 1) {
                throw refused();
            }
            return 9;
        }, o);
        assert.strictEqual(value, 9);
        assert.deepStrictEqual(calls, ['open cp', 'read 1', 'close cp', 'open cp', 'read 2', 'close cp']);
    });

    test('the retry opens it again even when another read here still holds it, and only the last read closes', async () => {
        const { o, calls } = opener();
        const gate = deferred();
        const started = deferred();
        const a = withCheckpointOpen('cp', async () => { calls.push('a start'); started.resolve(); await gate.promise; calls.push('a end'); }, o);
        await started.promise;
        let tries = 0;
        const b = await withCheckpointOpen('cp', async () => { tries++; calls.push(`b ${tries}`); if (tries === 1) { throw refused(); } return 2; }, o);
        assert.strictEqual(b, 2);
        assert.deepStrictEqual(calls, ['open cp', 'a start', 'b 1', 'open cp', 'b 2'], 'the retry re-opened it without closing it under a');
        gate.resolve();
        await a;
        assert.deepStrictEqual(calls.slice(-2), ['a end', 'close cp']);
    });

    test('a read refused twice, or failing otherwise, is not retried again', async () => {
        const { o, calls } = opener();
        let tries = 0;
        await assert.rejects(withCheckpointOpen('cp', async () => { tries++; throw refused(); }, o), /not currently accepting connections/);
        assert.strictEqual(tries, 2);
        tries = 0;
        await assert.rejects(withCheckpointOpen('cp', async () => { tries++; throw new Error('syntax error'); }, o), /syntax error/);
        assert.strictEqual(tries, 1);
        assert.deepStrictEqual(calls.filter(c => c === 'close cp').length, 3, 'every opening is closed again');
    });
});

suite('Sweeping open checkpoints', () => {
    function deps(over: { open?: string[]; connected?: string[] } = {}) {
        const calls: string[] = [];
        const opener: CheckpointOpener = { open: async db => { calls.push(`open ${db}`); }, close: async db => { calls.push(`close ${db}`); } };
        return {
            calls,
            d: {
                recorded: async () => ['cp'],
                openNow: async () => over.open ?? ['cp'],
                connected: async (name: string) => (over.connected ?? []).includes(name),
                opener
            }
        };
    }

    test('a free open checkpoint is closed', async () => {
        const { d, calls } = deps();
        assert.deepStrictEqual(await closeOpenCheckpointsWith(d), ['cp']);
        assert.deepStrictEqual(calls, ['close cp']);
    });

    test('one with a live connection is skipped', async () => {
        const { d, calls } = deps({ connected: ['cp'] });
        assert.deepStrictEqual(await closeOpenCheckpointsWith(d), []);
        assert.deepStrictEqual(calls, []);
    });

    test('one being read in this process is skipped', async () => {
        const { d, calls } = deps();
        const gate = deferred();
        const started = deferred();
        const read = withCheckpointOpen('cp', async () => { started.resolve(); await gate.promise; }, d.opener);
        await started.promise;
        assert.deepStrictEqual(await closeOpenCheckpointsWith(d), []);
        gate.resolve();
        await read;
        assert.deepStrictEqual(calls, ['open cp', 'close cp']);
    });

    test('a read started during the sweep close opens only after it', async () => {
        const calls: string[] = [];
        const closeGate = deferred();
        const opener: CheckpointOpener = {
            open: async db => { calls.push(`open ${db}`); },
            close: async db => { calls.push(`close ${db}`); await closeGate.promise; calls.push(`closed ${db}`); }
        };
        const sweep = closeOpenCheckpointsWith({ recorded: async () => ['cp'], openNow: async () => ['cp'], connected: async () => false, opener });
        await flush();
        const read = withCheckpointOpen('cp', async () => 1, opener);
        await flush();
        assert.deepStrictEqual(calls, ['close cp']);
        closeGate.resolve();
        await sweep;
        await read;
        assert.deepStrictEqual(calls, ['close cp', 'closed cp', 'open cp', 'close cp', 'closed cp']);
    });

    test('a read that starts during the connection check is not closed under', async () => {
        const calls: string[] = [];
        const opener: CheckpointOpener = { open: async db => { calls.push(`open ${db}`); }, close: async db => { calls.push(`close ${db}`); } };
        const check = deferred();
        const sweep = closeOpenCheckpointsWith({
            recorded: async () => ['cp'], openNow: async () => ['cp'],
            connected: async () => { await check.promise; return false; }, opener
        });
        await flush();
        const gate = deferred();
        const started = deferred();
        const read = withCheckpointOpen('cp', async () => { started.resolve(); await gate.promise; }, opener);
        await started.promise;
        check.resolve();
        assert.deepStrictEqual(await sweep, []);
        assert.deepStrictEqual(calls, ['open cp']);
        gate.resolve();
        await read;
        assert.deepStrictEqual(calls, ['open cp', 'close cp']);
    });
});
