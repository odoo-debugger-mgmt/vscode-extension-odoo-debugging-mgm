/**
 * Finding the same file in the other side's code. Pure rules over a file
 * system probe, no vscode import.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface CodeRoot { role: string; path: string }
export interface SideRoots { label: string; roots: CodeRoot[] }

export interface FsProbe {
    exists(p: string): Promise<boolean>;
    isDir(p: string): Promise<boolean>;
    /** Entry names of a folder; [] when it cannot be read. */
    list(dir: string): Promise<string[]>;
}

export type Counterpart =
    | { kind: 'found'; path: string }
    | { kind: 'pick'; candidates: string[] }
    | { kind: 'none' };

const MAX_CANDIDATES = 50;
const MAX_DEPTH = 8;
const SKIPPED = new Set(['__pycache__', 'node_modules']);

export const realFsProbe: FsProbe = {
    exists: async p => fs.stat(p).then(() => true, () => false),
    isDir: async p => fs.stat(p).then(s => s.isDirectory(), () => false),
    list: async dir => fs.readdir(dir).catch(() => [] as string[])
};

export function rootOf(file: string, side: SideRoots): { root: CodeRoot; rel: string } | undefined {
    const target = path.resolve(file);
    let best: { root: CodeRoot; length: number } | undefined;
    for (const root of side.roots) {
        const base = path.resolve(root.path);
        if ((target === base || target.startsWith(base + path.sep)) && (!best || base.length > best.length)) {
            best = { root, length: base.length };
        }
    }
    if (!best) {
        return undefined;
    }
    const rel = path.relative(path.resolve(best.root.path), target).split(path.sep).join('/');
    return { root: best.root, rel };
}

export function addonsRoots(side: SideRoots): CodeRoot[] {
    return side.roots.filter(root => root.role !== 'odoo');
}

/** Files named `name` under `dir`, depth-bounded, stopping at `limit`. */
async function collect(dir: string, name: string, fsProbe: FsProbe, limit: number, out: string[] = [], depth = 0): Promise<string[]> {
    if (depth > MAX_DEPTH || out.length >= limit) {
        return out;
    }
    for (const entry of await fsProbe.list(dir)) {
        if (out.length >= limit) {
            break;
        }
        if (entry.startsWith('.') || SKIPPED.has(entry)) {
            continue;
        }
        const full = path.join(dir, entry);
        if (entry === name && !(await fsProbe.isDir(full))) {
            out.push(full);
        } else if (await fsProbe.isDir(full)) {
            await collect(full, name, fsProbe, limit, out, depth + 1);
        }
    }
    return out;
}

function verdict(files: string[]): Counterpart {
    if (files.length === 0) {
        return { kind: 'none' };
    }
    return files.length === 1 ? { kind: 'found', path: files[0] } : { kind: 'pick', candidates: files.slice(0, MAX_CANDIDATES) };
}

export async function resolveCounterpart(file: string, from: SideRoots, to: SideRoots, fsProbe: FsProbe): Promise<Counterpart> {
    const hit = rootOf(file, from);
    if (!hit) {
        return { kind: 'none' };
    }
    const sameRole = to.roots.find(root => root.role === hit.root.role);
    if (sameRole) {
        const same = path.join(sameRole.path, hit.rel);
        if (await fsProbe.exists(same)) {
            return { kind: 'found', path: same };
        }
    }
    if (hit.root.role === 'odoo') {
        // Framework files (odoo/models.py) have no same-name search.
        return { kind: 'none' };
    }
    const name = path.basename(file);
    {
        const slash = hit.rel.indexOf('/');
        const module = slash < 0 ? hit.rel : hit.rel.slice(0, slash);
        const inner = slash < 0 ? '' : hit.rel.slice(slash + 1);
        if (sameRole) {
            const folder = path.join(sameRole.path, module);
            if (await fsProbe.isDir(folder)) {
                const files = await collect(folder, name, fsProbe, MAX_CANDIDATES);
                if (files.length > 0) {
                    return verdict(files);
                }
            }
        }
        for (const root of addonsRoots(to)) {
            if (root === sameRole) {
                continue;
            }
            const folder = path.join(root.path, module);
            if (!(await fsProbe.isDir(folder))) {
                continue;
            }
            if (inner && await fsProbe.exists(path.join(folder, inner))) {
                return { kind: 'found', path: path.join(folder, inner) };
            }
            const files = await collect(folder, name, fsProbe, MAX_CANDIDATES);
            if (files.length > 0) {
                return verdict(files);
            }
        }
    }
    const all: string[] = [];
    for (const root of addonsRoots(to)) {
        await collect(root.path, name, fsProbe, MAX_CANDIDATES, all);
    }
    return verdict([...new Set(all)]);
}

/**
 * The same-named module's folder on the other side (C1 step 3): the same root first, then the other
 * addons roots. Undefined for framework files and when no such module exists.
 */
export async function counterpartModuleDir(file: string, from: SideRoots, to: SideRoots, fsProbe: FsProbe): Promise<string | undefined> {
    const hit = rootOf(file, from);
    if (!hit || hit.root.role === 'odoo') {
        return undefined;
    }
    const module = hit.rel.split('/')[0];
    if (!module || !hit.rel.includes('/')) {
        return undefined;
    }
    const sameRole = to.roots.find(root => root.role === hit.root.role);
    const ordered = [...(sameRole ? [sameRole] : []), ...addonsRoots(to).filter(root => root !== sameRole)];
    for (const root of ordered) {
        const folder = path.join(root.path, module);
        if (await fsProbe.isDir(folder)) {
            return folder;
        }
    }
    return undefined;
}
