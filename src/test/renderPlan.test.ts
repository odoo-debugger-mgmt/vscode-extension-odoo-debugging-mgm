import * as assert from 'assert';
import { commonIds, framePath, qwebMessage, usesOdooRouter } from '../services/views/renderPlan';

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

    test('common ids, newest first', () => {
        assert.deepStrictEqual(commonIds([9, 7, 5, 5], [8, 5, 7]), [7, 5]);
        assert.deepStrictEqual(commonIds([9], [8]), []);
    });

    test('QWeb says where to look instead', () => {
        assert.match(qwebMessage(true), /^Reports need a record to render/);
        assert.match(qwebMessage(false), /^QWeb templates render inside the page/);
    });
});
