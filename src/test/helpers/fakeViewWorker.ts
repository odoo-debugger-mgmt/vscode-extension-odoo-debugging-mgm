/**
 * A stand-in for `odoo-bin shell` running view_worker.py, for the worker
 * client's tests. Like the real shell it reads stdin to EOF before doing
 * anything; then it speaks the worker protocol: requests on fd 3, replies on
 * fd 4, log noise on stdout. Spawned, never run as a test.
 *
 * argv: <mode> - 'ok', 'never-ready' or 'crash'
 */
import * as net from 'node:net';

const mode = process.argv[2] ?? 'ok';
let bootstrap = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => {
    bootstrap += chunk;
});
process.stdin.on('end', () => {
    if (mode === 'crash') {
        process.stderr.write('Traceback (most recent call last):\nKeyError: odoo.addons.missing_module\n');
        process.exit(1);
    }

    const requests = new net.Socket({ fd: 3, readable: true, writable: false });
    const replies = new net.Socket({ fd: 4, readable: false, writable: true });
    const reply = (payload: unknown) => replies.write(JSON.stringify(payload) + '\n');

    process.stdout.write('2026-10-02 INFO odoo: a log line that is not a reply\n');
    if (mode !== 'never-ready') {
        reply({ id: 0, ok: true, result: { series: '17.0', bootstrap } });
    }

    let buffer = '';
    requests.setEncoding('utf-8');
    requests.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
            const request = JSON.parse(line) as { id: number; cmd: string; args: Record<string, unknown> };
            switch (request.cmd) {
                case 'echo':
                    reply({ id: request.id, ok: true, result: request.args });
                    break;
                case 'fail':
                    reply({ id: request.id, ok: false, error: 'boom', trace: 'Traceback: boom' });
                    break;
                case 'hang':
                    break;
                case 'die':
                    process.exit(3);
                    break;
                default:
                    reply({ id: request.id, ok: false, error: `unknown command ${request.cmd}` });
            }
        }
    });
    requests.on('end', () => process.exit(0));
});
