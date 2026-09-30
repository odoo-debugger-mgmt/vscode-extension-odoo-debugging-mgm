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

export interface HeldLease {
    /** Says the holder is still alive. */
    renew(): void;
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

    if (!mayTakeLease(read(), owner, now(), pidAlive)) {
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
        release: () => {
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
