/**
 * Registry of the extension's running debug sessions, keyed by launch
 * configuration name. Versions derive a unique debuggerName (see
 * versionIdentity.ts), so several can run at once and each is addressable
 * on its own - which the previous single-active-session assumption made
 * impossible. A name the user gave several versions is one entry that follows
 * the active version, so each session also records what it runs (version,
 * database, port; see runRecords.ts): activating another version or selecting
 * another database later must not re-attribute it.
 */
import type * as vscode from 'vscode';
import type { RunDetails, RunRecord } from './runRecords';

const sessions = new Map<string, vscode.DebugSession>();
const runs = new Map<string, RunRecord>();

function nameOf(session: vscode.DebugSession): string | undefined {
    const name = session.configuration?.name;
    return typeof name === 'string' && name.length > 0 ? name : undefined;
}

export function trackSession(session: vscode.DebugSession, details?: RunDetails): void {
    const name = nameOf(session);
    if (name) {
        sessions.set(name, session);
        if (details) {
            runs.set(name, { name, ...details });
        } else {
            runs.delete(name);
        }
    }
}

export function untrackSession(session: vscode.DebugSession): void {
    const name = nameOf(session);
    if (name) {
        sessions.delete(name);
        runs.delete(name);
    }
}

/** The version a running session was started as, when it was recorded. */
export function versionIdOfSession(name: string): string | undefined {
    return sessions.has(name) ? runs.get(name)?.versionId : undefined;
}

/** What each live session runs, for those that recorded it. */
export function runRecords(): RunRecord[] {
    return [...runs.values()].filter(record => sessions.has(record.name));
}

export function runForDatabase(dbId: string): RunRecord | undefined {
    return runRecords().find(record => record.dbId === dbId);
}

export function getSessionByName(name: string): vscode.DebugSession | undefined {
    return sessions.get(name);
}

export function runningDebuggerNames(): string[] {
    return Array.from(sessions.keys());
}

export function anySessionRunning(): boolean {
    return sessions.size > 0;
}

/** Test seam: the registry is module state that outlives a single suite. */
export function clearSessions(): void {
    sessions.clear();
    runs.clear();
}

/**
 * What "Stop Server" should act on. The active version's session wins
 * outright; otherwise a lone session is unambiguous and anything else needs
 * the user to choose.
 */
export function resolveStopTarget(
    running: string[],
    activeName: string | undefined
): { kind: 'none' } | { kind: 'single'; name: string } | { kind: 'prompt'; names: string[] } {
    if (running.length === 0) {
        return { kind: 'none' };
    }
    if (activeName && running.includes(activeName)) {
        return { kind: 'single', name: activeName };
    }
    if (running.length === 1) {
        return { kind: 'single', name: running[0] };
    }
    return { kind: 'prompt', names: [...running] };
}
