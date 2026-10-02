import * as assert from 'assert';
import { archErrorSummary, locateArchError, readableArchError } from '../services/views/archErrors';

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

    test('points at the xpath when Odoo escapes its quotes, as every version does', () => {
        // Odoo 17's text, verbatim: template_inheritance html_escapes the locator's attributes.
        const message = 'Error while parsing or validating view:\n\nElement \'<xpath expr="//field[@name=&#39;partner_id&#39;]">\' cannot be located in parent view';
        assert.deepStrictEqual(locateArchError(ARCH, message), { line: 1, start: 17, end: 44 });
        assert.ok(readableArchError(message).includes('@name=\'partner_id\''));
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

    test('a one-line summary says the reason, not the heading', () => {
        const message = [
            'Error while parsing or validating view:',
            '',
            'Element \'<xpath expr="//field[@name=&#39;partner_id&#39;]">\' cannot be located in parent view',
            '',
            'View error context:',
            '{\'name\': \'odt.view.doctor.test\'}'
        ].join('\n');
        assert.strictEqual(archErrorSummary(message), 'Element \'<xpath expr="//field[@name=\'partner_id\']">\' cannot be located in parent view');
        assert.strictEqual(archErrorSummary('Field "x_custom" does not exist in model "res.partner"'), 'Field "x_custom" does not exist in model "res.partner"');
        assert.strictEqual(archErrorSummary('Odd heading only:'), 'Odd heading only:');
    });

    // Odoo 17.0's text verbatim, from activating such a view on a scratch database
    // (_check_xml: "Error while validating view near:\n\n%(fivelines)s\n%(error)s",
    // the same template on 15, 16, 18 and 19). Its five lines hold a text node too.
    const NEAR = "Error while validating view near:\n\n<form string=\"Partners\" __validate__=\"1\">\n                <div class=\"alert alert-warning oe_edit_only\" role=\"alert\" name=\"warning_tax\" invisible=\"not same_vat_partner_id\">\n                  A partner with the same <span><span class=\"o_vat_label\">Tax ID</span></span> already exists (<field name=\"same_vat_partner_id\" context=\"{'show_address': False, 'show_vat': False}\"/>), are you sure to create a new one?\n                </div>\n                <div class=\"alert alert-warning oe_edit_only\" role=\"alert\" name=\"warning_company\" invisible=\"not same_company_registry_partner_id\">\n\nField \"x_custom\" does not exist in model \"res.partner\"";

    test('the summary of a validation error is the reason, not the arch quoted near it', () => {
        assert.strictEqual(archErrorSummary(NEAR), 'Field "x_custom" does not exist in model "res.partner"');
        assert.strictEqual(
            archErrorSummary(`${NEAR}\nView error context:\n{'file': None,\n 'line': 1,\n 'name': 'odt.near'}`),
            'Field "x_custom" does not exist in model "res.partner"'
        );
    });

    test('the reason\'s quoted names are searched before the arch quoted around it', () => {
        const arch = [
            '<data>',
            '    <xpath expr="//div[@name=\'warning_tax\']" position="after">',
            '        <field name="x_custom"/>',
            '    </xpath>',
            '</data>'
        ].join('\n');
        // "warning_tax" comes first in Odoo's message, from the quoted arch.
        assert.deepStrictEqual(locateArchError(arch, NEAR), { line: 2, start: 21, end: 29 });
    });
});

