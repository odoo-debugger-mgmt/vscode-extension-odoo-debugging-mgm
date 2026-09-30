/**
 * What activation must do on its own, not only when a setting changes.
 *
 * The twelfth test run found the question "which version does this
 * workspace run?" never asked on open: the call had landed inside a
 * configuration-change handler, so only toggling a setting ran it.
 */
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const EXTENSION = path.resolve(__dirname, '..', '..', 'src', 'extension.ts');

/** The source with every `onDidChangeConfiguration(...)` call cut out. */
function withoutConfigurationHandlers(source: string): string {
    let result = source;
    for (;;) {
        const start = result.indexOf('onDidChangeConfiguration(');
        if (start < 0) {
            return result;
        }
        let depth = 0;
        let end = start + 'onDidChangeConfiguration'.length;
        for (; end < result.length; end++) {
            if (result[end] === '(') {
                depth++;
            } else if (result[end] === ')' && --depth === 0) {
                break;
            }
        }
        result = result.slice(0, start) + result.slice(end + 1);
    }
}

suite('Activation runs what it must on open', () => {
    (fs.existsSync(EXTENSION) ? test : test.skip)('the workspace is offered its version outside any settings handler', () => {
        const outside = withoutConfigurationHandlers(fs.readFileSync(EXTENSION, 'utf8'));
        assert.ok(outside.includes('offerWorkspaceBinding()'), 'offerWorkspaceBinding() only runs when a setting changes');
        assert.ok(outside.includes('offerToReopenByPath(context)'));
    });
});
