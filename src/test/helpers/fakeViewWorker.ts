/**
 * A stand-in for `odoo-bin shell` running view_worker.py, for the worker
 * client's tests. Like the real shell it reads stdin to EOF before doing
 * anything; then it speaks the worker protocol: it connects to the address in
 * ODT_VIEW_ADDRESS, sends ODT_VIEW_TOKEN, and exchanges JSON lines there, with
 * log noise on stdout. Spawned, never run as a test.
 *
 * argv: <mode> - 'ok', 'never-ready', 'crash', 'silent' (never connects),
 * 'intruder' (a client with a wrong token connects first, and must be turned
 * away before the real one) or 'flood' (a client streams data with no newline
 * first, and must be cut off)
 */
import * as net from 'node:net';

const mode = process.argv[2] ?? 'ok';
let bootstrap = '';

function connect(): net.Socket {
    const address = process.env.ODT_VIEW_ADDRESS ?? '';
    const separator = address.indexOf(':');
    const kind = address.slice(0, separator);
    const where = address.slice(separator + 1);
    if (kind === 'unix') {
        return net.connect({ path: where });
    }
    const portAt = where.lastIndexOf(':');
    return net.connect({ host: where.slice(0, portAt), port: Number(where.slice(portAt + 1)) });
}

function serve(): void {
    const channel = connect();
    const reply = (payload: unknown) => channel.write(JSON.stringify(payload) + '\n');
    channel.write(`${process.env.ODT_VIEW_TOKEN}\n`);

    process.stdout.write('2026-10-02 INFO odoo: a log line that is not a reply\n');
    if (mode !== 'never-ready') {
        reply({ id: 0, ok: true, result: { series: '17.0', bootstrap } });
    }

    let buffer = '';
    channel.setEncoding('utf-8');
    channel.on('data', (chunk: string) => {
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
                case 'env':
                    reply({ id: request.id, ok: true, result: { address: process.env.ODT_VIEW_ADDRESS } });
                    break;
                case 'fail':
                    reply({ id: request.id, ok: false, error: 'boom', trace: 'Traceback: boom' });
                    break;
                case 'hang':
                    break;
                case 'restart':
                    reply({ id: request.id, ok: false, error: 'modules changed', restart: true });
                    setTimeout(() => process.exit(0), 20);
                    break;
                case 'die':
                    process.exit(3);
                    break;
                default:
                    reply({ id: request.id, ok: false, error: `unknown command ${request.cmd}` });
            }
        }
    });
    channel.on('end', () => process.exit(0));
}

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => {
    bootstrap += chunk;
});
process.stdin.on('end', () => {
    if (mode === 'crash') {
        process.stderr.write('Traceback (most recent call last):\nKeyError: odoo.addons.missing_module\n');
        process.exit(1);
    }
    if (mode === 'silent') {
        setInterval(() => undefined, 1000);
        return;
    }
    if (mode !== 'intruder' && mode !== 'flood') {
        serve();
        return;
    }
    // Only once the intruder has been turned away does the real one connect:
    // a worker that let it in, or kept buffering it, never gets ready.
    const intruder = connect();
    intruder.on('error', () => undefined);
    intruder.write(mode === 'flood' ? 'x'.repeat(1024 * 1024) : 'not-the-token\n');
    intruder.on('close', serve);
});
