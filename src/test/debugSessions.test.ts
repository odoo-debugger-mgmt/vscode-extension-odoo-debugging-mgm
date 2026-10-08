import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    trackSession,
    untrackSession,
    getSessionByName,
    runningDebuggerNames,
    anySessionRunning,
    clearSessions,
    resolveStopTarget,
    versionIdOfSession,
    runForDatabase,
    runRecords,
    alongsideRunOf
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

    test('remembers the version a session started as, until it ends', () => {
        const shared = fakeSession('Odoo');
        trackSession(shared, { versionId: 'v17', kind: 'primary' });
        assert.strictEqual(versionIdOfSession('Odoo'), 'v17');

        untrackSession(shared);
        assert.strictEqual(versionIdOfSession('Odoo'), undefined);
    });

    test('records are kept per session and found by database', () => {
        clearSessions();
        trackSession(fakeSession('odoo:17.0'), { versionId: 'v17', dbId: 'shop', port: 8017, kind: 'primary' });
        trackSession(fakeSession('odoo:17.0 · demo'), { versionId: 'v17', dbId: 'demo', port: 8100, kind: 'alongside' });
        assert.strictEqual(runForDatabase('demo')?.name, 'odoo:17.0 · demo');
        assert.strictEqual(runRecords().length, 2);
        untrackSession(fakeSession('odoo:17.0 · demo'));
        assert.strictEqual(runForDatabase('demo'), undefined);
        assert.strictEqual(versionIdOfSession('odoo:17.0'), 'v17');
    });

    test('a database run both ways for a moment is found as its primary run', () => {
        // F5 from Run and Debug starts the primary before the alongside run
        // of the same database has stopped.
        trackSession(fakeSession('odoo:17.0 · shop'), { versionId: 'v17', dbId: 'shop', port: 8100, kind: 'alongside' });
        trackSession(fakeSession('odoo:17.0'), { versionId: 'v17', dbId: 'shop', port: 8017, kind: 'primary' });
        assert.strictEqual(runForDatabase('shop')?.name, 'odoo:17.0');
        assert.strictEqual(alongsideRunOf('shop')?.name, 'odoo:17.0 · shop');
        untrackSession(fakeSession('odoo:17.0 · shop'));
        assert.strictEqual(runForDatabase('shop')?.name, 'odoo:17.0');
        assert.strictEqual(alongsideRunOf('shop'), undefined);
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
