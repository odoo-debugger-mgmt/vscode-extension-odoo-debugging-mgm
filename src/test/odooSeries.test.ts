import * as assert from 'assert';
import { parseOdooSeries } from '../services/database';

suite('Odoo series parsing', () => {
    test('parses standard release versions', () => {
        assert.strictEqual(parseOdooSeries('17.0.1.3'), '17.0');
        assert.strictEqual(parseOdooSeries('18.0.1.0.0'), '18.0');
        assert.strictEqual(parseOdooSeries('16.0'), '16.0');
    });

    test('parses saas versions into branch names', () => {
        assert.strictEqual(parseOdooSeries('saas~17.4.1.2'), 'saas-17.4');
        assert.strictEqual(parseOdooSeries('saas-18.2.1.0'), 'saas-18.2');
    });

    test('tolerates whitespace from psql output', () => {
        assert.strictEqual(parseOdooSeries(' 17.0.1.3\n'), '17.0');
    });

    test('returns undefined for non-version content', () => {
        assert.strictEqual(parseOdooSeries(''), undefined);
        assert.strictEqual(parseOdooSeries(undefined), undefined);
        assert.strictEqual(parseOdooSeries(null), undefined);
        assert.strictEqual(parseOdooSeries('not-a-version'), undefined);
    });
});
