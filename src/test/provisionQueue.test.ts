import * as assert from 'assert';
import {
    resolveQueueTarget,
    EMPTY_QUEUE,
    QueueState,
    describeDrain,
    enqueue,
    finishActive,
    queueLabel,
    takeNext
} from '../services/provisionQueue';

const entry = (branch: string): { branch: string; name: string } => ({ branch, name: `Odoo ${branch}` });

suite('Provisioning queue', () => {
    test('enqueue appends and never duplicates a branch', () => {
        const state = enqueue(enqueue(EMPTY_QUEUE, [entry('19.0')]), [entry('19.0'), entry('18.0')]);

        assert.deepStrictEqual(state.pending.map(item => item.branch), ['19.0', '18.0']);
    });

    test('enqueue does not re-queue the branch being built', () => {
        const building = takeNext(enqueue(EMPTY_QUEUE, [entry('19.0')]));
        const state = enqueue(building, [entry('19.0')]);

        assert.strictEqual(state.active?.branch, '19.0');
        assert.deepStrictEqual(state.pending, []);
    });

    test('takeNext promotes the head and finishActive clears it', () => {
        const queued = enqueue(EMPTY_QUEUE, [entry('19.0'), entry('18.0')]);

        const building = takeNext(queued);
        assert.strictEqual(building.active?.branch, '19.0');
        assert.deepStrictEqual(building.pending.map(item => item.branch), ['18.0']);

        const done = finishActive(building);
        assert.strictEqual(done.active, undefined);
        assert.deepStrictEqual(done.pending.map(item => item.branch), ['18.0']);
    });

    test('takeNext on an empty queue is a no-op', () => {
        assert.deepStrictEqual(takeNext(EMPTY_QUEUE), EMPTY_QUEUE);
    });

    test('a failed entry leaves the queue drainable', () => {
        // Failure and success take the same transition: the entry is removed
        // either way, so one bad branch cannot wedge the queue.
        const state: QueueState = takeNext(enqueue(EMPTY_QUEUE, [entry('nope'), entry('18.0')]));
        const after = finishActive(state);

        assert.strictEqual(after.active, undefined);
        assert.strictEqual(takeNext(after).active?.branch, '18.0');
    });

    test('queueLabel reports what the version row should say', () => {
        const state = takeNext(enqueue(EMPTY_QUEUE, [entry('19.0'), entry('18.0')]));

        assert.strictEqual(queueLabel(state, '19.0'), 'building…');
        assert.strictEqual(queueLabel(state, '18.0'), 'queued');
        assert.strictEqual(queueLabel(state, '17.0'), undefined);
    });

    test('describeDrain names both outcomes in one sentence', () => {
        assert.strictEqual(describeDrain(['19.0', '18.0'], []), 'Provisioned 19.0, 18.0.');
        assert.strictEqual(
            describeDrain(['19.0'], ['18.0']),
            'Provisioned 19.0. Failed: 18.0 - use Check Version Environments to retry.'
        );
        assert.strictEqual(
            describeDrain([], ['18.0']),
            'Failed: 18.0 - use Check Version Environments to retry.'
        );
    });

    test('a queued branch rebuilds the version that already has it', () => {
        // The migration offer queues existing versions. Creating a second one
        // left the legacy version untouched beside a duplicate on a shifted
        // port, and database lookup by series then picked either.
        const target = resolveQueueTarget('17.0', [
            { id: 'v19', odooVersion: '19.0' },
            { id: 'v17', odooVersion: '17.0' }
        ]);
        assert.deepStrictEqual(target, { kind: 'rebuild', versionId: 'v17' });
    });

    test('a queued branch with no version creates one', () => {
        assert.deepStrictEqual(
            resolveQueueTarget('18.0', [{ id: 'v19', odooVersion: '19.0' }]),
            { kind: 'create' }
        );
    });

    test('matching a branch ignores surrounding whitespace', () => {
        assert.deepStrictEqual(
            resolveQueueTarget(' 17.0 ', [{ id: 'v17', odooVersion: '17.0 ' }]),
            { kind: 'rebuild', versionId: 'v17' }
        );
    });

    test('a version with no branch never matches', () => {
        assert.deepStrictEqual(resolveQueueTarget('17.0', [{ id: 'v' }]), { kind: 'create' });
    });
});
