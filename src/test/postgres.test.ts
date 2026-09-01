import * as assert from 'assert';
import { quotePgIdentifier, RESERVED_DATABASE_NAMES } from '../services/postgres';
import { parseActiveDatabaseNames } from '../services/database';

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

    test('parses active database names from the pg_stat_activity probe', () => {
        assert.deepStrictEqual(
            parseActiveDatabaseNames('shop-17\nshop-18\n\n  postgres  \n'),
            ['shop-17', 'shop-18', 'postgres']
        );
        assert.deepStrictEqual(parseActiveDatabaseNames(''), []);
        assert.deepStrictEqual(parseActiveDatabaseNames('   \n  '), []);
    });
});
