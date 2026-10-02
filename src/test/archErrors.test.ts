import * as assert from 'assert';
import { locateArchError } from '../services/views/archErrors';

const ARCH = [
    '<data>',
    '    <xpath expr="//field[@name=\'partner_id\']" position="after">',
    '        <field name="x_custom"/>',
    '    </xpath>',
    '</data>'
].join('\n');

suite('Arch error location', () => {
    test('points at the xpath Odoo could not locate', () => {
        const message = 'Element \'<xpath expr="//field[@name=\'partner_id\']">\' cannot be located in parent view';
        assert.deepStrictEqual(locateArchError(ARCH, message), { line: 1, start: 17, end: 44 });
    });

    test('points at a field Odoo does not know', () => {
        assert.deepStrictEqual(
            locateArchError(ARCH, 'Field "x_custom" does not exist in model "res.partner"'),
            { line: 2, start: 21, end: 29 }
        );
    });

    test('uses the line of an XML syntax error', () => {
        assert.deepStrictEqual(
            locateArchError(ARCH, 'Opening and ending tag mismatch: xpath line 2 and data, line 4, column 9'),
            { line: 3, start: 0, end: 12 }
        );
    });

    test('falls back to the first line', () => {
        assert.deepStrictEqual(locateArchError(ARCH, 'Something else broke'), { line: 0, start: 0, end: 6 });
    });
});
