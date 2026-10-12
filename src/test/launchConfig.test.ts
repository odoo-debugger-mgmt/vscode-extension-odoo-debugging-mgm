import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse } from 'jsonc-parser';
import { removeManagedLaunchConfigs, updateManagedLaunchConfig, ManagedLaunchConfig } from '../services/launchConfig';

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

suite('Removing managed launch entries', () => {
    test('only the named entries go; comments and the user\'s entries stay', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'odoo-launch-rm-'));
        await fs.mkdir(path.join(dir, '.vscode'));
        const launchPath = path.join(dir, '.vscode', 'launch.json');
        await fs.writeFile(launchPath, `{
    // mine
    "version": "0.2.0",
    "configurations": [
        { "name": "odoo:19.0" },
        { "name": "pytest" },
        { "name": "odoo:17.0" }
    ]
}
`, 'utf8');

        const removed = await removeManagedLaunchConfigs(dir, new Set(['odoo:19.0']));

        const raw = await fs.readFile(launchPath, 'utf8');
        assert.strictEqual(removed, 1);
        assert.deepStrictEqual(parse(raw).configurations.map((conf: { name: string }) => conf.name), ['pytest', 'odoo:17.0']);
        assert.ok(raw.includes('// mine'));
    });

    test('a launch.json with nothing to remove is not rewritten, and a missing one is fine', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'odoo-launch-rm-'));
        assert.strictEqual(await removeManagedLaunchConfigs(dir, new Set(['odoo:19.0'])), 0);

        await fs.mkdir(path.join(dir, '.vscode'));
        const launchPath = path.join(dir, '.vscode', 'launch.json');
        const content = '{ "configurations": [ { "name": "pytest" } ] }';
        await fs.writeFile(launchPath, content, 'utf8');
        assert.strictEqual(await removeManagedLaunchConfigs(dir, new Set(['odoo:19.0'])), 0);
        assert.strictEqual(await fs.readFile(launchPath, 'utf8'), content);
    });
});
