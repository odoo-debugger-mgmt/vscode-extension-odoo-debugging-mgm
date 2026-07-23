import * as assert from 'assert';
import { quotePgIdentifier, RESERVED_DATABASE_NAMES } from '../services/postgres';

suite('Postgres service', () => {
    test('quotes identifiers and escapes embedded quotes', () => {
        assert.strictEqual(quotePgIdentifier('simple'), '"simple"');
        assert.strictEqual(quotePgIdentifier('with"quote'), '"with""quote"');
        assert.strictEqual(quotePgIdentifier('we"ird""name'), '"we""ird""""name"');
    });

    test('reserves the postgres maintenance databases', () => {
        for (const name of ['postgres', 'template0', 'template1']) {
            assert.ok(RESERVED_DATABASE_NAMES.has(name));
        }
    });
});
