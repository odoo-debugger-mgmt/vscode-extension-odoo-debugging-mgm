import * as assert from 'assert';
import { ViewService, originalInactiveIds } from '../services/views/viewService';
import type { ViewWorkerPool } from '../services/views/viewWorkerPool';

function fakePool(replies: Record<string, unknown>, calls: Array<[string, string, unknown]>): ViewWorkerPool {
    return {
        run: async (dbName: string, cmd: string, args: Record<string, unknown> = {}) => {
            calls.push([dbName, cmd, args]);
            return replies[cmd];
        }
    } as unknown as ViewWorkerPool;
}

suite('View service render commands', () => {
    test('mints a session, makes an action and lists recent ids through the shell', async () => {
        const calls: Array<[string, string, unknown]> = [];
        const service = new ViewService(fakePool({
            new_session: { sid: 'abc' },
            make_action: { action_id: 41, model: 'res.partner', view_type: 'form', root_id: 7, series: 'saas~17.2' },
            recent_ids: { ids: [9, 5] }
        }, calls));
        assert.strictEqual(await service.newSession('shop-18'), 'abc');
        assert.deepStrictEqual(await service.makeAction('shop-18', 12),
            { actionId: 41, model: 'res.partner', viewType: 'form', rootId: 7, series: 'saas~17.2' });
        assert.deepStrictEqual(await service.recentIds('shop-18', 'res.partner'), [9, 5]);
        assert.deepStrictEqual(calls, [
            ['shop-18', 'new_session', {}],
            ['shop-18', 'make_action', { view_id: 12 }],
            ['shop-18', 'recent_ids', { model: 'res.partner', limit: 200, domain: [] }]
        ]);
    });
});

suite('View service reports', () => {
    test('resolves a report through the shell, and passes its domain to recent_ids', async () => {
        const calls: Array<[string, string, unknown]> = [];
        const service = new ViewService(fakePool({
            report_target: { report_name: 'account.report_invoice', name: 'Invoices', model: 'account.move', domain: [['move_type', '!=', 'entry']], series: '18.0', report_type: 'qweb-text' },
            recent_ids: { ids: [3] }
        }, calls));
        const report = await service.reportTarget('shop-18', 40);
        assert.deepStrictEqual(report, { reportName: 'account.report_invoice', name: 'Invoices', model: 'account.move', domain: [['move_type', '!=', 'entry']], series: '18.0', reportType: 'qweb-text' });
        assert.deepStrictEqual(await service.recentIds('shop-18', report!.model, 5, report!.domain), [3]);
        assert.deepStrictEqual(calls[1], ['shop-18', 'recent_ids', { model: 'account.move', limit: 5, domain: [['move_type', '!=', 'entry']] }]);
        assert.strictEqual(await new ViewService(fakePool({ report_target: null }, [])).reportTarget('shop-18', 41), null);
        const older = await new ViewService(fakePool({ report_target: { report_name: 'r', name: 'R', model: 'res.partner', series: '17.0' } }, [])).reportTarget('shop-17', 42);
        assert.strictEqual(older?.reportType, 'qweb-pdf', 'a shell that does not say defaults to a PDF report');
    });
});

suite('View service XPath check', () => {
    test('sends the editor\'s text to the shell and parses the result', async () => {
        const calls: Array<[string, string, unknown]> = [];
        const service = new ViewService(fakePool({
            check_xpaths: { locators: [{ kind: 'xpath', expr: '//a', position: 'after', status: 'dead', matches: 0, line: 1, element: 0, shorter: [] }] }
        }, calls));
        const report = await service.checkXpaths('shop-18', 12, '<xpath expr="//a"/>');
        assert.strictEqual(report.summary.dead, 1);
        assert.deepStrictEqual(calls, [['shop-18', 'check_xpaths', { view_id: 12, arch: '<xpath expr="//a"/>' }]]);
    });
});

suite('Views also off in the original', () => {
    test('read from the original only, and never failing the tree', async () => {
        const reads: string[] = [];
        const read = async (dbName: string) => { reads.push(dbName); return [3, 4]; };
        assert.deepStrictEqual(await originalInactiveIds(read, 'shop-18', 'shop-17'), new Set([3, 4]));
        assert.strictEqual(await originalInactiveIds(read, 'shop-18'), undefined);
        assert.strictEqual(await originalInactiveIds(read, 'shop-18', 'shop-18'), undefined);
        assert.deepStrictEqual(reads, ['shop-17']);
        assert.strictEqual(await originalInactiveIds(async () => { throw new Error('database "shop-17" does not exist'); }, 'shop-18', 'shop-17'), undefined);
    });
});
