/**
 * Odoo's filestore copied by hard links. Safe because Odoo never changes a
 * filestore file in place: a file is named by the SHA-1 of its content,
 * written once only when it does not exist yet (ir_attachment._file_write,
 * 15.0-19.0), and the garbage collector only unlinks. So two folders can share
 * the underlying files forever, and a checkpoint of a 5 GB filestore costs
 * almost nothing.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface LinkTreeResult {
    files: number;
    /** Files copied because linking was refused (another filesystem, some Windows volumes). */
    copied: number;
}

export interface LinkOps {
    link(src: string, dst: string): Promise<void>;
    copyFile(src: string, dst: string): Promise<void>;
}

const realOps: LinkOps = {
    link: (src, dst) => fs.link(src, dst),
    copyFile: (src, dst) => fs.copyFile(src, dst)
};

/** Errors that mean "links are not possible here", not "something broke". */
const NO_LINKS = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'ENOSYS']);

export async function dirExists(dir: string): Promise<boolean> {
    try {
        return (await fs.stat(dir)).isDirectory();
    } catch {
        return false;
    }
}

export async function removeTree(dir: string): Promise<void> {
    await fs.rm(dir, { recursive: true, force: true });
}

export async function renameDir(from: string, to: string): Promise<void> {
    await fs.rename(from, to);
}

/** Recreates `src` at `dst`, linking every file. `dst` must not exist. */
export async function linkTree(src: string, dst: string, ops: LinkOps = realOps): Promise<LinkTreeResult> {
    if (await dirExists(dst) || await fs.lstat(dst).then(() => true, () => false)) {
        throw new Error(`${dst} already exists.`);
    }
    const result: LinkTreeResult = { files: 0, copied: 0 };
    let linking = true;

    async function walk(from: string, to: string): Promise<void> {
        await fs.mkdir(to, { recursive: true });
        for (const entry of await fs.readdir(from, { withFileTypes: true })) {
            const source = path.join(from, entry.name);
            const target = path.join(to, entry.name);
            if (entry.isDirectory()) {
                await walk(source, target);
            } else if (entry.isSymbolicLink()) {
                await fs.symlink(await fs.readlink(source), target);
            } else if (entry.isFile()) {
                result.files++;
                if (linking) {
                    try {
                        await ops.link(source, target);
                        continue;
                    } catch (error) {
                        if (!NO_LINKS.has((error as NodeJS.ErrnoException).code ?? '')) {
                            throw error;
                        }
                        linking = false;
                    }
                }
                await ops.copyFile(source, target);
                result.copied++;
            }
        }
    }

    await walk(src, dst);
    return result;
}
