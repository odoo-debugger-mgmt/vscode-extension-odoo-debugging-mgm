import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { dirExists, linkTree, removeTree, renameDir, LinkOps } from '../services/filestore';

async function tree(root: string): Promise<string[]> {
    const out: string[] = [];
    async function walk(dir: string) {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                out.push(path.relative(root, full) + '/');
                await walk(full);
            } else {
                out.push(path.relative(root, full));
            }
        }
    }
    await walk(root);
    return out.sort();
}

suite('Filestore tree copy', () => {
    let tmp: string;

    setup(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'odt-fs-'));
        await fs.mkdir(path.join(tmp, 'src', 'ab'), { recursive: true });
        await fs.mkdir(path.join(tmp, 'src', 'cd', 'empty'), { recursive: true });
        await fs.writeFile(path.join(tmp, 'src', 'ab', 'ab12'), 'one');
        await fs.writeFile(path.join(tmp, 'src', 'cd', 'cd34'), 'two');
    });

    teardown(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    test('hard-links every file into the same tree, empty folders included', async () => {
        const result = await linkTree(path.join(tmp, 'src'), path.join(tmp, 'dst'));
        assert.deepStrictEqual(result, { files: 2, copied: 0 });
        assert.deepStrictEqual(await tree(path.join(tmp, 'dst')), await tree(path.join(tmp, 'src')));
        const [a, b] = await Promise.all([
            fs.stat(path.join(tmp, 'src', 'ab', 'ab12')),
            fs.stat(path.join(tmp, 'dst', 'ab', 'ab12'))
        ]);
        assert.strictEqual(a.ino, b.ino, 'the file is linked, not copied');
    });

    test('falls back to copying, for the rest of the tree, when linking is refused', async () => {
        let linkCalls = 0;
        const ops: LinkOps = {
            link: async () => {
                linkCalls++;
                throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
            },
            copyFile: (from, to) => fs.copyFile(from, to)
        };
        const result = await linkTree(path.join(tmp, 'src'), path.join(tmp, 'dst'), ops);
        assert.deepStrictEqual(result, { files: 2, copied: 2 });
        assert.strictEqual(linkCalls, 1, 'once refused, linking is not tried again');
        assert.strictEqual(await fs.readFile(path.join(tmp, 'dst', 'cd', 'cd34'), 'utf8'), 'two');
    });

    test('any other link error is not swallowed', async () => {
        const ops: LinkOps = {
            link: async () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); },
            copyFile: (from, to) => fs.copyFile(from, to)
        };
        await assert.rejects(linkTree(path.join(tmp, 'src'), path.join(tmp, 'dst'), ops), /no space/);
    });

    test('never merges into an existing folder', async () => {
        await fs.mkdir(path.join(tmp, 'dst'));
        await assert.rejects(linkTree(path.join(tmp, 'src'), path.join(tmp, 'dst')), /already exists/);
    });

    test('dirExists, renameDir and removeTree', async () => {
        assert.strictEqual(await dirExists(path.join(tmp, 'src')), true);
        assert.strictEqual(await dirExists(path.join(tmp, 'nope')), false);
        await fs.writeFile(path.join(tmp, 'file'), 'x');
        assert.strictEqual(await dirExists(path.join(tmp, 'file')), false, 'a file is not a folder');
        await renameDir(path.join(tmp, 'src'), path.join(tmp, 'moved'));
        assert.strictEqual(await dirExists(path.join(tmp, 'moved')), true);
        await removeTree(path.join(tmp, 'moved'));
        assert.strictEqual(await dirExists(path.join(tmp, 'moved')), false);
        await removeTree(path.join(tmp, 'moved'));
    });
});
