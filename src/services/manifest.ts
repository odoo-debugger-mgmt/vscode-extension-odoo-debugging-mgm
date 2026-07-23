import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from './logger';

/**
 * Lightweight __manifest__.py reader: extracts the `depends` list and any
 * ticket/task identifiers (Odoo PS convention) without executing Python.
 * Results are cached by file mtime.
 */

export interface ModuleManifestInfo {
    depends: string[];
    ticketIds: string[];
}

interface CacheEntry {
    mtimeMs: number;
    info: ModuleManifestInfo;
}

const manifestCache = new Map<string, CacheEntry>();

const TICKET_KEYS = ['task_id', 'task_ids', 'ticket', 'ticket_id', 'ticket_number'];

function extractQuotedStrings(source: string): string[] {
    const values: string[] = [];
    const regex = /['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
        values.push(match[1].trim());
    }
    return values.filter(Boolean);
}

function parseDepends(content: string): string[] {
    const match = /['"]depends['"]\s*:\s*\[([^\]]*)\]/s.exec(content);
    if (!match) {
        return [];
    }
    return Array.from(new Set(extractQuotedStrings(match[1])));
}

function parseTicketIds(content: string): string[] {
    const ids = new Set<string>();

    for (const key of TICKET_KEYS) {
        // Value forms: 1234567, '1234567', or a [list, of, them].
        const keyRegex = new RegExp(`['"]${key}['"]\\s*:\\s*(\\[[^\\]]*\\]|['"][^'"]+['"]|\\d+)`, 'g');
        let match: RegExpExecArray | null;
        while ((match = keyRegex.exec(content)) !== null) {
            const raw = match[1];
            const digits = raw.match(/\d{4,}/g);
            for (const digit of digits ?? []) {
                ids.add(digit);
            }
        }
    }

    // Free-form mentions like "task 1234567" / "task-id: 1234567" in the
    // description or comments.
    const mentionRegex = /task[-_ ]?(?:id)?\s*[:#]?\s*(\d{5,})/gi;
    let mention: RegExpExecArray | null;
    while ((mention = mentionRegex.exec(content)) !== null) {
        ids.add(mention[1]);
    }

    return Array.from(ids);
}

/**
 * Reads a module's manifest (depends + ticket ids), or undefined when the
 * module has no readable __manifest__.py.
 */
export async function readModuleManifest(modulePath: string): Promise<ModuleManifestInfo | undefined> {
    const manifestPath = path.join(modulePath, '__manifest__.py');

    let mtimeMs: number;
    try {
        mtimeMs = (await fs.stat(manifestPath)).mtimeMs;
    } catch {
        return undefined;
    }

    const cached = manifestCache.get(manifestPath);
    if (cached && cached.mtimeMs === mtimeMs) {
        return cached.info;
    }

    try {
        const content = await fs.readFile(manifestPath, 'utf-8');
        const info: ModuleManifestInfo = {
            depends: parseDepends(content),
            ticketIds: parseTicketIds(content)
        };
        manifestCache.set(manifestPath, { mtimeMs, info });
        return info;
    } catch (error) {
        logger.debug(`Failed to read manifest for ${modulePath}:`, error);
        return undefined;
    }
}

/**
 * Extracts ticket-id candidates from a branch name (PS convention:
 * "17.0-project-1234567-dev" carries the task id as a long digit run).
 */
/**
 * Finds the Odoo module a file belongs to by walking up the directory
 * tree until a folder containing __manifest__.py is found.
 */
export async function findModuleForFile(filePath: string): Promise<{ name: string; path: string } | undefined> {
    let dir = path.dirname(filePath);
    // Bounded walk so a weird path can never loop forever.
    for (let depth = 0; depth < 40; depth++) {
        try {
            await fs.access(path.join(dir, '__manifest__.py'));
            return { name: path.basename(dir), path: dir };
        } catch {
            // not a module root - keep walking up
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
    return undefined;
}

export function extractTicketIdsFromBranch(branchName: string | null | undefined): string[] {
    if (!branchName) {
        return [];
    }
    return Array.from(new Set(branchName.match(/\d{5,}/g) ?? []));
}
