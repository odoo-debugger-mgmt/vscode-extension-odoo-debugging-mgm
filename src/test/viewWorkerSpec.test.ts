import * as assert from 'assert';
import { viewWorkerUnavailableReason } from '../services/views/viewWorkerSpec';

suite('View worker availability', () => {
    const ok = { dbName: 'shop-18', inProject: true, versionName: '18.0', provisioned: true };

    test('runs on a provisioned version of a project database', () => {
        assert.strictEqual(viewWorkerUnavailableReason(ok), undefined);
    });

    test('names the reason instead of failing to spawn', () => {
        assert.match(viewWorkerUnavailableReason({ ...ok, inProject: false }) ?? '', /"shop-18" is not a database of the selected project/);
        assert.match(viewWorkerUnavailableReason({ ...ok, versionName: undefined }) ?? '', /"shop-18" has no version/);
        assert.match(viewWorkerUnavailableReason({ ...ok, provisioned: false }) ?? '', /"18.0" has no environment to run/);
    });
});
