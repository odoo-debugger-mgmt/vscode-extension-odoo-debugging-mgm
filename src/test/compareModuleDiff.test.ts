import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { diffTrees, listTree, sha1OfFile } from '../services/compare/moduleDiff';

function tree(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'));
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
    return dir;
}

suite('Compare module diff', () => {
    test('the same content is the same', async () => {
        const a = tree({ 'a.py': 'x = 1\n' });
        const b = tree({ 'a.py': 'x = 1\n' });
        const result = await diffTrees(a, b);
        assert.deepStrictEqual(result, { changed: [], added: [], removed: [], same: 1 });
    });

    test('a different size is changed without hashing', async () => {
        const a = tree({ 'a.py': 'x = 1\n' });
        const b = tree({ 'a.py': 'x = 12\n' });
        let calls = 0;
        const result = await diffTrees(a, b, async () => { calls++; return ''; });
        assert.deepStrictEqual(result.changed, ['a.py']);
        assert.strictEqual(calls, 0);
    });

    test('the same size with other content is changed, with a hash', async () => {
        const a = tree({ 'a.py': 'x = 1\n' });
        const b = tree({ 'a.py': 'x = 2\n' });
        let calls = 0;
        const result = await diffTrees(a, b, async file => { calls++; return sha1OfFile(file); });
        assert.deepStrictEqual(result.changed, ['a.py']);
        assert.strictEqual(calls, 2);
    });

    test('added and removed files are listed', async () => {
        const a = tree({ 'old.py': '1', 'both.py': 'a' });
        const b = tree({ 'new.py': '1', 'both.py': 'a' });
        const result = await diffTrees(a, b);
        assert.deepStrictEqual(result.removed, ['old.py']);
        assert.deepStrictEqual(result.added, ['new.py']);
        assert.strictEqual(result.same, 1);
    });

    test('caches, git and node_modules are ignored', async () => {
        const a = tree({ '__pycache__/x.pyc': '1', '.git/HEAD': '1', 'node_modules/a.js': '1', 'm.pyc': '1', 'ok.py': '1' });
        const files = [...(await listTree(a)).keys()];
        assert.deepStrictEqual(files, ['ok.py']);
    });
});
