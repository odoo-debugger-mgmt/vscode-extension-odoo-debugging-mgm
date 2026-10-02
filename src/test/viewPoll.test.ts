import * as assert from 'assert';
import * as vscode from 'vscode';
import { ViewArchPoller } from '../views/viewPoll';
import { viewUri } from '../views/viewFileSystem';

suite('View arch poll', () => {
    const uri = viewUri('shop', 12, 'a');
    const open = [{ uri, ref: { dbName: 'shop', viewId: 12 } }];

    test('skips a database whose query is still pending', async () => {
        let calls = 0;
        let release: (dates: Map<number, number>) => void = () => undefined;
        const poller = new ViewArchPoller(
            () => { calls++; return new Promise(resolve => { release = resolve; }); },
            () => undefined, () => undefined);
        const first = poller.tick(open);
        await poller.tick(open);
        assert.strictEqual(calls, 1);
        release(new Map([[12, 1]]));
        await first;
        void poller.tick(open);
        assert.strictEqual(calls, 2, 'a finished query frees the database');
    });

    test('reports the first sighting without calling it an edit, then real edits', async () => {
        const dates = new Map([[12, 1]]);
        const reports: Array<[vscode.Uri[], boolean]> = [];
        const poller = new ViewArchPoller(async () => dates, (uris, edited) => reports.push([uris, edited]), () => undefined);
        await poller.tick(open);
        await poller.tick(open);
        dates.set(12, 2);
        await poller.tick(open);
        assert.deepStrictEqual(reports.map(([uris, edited]) => [uris.length, edited]), [[1, false], [1, true]]);
    });

    test('forgets closed tabs and frees the database after a failure', async () => {
        let fail = true;
        const errors: string[] = [];
        const reports: number[] = [];
        const poller = new ViewArchPoller(
            async () => { if (fail) { throw new Error('x'); } return new Map([[12, 1]]); },
            uris => reports.push(uris.length), db => errors.push(db));
        await poller.tick(open);
        fail = false;
        await poller.tick(open);
        await poller.tick([]);
        await poller.tick(open);
        assert.deepStrictEqual(errors, ['shop']);
        assert.deepStrictEqual(reports, [1, 1], 'reopened tab is a first sighting again');
    });
});
