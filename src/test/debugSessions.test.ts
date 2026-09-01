import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    trackSession,
    untrackSession,
    getSessionByName,
    runningDebuggerNames,
    anySessionRunning,
    clearSessions,
    resolveStopTarget
} from '../services/debugSessions';

function fakeSession(name: string): vscode.DebugSession {
    return { configuration: { name } } as unknown as vscode.DebugSession;
}

suite('Debug session registry', () => {
    setup(() => clearSessions());
    teardown(() => clearSessions());

    test('tracks and retrieves sessions by configuration name', () => {
        const seventeen = fakeSession('odoo:17.0');
        const eighteen = fakeSession('odoo:18.0');

        trackSession(seventeen);
        trackSession(eighteen);

        assert.strictEqual(getSessionByName('odoo:17.0'), seventeen);
        assert.strictEqual(getSessionByName('odoo:18.0'), eighteen);
        assert.deepStrictEqual(runningDebuggerNames().sort(), ['odoo:17.0', 'odoo:18.0']);
        assert.strictEqual(anySessionRunning(), true);
    });

    test('untracking one session leaves the others running', () => {
        trackSession(fakeSession('odoo:17.0'));
        trackSession(fakeSession('odoo:18.0'));

        untrackSession(fakeSession('odoo:17.0'));

        assert.strictEqual(getSessionByName('odoo:17.0'), undefined);
        assert.deepStrictEqual(runningDebuggerNames(), ['odoo:18.0']);
        // server_running must stay true while any version is up.
        assert.strictEqual(anySessionRunning(), true);
    });

    test('ignores sessions with no configuration name', () => {
        trackSession({ configuration: {} } as unknown as vscode.DebugSession);
        assert.strictEqual(anySessionRunning(), false);
    });

    test('resolves what Stop Server should target', () => {
        assert.deepStrictEqual(resolveStopTarget([], 'odoo:17.0'), { kind: 'none' });
        assert.deepStrictEqual(
            resolveStopTarget(['odoo:18.0'], 'odoo:17.0'),
            { kind: 'single', name: 'odoo:18.0' }
        );
        // The active version's own session wins without prompting.
        assert.deepStrictEqual(
            resolveStopTarget(['odoo:17.0', 'odoo:18.0'], 'odoo:17.0'),
            { kind: 'single', name: 'odoo:17.0' }
        );
        // Several running, none of them the active version: ask.
        assert.deepStrictEqual(
            resolveStopTarget(['odoo:18.0', 'odoo:19.0'], 'odoo:17.0'),
            { kind: 'prompt', names: ['odoo:18.0', 'odoo:19.0'] }
        );
    });
});
