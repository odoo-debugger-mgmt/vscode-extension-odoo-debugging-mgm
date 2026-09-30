/**
 * One window builds queued versions at a time (design §9, problem 5).
 *
 * The queue lives in globalState, which every window sees, but the guard
 * against two drains was per process: two open windows could both build the
 * same branch into the same directory. A lease file in the provisioning root
 * - where the builds happen, so every window agrees on it whatever store it
 * uses - names the window draining and when it last said it was alive. Only
 * the holder drains; a lease whose holder is gone, or silent for too long, is
 * taken over.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const LEASE_FILE = '.odt-provision.lease';
/** How often the holder says it is alive. */
export const HEARTBEAT_MS = 30_000;
/** Silent this long, a lease is stale even if its process still exists. */
export const STALE_MS = 3 * HEARTBEAT_MS;

export interface Lease {
    owner: string;
    pid: number;
    heartbeat: number;
}

/**
 * Runs `work` holding the lease, waiting for it while another window holds
 * it: a build started by hand (Create Version, Migrate) must not run beside
 * another window's build either. Undefined when cancelled while waiting.
 */
export async function withLease<T>(
    root: string,
    work: (lease: HeldLease) => Promise<T>,
    options: { onWait?: () => void; isCancelled?: () => boolean; onLost?: () => void; pollMs?: number } = {}
): Promise<T | undefined> {
    let lease = acquireLease(root);
    let waited = false;
    while (!lease) {
        if (options.isCancelled?.()) {
            return undefined;
        }
        if (!waited) {
            waited = true;
            options.onWait?.();
        }
        await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 5000));
        lease = acquireLease(root);
    }
    const held = lease;
    const heartbeat = setInterval(() => held.renew(), HEARTBEAT_MS);
    heartbeat.unref?.();
    // Checked more often than the heartbeat: a window that resumes after
    // stalling past STALE_MS stops within seconds, rather than build on
    // beside the window that took over (fourteenth run).
    let lost = false;
    const watch = setInterval(() => {
        if (!lost && !held.held()) {
            lost = true;
            options.onLost?.();
        }
    }, options.pollMs ?? 5000);
    watch.unref?.();
    try {
        return await work(held);
    } finally {
        clearInterval(heartbeat);
        clearInterval(watch);
        held.release();
    }
}

/** This window's id as a lease owner. */
export const OWNER_ID = randomUUID();

export function parseLease(raw: string | undefined): Lease | undefined {
    if (!raw) {
        return undefined;
    }
    try {
        const value = JSON.parse(raw) as Partial<Lease>;
        return typeof value.owner === 'string' && typeof value.pid === 'number' && typeof value.heartbeat === 'number'
            ? { owner: value.owner, pid: value.pid, heartbeat: value.heartbeat }
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Whether `owner` may drain, given the lease on disk: when there is none,
 * when it is its own, or when the holder's process is gone or has been
 * silent past STALE_MS.
 */
export function mayTakeLease(existing: Lease | undefined, owner: string, now: number, pidAlive: (pid: number) => boolean): boolean {
    if (!existing || existing.owner === owner) {
        return true;
    }
    return !pidAlive(existing.pid) || now - existing.heartbeat > STALE_MS;
}

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: it exists, it is just not ours to signal.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** How many holders in this process each lease file has, per owner. */
const holders = new Map<string, number>();

export interface HeldLease {
    /** Says the holder is still alive. */
    renew(): void;
    /**
     * Whether this window still holds it. A window that stalled past STALE_MS
     * - a paused debugger, a suspended machine - may have lost it to another
     * window, and must not go on building.
     */
    held(): boolean;
    release(): void;
}

/**
 * Takes the lease in `root`, or returns undefined when another live window
 * holds it. Taking over a stale lease rewrites it; a race between two
 * windows taking over at once is settled by reading back who won.
 */
export function acquireLease(root: string, owner: string = OWNER_ID, now: () => number = Date.now): HeldLease | undefined {
    const file = path.join(root, LEASE_FILE);
    try {
        fs.mkdirSync(root, { recursive: true });
    } catch {
        return undefined;
    }
    const write = () => fs.writeFileSync(file, JSON.stringify({ owner, pid: process.pid, heartbeat: now() }));
    const read = () => {
        try {
            return parseLease(fs.readFileSync(file, 'utf8'));
        } catch {
            return undefined;
        }
    };

    const before = read();
    if (!mayTakeLease(before, owner, now(), pidAlive)) {
        return undefined;
    }
    try {
        write();
    } catch {
        return undefined;
    }
    if (read()?.owner !== owner) {
        return undefined;
    }
    // Already this window's - the queue holds it while a foreground build
    // asks too: only the last holder in this window removes the file, so a
    // missing file always means the lease was lost.
    const key = `${file}\0${owner}`;
    holders.set(key, (holders.get(key) ?? 0) + 1);
    let released = false;
    return {
        renew: () => {
            if (read()?.owner === owner) {
                try {
                    write();
                } catch {
                    // A heartbeat that cannot be written lets the lease go stale, which is right.
                }
            }
        },
        // Gone or someone else's: another window took over - and, if the
        // file is gone, has already finished. Not taken back either way.
        held: () => read()?.owner === owner,
        release: () => {
            if (released) {
                return;
            }
            released = true;
            const left = (holders.get(key) ?? 1) - 1;
            if (left > 0) {
                holders.set(key, left);
                return;
            }
            holders.delete(key);
            if (read()?.owner === owner) {
                try {
                    fs.rmSync(file, { force: true });
                } catch {
                    // Gone already, or unwritable: it goes stale on its own.
                }
            }
        }
    };
}
