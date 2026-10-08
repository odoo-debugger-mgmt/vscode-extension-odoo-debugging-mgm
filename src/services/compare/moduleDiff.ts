/**
 * Comparing two module folders: by size first, then by SHA-1 of the content,
 * so a large module costs hashes only for files of equal size.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const SKIPPED_DIRS = new Set(['__pycache__', 'node_modules']);

export interface TreeDiff { changed: string[]; added: string[]; removed: string[]; same: number }

export async function sha1OfFile(file: string): Promise<string> {
    return createHash('sha1').update(await fs.readFile(file)).digest('hex');
}

/** Relative path (forward slashes) to size, skipping caches, `.pyc` and dot-folders. */
export async function listTree(dir: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const walk = async (current: string, prefix: string): Promise<void> => {
        const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (!entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name)) {
                    await walk(full, rel);
                }
            } else if (entry.isFile() && !entry.name.endsWith('.pyc')) {
                const stat = await fs.stat(full).catch(() => undefined);
                if (stat) {
                    out.set(rel, stat.size);
                }
            }
        }
    };
    await walk(dir, '');
    return out;
}

/** `added` is only on the right, `removed` only on the left. */
export async function diffTrees(
    left: string,
    right: string,
    hash: (file: string) => Promise<string> = sha1OfFile
): Promise<TreeDiff> {
    const [l, r] = await Promise.all([listTree(left), listTree(right)]);
    const result: TreeDiff = { changed: [], added: [], removed: [], same: 0 };
    for (const [rel, size] of l) {
        const other = r.get(rel);
        if (other === undefined) {
            result.removed.push(rel);
        } else if (other !== size) {
            result.changed.push(rel);
        } else if ((await hash(path.join(left, rel))) === (await hash(path.join(right, rel)))) {
            result.same++;
        } else {
            result.changed.push(rel);
        }
    }
    for (const rel of r.keys()) {
        if (!l.has(rel)) {
            result.added.push(rel);
        }
    }
    for (const list of [result.changed, result.added, result.removed]) {
        list.sort();
    }
    return result;
}
