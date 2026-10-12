import * as assert from 'assert';
import * as vscode from 'vscode';
import { openedByStorageUri, projectWorkspaceOpenUri } from '../projectWorkspace';

suite('Opening a generated project workspace', () => {
    // The generated file lives in global storage. Opened by that storage URI,
    // the window's workspace file is a vscode-userdata: URI, and the Python
    // debugger refuses to run in it.
    const stored = vscode.Uri.from({ scheme: 'vscode-userdata', path: '/home/me/.config/Code/User/globalStorage/x/workspaces/p1.code-workspace' });

    test('is opened by its path, not by the storage URI it was written through', () => {
        const target = projectWorkspaceOpenUri(stored);
        assert.strictEqual(target.scheme, 'file');
        assert.strictEqual(target.fsPath, stored.fsPath);
    });

    test('a window an earlier build opened by the storage URI is recognised, and only that one', () => {
        assert.strictEqual(openedByStorageUri(stored), true);
        assert.strictEqual(openedByStorageUri(vscode.Uri.file('/home/me/acme.code-workspace')), false);
        assert.strictEqual(openedByStorageUri(undefined), false);
    });
});
