import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { candidatesOf, leftRight, locateCounterpart, matchSide, orderSides, qualifiedAt, type LocateDeps, type SymbolNode } from '../services/compare/locate';
import { realFsProbe, type SideRoots } from '../services/compare/counterpart';

async function touch(file: string) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'x');
}

suite('Compare: sides and locating', () => {
    const mk = (label: string, root: string): SideRoots => ({ label, roots: [{ role: 'repo:a', path: root }] });

    test('this side wins when both sides match the same checkout', () => {
        const left = mk('L', '/w/a');
        const right = mk('R', '/w/a');
        const file = '/w/a/m/x.py';
        assert.ok(matchSide(file, { left, right, thisSide: 'left' }).onLeft);
        assert.ok(!matchSide(file, { left, right, thisSide: 'left' }).onRight);
        assert.ok(matchSide(file, { left, right, thisSide: 'right' }).onRight);
        assert.ok(!matchSide(file, { left, right, thisSide: 'right' }).onLeft);
    });

    test('orderSides gives from, to and the left/right placement; undefined for a foreign file', () => {
        const sides = { left: mk('L', '/l'), right: mk('R', '/r'), thisSide: 'right' as const };
        const onRight = orderSides('/r/m/x.py', sides);
        assert.deepStrictEqual([onRight?.from.label, onRight?.to.label, onRight?.fileOnLeft], ['R', 'L', false]);
        const onLeft = orderSides('/l/m/x.py', sides);
        assert.deepStrictEqual([onLeft?.from.label, onLeft?.to.label, onLeft?.fileOnLeft], ['L', 'R', true]);
        assert.strictEqual(orderSides('/elsewhere/x.py', sides), undefined);
        assert.deepStrictEqual(leftRight(true, 'mine', 'other'), ['mine', 'other']);
        assert.deepStrictEqual(leftRight(false, 'mine', 'other'), ['other', 'mine']);
    });

    test('candidatesOf puts the first files first, deduplicates and drops this file', () => {
        assert.deepStrictEqual(candidatesOf(['/b/y.py'], ['/b/x.py', '/b/y.py', '/a/self.py'], '/a/self.py'), ['/b/y.py', '/b/x.py']);
    });

    test('qualifiedAt picks the innermost class or function and ignores other kinds', () => {
        const node = (name: string, isScope: boolean, from: number, to: number, children: SymbolNode<number>[] = []): SymbolNode<number> =>
            ({ name, isScope, contains: p => p >= from && p <= to, children });
        const tree = [node('Order', true, 0, 20, [node('_compute', true, 2, 10, [node('inner', true, 4, 6)]), node('field', false, 12, 12)])];
        assert.strictEqual(qualifiedAt(tree, 5), 'Order._compute.inner');
        assert.strictEqual(qualifiedAt(tree, 8), 'Order._compute');
        assert.strictEqual(qualifiedAt(tree, 12), 'Order');
        assert.strictEqual(qualifiedAt(tree, 99), undefined);
        assert.strictEqual(qualifiedAt([], 1), undefined);
    });

    suite('locateCounterpart', () => {
        let tmp: string;
        let left: SideRoots;
        let right: SideRoots;
        let infos: string[];
        let searched: Array<{ files: string[]; moduleDir: string | undefined }>;
        const deps = (over: Partial<LocateDeps> = {}): LocateDeps => ({
            fs: realFsProbe,
            moduleOf: async f => path.dirname(path.dirname(f)),
            pick: async found => found.kind === 'pick' ? found.candidates[0] : undefined,
            info: m => { infos.push(m); },
            busy: work => work(),
            search: async (files, moduleDir) => { searched.push({ files, moduleDir }); return files.length ? 'TEXT' : undefined; },
            ...over
        });

        setup(async () => {
            tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'odt-loc-'));
            left = mk('L', path.join(tmp, 'l'));
            right = mk('R', path.join(tmp, 'r'));
            infos = [];
            searched = [];
        });
        teardown(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

        test('the same path searches that file and its module', async () => {
            await touch(path.join(tmp, 'l/m/models/a.py'));
            await touch(path.join(tmp, 'r/m/models/a.py'));
            const hit = await locateCounterpart(path.join(tmp, 'l/m/models/a.py'), left, right, { left, right }, 'Order', deps());
            assert.strictEqual(hit, 'TEXT');
            assert.deepStrictEqual(searched, [{ files: [path.join(tmp, 'r/m/models/a.py')], moduleDir: path.join(tmp, 'r/m') }]);
        });

        test('no symbol in the found file says so', async () => {
            await touch(path.join(tmp, 'l/m/a.py'));
            await touch(path.join(tmp, 'r/m/a.py'));
            const hit = await locateCounterpart(path.join(tmp, 'l/m/a.py'), left, right, { left, right }, 'Order', deps({ search: async () => undefined }));
            assert.strictEqual(hit, undefined);
            assert.deepStrictEqual(infos, ['Order has no counterpart in R.']);
        });

        test('the same file on both sides says so and searches nothing', async () => {
            await touch(path.join(tmp, 'l/m/a.py'));
            const same: SideRoots = { label: 'R', roots: left.roots };
            const hit = await locateCounterpart(path.join(tmp, 'l/m/a.py'), left, same, { left, right: same }, 'Order', deps());
            assert.strictEqual(hit, undefined);
            assert.deepStrictEqual(infos, ['a.py is the same file in L and R.']);
            assert.deepStrictEqual(searched, []);
        });

        test('without a matching file it searches the module first, then asks', async () => {
            await touch(path.join(tmp, 'l/m/models/a.py'));
            await touch(path.join(tmp, 'r/m/models/b.py'));
            const hit = await locateCounterpart(path.join(tmp, 'l/m/models/a.py'), left, right, { left, right }, 'Order',
                deps({ search: async (files, moduleDir) => { searched.push({ files, moduleDir }); return moduleDir ? 'FROM MODULE' : undefined; } }));
            assert.strictEqual(hit, 'FROM MODULE');
            assert.deepStrictEqual(searched, [{ files: [], moduleDir: path.join(tmp, 'r/m') }]);
        });

        test('when the module search fails it asks which file, then searches that file', async () => {
            await touch(path.join(tmp, 'l/gone/a.py'));
            await touch(path.join(tmp, 'r/other/models/a.py'));
            const hit = await locateCounterpart(path.join(tmp, 'l/gone/a.py'), left, right, { left, right }, 'Order', deps());
            assert.strictEqual(hit, 'TEXT');
            assert.deepStrictEqual(searched, [{ files: [path.join(tmp, 'r/other/models/a.py')], moduleDir: path.join(tmp, 'r/other') }]);
        });

        test('a dismissed pick or no candidate gives nothing', async () => {
            await touch(path.join(tmp, 'l/gone/a.py'));
            await fs.mkdir(path.join(tmp, 'r'), { recursive: true });
            const hit = await locateCounterpart(path.join(tmp, 'l/gone/a.py'), left, right, { left, right }, 'Order', deps({ pick: async () => undefined }));
            assert.strictEqual(hit, undefined);
            assert.deepStrictEqual(searched, []);
        });
    });
});
