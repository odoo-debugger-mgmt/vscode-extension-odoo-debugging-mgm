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

/**
 * The core models whose `_table` is not the model name with dots replaced (the same in Odoo 17 and 18).
 * Any other custom `_table`, such as a custom module's, is not known and reports no table.
 */
const CORE_TABLES: Record<string, string> = {
    'ir.actions.actions': 'ir_actions',
    'ir.actions.act_window': 'ir_act_window',
    'ir.actions.act_window.view': 'ir_act_window_view',
    'ir.actions.act_window_close': 'ir_actions',
    'ir.actions.act_url': 'ir_act_url',
    'ir.actions.server': 'ir_act_server',
    'ir.actions.report': 'ir_act_report_xml',
    'ir.actions.client': 'ir_act_client'
};

export function tableOf(model: string): string {
    return CORE_TABLES[model] ?? model.replace(/\./g, '_');
}

/** How many stored fields the model has, whatever its table is called. */
export function storedCountSql(model: string): string {
    return `SELECT count(*) FROM ir_model_fields WHERE model = ${sqlText(model)} AND store AND ttype NOT IN ('one2many', 'many2many');`;
}

/** `res_field|file_size|checksum` of the attachment-stored binaries of a record. */
export function attachmentsSql(model: string, id: number): string {
    if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error(`Not a record id: ${id}`);
    }
    return `SELECT res_field || '|' || coalesce(file_size, 0) || '|' || coalesce(checksum, '') FROM ir_attachment WHERE res_model = ${sqlText(model)} AND res_id = ${id} AND res_field IS NOT NULL ORDER BY res_field;`;
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

const LANGUAGE_KEY = /^[a-z]{2,3}(_[A-Za-z0-9@]+)?$/;

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
    } else if (typeof value === 'object' && !Array.isArray(value) && ['char', 'text', 'html'].includes(ttype)
        && Object.keys(value as object).length > 0 && Object.keys(value as object).every(key => LANGUAGE_KEY.test(key))) {
        // A translated field of Odoo 16 and later: jsonb keyed by language. (Company-dependent fields of
        // Odoo 18 are keyed by company id and fall through to the JSON below.)
        const map = value as Record<string, unknown>;
        const pick = 'en_US' in map ? map.en_US : map[Object.keys(map)[0]];
        shown = typeof pick === 'string' ? pick : stableJson(pick ?? false);
    } else {
        shown = typeof value === 'object' ? stableJson(value) : String(value);
    }
    if (/\r?\n/.test(shown) && ['char', 'text', 'html'].includes(ttype)) {
        // A long value (an arch, a body): an indented block, so the diff goes line by line.
        return '\n' + shown.replace(/\r?\n$/, '').split(/\r?\n/).map(line => `    ${line}`.trimEnd()).join('\n');
    }
    return shown.replace(/\r?\n/g, '\\n');
}

/** One `field: value` line per field, sorted by name; the note alone when the row is missing. */
export function renderRecord(
    fields: Array<{ name: string; ttype: string }>, row: Record<string, unknown> | undefined, missingNote: string,
    attachments: Array<{ name: string; size: number; checksum: string }> = []
): string {
    if (!row) {
        return `${missingNote}\n`;
    }
    const lines = [
        ...fields.filter(field => field.name in row).map(field => ({ name: field.name, text: renderValue(field.ttype, row[field.name]) })),
        ...attachments.map(a => ({ name: a.name, text: `${a.size} bytes, sha1 ${a.checksum.slice(0, 12)}` }))
    ];
    return lines.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(line => `${line.name}:${line.text.startsWith('\n') ? '' : ' '}${line.text}`)
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
    if (l && r) {
        // The model is missing on one side and the record on the other: nothing to compare.
        const noTable = l.code === 'no-table' ? leftLabel : rightLabel;
        const noRecord = l.code === 'no-table' ? rightLabel : leftLabel;
        return { message: `${what}: the model is not installed in ${noTable}, and the record does not exist in ${noRecord}.` };
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
        const stored = Number((await sql(dbName, storedCountSql(model))).trim()) || 0;
        return {
            error: stored > 0
                ? `${model} has stored fields in ${dbName}, but no table of the expected name (a custom _table?).`
                : `${model} has no table in ${dbName} (an abstract or transient model?).`,
            code: 'no-table'
        };
    }
    const raw = (await sql(dbName, rowSql(model, id, fields.map(f => f.name)))).trim();
    if (!raw) {
        return { error: `${model},${id} does not exist in ${dbName}.`, code: 'missing' };
    }
    const attachments = (await sql(dbName, attachmentsSql(model, id))).split('\n').filter(Boolean).map(line => {
        const [name, size, checksum] = line.split('|');
        return { name, size: Number(size) || 0, checksum: checksum ?? '' };
    });
    return { model, id, text: renderRecord(fields, JSON.parse(raw) as Record<string, unknown>, '', attachments) };
}
