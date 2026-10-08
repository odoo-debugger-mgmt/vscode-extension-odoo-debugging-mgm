import * as assert from 'assert';
import { findXmlElementById, xmlElementAt } from '../services/compare/xmlElements';

const XML = `<odoo>
    <record id="view_form" model="ir.ui.view">
        <field name="arch" type="xml"><form/></field>
    </record>
    <template id="acme.tpl"><div/></template>
    <menuitem id="menu_root" name="Root"/>
    <!-- <record id="commented"/> -->
</odoo>`;

suite('Compare: XML elements', () => {
    test('the element under the cursor', () => {
        const at = XML.indexOf('<form/>');
        const el = xmlElementAt(XML, at)!;
        assert.deepStrictEqual([el.tag, el.id], ['record', 'view_form']);
        assert.ok(XML.slice(el.start, el.end).startsWith('<record id="view_form"'));
        assert.ok(XML.slice(el.start, el.end).endsWith('</record>'));
        assert.strictEqual(xmlElementAt(XML, XML.indexOf('menu_root'))?.tag, 'menuitem');
        assert.strictEqual(xmlElementAt(XML, 2), undefined);
        assert.strictEqual(xmlElementAt(XML, XML.indexOf('commented')), undefined, 'comments are skipped');
    });

    test('the same id, bare or module-qualified', () => {
        assert.strictEqual(findXmlElementById(XML, 'acme.view_form', 'acme')?.id, 'view_form');
        assert.strictEqual(findXmlElementById(XML, 'tpl', 'acme')?.id, 'acme.tpl');
        assert.strictEqual(findXmlElementById(XML, 'nope', 'acme'), undefined);
    });
});
