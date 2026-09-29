/**
 * The three-way merge a shared store falls back on when two windows changed
 * the same document. What one side changed is kept; only a value both sides
 * changed differently is decided, by the last writer.
 */
import * as assert from 'assert';
import { jsonEqual, merge3, stableStringify } from '../services/mergeDocuments';

function project() {
    return {
        uid: 'p1',
        name: 'Acme',
        dbs: [
            { id: 'acme-17', modules: [{ name: 'sale', state: 'none' }] },
            { id: 'acme-19', modules: [{ name: 'crm', state: 'none' }] }
        ],
        repos: [{ name: 'acme', path: '/r/acme' }],
        tickets: [] as Array<{ id: string }>
    };
}

suite('Three-way document merge', () => {
    test('two windows editing different databases of one project both survive', () => {
        const base = project();
        const mine = project();
        mine.dbs[0].modules[0].state = 'install';
        const theirs = project();
        theirs.dbs[1].modules[0].state = 'upgrade';

        const merged = merge3(base, mine, theirs) as ReturnType<typeof project>;

        assert.strictEqual(merged.dbs[0].modules[0].state, 'install');
        assert.strictEqual(merged.dbs[1].modules[0].state, 'upgrade');
    });

    test('a value both sides changed goes to the last writer', () => {
        const base = project();
        const mine = { ...project(), name: 'Acme Corp' };
        const theirs = { ...project(), name: 'ACME' };

        assert.strictEqual((merge3(base, mine, theirs) as { name: string }).name, 'Acme Corp');
    });

    test('additions from both sides are kept', () => {
        const base = project();
        const mine = project();
        mine.tickets.push({ id: 'T-1' });
        const theirs = project();
        theirs.tickets.push({ id: 'T-2' });

        const merged = merge3(base, mine, theirs) as ReturnType<typeof project>;

        assert.deepStrictEqual(merged.tickets.map(ticket => ticket.id), ['T-1', 'T-2']);
    });

    test('a removal goes through when the other side left the element alone', () => {
        const base = project();
        const mine = project();
        mine.dbs.splice(1, 1);
        const theirs = { ...project(), name: 'Renamed' };

        const merged = merge3(base, mine, theirs) as ReturnType<typeof project>;

        assert.deepStrictEqual(merged.dbs.map(db => db.id), ['acme-17']);
        assert.strictEqual(merged.name, 'Renamed');
    });

    test('an edit outlives a removal made at the same time', () => {
        const base = project();
        const mine = project();
        mine.dbs.splice(1, 1);
        const theirs = project();
        theirs.dbs[1].modules[0].state = 'install';

        const merged = merge3(base, mine, theirs) as ReturnType<typeof project>;

        assert.deepStrictEqual(merged.dbs.map(db => db.id), ['acme-17', 'acme-19']);
        assert.strictEqual(merged.dbs[1].modules[0].state, 'install');
    });

    test('with no base, what only one side has is kept', () => {
        const merged = merge3(undefined, { a: 1 }, { b: 2 }) as Record<string, number>;

        assert.deepStrictEqual(merged, { a: 1, b: 2 });
    });

    test('equality and serialization ignore key order', () => {
        assert.ok(jsonEqual({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 }));
        assert.strictEqual(stableStringify({ b: 1, a: { d: 1, c: 2 } }), stableStringify({ a: { c: 2, d: 1 }, b: 1 }));
        assert.ok(!jsonEqual([1, 2], [2, 1]));
    });
});
