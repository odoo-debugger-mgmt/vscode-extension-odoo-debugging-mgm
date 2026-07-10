import * as assert from 'assert';
import * as vscode from 'vscode';
import { extractVersionId, extractVersionSettingRef, extractUri } from '../commands/args';

suite('Command argument extractors', () => {
    test('extractVersionId accepts ids and version tree items', () => {
        assert.strictEqual(extractVersionId('v1'), 'v1');
        assert.strictEqual(extractVersionId({ version: { id: 'v2' } }), 'v2');
        assert.strictEqual(extractVersionId({ version: {} }), undefined);
        assert.strictEqual(extractVersionId(undefined), undefined);
        assert.strictEqual(extractVersionId(42), undefined);
    });

    test('extractVersionSettingRef handles both invocation shapes', () => {
        assert.deepStrictEqual(
            extractVersionSettingRef('v1', 'portNumber', 8069),
            { versionId: 'v1', key: 'portNumber', value: 8069 }
        );
        assert.deepStrictEqual(
            extractVersionSettingRef({ versionId: 'v1', key: 'devMode', value: '--dev=all' }),
            { versionId: 'v1', key: 'devMode', value: '--dev=all' }
        );
        assert.strictEqual(extractVersionSettingRef('v1'), undefined);
        assert.strictEqual(extractVersionSettingRef({}), undefined);
    });

    test('extractUri accepts uris and tree items carrying them', () => {
        const uri = vscode.Uri.file('/tmp/example');
        assert.strictEqual(extractUri(uri), uri);
        assert.strictEqual(extractUri({ resourceUri: uri }), uri);
        assert.strictEqual(extractUri({ uri }), uri);
        assert.strictEqual(extractUri({}), undefined);
        assert.strictEqual(extractUri('not-a-uri'), undefined);
    });
});
