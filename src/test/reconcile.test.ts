import * as assert from 'assert';
import { collectStaleCheckpoints } from '../services/reconcile';

suite('Reconcile checkpoints', () => {
    test('a record whose database is gone is stale; the rest are recorded', () => {
        const projects = [{
            name: 'Shop',
            dbs: [
                { id: 'shop', checkpoints: [
                    { id: 'shop__cp_1', label: 'a', createdAt: '2026-10-07T00:00:00.000Z', filestore: true },
                    { id: 'shop__cp_2', label: 'b', createdAt: '2026-10-07T00:00:00.000Z', filestore: true }
                ] },
                { id: 'plain' }
            ]
        }];
        const { stale, recorded } = collectStaleCheckpoints(projects, new Set(['shop', 'shop__cp_1']));
        assert.deepStrictEqual(stale.map(entry => [entry.projectName, entry.dbId, entry.checkpoint.id]), [['Shop', 'shop', 'shop__cp_2']]);
        assert.deepStrictEqual([...recorded].sort(), ['shop__cp_1', 'shop__cp_2']);
    });
});
