/**
 * Derives a version's debugger identity - launch configuration name, HTTP
 * port and shell port - from its branch, so two versions can run at once
 * without overwriting each other's launch.json entry.
 *
 * The derivation rules are pure and unit-tested; only the live-socket probe
 * at the bottom does I/O, mirroring how pythonToolchain.ts keeps
 * `rankInterpreters` pure and `discoverInterpreters` impure.
 */
import * as net from 'node:net';

export interface VersionIdentity {
    debuggerName: string;
    portNumber: number;
    shellPortNumber: number;
}

/** Names and ports already spoken for by other versions (or live sockets). */
export interface IdentityTaken {
    names: Set<string>;
    ports: Set<number>;
}

/** The shape of a stored version this module needs; VersionModel satisfies it. */
export interface IdentityCandidate {
    id: string;
    odooVersion: string;
    createdAt: Date | string;
    settings: {
        debuggerName?: string;
        portNumber?: number;
        shellPortNumber?: number;
    };
}

/** Settings computed from the branch: visible in the tree, never editable. */
export const DERIVED_SETTING_KEYS = ['debuggerName', 'portNumber', 'shellPortNumber'] as const;

export const SERVER_PORT_BASE = 8000;
export const SHELL_PORT_BASE = 5000;

/** Branch names carry the series first: `17.0`, `saas-17.4`, `17.0-fix-abc`. */
const SERIES_PATTERN = /^(?:saas[~-])?(\d+)\.\d+/;

export function isDerivedSetting(key: string): boolean {
    return (DERIVED_SETTING_KEYS as readonly string[]).includes(key);
}

export function parseSeriesMajor(branch: string): number | undefined {
    const match = SERIES_PATTERN.exec(branch.trim());
    return match ? Number(match[1]) : undefined;
}

function nextFreePort(base: number, taken: Set<number>): number {
    let port = base;
    while (taken.has(port)) {
        port += 1;
    }
    return port;
}

function nextFreeName(base: string, taken: Set<string>): string {
    if (!taken.has(base)) {
        return base;
    }
    let suffix = 2;
    while (taken.has(`${base} (${suffix})`)) {
        suffix += 1;
    }
    return `${base} (${suffix})`;
}

/**
 * The identity for `branch`, avoiding everything in `taken`. A branch with no
 * numeric series (`master`) starts from the bases and walks up from there.
 */
export function deriveIdentity(branch: string, prefix: string, taken: IdentityTaken): VersionIdentity {
    const major = parseSeriesMajor(branch);
    const serverBase = major === undefined ? SERVER_PORT_BASE : SERVER_PORT_BASE + major;
    const shellBase = major === undefined ? SHELL_PORT_BASE : SHELL_PORT_BASE + major;

    return {
        debuggerName: nextFreeName(`${prefix}:${branch}`, taken.names),
        portNumber: nextFreePort(serverBase, taken.ports),
        shellPortNumber: nextFreePort(shellBase, taken.ports)
    };
}

export function collectTaken(candidates: IdentityCandidate[], exceptId?: string): IdentityTaken {
    const names = new Set<string>();
    const ports = new Set<number>();

    for (const candidate of candidates) {
        if (candidate.id === exceptId) {
            continue;
        }
        const { debuggerName, portNumber, shellPortNumber } = candidate.settings ?? {};
        if (debuggerName) {
            names.add(debuggerName);
        }
        if (typeof portNumber === 'number') {
            ports.add(portNumber);
        }
        if (typeof shellPortNumber === 'number') {
            ports.add(shellPortNumber);
        }
    }

    return { names, ports };
}

function timestamp(value: Date | string): number {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

/**
 * Existing versions are healed, not rewritten: a stored identity is kept
 * unless it collides with an older version's, or is missing entirely. Returns
 * a patch per version that needs changing, in creation order.
 */
export function healIdentities(
    candidates: IdentityCandidate[],
    prefix: string
): Array<{ id: string; identity: VersionIdentity }> {
    const ordered = [...candidates].sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt));

    const taken: IdentityTaken = { names: new Set(), ports: new Set() };
    const patches: Array<{ id: string; identity: VersionIdentity }> = [];

    for (const candidate of ordered) {
        const stored = candidate.settings ?? {};
        const complete = !!stored.debuggerName
            && typeof stored.portNumber === 'number'
            && typeof stored.shellPortNumber === 'number';
        const collides = complete && (
            taken.names.has(stored.debuggerName!)
            || taken.ports.has(stored.portNumber!)
            || taken.ports.has(stored.shellPortNumber!)
        );

        if (complete && !collides) {
            taken.names.add(stored.debuggerName!);
            taken.ports.add(stored.portNumber!);
            taken.ports.add(stored.shellPortNumber!);
            continue;
        }

        const identity = deriveIdentity(candidate.odooVersion, prefix, taken);
        taken.names.add(identity.debuggerName);
        taken.ports.add(identity.portNumber);
        taken.ports.add(identity.shellPortNumber);
        patches.push({ id: candidate.id, identity });
    }

    return patches;
}

/** The ports a new version for `branch` could land on, both ranges. */
export function candidatePortsFor(branch: string, window = 10): number[] {
    const major = parseSeriesMajor(branch);
    const serverBase = major === undefined ? SERVER_PORT_BASE : SERVER_PORT_BASE + major;
    const shellBase = major === undefined ? SHELL_PORT_BASE : SHELL_PORT_BASE + major;

    const ports: number[] = [];
    for (let offset = 0; offset < window; offset += 1) {
        ports.push(serverBase + offset);
    }
    for (let offset = 0; offset < window; offset += 1) {
        ports.push(shellBase + offset);
    }
    return ports;
}

/**
 * Which of `ports` already have something listening. Other versions are the
 * primary authority, but a port can also be held by an unrelated process -
 * another project's server, a stray container - and deriving onto it would
 * produce a version that cannot start.
 */
export async function probeBusyPorts(ports: number[]): Promise<Set<number>> {
    const results = await Promise.all(ports.map(port => new Promise<number | undefined>(resolve => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        const finish = (busy: boolean) => {
            socket.destroy();
            resolve(busy ? port : undefined);
        };
        socket.setTimeout(250, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    })));

    return new Set(results.filter((port): port is number => port !== undefined));
}
