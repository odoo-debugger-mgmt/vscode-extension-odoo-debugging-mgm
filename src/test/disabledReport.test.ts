import * as assert from 'assert';
import { mergeReports, parseDisabledViews, viewIdFromHref } from '../services/views/disabledReport';

const OLD_STYLE = `
<h2> Congratulations, you have just upgraded to Odoo 17.0 </h2>
<p>Want to know more? Check out the <a href="https://www.odoo.com/odoo-17-release-notes">release note</a>.</p>
<h3>Fields renamed</h3>
<ul><li><details><summary>Models <kbd>a.b</kbd>: renamed.</summary><ul>
<li><a target="_blank" href="/web?debug=1#view_type=form&amp;model=ir.actions.server&amp;action=&amp;id=885">Some server action</a></li>
</ul></details></li></ul>
<h3>Disabled views</h3>
<ul><li><details><summary>The below custom views have been disabled during the migration because they were no longer valid.</summary>
<ul>
<li><a target="_blank" href="/web?debug=1#view_type=form&amp;model=ir.ui.view&amp;action=29&amp;id=1818">Odoo Studio: account.move.form customization</a></li>
<li><a target="_blank" href="/web?debug=1#view_type=form&amp;model=ir.ui.view&amp;action=29&amp;id=1788">report_invoice_with_payments</a></li>
</ul></details></li></ul>
<h3>Overridden views</h3>
<ul><li><details><summary>The below standard views have been overridden.</summary><ul>
<li>hr.some_view <a target="_blank" href="/web?debug=1#view_type=form&amp;model=ir.ui.view&amp;action=29&amp;id=4174">Original</a>
<a target="_blank" href="/web?debug=1#view_type=form&amp;model=ir.ui.view&amp;action=29&amp;id=4223">Copy</a></li>
</ul></details></li></ul>
`;

const NEW_STYLE = `
<h2> Congratulations, you have just upgraded to Odoo 18.0 </h2>
<h3>Disabled views</h3>
<ul><li><details><summary>The below custom views have been disabled during the migration because they were no longer valid.</summary>
<ul>
<li><a target="_blank" href="/odoo/action-29/1830?debug=1">Odoo Studio: res.partner.form customization</a></li>
<li><a target="_blank" href="/odoo/action-29/1863?debug=1">approval.request.view.form</a></li>
</ul></details></li></ul>
<h3>Overridden views</h3>
<ul><li>hr.some_view <a href="/odoo/action-29/4174?debug=1">Original</a> <a href="/odoo/action-29/4223?debug=1">Copy</a></li></ul>
`;

const PRE_2024_LAYOUT = `
<h2> Upgrade report: 16 </h2>
<h3>Fields renamed</h3>
<ul><li>something <a href="web?debug=1#view_type=form&amp;model=ir.actions.server&amp;action=&amp;id=885">action</a></li></ul>
<h3>Disabled views</h3>
<ul>
<div>The below custom views have been disabled during the migration because they were no longer valid.
<li><a href="web?debug=1#view_type=form&amp;model=ir.ui.view&amp;action=29&amp;id=812" target="_blank">sale.order.form.custom</a></li>
<li><a href="web?debug=1#view_type=form&amp;model=ir.ui.view&amp;action=29&amp;id=815" target="_blank">Odoo Studio: res.partner.form customization</a></li>
</div>
</ul>
<h3>Overridden views</h3>
<ul><div>The below standard views have been overriden.
<li>sale.view_order_form <a href="web?debug=1#view_type=form&amp;model=ir.ui.view&amp;action=29&amp;id=901">Original</a>
<a href="web?debug=1#view_type=form&amp;model=ir.ui.view&amp;action=29&amp;id=902">Copy</a></li></div></ul>
`;

suite('Upgrade report: disabled views', () => {
    test('reads the view id from both anchor shapes', () => {
        const cases: Array<[string | null | undefined, number | undefined]> = [
            ['/web?debug=1#view_type=form&model=ir.ui.view&action=29&id=1818', 1818],
            ['/web?debug=1#view_type=form&model=ir.ui.view&action=&id=7', 7],
            ['/odoo/action-29/1830?debug=1', 1830],
            ['/odoo/ir.ui.view/1830?debug=1', 1830],
            ['/odoo/action-29/1830', 1830],
            ['web?debug=1#view_type=form&model=ir.ui.view&action=29&id=812', 812],
            ['/odoo/action-29/new?debug=1', undefined],
            ['https://www.odoo.com/odoo-17-release-notes', undefined],
            ['', undefined],
            [null, undefined],
            [undefined, undefined]
        ];
        for (const [href, expected] of cases) {
            assert.strictEqual(viewIdFromHref(href), expected, String(href));
        }
    });

    test('parses the hash style used up to 17.0, ignoring the other sections', () => {
        assert.deepStrictEqual(parseDisabledViews(OLD_STYLE), { odooVersion: '17.0', viewIds: [1818, 1788] });
    });

    test('parses the path style used from saas~17.2', () => {
        assert.deepStrictEqual(parseDisabledViews(NEW_STYLE), { odooVersion: '18.0', viewIds: [1830, 1863] });
    });

    test('parses the layout from before 2024, which names no version', () => {
        assert.deepStrictEqual(parseDisabledViews(PRE_2024_LAYOUT), { viewIds: [812, 815] });
    });

    test('a message that only mentions the phrase is not a report', () => {
        assert.deepStrictEqual(parseDisabledViews('<p>Disabled views are listed in the report.</p>'), { viewIds: [] });
        assert.deepStrictEqual(parseDisabledViews(''), { viewIds: [] });
        assert.deepStrictEqual(parseDisabledViews(undefined), { viewIds: [] });
    });

    test('lists each view once, with every upgrade that disabled it', () => {
        const merged = mergeReports([
            { odooVersion: '17.0', viewIds: [1818, 1788] },
            { odooVersion: '18.0', viewIds: [1818, 1830] },
            { viewIds: [1830] }
        ]);
        assert.deepStrictEqual([...merged], [[1818, ['17.0', '18.0']], [1788, ['17.0']], [1830, ['18.0']]]);
    });
});
