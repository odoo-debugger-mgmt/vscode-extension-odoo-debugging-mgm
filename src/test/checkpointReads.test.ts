import * as assert from 'assert';
import { withCheckpointOpen, CheckpointOpener } from '../services/checkpointReads';

function opener() {
    const calls: string[] = [];
    const o: CheckpointOpener = {
        open: async db => { calls.push(`open ${db}`); },
        close: async db => { calls.push(`close ${db}`); }
    };
    return { o, calls };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

suite('Reading a checkpoint', () => {
    test('opens for the read and closes after', async () => {
        const { o, calls } = opener();
        const value = await withCheckpointOpen('cp', async () => { calls.push('read'); return 42; }, o);
        assert.strictEqual(value, 42);
        assert.deepStrictEqual(calls, ['open cp', 'read', 'close cp']);
    });

    test('two reads at once share one opening, and the last closes it', async () => {
        const { o, calls } = opener();
        let release!: () => void;
        const slow = new Promise<void>(resolve => { release = resolve; });
        const a = withCheckpointOpen('cp', async () => { calls.push('a start'); await slow; calls.push('a end'); }, o);
        await tick();
        const b = withCheckpointOpen('cp', async () => { calls.push('b'); }, o);
        await b;
        assert.ok(!calls.includes('close cp'), 'b must not close it under a');
        release();
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
});
