import * as assert from 'assert';
import { QWEB_FRAGMENT_MESSAGE, commonIds, framePath, reportPath, usesOdooRouter } from '../services/views/renderPlan';

suite('Render plan', () => {
    test('saas~17.2 brought the /odoo URLs', () => {
        for (const series of ['saas~17.2', 'saas~17.4', '18.0', 'saas~18.3', '19.0', 'master']) {
            assert.strictEqual(usesOdooRouter(series), true, series);
        }
        for (const series of ['15.0', '16.0', 'saas~16.4', '17.0', 'saas~17.1']) {
            assert.strictEqual(usesOdooRouter(series), false, series);
        }
    });

    test('frame paths, with debug on, for a record, a new record and a list', () => {
        const base = { actionId: 41, model: 'res.partner', viewType: 'form' };
        assert.strictEqual(framePath({ ...base, series: '19.0', resId: 7 }), '/odoo/action-41/7?debug=1');
        assert.strictEqual(framePath({ ...base, series: '19.0' }), '/odoo/action-41?debug=1');
        assert.strictEqual(framePath({ ...base, series: '17.0', resId: 7 }), '/web?debug=1#action=41&model=res.partner&view_type=form&id=7');
        assert.strictEqual(framePath({ ...base, series: '17.0' }), '/web?debug=1#action=41&model=res.partner&view_type=form');
        assert.strictEqual(framePath({ ...base, viewType: 'list', series: '18.0', resId: 7 }), '/odoo/action-41?debug=1');
        assert.strictEqual(framePath({ ...base, viewType: 'tree', series: '16.0', resId: 7 }), '/web?debug=1#action=41&model=res.partner&view_type=tree');
    });

    test('debug off is said, not left out: Odoo keeps the last debug mode in the session', () => {
        const base = { actionId: 41, model: 'res.partner', viewType: 'form', resId: 7 };
        assert.strictEqual(framePath({ ...base, series: '19.0', debug: false }), '/odoo/action-41/7?debug=0');
        assert.strictEqual(framePath({ ...base, series: '17.0', debug: false }), '/web?debug=0#action=41&model=res.partner&view_type=form&id=7');
        assert.strictEqual(framePath({ ...base, series: '19.0', debug: true }), '/odoo/action-41/7?debug=1');
    });

    test('common ids, newest first', () => {
        assert.deepStrictEqual(commonIds([9, 7, 5, 5], [8, 5, 7]), [7, 5]);
        assert.deepStrictEqual(commonIds([9], [8]), []);
    });

    test('a QWeb fragment says where to look instead', () => {
        assert.match(QWEB_FRAGMENT_MESSAGE, /^QWeb templates render inside the page that uses them/);
    });

    test('a report renders as HTML on its record', () => {
        assert.strictEqual(reportPath('account.report_invoice', 7), '/report/html/account.report_invoice/7?debug=1');
        assert.strictEqual(reportPath('odd name/x', 7, false), '/report/html/odd%20name%2Fx/7?debug=0');
    });
});
