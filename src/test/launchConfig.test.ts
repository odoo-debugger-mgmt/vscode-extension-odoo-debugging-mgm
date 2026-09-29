import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse } from 'jsonc-parser';
import {
    launchTarget,
    localWorkspaceFilePath,
    removeManagedLaunchConfigs,
    updateManagedLaunchConfig,
    updateManagedLaunchConfigIn,
    ManagedLaunchConfig
} from '../services/launchConfig';

function managedConfig(overrides: Partial<ManagedLaunchConfig> = {}): ManagedLaunchConfig {
    return {
        name: 'odoo:17.0',
        type: 'debugpy',
        request: 'launch',
        cwd: '/ws',
        program: '/ws/odoo/odoo-bin',
        python: '/ws/venv/bin/python',
        console: 'integratedTerminal',
        args: ['-d', 'mydb'],
        ...overrides
    };
}

suite('Managed launch.json updates', () => {
    async function makeWorkspace(launchContent?: string): Promise<string> {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'odoo-launch-test-'));
        if (launchContent !== undefined) {
            await fs.mkdir(path.join(dir, '.vscode'), { recursive: true });
            await fs.writeFile(path.join(dir, '.vscode', 'launch.json'), launchContent, 'utf-8');
        }
        return dir;
    }

    async function readLaunch(dir: string): Promise<string> {
        return fs.readFile(path.join(dir, '.vscode', 'launch.json'), 'utf-8');
    }

    test('creates launch.json when missing', async () => {
        const dir = await makeWorkspace();
        await updateManagedLaunchConfig(dir, managedConfig());
        const raw = await readLaunch(dir);
        assert.ok(raw.includes('"odoo:17.0"'));
        assert.ok(raw.includes('"version": "0.2.0"'));
    });

    test('preserves comments and user configurations', async () => {
        const dir = await makeWorkspace(`{
    // my precious comment
    "version": "0.2.0",
    "configurations": [
        {
            "name": "User: attach",
            "type": "node",
            "request": "attach"
        }
    ]
}
`);
        await updateManagedLaunchConfig(dir, managedConfig());
        const raw = await readLaunch(dir);
        assert.ok(raw.includes('// my precious comment'), 'comment should survive');
        assert.ok(raw.includes('"User: attach"'), 'user config should survive');
        assert.ok(raw.includes('"odoo:17.0"'), 'managed entry should be inserted');
        // New managed entry is inserted first.
        assert.ok(raw.indexOf('"odoo:17.0"') < raw.indexOf('"User: attach"'));
    });

    test('updates the managed entry in place and keeps extra user keys on it', async () => {
        const dir = await makeWorkspace(`{
    "version": "0.2.0",
    "configurations": [
        { "name": "User: attach", "type": "node", "request": "attach" },
        { "name": "odoo:17.0", "type": "debugpy", "request": "launch", "args": ["-d", "olddb"], "justMyCode": false }
    ]
}
`);
        await updateManagedLaunchConfig(dir, managedConfig());
        const raw = await readLaunch(dir);
        assert.ok(raw.includes('"mydb"'), 'args should be rewritten');
        assert.ok(!raw.includes('"olddb"'));
        assert.ok(raw.includes('"justMyCode"'), 'user-added key on the managed entry should survive');
        // Entry stays in place (after the user config) instead of moving to the top.
        assert.ok(raw.indexOf('"User: attach"') < raw.indexOf('"odoo:17.0"'));
    });

    test('falls back to a fresh skeleton for malformed files', async () => {
        const dir = await makeWorkspace('{ not json at all');
        await updateManagedLaunchConfig(dir, managedConfig());
        const raw = await readLaunch(dir);
        assert.ok(raw.includes('"odoo:17.0"'));
    });
});

suite('Where launch configurations live', () => {
    test('a folder window keeps them in the folder', () => {
        assert.deepStrictEqual(launchTarget(undefined, ['/ws', '/repo']), {
            kind: 'folder', folderPath: '/ws', filePath: path.join('/ws', '.vscode', 'launch.json')
        });
    });

    test('a saved multi-root workspace keeps them in its workspace file, not its first folder', () => {
        // The first folder of a generated project workspace is the user's repository.
        assert.deepStrictEqual(launchTarget({ scheme: 'file', fsPath: '/w/acme.code-workspace' }, ['/repos/acme']), {
            kind: 'workspaceFile', filePath: '/w/acme.code-workspace', firstFolderPath: '/repos/acme'
        });
    });

    test('a workspace opened by its global-storage URI still keeps them in its file', () => {
        // Open Project Workspace used to open the file that way, and the
        // Recent list reopens it the same way.
        assert.deepStrictEqual(launchTarget({ scheme: 'vscode-userdata', fsPath: '/u/acme.code-workspace' }, ['/repos/acme']), {
            kind: 'workspaceFile', filePath: '/u/acme.code-workspace', firstFolderPath: '/repos/acme'
        });
    });

    test('a workspace file on another machine is not written through the local disk', () => {
        assert.strictEqual(localWorkspaceFilePath({ scheme: 'vscode-remote', fsPath: '/r/x.code-workspace' }), undefined);
        assert.strictEqual(launchTarget({ scheme: 'vscode-remote', fsPath: '/r/x.code-workspace' }, ['/repo'])?.kind, 'folder');
    });

    test('an untitled workspace has no file yet, so its first folder is used', () => {
        assert.strictEqual(launchTarget({ scheme: 'untitled', fsPath: '/tmp/x' }, ['/repo'])?.kind, 'folder');
    });

    test('no folders and no workspace file: nowhere to write', () => {
        assert.strictEqual(launchTarget(undefined, []), undefined);
    });
});

suite('Launch configurations in a workspace file', () => {
    const WORKSPACE = `{
    // My workspace
    "folders": [{ "path": "/repos/acme" }],
    "settings": { "odooDebugger.dataStore.path": "/ws/.vscode/odoo-debugger-data.json" },
    "launch": {
        "version": "0.2.0",
        "configurations": [
            // Mine
            { "name": "my-script", "type": "node", "request": "launch" }
        ]
    }
}
`;

    async function workspaceFile(content: string): Promise<string> {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'odoo-launch-ws-'));
        const file = path.join(dir, 'acme.code-workspace');
        await fs.writeFile(file, content, 'utf8');
        return file;
    }

    test('our entry goes in, then is updated in place; the rest of the file survives', async () => {
        const file = await workspaceFile(WORKSPACE);
        const target = { kind: 'workspaceFile' as const, filePath: file };

        await updateManagedLaunchConfigIn(target, managedConfig());
        await updateManagedLaunchConfigIn(target, managedConfig({ args: ['-d', 'other'] }));

        const raw = await fs.readFile(file, 'utf8');
        const parsed = parse(raw);
        const names = parsed.launch.configurations.map((conf: any) => conf.name);
        assert.deepStrictEqual(names, ['odoo:17.0', 'my-script']);
        assert.deepStrictEqual(parsed.launch.configurations[0].args, ['-d', 'other']);
        assert.ok(raw.includes('// My workspace') && raw.includes('// Mine'));
        assert.strictEqual(parsed.settings['odooDebugger.dataStore.path'], '/ws/.vscode/odoo-debugger-data.json');
    });

    test('a workspace file with no launch section gets one', async () => {
        const file = await workspaceFile('{ "folders": [{ "path": "/repos/acme" }] }');

        await updateManagedLaunchConfigIn({ kind: 'workspaceFile', filePath: file }, managedConfig());

        const parsed = parse(await fs.readFile(file, 'utf8'));
        assert.strictEqual(parsed.launch.version, '0.2.0');
        assert.deepStrictEqual(parsed.launch.configurations.map((conf: any) => conf.name), ['odoo:17.0']);
        assert.deepStrictEqual(parsed.folders, [{ path: '/repos/acme' }]);
    });

    test('a workspace file that does not parse is left alone', async () => {
        const file = await workspaceFile('{ "folders": [ oops');

        await assert.rejects(updateManagedLaunchConfigIn({ kind: 'workspaceFile', filePath: file }, managedConfig()));
        assert.strictEqual(await fs.readFile(file, 'utf8'), '{ "folders": [ oops');
    });
});

suite('Taking our entries back out of a repository', () => {
    async function repoWith(content: string, extra?: string): Promise<string> {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'odoo-launch-repo-'));
        await fs.mkdir(path.join(dir, '.vscode'));
        await fs.writeFile(path.join(dir, '.vscode', 'launch.json'), content, 'utf8');
        if (extra) {
            await fs.writeFile(path.join(dir, '.vscode', extra), '{}', 'utf8');
        }
        return dir;
    }

    async function written(dir: string): Promise<string> {
        const target = { kind: 'folder' as const, folderPath: dir, filePath: path.join(dir, '.vscode', 'launch.json') };
        await updateManagedLaunchConfigIn(target, managedConfig());
        await updateManagedLaunchConfigIn(target, managedConfig({ name: 'odoo:19.0' }));
        return dir;
    }

    test('a file only we wrote goes, with its empty .vscode', async () => {
        const dir = await written(await fs.mkdtemp(path.join(os.tmpdir(), 'odoo-launch-repo-')));

        const removed = await removeManagedLaunchConfigs(dir, new Set(['odoo:17.0', 'odoo:19.0']));

        assert.strictEqual(removed, 2);
        await assert.rejects(fs.stat(path.join(dir, '.vscode')));
    });

    test('the user\'s own entries, comments and files stay', async () => {
        const dir = await repoWith(`{
    // the team's
    "version": "0.2.0",
    "configurations": [
        { "name": "odoo:17.0", "type": "debugpy", "request": "launch" },
        { "name": "pytest", "type": "debugpy", "request": "launch" }
    ]
}
`, 'settings.json');

        assert.strictEqual(await removeManagedLaunchConfigs(dir, new Set(['odoo:17.0'])), 1);

        const raw = await fs.readFile(path.join(dir, '.vscode', 'launch.json'), 'utf8');
        assert.deepStrictEqual(parse(raw).configurations.map((conf: any) => conf.name), ['pytest']);
        assert.ok(raw.includes("// the team's"));
    });

    test('an emptied file with the user\'s own comment is kept', async () => {
        const dir = await repoWith('{\n    // keep me\n    "version": "0.2.0",\n    "configurations": [{ "name": "odoo:17.0" }]\n}\n');

        await removeManagedLaunchConfigs(dir, new Set(['odoo:17.0']));

        assert.ok((await fs.readFile(path.join(dir, '.vscode', 'launch.json'), 'utf8')).includes('// keep me'));
    });

    test('nothing of ours: the file is not touched', async () => {
        const content = '{ "configurations": [{ "name": "pytest" }] }';
        const dir = await repoWith(content);

        assert.strictEqual(await removeManagedLaunchConfigs(dir, new Set(['odoo:17.0'])), 0);
        assert.strictEqual(await fs.readFile(path.join(dir, '.vscode', 'launch.json'), 'utf8'), content);
    });
});
