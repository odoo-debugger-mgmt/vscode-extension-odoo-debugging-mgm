import * as assert from 'assert';
import {
    checkpointDbName, checkpointsOf, setCheckpoints, derivedDbName, defaultCheckpointLabel, formatAge,
    formatBytes, parseSizes, checkpointSizeSql, checkpointComment, parseCheckpointComments,
    findOrphanCheckpoints, CHECKPOINT_COMMENT_PREFIX
} from '../services/checkpoints';

const bytes = (value: string) => Buffer.byteLength(value, 'utf8');

suite('Checkpoints', () => {
    test('checkpointsOf: a project read from the store may have no field at all', () => {
        assert.deepStrictEqual(checkpointsOf({}), []);
        assert.deepStrictEqual(checkpointsOf({ checkpoints: 'junk' }), []);
    });

    test('checkpointsOf drops records without a name and fills the rest in', () => {
        const list = checkpointsOf({ checkpoints: [
            { id: 'shop__cp_abc', label: 'before', createdAt: '2026-10-07T15:42:00.000Z', filestore: true },
            { label: 'no id' },
            null,
            { id: 'shop__cp_def' }
        ] });
        assert.strictEqual(list.length, 2);
        assert.deepStrictEqual(list[0], { id: 'shop__cp_abc', label: 'before', createdAt: '2026-10-07T15:42:00.000Z', filestore: true });
        assert.strictEqual(list[1].id, 'shop__cp_def');
        assert.strictEqual(list[1].label, 'shop__cp_def');
        assert.strictEqual(list[1].filestore, false);
        assert.ok(!Number.isNaN(Date.parse(list[1].createdAt)));
    });

    test('checkpointsOf keeps the filestore root a checkpoint recorded, and only a real one', () => {
        const list = checkpointsOf({ checkpoints: [
            { id: 'a', filestoreRoot: '/data/filestore' },
            { id: 'b', filestoreRoot: '' },
            { id: 'c', filestoreRoot: 42 },
            { id: 'd' }
        ] });
        assert.deepStrictEqual(list.map(cp => cp.filestoreRoot), ['/data/filestore', undefined, undefined, undefined]);
        assert.ok(!('filestoreRoot' in list[3]), 'no empty key is written back');
    });

    test('setCheckpoints writes the list back onto the plain object', () => {
        const db: { checkpoints?: unknown } = {};
        setCheckpoints(db, [{ id: 'a', label: 'a', createdAt: '2026-10-07T00:00:00.000Z', filestore: false }]);
        assert.strictEqual(checkpointsOf(db).length, 1);
    });

    test('the checkpoint name is <db>__cp_<base36 epoch seconds>', () => {
        const now = new Date('2026-10-07T15:42:00Z');
        const seconds = Math.floor(now.getTime() / 1000).toString(36);
        assert.strictEqual(checkpointDbName('shop', now, new Set()), `shop__cp_${seconds}`);
    });

    test('two checkpoints in one second get distinct names', () => {
        const now = new Date('2026-10-07T15:42:00Z');
        const first = checkpointDbName('shop', now, new Set());
        const second = checkpointDbName('shop', now, new Set([first.toLowerCase()]));
        assert.notStrictEqual(first, second);
    });

    test('long names are cut to 63 bytes, with a hash, and stay distinct', () => {
        const long = 'a'.repeat(62);
        const now = new Date('2026-10-07T15:42:00Z');
        const cp = checkpointDbName(long, now, new Set());
        const restoring = derivedDbName(long, '__restoring');
        const replaced = derivedDbName(long, '__replaced');
        for (const name of [cp, restoring, replaced]) {
            assert.ok(bytes(name) <= 63, `${name} is ${bytes(name)} bytes`);
        }
        assert.ok(restoring.endsWith('__restoring') && replaced.endsWith('__replaced'));
        assert.notStrictEqual(derivedDbName('b'.repeat(62), '__replaced'), replaced, 'different bases, different names');
        assert.strictEqual(derivedDbName('shop', '__replaced'), 'shop__replaced', 'short names are not touched');
    });

    test('multi-byte names are cut on a character boundary', () => {
        const name = derivedDbName('é'.repeat(40), '__restoring');
        assert.ok(bytes(name) <= 63);
        assert.ok(!name.includes('�'));
    });

    test('the default label is day, month and time', () => {
        assert.strictEqual(defaultCheckpointLabel(new Date(2026, 9, 7, 15, 42)), '7 Oct 15:42');
        assert.strictEqual(defaultCheckpointLabel(new Date(2026, 0, 3, 9, 5)), '3 Jan 09:05');
    });

    test('age reads like the rest of the tree', () => {
        const now = new Date('2026-10-07T15:42:00Z');
        const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
        assert.strictEqual(formatAge(ago(20 * 1000), now), 'just now');
        assert.strictEqual(formatAge(ago(5 * 60 * 1000), now), '5 min ago');
        assert.strictEqual(formatAge(ago(2 * 3600 * 1000), now), '2 h ago');
        assert.strictEqual(formatAge(ago(3 * 86400 * 1000), now), '3 d ago');
        assert.strictEqual(formatAge('not a date', now), '');
    });

    test('sizes', () => {
        assert.strictEqual(formatBytes(512), '512 B');
        assert.strictEqual(formatBytes(15 * 1024 * 1024), '15 MB');
        assert.strictEqual(formatBytes(1.45 * 1024 * 1024 * 1024), '1.4 GB');
        assert.strictEqual(formatBytes(2.5 * 1024), '2.5 KB');
    });

    test('the size query is one statement and its output parses', () => {
        const sql = checkpointSizeSql(['a__cp_1', "we'ird"]);
        assert.ok(sql.includes('pg_database_size'));
        assert.ok(!sql.includes("we'ird"), 'names go in as sqlText, never raw');
        const sizes = parseSizes('a__cp_1|8000000\nb|12\n\n');
        assert.strictEqual(sizes.get('a__cp_1'), 8000000);
        assert.strictEqual(sizes.get('b'), 12);
    });

    test('the comment names the source, and orphans are found by it', () => {
        assert.strictEqual(checkpointComment('shop'), `${CHECKPOINT_COMMENT_PREFIX}shop`);
        const rows = parseCheckpointComments([
            `shop__cp_1|${CHECKPOINT_COMMENT_PREFIX}shop`,
            `gone__cp_1|${CHECKPOINT_COMMENT_PREFIX}gone`,
            'tpl_base|',
            'other|some comment'
        ].join('\n'));
        assert.deepStrictEqual(rows, [{ name: 'shop__cp_1', source: 'shop' }, { name: 'gone__cp_1', source: 'gone' }]);
        const orphans = findOrphanCheckpoints(rows, new Set(['shop', 'shop__cp_1', 'gone__cp_1']), new Set());
        assert.deepStrictEqual(orphans, [{ name: 'gone__cp_1', source: 'gone' }]);
        assert.deepStrictEqual(findOrphanCheckpoints(rows, new Set(['shop']), new Set(['gone__cp_1'])), [], 'a recorded one is not an orphan');
    });
});
