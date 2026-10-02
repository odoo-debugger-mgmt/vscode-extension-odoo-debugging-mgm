/**
 * At most one Odoo shell per database, started on first use and stopped
 * after ten idle minutes, on release (before the database is dropped, renamed
 * or copied) and with the extension.
 */
import type * as vscode from 'vscode';
import { ViewWorkerError, type PooledWorker } from './viewWorker';

export type WorkerFactory = (dbName: string) => Promise<PooledWorker>;

export interface ViewWorkerPoolOptions {
    idleMs?: number;
    /** Called once per spawn, with the start in flight: progress UI hooks in here. */
    onStarting?: (dbName: string, ready: Promise<unknown>) => void;
}

interface Entry {
    created: Promise<PooledWorker>;
    ready: Promise<PooledWorker>;
    worker?: PooledWorker;
    idle?: NodeJS.Timeout;
}

const DEFAULT_IDLE_MS = 10 * 60_000;

export class ViewWorkerPool implements vscode.Disposable {
    private readonly entries = new Map<string, Entry>();

    constructor(private readonly factory: WorkerFactory, private readonly options: ViewWorkerPoolOptions = {}) {}

    has(dbName: string): boolean {
        return this.entries.has(dbName);
    }

    /** Runs one command on the database's shell, starting it on first use. */
    async run<T>(dbName: string, cmd: string, args: Record<string, unknown> = {}): Promise<T> {
        try {
            return await this.runOnce<T>(dbName, cmd, args);
        } catch (error) {
            if (!(error instanceof ViewWorkerError) || !error.restart) {
                throw error;
            }
            // The shell found its registry out of date and exited: retry once on a fresh one.
            await this.release(dbName);
            return this.runOnce<T>(dbName, cmd, args);
        }
    }

    private async runOnce<T>(dbName: string, cmd: string, args: Record<string, unknown>): Promise<T> {
        const worker = await this.workerFor(dbName);
        this.touch(dbName);
        try {
            return await worker.request<T>(cmd, args);
        } finally {
            this.touch(dbName);
        }
    }

    /** Stops the database's shell now, even mid-start, and waits for it to exit. */
    async release(dbName: string): Promise<void> {
        const entry = this.entries.get(dbName);
        if (!entry) {
            return;
        }
        this.forget(dbName, entry);
        const worker = entry.worker ?? await entry.created.catch(() => undefined);
        await worker?.dispose();
    }

    dispose(): void {
        for (const dbName of [...this.entries.keys()]) {
            void this.release(dbName);
        }
    }

    private workerFor(dbName: string): Promise<PooledWorker> {
        const existing = this.entries.get(dbName);
        if (existing) {
            return existing.ready;
        }
        const entry = {} as Entry;
        entry.created = this.factory(dbName).then(worker => {
            entry.worker = worker;
            worker.onDidExit(() => this.forget(dbName, entry));
            return worker;
        });
        entry.ready = entry.created.then(async worker => {
            const started = worker.start();
            this.options.onStarting?.(dbName, started);
            await started;
            return worker;
        });
        entry.ready.catch(() => this.forget(dbName, entry));
        this.entries.set(dbName, entry);
        return entry.ready;
    }

    private touch(dbName: string): void {
        const entry = this.entries.get(dbName);
        if (!entry) {
            return;
        }
        if (entry.idle) {
            clearTimeout(entry.idle);
        }
        entry.idle = setTimeout(() => void this.release(dbName), this.options.idleMs ?? DEFAULT_IDLE_MS);
        entry.idle.unref?.();
    }

    private forget(dbName: string, entry: Entry): void {
        if (entry.idle) {
            clearTimeout(entry.idle);
        }
        if (this.entries.get(dbName) === entry) {
            this.entries.delete(dbName);
        }
    }
}
