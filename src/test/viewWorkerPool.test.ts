import * as assert from 'assert';
import * as vscode from 'vscode';
import { ViewWorkerPool } from '../services/views/viewWorkerPool';
import { ViewWorkerError, type PooledWorker } from '../services/views/viewWorker';
import { onBeforeDatabaseRelease, releaseDatabase } from '../services/postgres';

class FakeWorker implements PooledWorker {
    started = 0;
    disposed = 0;
    readonly exit = new vscode.EventEmitter<void>();
    readonly onDidExit = this.exit.event;
    // A function, not a promise: a rejection made before start() is called
    // would be reported as unhandled.
    constructor(readonly db: string, private readonly startResult: () => Promise<unknown> = async () => ({ series: '17.0' })) {}
    start(): Promise<unknown> {
        this.started++;
        return this.startResult();
    }
    async request<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
        return { db: this.db, cmd, args } as T;
    }
    async dispose(): Promise<void> {
        this.disposed++;
        this.exit.fire();
    }
}

suite('View worker pool', () => {
    test('one worker per database, reused', async () => {
        const created: FakeWorker[] = [];
        const pool = new ViewWorkerPool(async db => {
            const worker = new FakeWorker(db);
            created.push(worker);
            return worker;
        });
        await pool.run('a', 'echo');
        await pool.run('a', 'echo');
        assert.deepStrictEqual(await pool.run('b', 'get_arch', { view_id: 3 }), { db: 'b', cmd: 'get_arch', args: { view_id: 3 } });
        assert.deepStrictEqual(created.map(worker => worker.db), ['a', 'b']);
        pool.dispose();
    });

    test('a worker that exited is replaced on the next run', async () => {
        const created: FakeWorker[] = [];
        const pool = new ViewWorkerPool(async db => {
            const worker = new FakeWorker(db);
            created.push(worker);
            return worker;
        });
        await pool.run('a', 'echo');
        created[0].exit.fire();
        assert.strictEqual(pool.has('a'), false);
        await pool.run('a', 'echo');
        assert.strictEqual(created.length, 2);
        pool.dispose();
    });

    test('a restart error releases the worker and retries once on a fresh one', async () => {
        const created: FakeWorker[] = [];
        const pool = new ViewWorkerPool(async db => {
            const worker = new FakeWorker(db);
            if (created.length === 0) {
                worker.request = async () => { throw new ViewWorkerError('modules changed', undefined, true); };
            }
            created.push(worker);
            return worker;
        });
        assert.deepStrictEqual(await pool.run('a', 'echo'), { db: 'a', cmd: 'echo', args: {} });
        assert.strictEqual(created.length, 2);
        assert.strictEqual(created[0].disposed, 1);
        pool.dispose();
    });

    test('a restart retry leaves a newer worker alone', async () => {
        const created: FakeWorker[] = [];
        const pool = new ViewWorkerPool(async db => {
            const worker = new FakeWorker(db);
            if (created.length === 0) {
                worker.request = async () => {
                    worker.exit.fire();
                    await pool.run(db, 'echo');
                    throw new ViewWorkerError('modules changed', undefined, true);
                };
            }
            created.push(worker);
            return worker;
        });
        await pool.run('a', 'echo');
        assert.strictEqual(created.length, 2);
        assert.strictEqual(created[1].disposed, 0);
        assert.strictEqual(pool.has('a'), true);
        pool.dispose();
    });

    test('a failed start is forgotten, so the next run tries again', async () => {
        let attempt = 0;
        const pool = new ViewWorkerPool(async db => {
            attempt++;
            return new FakeWorker(db, attempt === 1 ? async () => { throw new Error('no python'); } : undefined);
        });
        await assert.rejects(pool.run('a', 'echo'), /no python/);
        await pool.run('a', 'echo');
        assert.strictEqual(attempt, 2);
        pool.dispose();
    });

    test('release disposes even a worker that is still starting', async () => {
        const worker = new FakeWorker('a', () => new Promise(() => undefined));
        const pool = new ViewWorkerPool(async () => worker);
        void pool.run('a', 'echo').catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 10));
        await pool.release('a');
        assert.strictEqual(worker.disposed, 1);
        assert.strictEqual(pool.has('a'), false);
    });

    test('an idle worker is released', async () => {
        const worker = new FakeWorker('a');
        const pool = new ViewWorkerPool(async () => worker, { idleMs: 50 });
        await pool.run('a', 'echo');
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.strictEqual(worker.disposed, 1);
        pool.dispose();
    });

    test('announces each start once', async () => {
        const announced: string[] = [];
        const pool = new ViewWorkerPool(async db => new FakeWorker(db), { onStarting: db => announced.push(db) });
        await pool.run('a', 'echo');
        await pool.run('a', 'echo');
        assert.deepStrictEqual(announced, ['a']);
        pool.dispose();
    });

    test('database release listeners run before Postgres is asked, and their failures do not block it', async () => {
        const released: string[] = [];
        const first = onBeforeDatabaseRelease(async db => {
            released.push(db);
        });
        const failing = onBeforeDatabaseRelease(async () => {
            throw new Error('ignored');
        });
        await releaseDatabase('shop');
        first.dispose();
        failing.dispose();
        await releaseDatabase('other');
        assert.deepStrictEqual(released, ['shop']);
    });
});
