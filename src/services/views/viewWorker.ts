/**
 * One long-lived `odoo-bin shell` on one database, running view_worker.py.
 *
 * The shell exec()s all of stdin once it reaches EOF, so stdin carries only
 * a one-line bootstrap and is then closed. Requests and replies, one JSON
 * object per line, go over a local socket instead: the worker connects to the
 * address in ODT_VIEW_ADDRESS and proves itself with ODT_VIEW_TOKEN. That also
 * keeps Odoo's logging on stdout/stderr out of the replies; its last lines are
 * kept, to explain a shell that dies.
 *
 * The socket is a Unix socket in a folder only this user can open, or on
 * Windows, which Python cannot reach a Unix socket from, a loopback port. The
 * token is what keeps another local process from posing as the shell there.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface WorkerSpawnSpec {
    command: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Python piped to the shell's stdin, which the shell exec()s whole. */
    bootstrap: string;
}

export type WorkerTransport = 'unix' | 'tcp';

export interface ViewWorkerOptions {
    /** The first start loads the whole registry: minutes on a large database. */
    startTimeoutMs?: number;
    requestTimeoutMs?: number;
    /** Defaults to a loopback port on Windows and a Unix socket elsewhere. */
    transport?: WorkerTransport;
}

/** What a pool needs from a worker; ViewWorker is the real one. */
export interface PooledWorker {
    start(): Promise<unknown>;
    request<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
    dispose(): Promise<void>;
    readonly onDidExit: vscode.Event<void>;
}

export class ViewWorkerError extends Error {
    constructor(message: string, readonly trace?: string, readonly restart = false) {
        super(message);
        this.name = 'ViewWorkerError';
    }
}

/**
 * A JSON string literal is a valid Python string literal, whatever the path
 * holds. Non-ASCII is escaped too (as Python reads it, \U for characters
 * beyond the BMP), so the line survives a stdin decoded in any code page.
 */
export function workerBootstrap(scriptPath: string): string {
    const literal = Array.from(JSON.stringify(scriptPath), char => {
        const code = char.codePointAt(0) ?? 0;
        if (code < 0x80) {
            return char;
        }
        return code > 0xffff ? `\\U${code.toString(16).padStart(8, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
    }).join('');
    return `exec(compile(open(${literal}, encoding='utf-8').read(), ${literal}, 'exec'))\n`;
}

/** Compares in constant time, so a wrong token says nothing about the right one. */
function sameToken(candidate: string, token: string): boolean {
    const given = Buffer.from(candidate, 'utf-8');
    const expected = Buffer.from(token, 'utf-8');
    return given.length === expected.length && timingSafeEqual(given, expected);
}

interface Pending {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
}

interface Reply {
    id?: number;
    ok?: boolean;
    result?: unknown;
    error?: string;
    trace?: string;
    restart?: boolean;
}

const TAIL_LINES = 30;
/** Longer than any token: a connection still talking past this is not the shell. */
const MAX_TOKEN_LINE = 128;
const DEFAULT_START_TIMEOUT_MS = 180_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const KILL_AFTER_MS = 3000;

export class ViewWorker implements PooledWorker {
    private child: ChildProcess | undefined;
    /** The shell's end of the socket, once it has connected with the token. */
    private channel: net.Socket | undefined;
    private server: net.Server | undefined;
    private socketDir: string | undefined;
    /** Connections that have not sent the token yet. */
    private readonly unproven = new Set<net.Socket>();
    private disposed = false;
    private readonly pending = new Map<number, Pending>();
    private nextId = 1;
    private ready: Promise<unknown> | undefined;
    private exited = false;
    private readonly tail: string[] = [];
    private readonly exitEmitter = new vscode.EventEmitter<void>();
    readonly onDidExit = this.exitEmitter.event;

    constructor(private readonly spec: WorkerSpawnSpec, private readonly options: ViewWorkerOptions = {}) {}

    get isAlive(): boolean {
        return !!this.child && !this.exited;
    }

    start(): Promise<unknown> {
        if (!this.ready) {
            this.ready = this.spawn();
        }
        return this.ready;
    }

    async request<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
        await this.start();
        const requests = this.channel;
        if (!this.isAlive || !requests || requests.destroyed || !requests.writable) {
            throw new ViewWorkerError('The Odoo shell is not running.');
        }
        const id = this.nextId++;
        const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, {
                resolve: value => resolve(value as T),
                reject,
                timer: setTimeout(() => {
                    this.pending.delete(id);
                    reject(new ViewWorkerError(`The Odoo shell did not answer "${cmd}" within ${Math.round(timeoutMs / 1000)} s.`));
                    // It answers in order: one stuck request blocks every later one.
                    void this.dispose();
                }, timeoutMs)
            });
            requests.write(JSON.stringify({ id, cmd, args }) + '\n');
        });
    }

    /**
     * EOF on the socket lets Python finish cleanly; a kill follows if it does
     * not. A shell that has not connected yet has nothing to read EOF from.
     */
    dispose(): Promise<void> {
        // A start still setting up its socket sees this and gives up.
        this.disposed = true;
        const child = this.child;
        if (!child || this.exited) {
            this.closeServer();
            return Promise.resolve();
        }
        return new Promise<void>(resolve => {
            const killer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS);
            child.once('exit', () => {
                clearTimeout(killer);
                resolve();
            });
            if (this.channel) {
                this.channel.end();
            } else {
                child.kill();
            }
        });
    }

    private async spawn(): Promise<unknown> {
        const token = randomBytes(24).toString('hex');
        let address: string;
        try {
            address = await this.listen(token);
        } catch (error) {
            this.closeServer();
            throw error instanceof ViewWorkerError
                ? error
                : new ViewWorkerError(`Could not open a socket for the Odoo shell: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (this.disposed) {
            this.closeServer();
            throw new ViewWorkerError('The Odoo shell was stopped before it started.');
        }
        return new Promise<unknown>((resolve, reject) => {
            const startTimeoutMs = this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
            this.pending.set(0, {
                resolve,
                reject,
                timer: setTimeout(() => {
                    this.closeServer();
                    this.failAll(new ViewWorkerError(
                        `The Odoo shell did not start within ${Math.round(startTimeoutMs / 1000)} s.${this.tailText()}`));
                    this.child?.kill('SIGKILL');
                }, startTimeoutMs)
            });

            let child: ChildProcess;
            try {
                child = spawn(this.spec.command, this.spec.args, {
                    cwd: this.spec.cwd,
                    env: { ...(this.spec.env ?? process.env), ODT_VIEW_ADDRESS: address, ODT_VIEW_TOKEN: token },
                    shell: false,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
            } catch (error) {
                // Some failures throw rather than emit 'error': an argument Node
                // rejects, or on Windows a .bat/.cmd python shim (EINVAL).
                this.exited = true;
                this.closeServer();
                this.failAll(new ViewWorkerError(`Could not start ${this.spec.command}: ${error instanceof Error ? error.message : String(error)}`));
                return;
            }
            this.child = child;

            const remember = (chunk: Buffer) => {
                this.tail.push(...chunk.toString('utf-8').split('\n').filter(line => line.trim()));
                if (this.tail.length > TAIL_LINES) {
                    this.tail.splice(0, this.tail.length - TAIL_LINES);
                }
            };
            child.stdout?.on('data', remember);
            child.stderr?.on('data', remember);

            child.on('error', error => {
                this.exited = true;
                this.closeServer();
                this.failAll(new ViewWorkerError(`Could not start ${this.spec.command}: ${error.message}`));
            });
            child.on('exit', () => {
                this.exited = true;
            });
            // 'close' comes after stdout and stderr are drained, so the tail is complete.
            child.on('close', code => {
                this.exited = true;
                this.closeServer();
                this.channel?.destroy();
                const status = code === null ? '' : ` (exit code ${code})`;
                this.failAll(new ViewWorkerError(`The Odoo shell stopped${status}.${this.tailText()}`));
                this.exitEmitter.fire();
            });
            // A failed write after an early exit is reported by 'close'; do not crash on EPIPE.
            child.stdin?.on('error', () => undefined);
            if (child.pid !== undefined) {
                child.stdin?.end(this.spec.bootstrap);
            }
        });
    }

    /** Listens where the shell will connect; resolves with the address to give it. */
    private listen(token: string): Promise<string> {
        const transport = this.options.transport ?? (process.platform === 'win32' ? 'tcp' : 'unix');
        const server = net.createServer(socket => this.accept(socket, token));
        this.server = server;
        return new Promise<string>((resolve, reject) => {
            const listening = (address: string) => {
                server.off('error', reject);
                // Errors from then on (an accept failing) must not crash the host.
                server.on('error', () => undefined);
                resolve(address);
            };
            server.once('error', reject);
            // A dispose() while listening closes the server before it is up.
            server.once('close', () => reject(new ViewWorkerError('The Odoo shell was stopped before it started.')));
            if (transport === 'tcp') {
                server.listen(0, '127.0.0.1', () => {
                    listening(`tcp:127.0.0.1:${(server.address() as net.AddressInfo).port}`);
                });
                return;
            }
            // mkdtemp makes the folder 0700: no other user can reach the socket.
            this.socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-view-'));
            const socketPath = path.join(this.socketDir, 'worker.sock');
            server.listen(socketPath, () => listening(`unix:${socketPath}`));
        });
    }

    /**
     * The first line on a connection must be the token. The first connection
     * that sends it becomes the channel and nothing else is accepted after it;
     * any other connection is dropped, as is one that sends more than a token
     * could be without a line break.
     */
    private accept(socket: net.Socket, token: string): void {
        if (this.channel) {
            socket.destroy();
            return;
        }
        this.unproven.add(socket);
        let authenticated = false;
        let buffer = '';
        socket.setEncoding('utf-8');
        socket.on('error', () => undefined);
        socket.on('data', (chunk: string) => {
            buffer += chunk;
            if (!authenticated && buffer.indexOf('\n') < 0 && buffer.length > MAX_TOKEN_LINE) {
                socket.destroy();
                return;
            }
            let newline = buffer.indexOf('\n');
            while (newline >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                newline = buffer.indexOf('\n');
                if (authenticated) {
                    this.handleReply(line);
                    continue;
                }
                this.unproven.delete(socket);
                if (!sameToken(line, token) || this.channel) {
                    socket.destroy();
                    return;
                }
                authenticated = true;
                this.channel = socket;
                this.closeServer();
            }
        });
        socket.on('close', () => {
            this.unproven.delete(socket);
            if (this.channel !== socket || this.exited) {
                return;
            }
            // The shell hung up. Normally it is exiting (Odoo is closing its
            // cursor); only one that is still there after a while is stuck.
            const child = this.child;
            setTimeout(() => {
                if (child && !this.exited) {
                    child.kill('SIGKILL');
                }
            }, KILL_AFTER_MS).unref?.();
        });
    }

    /**
     * Stops accepting connections, drops the ones that never sent the token,
     * and removes the socket file and its folder.
     */
    private closeServer(): void {
        this.server?.close();
        this.server = undefined;
        for (const socket of this.unproven) {
            socket.destroy();
        }
        this.unproven.clear();
        if (this.socketDir) {
            fs.rmSync(this.socketDir, { recursive: true, force: true });
            this.socketDir = undefined;
        }
    }

    private handleReply(line: string): void {
        let reply: Reply;
        try {
            reply = JSON.parse(line) as Reply;
        } catch {
            return;
        }
        if (typeof reply.id !== 'number') {
            return;
        }
        const pending = this.pending.get(reply.id);
        if (!pending) {
            return;
        }
        this.pending.delete(reply.id);
        clearTimeout(pending.timer);
        if (reply.ok) {
            pending.resolve(reply.result);
        } else {
            pending.reject(new ViewWorkerError(reply.error || 'The Odoo shell reported an error.', reply.trace, reply.restart === true));
        }
    }

    private failAll(error: ViewWorkerError): void {
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            this.pending.delete(id);
            pending.reject(error);
        }
    }

    private tailText(): string {
        return this.tail.length > 0 ? `\n${this.tail.slice(-8).join('\n')}` : '';
    }
}
