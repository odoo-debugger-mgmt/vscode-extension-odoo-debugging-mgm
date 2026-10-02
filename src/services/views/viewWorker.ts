/**
 * One long-lived `odoo-bin shell` on one database, running view_worker.py.
 *
 * The shell exec()s all of stdin once it reaches EOF, so stdin carries only
 * a one-line bootstrap and is then closed. Requests go out on fd 3 and replies
 * come back on fd 4, one JSON object per line. That also keeps Odoo's logging
 * on stdout/stderr out of the replies; its last lines are kept, to explain a
 * shell that dies.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import * as vscode from 'vscode';

export interface WorkerSpawnSpec {
    command: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Python piped to the shell's stdin, which the shell exec()s whole. */
    bootstrap: string;
}

export interface ViewWorkerOptions {
    /** The first start loads the whole registry: minutes on a large database. */
    startTimeoutMs?: number;
    requestTimeoutMs?: number;
}

/** What a pool needs from a worker; ViewWorker is the real one. */
export interface PooledWorker {
    start(): Promise<unknown>;
    request<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
    dispose(): Promise<void>;
    readonly onDidExit: vscode.Event<void>;
}

export class ViewWorkerError extends Error {
    constructor(message: string, readonly trace?: string) {
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
}

const TAIL_LINES = 30;
const DEFAULT_START_TIMEOUT_MS = 180_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const KILL_AFTER_MS = 3000;

export class ViewWorker implements PooledWorker {
    private child: ChildProcess | undefined;
    private requests: Writable | undefined;
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
        const requests = this.requests;
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

    /** EOF on the request pipe lets Python finish cleanly; a kill follows if it does not. */
    dispose(): Promise<void> {
        const child = this.child;
        if (!child || this.exited) {
            return Promise.resolve();
        }
        return new Promise<void>(resolve => {
            const killer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS);
            child.once('exit', () => {
                clearTimeout(killer);
                resolve();
            });
            this.requests?.end();
        });
    }

    private spawn(): Promise<unknown> {
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
                env: this.spec.env,
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe']
            });
            this.child = child;
            // Null when the spawn itself failed; 'error' below reports that.
            this.requests = (child.stdio[3] ?? undefined) as Writable | undefined;
            const replies = (child.stdio[4] ?? undefined) as Readable | undefined;

            const remember = (chunk: Buffer) => {
                this.tail.push(...chunk.toString('utf-8').split('\n').filter(line => line.trim()));
                if (this.tail.length > TAIL_LINES) {
                    this.tail.splice(0, this.tail.length - TAIL_LINES);
                }
            };
            child.stdout?.on('data', remember);
            child.stderr?.on('data', remember);

            let buffer = '';
            replies?.setEncoding('utf-8');
            replies?.on('data', (chunk: string) => {
                buffer += chunk;
                let newline = buffer.indexOf('\n');
                while (newline >= 0) {
                    const line = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    newline = buffer.indexOf('\n');
                    this.handleReply(line);
                }
            });

            child.on('error', error => {
                this.exited = true;
                this.failAll(new ViewWorkerError(`Could not start ${this.spec.command}: ${error.message}`));
            });
            child.on('exit', code => {
                this.exited = true;
                const status = code === null ? '' : ` (exit code ${code})`;
                this.failAll(new ViewWorkerError(`The Odoo shell stopped${status}.${this.tailText()}`));
                this.exitEmitter.fire();
            });
            // A failed write after an early exit is reported by 'exit'; do not crash on EPIPE.
            child.stdin?.on('error', () => undefined);
            this.requests?.on('error', () => undefined);
            child.stdin?.end(this.spec.bootstrap);
        });
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
            pending.reject(new ViewWorkerError(reply.error || 'The Odoo shell reported an error.', reply.trace));
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
