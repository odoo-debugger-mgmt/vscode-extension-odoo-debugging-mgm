import * as assert from 'assert';
import { ViewService } from '../services/views/viewService';
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
            ['shop-18', 'recent_ids', { model: 'res.partner', limit: 200 }]
        ]);
    });
});
