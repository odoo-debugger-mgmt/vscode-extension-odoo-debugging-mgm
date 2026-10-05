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
import { randomBytes } from 'node:crypto';
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

/** A JSON string literal is a valid Python string literal, whatever the path holds. */
export function workerBootstrap(scriptPath: string): string {
    const literal = JSON.stringify(scriptPath);
    return `exec(compile(open(${literal}, encoding='utf-8').read(), ${literal}, 'exec'))\n`;
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
const DEFAULT_START_TIMEOUT_MS = 180_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const KILL_AFTER_MS = 3000;

export class ViewWorker implements PooledWorker {
    private child: ChildProcess | undefined;
    /** The shell's end of the socket, once it has connected with the token. */
    private channel: net.Socket | undefined;
    private server: net.Server | undefined;
    private socketDir: string | undefined;
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
        if (!this.isAlive || !requests) {
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
        const address = await this.listen(token);
        return new Promise<unknown>((resolve, reject) => {
            const startTimeoutMs = this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
            this.pending.set(0, {
                resolve,
                reject,
                timer: setTimeout(() => {
                    this.failAll(new ViewWorkerError(
                        `The Odoo shell did not start within ${Math.round(startTimeoutMs / 1000)} s.${this.tailText()}`));
                    this.child?.kill('SIGKILL');
                }, startTimeoutMs)
            });

            const child = spawn(this.spec.command, this.spec.args, {
                cwd: this.spec.cwd,
                env: { ...(this.spec.env ?? process.env), ODT_VIEW_ADDRESS: address, ODT_VIEW_TOKEN: token },
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe']
            });
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
            server.once('error', reject);
            if (transport === 'tcp') {
                server.listen(0, '127.0.0.1', () => {
                    resolve(`tcp:127.0.0.1:${(server.address() as net.AddressInfo).port}`);
                });
                return;
            }
            // mkdtemp makes the folder 0700: no other user can reach the socket.
            this.socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odt-view-'));
            const socketPath = path.join(this.socketDir, 'worker.sock');
            server.listen(socketPath, () => resolve(`unix:${socketPath}`));
        });
    }

    /**
     * The first line on a connection must be the token. The first connection
     * that sends it becomes the channel and nothing else is accepted after it;
     * any other connection is dropped.
     */
    private accept(socket: net.Socket, token: string): void {
        if (this.channel) {
            socket.destroy();
            return;
        }
        let authenticated = false;
        let buffer = '';
        socket.setEncoding('utf-8');
        socket.on('error', () => undefined);
        socket.on('data', (chunk: string) => {
            buffer += chunk;
            let newline = buffer.indexOf('\n');
            while (newline >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                newline = buffer.indexOf('\n');
                if (authenticated) {
                    this.handleReply(line);
                    continue;
                }
                if (line !== token || this.channel) {
                    socket.destroy();
                    return;
                }
                authenticated = true;
                this.channel = socket;
                this.closeServer();
            }
        });
        // The shell hung up without exiting: it can no longer be reached.
        socket.on('close', () => {
            if (this.channel === socket && !this.exited) {
                this.child?.kill();
            }
        });
    }

    /** Stops accepting connections; the socket file and its folder go with it. */
    private closeServer(): void {
        this.server?.close();
        this.server = undefined;
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
