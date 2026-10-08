/**
 * Compare one database record with the same record in the comparison partner.
 * Pure over a `sql` function, so a fake can stand in for psql. A model or an
 * external id from the user reaches SQL only through sqlText / quotePgIdentifier.
 */
import { createHash } from 'node:crypto';
import { quotePgIdentifier } from '../postgres';
import { sqlText } from '../views/viewQueries';

export type RecordRef =
    | { kind: 'xmlid'; module: string; name: string }
    | { kind: 'id'; model: string; id: number };

const MODEL = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const XMLID = /^([A-Za-z0-9_]+)\.([A-Za-z0-9_.\-]+)$/;

/** `module.name`, `model,id`, `model id` or `model(id)`; undefined for anything else. */
export function parseRecordRef(input: string): RecordRef | undefined {
    const text = input.trim();
    const byId = /^([a-z][a-z0-9_.]*)\s*(?:,\s*|\s+|\()(\d+)\)?$/.exec(text);
    if (byId && MODEL.test(byId[1]) && (!text.includes('(') || text.endsWith(')'))) {
        const id = Number(byId[2]);
        return Number.isSafeInteger(id) && id > 0 ? { kind: 'id', model: byId[1], id } : undefined;
    }
    const xml = XMLID.exec(text);
    return xml ? { kind: 'xmlid', module: xml[1], name: xml[2] } : undefined;
}

export function tableOf(model: string): string {
    return model.replace(/\./g, '_');
}

/** `model|res_id` of an external id; no row when it does not exist. */
export function xmlidSql(ref: Extract<RecordRef, { kind: 'xmlid' }>): string {
    return `SELECT model || '|' || res_id FROM ir_model_data WHERE module = ${sqlText(ref.module)} AND name = ${sqlText(ref.name)} LIMIT 1;`;
}

/** `name|ttype` of the stored fields that are also real columns of the model's table. */
export function fieldsSql(model: string): string {
    return `SELECT f.name || '|' || f.ttype FROM ir_model_fields f JOIN information_schema.columns c ON c.table_name = ${sqlText(tableOf(model))} AND c.column_name = f.name AND c.table_schema = current_schema() WHERE f.model = ${sqlText(model)} AND f.store ORDER BY f.name;`;
}

export function rowSql(model: string, id: number, columns: string[]): string {
    if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error(`Not a record id: ${id}`);
    }
    return `SELECT row_to_json(t) FROM (SELECT ${columns.map(quotePgIdentifier).join(', ')} FROM ${quotePgIdentifier(tableOf(model))} WHERE id = ${id}) t;`;
}

function binaryBytes(value: string): Buffer {
    if (/^\\x([0-9a-fA-F]{2})*$/.test(value)) {
        return Buffer.from(value.slice(2), 'hex');
    }
    if (/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(value) && value.length % 4 === 0) {
        return Buffer.from(value, 'base64');
    }
    return Buffer.from(value, 'utf8');
}

function renderValue(ttype: string, value: unknown): string {
    if (value === null || value === undefined) {
        return 'False';
    }
    if (typeof value === 'boolean') {
        return value ? 'True' : 'False';
    }
    if (ttype === 'binary' && typeof value === 'string') {
        const bytes = binaryBytes(value);
        return `${bytes.length} bytes, sha1 ${createHash('sha1').update(bytes).digest('hex').slice(0, 12)}`;
    }
    let shown: string;
    if (typeof value === 'string') {
        shown = value;
    } else if (typeof value === 'object' && !Array.isArray(value) && ['char', 'text', 'html'].includes(ttype)) {
        // A translated field of Odoo 16 and later: jsonb keyed by language.
        const map = value as Record<string, unknown>;
        const pick = 'en_US' in map ? map.en_US : map[Object.keys(map)[0]];
        shown = typeof pick === 'string' ? pick : stableJson(pick ?? false);
    } else {
        shown = typeof value === 'object' ? stableJson(value) : String(value);
    }
    return shown.replace(/\r?\n/g, '\\n');
}

/** One `field: value` line per field, sorted by name; the note alone when the row is missing. */
export function renderRecord(fields: Array<{ name: string; ttype: string }>, row: Record<string, unknown> | undefined, missingNote: string): string {
    if (!row) {
        return `${missingNote}\n`;
    }
    return [...fields].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .filter(field => field.name in row)
        .map(field => `${field.name}: ${renderValue(field.ttype, row[field.name])}`)
        .join('\n') + '\n';
}

export type RecordRead = { model: string; id: number; text: string } | { error: string; code: 'missing' | 'no-table' };

/** JSON with sorted keys at every level, so equal values print equal. */
function stableJson(value: unknown): string {
    const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
        : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort((v as Record<string, unknown>)[k])]))
        : v;
    return JSON.stringify(sort(value));
}

/**
 * What to show for the two reads: a message and nothing to open, or the two texts.
 * A side without the table of a model the other has renders "(model not installed in <db>)";
 * a side without the record renders "(no such record in <db>)".
 */
export function planSides(
    left: RecordRead, right: RecordRead, leftLabel: string, rightLabel: string, what: string
): { message: string } | { left: string; right: string } {
    const err = (r: RecordRead) => 'error' in r ? r : undefined;
    const [l, r] = [err(left), err(right)];
    const hard = [l, r].find(e => e && e.code !== 'missing' && e.code !== 'no-table');
    if (hard) {
        return { message: hard.error };
    }
    if (l?.code === 'missing' && r?.code === 'missing') {
        return { message: `${what} does not exist in ${leftLabel} or in ${rightLabel}.` };
    }
    if (l?.code === 'no-table' && r?.code === 'no-table') {
        return { message: l.error };
    }
    const show = (read: RecordRead, label: string) => 'error' in read
        ? renderRecord([], undefined, read.code === 'no-table' ? `(model not installed in ${label})` : `(no such record in ${label})`)
        : read.text;
    return { left: show(left, leftLabel), right: show(right, rightLabel) };
}

export async function readRecord(
    dbName: string,
    ref: RecordRef,
    sql: (db: string, s: string) => Promise<string>
): Promise<RecordRead> {
    let model: string;
    let id: number;
    if (ref.kind === 'xmlid') {
        const found = (await sql(dbName, xmlidSql(ref))).trim();
        const match = /^([a-z][a-z0-9_.]*)\|(\d+)$/.exec(found);
        if (!match || !MODEL.test(match[1])) {
            return { error: `${ref.module}.${ref.name} does not exist in ${dbName}.`, code: 'missing' };
        }
        model = match[1];
        id = Number(match[2]);
    } else {
        ({ model, id } = ref);
    }
    const fields = (await sql(dbName, fieldsSql(model))).split('\n').filter(Boolean).map(line => {
        const cut = line.lastIndexOf('|');
        return { name: line.slice(0, cut), ttype: line.slice(cut + 1) };
    });
    if (fields.length === 0) {
        return { error: `${model} has no table in ${dbName} (an abstract or transient model?).`, code: 'no-table' };
    }
    const raw = (await sql(dbName, rowSql(model, id, fields.map(f => f.name)))).trim();
    if (!raw) {
        return { error: `${model},${id} does not exist in ${dbName}.`, code: 'missing' };
    }
    return { model, id, text: renderRecord(fields, JSON.parse(raw) as Record<string, unknown>, '') };
}
