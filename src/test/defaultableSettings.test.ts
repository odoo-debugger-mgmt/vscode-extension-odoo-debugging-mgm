import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDefaultVersionSettings, isDefaultableSetting } from '../utils';

suite('Settings a version can save as defaults', () => {
    test('exactly the registered odooDebugger.defaultVersion.* settings', () => {
        const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
        const sections = Array.isArray(manifest.contributes.configuration)
            ? manifest.contributes.configuration
            : [manifest.contributes.configuration];
        const registered = sections
            .flatMap((section: { properties?: Record<string, unknown> }) => Object.keys(section.properties ?? {}))
            .filter((key: string) => key.startsWith('odooDebugger.defaultVersion.'))
            .map((key: string) => key.slice('odooDebugger.defaultVersion.'.length))
            .sort();
        assert.deepStrictEqual(Object.keys(getDefaultVersionSettings()).sort(), registered);
        registered.forEach((key: string) => assert.ok(isDefaultableSetting(key), key));
    });

    test('per-version bookkeeping has no default to save', () => {
        // Set All as Default wrote these too, and VS Code refuses a setting
        // it does not know - so the command failed halfway.
        for (const key of ['managedPaths', 'customIdentity', 'debuggerName', 'portNumber', 'shellPortNumber']) {
            assert.strictEqual(isDefaultableSetting(key), false, key);
        }
    });
});
