/**
 * Registry of the extension's running debug sessions, keyed by launch
 * configuration name. Versions derive a unique debuggerName (see
 * versionIdentity.ts), so several can run at once and each is addressable
 * on its own - which the previous single-active-session assumption made
 * impossible.
 */
import type * as vscode from 'vscode';

const sessions = new Map<string, vscode.DebugSession>();

function nameOf(session: vscode.DebugSession): string | undefined {
    const name = session.configuration?.name;
    return typeof name === 'string' && name.length > 0 ? name : undefined;
}

export function trackSession(session: vscode.DebugSession): void {
    const name = nameOf(session);
    if (name) {
        sessions.set(name, session);
    }
}

export function untrackSession(session: vscode.DebugSession): void {
    const name = nameOf(session);
    if (name) {
        sessions.delete(name);
    }
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
