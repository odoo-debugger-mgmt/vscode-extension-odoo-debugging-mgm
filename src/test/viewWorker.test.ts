import * as assert from 'assert';
import * as path from 'node:path';
import { ViewWorker, ViewWorkerError, workerBootstrap, type WorkerSpawnSpec } from '../services/views/viewWorker';

function fakeSpec(mode: string): WorkerSpawnSpec {
    return {
        command: process.execPath,
        args: [path.join(__dirname, 'helpers', 'fakeViewWorker.js'), mode],
        // The Extension Host's execPath is Electron; this makes it plain Node.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        bootstrap: workerBootstrap('/tmp/view_worker.py')
    };
}

suite('View worker', function () {
    this.timeout(20000);

    test('pipes the bootstrap to stdin and waits for the ready reply', async () => {
        const worker = new ViewWorker(fakeSpec('ok'));
        try {
            const ready = await worker.start() as { series: string; bootstrap: string };
            assert.strictEqual(ready.series, '17.0');
            assert.ok(ready.bootstrap.includes('exec(compile(open("/tmp/view_worker.py"'));
            assert.strictEqual(worker.isAlive, true);
        } finally {
            await worker.dispose();
        }
    });

    test('round-trips a 2 MB non-ASCII arch byte for byte', async () => {
        const worker = new ViewWorker(fakeSpec('ok'));
        try {
            const arch = '<form string="Prénom ✓ 日本">' + 'x'.repeat(2 * 1024 * 1024) + '<![CDATA[a\nb]]></form>';
            const result = await worker.request<{ arch: string }>('echo', { arch });
            assert.strictEqual(result.arch, arch);
        } finally {
            await worker.dispose();
        }
    });

    test('an error reply rejects with the message and keeps the worker', async () => {
        const worker = new ViewWorker(fakeSpec('ok'));
        try {
            await assert.rejects(worker.request('fail'), (error: unknown) =>
                error instanceof ViewWorkerError && error.message === 'boom' && error.trace === 'Traceback: boom');
            assert.deepStrictEqual(await worker.request('echo', { a: 1 }), { a: 1 });
        } finally {
            await worker.dispose();
        }
    });

    test('a restart reply rejects with restart set', async () => {
        const worker = new ViewWorker(fakeSpec('ok'));
        try {
            await assert.rejects(worker.request('restart'), (error: unknown) =>
                error instanceof ViewWorkerError && error.restart === true && error.message === 'modules changed');
            await assert.rejects(worker.request('fail'), (error: unknown) =>
                error instanceof ViewWorkerError && error.restart === false);
        } finally {
            await worker.dispose();
        }
    });

    test('a shell that dies mid-request fails it and says it stopped', async () => {
        const worker = new ViewWorker(fakeSpec('ok'));
        await worker.start();
        let exited = false;
        worker.onDidExit(() => (exited = true));
        await assert.rejects(worker.request('die'), /stopped \(exit code 3\)/);
        assert.strictEqual(exited, true);
        assert.strictEqual(worker.isAlive, false);
        await assert.rejects(worker.request('echo'), /not running/);
    });

    test('a shell that crashes on start shows the end of its traceback', async () => {
        const worker = new ViewWorker(fakeSpec('crash'));
        await assert.rejects(worker.start(), /KeyError: odoo\.addons\.missing_module/);
    });

    test('a shell that never gets ready times out and is killed', async () => {
        const worker = new ViewWorker(fakeSpec('never-ready'), { startTimeoutMs: 500 });
        await assert.rejects(worker.start(), /did not start within/);
        // The kill is asynchronous: wait for the exit before asserting it.
        await new Promise(resolve => setTimeout(resolve, 1000));
        assert.strictEqual(worker.isAlive, false);
    });

    test('a request with no answer times out and the shell is replaced, not reused', async () => {
        const worker = new ViewWorker(fakeSpec('ok'), { requestTimeoutMs: 300 });
        await worker.start();
        await assert.rejects(worker.request('hang'), /did not answer "hang"/);
        await new Promise(resolve => setTimeout(resolve, 3500));
        assert.strictEqual(worker.isAlive, false);
    });

    test('a missing python is a named error, not a hang', async () => {
        const worker = new ViewWorker({ ...fakeSpec('ok'), command: '/nonexistent/python3' }, { startTimeoutMs: 5000 });
        await assert.rejects(worker.start(), /Could not start \/nonexistent\/python3/);
    });

    test('the bootstrap quotes any path as a Python literal', () => {
        assert.strictEqual(
            workerBootstrap('/a b/it\'s "x".py'),
            'exec(compile(open("/a b/it\'s \\"x\\".py", encoding=\'utf-8\').read(), "/a b/it\'s \\"x\\".py", \'exec\'))\n'
        );
    });
});
