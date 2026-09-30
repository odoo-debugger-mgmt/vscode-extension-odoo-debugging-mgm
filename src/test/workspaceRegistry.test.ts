/**
 * The workspace registry (design §3): what reopens a workspace, and when a
 * row is dropped. Recording and reading run against real SQLite in the
 * SQLite main store suite.
 */
import * as assert from 'assert';
import { STALE_AFTER_MS, reopenPath, staleWorkspaces } from '../services/workspaceRegistry';

suite('What reopens a workspace', () => {
    test('its saved workspace file', () => {
        assert.strictEqual(reopenPath({ scheme: 'file', fsPath: '/w/acme.code-workspace' }, ['/a', '/b']), '/w/acme.code-workspace');
    });

    test('its folder, when it is a folder window', () => {
        assert.strictEqual(reopenPath(undefined, ['/W19/acme']), '/W19/acme');
    });

    test('nothing, for an untitled multi-root window or no folder', () => {
        assert.strictEqual(reopenPath({ scheme: 'untitled', fsPath: '/tmp/x' }, ['/a', '/b']), undefined);
        assert.strictEqual(reopenPath(undefined, []), undefined);
    });
});

suite('Rows dropped from the registry', () => {
    const now = 10 * STALE_AFTER_MS;
    const row = (id: string, lastSeen: number) => ({ id, name: id, uri: `file:///${id}`, lastSeen });

    test('unseen for 90 days, or gone from disk; never this window\'s own', () => {
        const rows = [row('fresh', now - 1000), row('old', now - STALE_AFTER_MS - 1), row('gone', now), row('mine', 0)];
        const stale = staleWorkspaces(rows, now, candidate => candidate.id !== 'gone', 'mine');
        assert.deepStrictEqual(stale, ['old', 'gone']);
    });
});
