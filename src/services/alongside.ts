/**
 * Running a database next to whatever already runs: its name, its port and
 * the args that make it listen there. Pure; debugger.ts runs it. An alongside
 * run is never written to launch.json - F5 stays one entry per version.
 */
import { extraParamValue } from './odooDataDir';

export const ALONGSIDE_FIRST_PORT = 8100;
export const ALONGSIDE_LAST_PORT = 8199;

export function alongsideName(debuggerName: string, dbId: string): string {
    return `${debuggerName} · ${dbId}`;
}

const reservations = new Map<number, ReturnType<typeof setTimeout>>();

/** Holds a port for a start that has not been recorded yet. */
export function reservePort(port: number, ttlMs = 30000): () => void {
    const release = () => {
        const timer = reservations.get(port);
        if (timer) {
            clearTimeout(timer);
        }
        reservations.delete(port);
    };
    release();
    reservations.set(port, setTimeout(release, ttlMs));
    return release;
}

export function reservedPorts(): Set<number> {
    return new Set(reservations.keys());
}

export async function pickFreePort(
    isOpen: (port: number) => Promise<boolean>,
    taken: Set<number>,
    first = ALONGSIDE_FIRST_PORT,
    last = ALONGSIDE_LAST_PORT
): Promise<number> {
    for (let port = first; port <= last; port++) {
        if (taken.has(port)) {
            continue;
        }
        if (!await isOpen(port)) {
            return port;
        }
    }
    throw new Error(`No free port between ${first} and ${last}.`);
}

export function workersOf(extraParams: string): number {
    const tokens = extraParams.split(',').map(token => token.trim()).filter(Boolean);
    // --workers has no short form; pass it as both so extraParamValue's
    // short-option branch matches nothing else.
    const value = extraParamValue(tokens, '--workers', '--workers');
    const workers = Number.parseInt(value ?? '', 10);
    return Number.isFinite(workers) && workers > 0 ? workers : 0;
}

export function realtimePortFlag(odooVersion: string | undefined): '--gevent-port' | '--longpolling-port' {
    const match = /(\d+)\.\d+/.exec(odooVersion ?? '');
    const major = match ? Number(match[1]) : undefined;
    return major !== undefined && major < 16 ? '--longpolling-port' : '--gevent-port';
}

const PORT_FLAGS = ['-p', '--http-port', '--xmlrpc-port', '--gevent-port', '--longpolling-port'];

/** `baseArgs` without any port of their own, listening on `port`. */
export function alongsideArgs(baseArgs: string[], port: number, realtime?: { flag: string; port: number }): string[] {
    const out: string[] = [];
    for (let i = 0; i < baseArgs.length; i++) {
        const arg = baseArgs[i];

        // Skip exact flag matches (and their following value)
        if (PORT_FLAGS.includes(arg)) {
            i++;
            continue;
        }

        // Skip --flag=value forms
        if (PORT_FLAGS.some(flag => flag.startsWith('--') && arg.startsWith(`${flag}=`))) {
            continue;
        }

        // Skip tokens that are port flags with space embedded (e.g., '--http-port 9000')
        let isPortFlagWithSpace = false;
        for (const flag of PORT_FLAGS) {
            if (flag.startsWith('--') && arg.startsWith(`${flag} `)) {
                isPortFlagWithSpace = true;
                break;
            }
        }
        if (isPortFlagWithSpace) {
            continue;
        }

        // Skip -p followed directly by digits (e.g., '-p9002'), by = (e.g., '-p=9003'), or by space (e.g., '-p 9001')
        if (/^-p(\d+|=| )/.test(arg)) {
            continue;
        }

        out.push(arg);
    }
    const args = ['-p', String(port), ...out];
    if (realtime) {
        args.push(realtime.flag, String(realtime.port));
    }
    return args;
}

export interface CheckoutConflict {
    repo: string;
    path: string;
    current: string;
    needed: string;
    mode: 'checkout' | 'worktree';
}

/**
 * Repositories this database would run from a shared checkout that is on
 * another branch. Run Alongside never switches a branch under servers that
 * are running, so each of these refuses it.
 */
export function checkoutConflicts(
    resolved: Array<{ repo: { name: string }; path: string; branch?: string; mode: string; isWorktree: boolean }>,
    currentBranches: Map<string, string | null>
): CheckoutConflict[] {
    const conflicts: CheckoutConflict[] = [];
    for (const entry of resolved) {
        if (entry.isWorktree || !entry.branch) {
            continue;
        }
        const current = currentBranches.get(entry.path);
        if (current && current !== entry.branch) {
            conflicts.push({
                repo: entry.repo.name,
                path: entry.path,
                current,
                needed: entry.branch,
                mode: entry.mode === 'worktree' ? 'worktree' : 'checkout'
            });
        }
    }
    return conflicts;
}
