import * as assert from 'assert';
import { isStoreRefusal, reportingStoreRefusals } from '../commands/registerCommand';
import { StoreBusyError, StoreReadOnlyError } from '../services/sqliteMainStore';

suite('Commands report a refused save as a warning', () => {
    test('a read-only store refusing the save does not fail the command', async () => {
        // Failing it is what made VS Code blame the extension.
        const result = await reportingStoreRefusals(async () => {
            throw new StoreReadOnlyError('/tmp/shared.db', 99);
        });
        assert.strictEqual(result, undefined);
    });

    test('neither does a store another window kept locked', async () => {
        assert.strictEqual(await reportingStoreRefusals(() => {
            throw new StoreBusyError('/tmp/shared.db');
        }), undefined);
    });

    test('any other error still propagates', async () => {
        await assert.rejects(reportingStoreRefusals(async () => {
            throw new Error('boom');
        }), /boom/);
    });

    test('a command that succeeds returns its value', async () => {
        assert.strictEqual(await reportingStoreRefusals(() => 42), 42);
    });

    test('the refusal reads as one sentence', () => {
        const error = new StoreReadOnlyError('/tmp/shared.db', 99);
        assert.ok(isStoreRefusal(error));
        assert.ok(!error.message.endsWith('.'), 'a full stop here doubles up inside "Failed to …: <message>."');
        assert.match(error.message, /read-only here/);
    });
});
