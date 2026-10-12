/**
 * Derives a version's debugger identity - launch configuration name, HTTP
 * port and shell port - from its branch, so two versions can run at once
 * without overwriting each other's launch.json entry.
 *
 * Each value is automatic until the user sets it by hand: it is then listed
 * in `customIdentity` and kept as typed, even when another version uses it
 * too. Automatic values still move out of the way of every other value.
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
        customIdentity?: IdentityKey[];
    };
}

/** Settings derived from the branch unless the user sets them by hand. */
export const DERIVED_SETTING_KEYS = ['debuggerName', 'portNumber', 'shellPortNumber'] as const;

export type IdentityKey = typeof DERIVED_SETTING_KEYS[number];

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

/** The identity keys the user set by hand (stored data may hold anything). */
export function customKeys(settings: { customIdentity?: unknown } | undefined): Set<IdentityKey> {
    const listed = Array.isArray(settings?.customIdentity) ? settings.customIdentity : [];
    return new Set(listed.filter((key): key is IdentityKey => isDerivedSetting(String(key))));
}

/** `identity` without the keys the user set by hand: what may be written over. */
export function automaticPart(identity: VersionIdentity, custom: readonly IdentityKey[] | undefined): Partial<VersionIdentity> {
    const kept = new Set(custom ?? []);
    const part: Partial<VersionIdentity> = {};
    for (const key of DERIVED_SETTING_KEYS) {
        if (!kept.has(key)) {
            (part as Record<IdentityKey, unknown>)[key] = identity[key];
        }
    }
    return part;
}

function isSet(key: IdentityKey, value: unknown): boolean {
    return key === 'debuggerName' ? typeof value === 'string' && value.length > 0 : typeof value === 'number' && value > 0;
}

function reserve(taken: IdentityTaken, key: IdentityKey, value: unknown): void {
    if (key === 'debuggerName') {
        taken.names.add(value as string);
    } else {
        taken.ports.add(value as number);
    }
}

function isTaken(taken: IdentityTaken, key: IdentityKey, value: unknown): boolean {
    return key === 'debuggerName' ? taken.names.has(value as string) : taken.ports.has(value as number);
}

/**
 * Existing versions are healed, not rewritten: a stored identity is kept
 * unless it collides with an older version's, or is missing entirely. Values
 * set by hand are never touched, and are reserved first, so an automatic
 * value that lands on one moves instead. Returns, per version that needs
 * changing and in creation order, only the keys to write.
 */
export function healIdentities(
    candidates: IdentityCandidate[],
    prefix: string
): Array<{ id: string; identity: Partial<VersionIdentity> }> {
    const ordered = [...candidates].sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt));

    const taken: IdentityTaken = { names: new Set(), ports: new Set() };
    for (const candidate of ordered) {
        for (const key of customKeys(candidate.settings)) {
            const value = candidate.settings?.[key];
            if (isSet(key, value)) {
                reserve(taken, key, value);
            }
        }
    }

    const patches: Array<{ id: string; identity: Partial<VersionIdentity> }> = [];
    for (const candidate of ordered) {
        const stored = candidate.settings ?? {};
        const custom = customKeys(stored);
        const automatic = DERIVED_SETTING_KEYS.filter(key => !custom.has(key) || !isSet(key, stored[key]));
        const fine = automatic.every(key => isSet(key, stored[key]) && !isTaken(taken, key, stored[key]));

        if (fine) {
            automatic.forEach(key => reserve(taken, key, stored[key]));
            continue;
        }

        const derived = deriveIdentity(candidate.odooVersion, prefix, taken);
        const identity: Partial<VersionIdentity> = {};
        for (const key of automatic) {
            (identity as Record<IdentityKey, unknown>)[key] = derived[key];
            reserve(taken, key, derived[key]);
        }
        patches.push({ id: candidate.id, identity });
    }

    return patches;
}

/**
 * The other versions `id` shares its debugger name or a port with. Sharing
 * is allowed - those versions simply cannot run at the same time - so this
 * feeds a warning, never a refusal.
 */
export function identityConflicts(
    candidates: IdentityCandidate[],
    id: string
): Array<{ key: IdentityKey; value: string | number; otherIds: string[] }> {
    const own = candidates.find(candidate => candidate.id === id)?.settings;
    if (!own) {
        return [];
    }
    const conflicts: Array<{ key: IdentityKey; value: string | number; otherIds: string[] }> = [];
    for (const key of DERIVED_SETTING_KEYS) {
        const value = own[key];
        if (!isSet(key, value)) {
            continue;
        }
        const otherIds = candidates
            .filter(candidate => candidate.id !== id)
            .filter(candidate => {
                const other = candidate.settings ?? {};
                return key === 'debuggerName'
                    ? other.debuggerName === value
                    : other.portNumber === value || other.shellPortNumber === value;
            })
            .map(candidate => candidate.id);
        if (otherIds.length > 0) {
            conflicts.push({ key, value: value as string | number, otherIds });
        }
    }
    return conflicts;
}

/**
 * The version a launch entry named `name` belongs to. Versions that share a
 * name share one entry: it is written for, and its session belongs to, the
 * active version when that is one of them, else the oldest.
 */
export function sessionOwner<T extends IdentityCandidate>(
    candidates: T[],
    name: string,
    activeId: string | undefined
): T | undefined {
    const named = candidates
        .filter(candidate => candidate.settings?.debuggerName === name)
        .sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt));
    return named.find(candidate => candidate.id === activeId) ?? named[0];
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
