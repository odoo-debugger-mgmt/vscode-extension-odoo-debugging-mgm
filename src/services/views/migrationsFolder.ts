/**
 * Where an upgrade script lands in a module: migrations/<version>/
 * end-update_views.py. Odoo runs migrations/<v>/ for a module being updated
 * when installed < v <= the manifest's version, versions with fewer than two
 * dots being prefixed with the series first (odoo/modules/migration.py,
 * convert_version). end- scripts run after every module has loaded.
 *
 * A script already there is merged into when this extension wrote it
 * (parseScript); anything else is never overwritten: the next numbered
 * sibling is used instead.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mergeEntries, newScriptFile, parseScript, renderScript, scriptEntry, type ScriptView } from './upgradeScript';

export const SCRIPT_NAME = 'end-update_views';
const MAX_SIBLINGS = 100;

export function isVersionFolder(version: string): boolean {
    return /^\d+(\.\d+){1,5}$/.test(version);
}

export function manifestVersion(text: string): string | undefined {
    const match = /(['"])version\1\s*:\s*(['"])([^'"\n]*)\2/.exec(text);
    return match?.[3].trim() || undefined;
}

/** The version one patch up; Odoo's default 1.0 bumped when there is none; undefined when it is not plain numbers. */
export function bumpVersion(version: string | undefined): string | undefined {
    const base = version ?? '1.0';
    if (!/^\d+(\.\d+)*$/.test(base)) {
        return undefined;
    }
    const parts = base.split('.');
    if (parts.length === 1) {
        parts.push('0');
    }
    parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1);
    return parts.join('.');
}

/** Odoo's release.major_version for a version's branch: 17.0, saas~17.4; undefined for master and the like. */
export function seriesOf(odooVersion: string | undefined): string | undefined {
    if (!odooVersion) {
        return undefined;
    }
    if (/^\d+\.\d+$/.test(odooVersion)) {
        return odooVersion;
    }
    const saas = /^saas-(\d+\.\d+)$/.exec(odooVersion);
    return saas ? `saas~${saas[1]}` : undefined;
}

/** convert_version: a version with fewer than two dots gets the series in front. */
export function withSeries(version: string, series: string | undefined): string {
    return version.split('.').length >= 3 || !series ? version : `${series}.${version}`;
}

export function compareVersions(a: string, b: string): number {
    const left = a.split('.');
    const right = b.split('.');
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const x = left[i] ?? '0';
        const y = right[i] ?? '0';
        const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
        const diff = numeric ? Number(x) - Number(y) : x.localeCompare(y);
        if (diff !== 0) {
            return Math.sign(diff);
        }
    }
    return 0;
}

/** Whether Odoo would skip migrations/<folder>/ until the manifest version goes up to it. */
export function needsManifestBump(folder: string, manifest: string | undefined, series: string | undefined): boolean {
    return compareVersions(withSeries(folder, series), withSeries(manifest ?? '1.0', series)) > 0;
}

/** The manifest with its version set, quotes kept; a manifest with none gets one first in its dict. */
export function setManifestVersion(text: string, version: string): string {
    const existing = /((['"])version\2\s*:\s*)(['"])[^'"\n]*\3/;
    if (existing.test(text)) {
        return text.replace(existing, (_match, key: string, _keyQuote: string, quote: string) => `${key}${quote}${version}${quote}`);
    }
    const open = text.indexOf('{');
    if (open < 0) {
        throw new Error('The manifest has no dictionary to add the version to.');
    }
    return `${text.slice(0, open + 1)}\n    'version': '${version}',${text.slice(open + 1)}`;
}

export interface WrittenScript {
    path: string;
    merged: boolean;
}

async function writeAtomic(file: string, text: string): Promise<void> {
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
        await fs.writeFile(temp, text);
        await fs.rename(temp, file);
    } catch (error) {
        await fs.rm(temp, { force: true });
        throw error;
    }
}

/**
 * Writes `views` into `dir`/end-update_views.py, merging into it when this
 * extension wrote it, else into the first end-update_views_<n>.py that it
 * wrote or that does not exist yet.
 */
export async function writeScriptToFolder(dir: string, views: ScriptView[]): Promise<WrittenScript> {
    if (views.length === 0) {
        throw new Error('No views to write.');
    }
    const entries = views.map(scriptEntry);
    await fs.mkdir(dir, { recursive: true });
    for (let n = 1; n <= MAX_SIBLINGS; n++) {
        const file = path.join(dir, `${SCRIPT_NAME}${n === 1 ? '' : `_${n}`}.py`);
        let existing: string;
        try {
            existing = await fs.readFile(file, 'utf-8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
            // 'wx': if something appeared since the read, fail rather than overwrite it.
            await fs.writeFile(file, renderScript(mergeEntries(newScriptFile(), entries)), { flag: 'wx' });
            return { path: file, merged: false };
        }
        const parsed = parseScript(existing);
        if (parsed) {
            await writeAtomic(file, renderScript(mergeEntries(parsed, entries)));
            return { path: file, merged: true };
        }
    }
    throw new Error(`${dir} has no ${SCRIPT_NAME} file this extension can add to.`);
}
