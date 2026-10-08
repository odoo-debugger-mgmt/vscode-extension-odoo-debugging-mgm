/**
 * Database checkpoints: protected PostgreSQL copies of a database, listed
 * under it, restored by swapping them in. This module is the pure part: the
 * stored record, names, labels and the SQL text of the read-only queries.
 */
import * as crypto from 'node:crypto';
import { sqlText } from './views/viewQueries';

export interface CheckpointModel {
    /** The PostgreSQL database holding it. Named `id` so the store merges records by it. */
    id: string;
    label: string;
    createdAt: string;
    /** False when the source had no filestore folder. */
    filestore: boolean;
}

const MAX_IDENTIFIER_BYTES = 63;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The checkpoints of a database read from the store. Projects there are
 * plain JSON, so the field may be missing or malformed on any of them.
 */
export function checkpointsOf(db: { checkpoints?: unknown }): CheckpointModel[] {
    if (!Array.isArray(db.checkpoints)) {
        return [];
    }
    const list: CheckpointModel[] = [];
    for (const entry of db.checkpoints as unknown[]) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const raw = entry as Partial<Record<keyof CheckpointModel, unknown>>;
        if (typeof raw.id !== 'string' || raw.id.trim() === '') {
            continue;
        }
        const id = raw.id.trim();
        list.push({
            id,
            label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : id,
            createdAt: typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))
                ? raw.createdAt
                : new Date().toISOString(),
            filestore: raw.filestore === true
        });
    }
    return list;
}

export function setCheckpoints(db: { checkpoints?: unknown }, list: CheckpointModel[]): void {
    db.checkpoints = list.map(entry => ({ ...entry }));
}

function cutToBytes(value: string, maxBytes: number): string {
    let out = '';
    for (const char of value) {
        if (Buffer.byteLength(out + char, 'utf8') > maxBytes) {
            break;
        }
        out += char;
    }
    return out;
}

/**
 * `base + suffix`, kept within PostgreSQL's 63 bytes. PostgreSQL would
 * truncate a longer name silently, and two of them could then be one; so the
 * base is cut instead and a hash of the full name keeps them apart.
 */
export function derivedDbName(base: string, suffix: string): string {
    const full = `${base}${suffix}`;
    if (Buffer.byteLength(full, 'utf8') <= MAX_IDENTIFIER_BYTES) {
        return full;
    }
    const hash = crypto.createHash('sha1').update(full).digest('hex').slice(0, 6);
    const tail = `_${hash}${suffix}`;
    const head = cutToBytes(base, MAX_IDENTIFIER_BYTES - Buffer.byteLength(tail, 'utf8')).replace(/_+$/, '');
    return `${head || 'db'}${tail}`;
}

/** `<db>__cp_<base36 epoch seconds>`, moved on a second when taken. */
export function checkpointDbName(db: string, now: Date, taken: Set<string>): string {
    let seconds = Math.floor(now.getTime() / 1000);
    for (;;) {
        const name = derivedDbName(db, `__cp_${seconds.toString(36)}`);
        if (!taken.has(name.toLowerCase())) {
            return name;
        }
        seconds++;
    }
}

export function defaultCheckpointLabel(now: Date): string {
    const pad = (n: number) => `${n}`.padStart(2, '0');
    return `${now.getDate()} ${MONTHS[now.getMonth()]} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function formatAge(createdAt: string, now: Date): string {
    const then = Date.parse(createdAt);
    if (Number.isNaN(then)) {
        return '';
    }
    const minutes = Math.floor((now.getTime() - then) / 60000);
    if (minutes < 1) {
        return 'just now';
    }
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} h ago`;
    }
    return `${Math.floor(hours / 24)} d ago`;
}

export function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    const shown = unit === 0 || value >= 10 ? Math.round(value).toString() : (Math.floor(value * 10) / 10).toString();
    return `${shown} ${units[unit]}`;
}

/**
 * One query for every checkpoint's size. pg_database_size reads the files;
 * it never connects to the checkpoint, which refuses connections.
 */
export function checkpointSizeSql(names: string[]): string {
    const list = names.map(sqlText).join(', ');
    return `SELECT datname, pg_database_size(oid) FROM pg_database WHERE datname IN (${list});`;
}

/** `name|bytes` lines, as `runSql` prints them. */
export function parseSizes(output: string): Map<string, number> {
    const sizes = new Map<string, number>();
    for (const line of output.split('\n')) {
        const cut = line.lastIndexOf('|');
        if (cut <= 0) {
            continue;
        }
        const value = Number(line.slice(cut + 1).trim());
        if (Number.isFinite(value)) {
            sizes.set(line.slice(0, cut).trim(), value);
        }
    }
    return sizes;
}

export const CHECKPOINT_COMMENT_PREFIX = 'odoo-devtools checkpoint of ';

export function checkpointComment(source: string): string {
    return `${CHECKPOINT_COMMENT_PREFIX}${source}`;
}

/** Every protected database with its comment; checkpoints are among them. */
export const CHECKPOINT_COMMENTS_SQL =
    "SELECT datname, coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datistemplate;";

export function parseCheckpointComments(output: string): Array<{ name: string; source: string }> {
    const rows: Array<{ name: string; source: string }> = [];
    for (const line of output.split('\n')) {
        const cut = line.indexOf('|');
        if (cut <= 0) {
            continue;
        }
        const comment = line.slice(cut + 1);
        if (comment.startsWith(CHECKPOINT_COMMENT_PREFIX)) {
            rows.push({ name: line.slice(0, cut), source: comment.slice(CHECKPOINT_COMMENT_PREFIX.length) });
        }
    }
    return rows;
}

/** Checkpoints whose source database is gone and that nothing here records. */
export function findOrphanCheckpoints(
    rows: Array<{ name: string; source: string }>,
    existing: Set<string>,
    recorded: Set<string>
): Array<{ name: string; source: string }> {
    return rows.filter(row => !existing.has(row.source.toLowerCase()) && !recorded.has(row.name.toLowerCase()));
}
