/**
 * Read-only SQL for the View Doctor, through psql. Every query returns one
 * JSON value (json_agg / json_object_agg): view names and Discuss bodies are
 * free text with tabs and newlines, which the `|`-separated readers in
 * database.ts would split. Ported from odoo-manager's docker_manager.py
 * (list_disabled_views, _first_xmlid, the Discuss report query). Ids are
 * validated integers and text goes in hex-encoded (sqlText); nothing else is
 * ever interpolated.
 */
import { runSql } from '../postgres';
import type { Fingerprint } from './viewNotes';

export interface ViewRow {
    id: number;
    name: string;
    model: string;
    type: string;
    active: boolean;
    inheritId: number | null;
    /** The view's first external id, the one Odoo shows; null when it has none. */
    xmlid: string | null;
    /** The view at the top of its inherit_id chain (itself when it inherits nothing). */
    rootId: number;
    /** Whether the root is the template of an ir.actions.report. */
    isReport: boolean;
    /** write_date in epoch milliseconds; 0 when unset. */
    writeDate: number;
}

export interface ReportMessage {
    id: number;
    body: string;
}

/** Ids for embedding in SQL; throws on anything that is not a positive integer. */
export function sqlIdList(ids: number[]): string {
    for (const id of ids) {
        if (!Number.isSafeInteger(id) || id <= 0) {
            throw new Error(`Not a view id: ${id}`);
        }
    }
    return ids.join(',');
}

/**
 * Text for embedding in SQL. Hex digits cannot close a literal, so no value
 * - a model, a view name, an external id - can change the query.
 */
export function sqlText(value: string): string {
    return `convert_from(decode('${Buffer.from(value, 'utf-8').toString('hex')}', 'hex'), 'UTF8')`;
}

/**
 * A column of the view `v`'s first external id. ir.ui.view.xml_id is
 * computed, with no column: Odoo takes the first ir_model_data row in that
 * model's order (module, name). Every query that names or classifies a view
 * by its external id goes through this, so a view with several is the same
 * view everywhere.
 */
export function firstXmlidSql(column: string): string {
    return `(SELECT ${column} FROM ir_model_data d WHERE d.model = 'ir.ui.view' AND d.res_id = v.id ORDER BY d.module, d.name LIMIT 1)`;
}

/**
 * The view rows matching `where`, an expression over ir_ui_view aliased `v`.
 * The root comes from a walk up inherit_id bounded at 50 steps, so a corrupt
 * cycle cannot hang the query. A root counts as a report when any of its
 * external ids is an ir.actions.report's report_name.
 */
export function viewRowsSql(where: string): string {
    return `
WITH RECURSIVE chain AS (
    SELECT v.id AS start_id, v.id AS cur_id, v.inherit_id, 0 AS depth
    FROM ir_ui_view v WHERE ${where}
    UNION ALL
    SELECT c.start_id, p.id, p.inherit_id, c.depth + 1
    FROM chain c JOIN ir_ui_view p ON p.id = c.inherit_id
    WHERE c.depth < 50
), roots AS (
    SELECT DISTINCT ON (start_id) start_id, cur_id AS root_id
    FROM chain ORDER BY start_id, depth DESC
)
SELECT coalesce(json_agg(json_build_object(
    'id', v.id,
    'name', coalesce(v.name, v.type),
    'model', coalesce(v.model, ''),
    'type', v.type,
    'active', v.active,
    'inherit_id', v.inherit_id,
    'xmlid', ${firstXmlidSql("d.module || '.' || d.name")},
    'root_id', r.root_id,
    'is_report', EXISTS (
        SELECT 1 FROM ir_model_data rd
        JOIN ir_act_report_xml a ON a.report_name = rd.module || '.' || rd.name
        WHERE rd.model = 'ir.ui.view' AND rd.res_id = r.root_id),
    'write_date', floor(extract(epoch FROM v.write_date) * 1000)
) ORDER BY v.model, v.id), '[]'::json)
FROM ir_ui_view v JOIN roots r ON r.start_id = v.id;`.trim();
}

const REPORT_MESSAGES_SQL = `
SELECT coalesce(json_agg(json_build_object('id', id, 'date', create_date, 'body', body) ORDER BY id), '[]'::json)
FROM mail_message
WHERE model IN ('discuss.channel', 'mail.channel') AND body LIKE '%Disabled views%';`.trim();

function parseJson(output: string, fallback: string): unknown {
    return JSON.parse(output.trim() || fallback);
}

export function parseViewRows(output: string): ViewRow[] {
    const raw = parseJson(output, '[]');
    if (!Array.isArray(raw)) {
        throw new Error('Unexpected output from the view query.');
    }
    return raw.map(entry => {
        const row = entry as Record<string, unknown>;
        const id = Number(row.id);
        return {
            id,
            name: String(row.name ?? ''),
            model: String(row.model ?? ''),
            type: String(row.type ?? ''),
            active: row.active === true,
            inheritId: typeof row.inherit_id === 'number' ? row.inherit_id : null,
            xmlid: typeof row.xmlid === 'string' ? row.xmlid : null,
            rootId: typeof row.root_id === 'number' ? row.root_id : id,
            isReport: row.is_report === true,
            writeDate: typeof row.write_date === 'number' ? row.write_date : 0
        };
    });
}

export function parseReportMessages(output: string): ReportMessage[] {
    const raw = parseJson(output, '[]');
    if (!Array.isArray(raw)) {
        throw new Error('Unexpected output from the report query.');
    }
    return raw.map(entry => {
        const message = entry as Record<string, unknown>;
        return { id: Number(message.id), body: String(message.body ?? '') };
    });
}

export function parseWriteDates(output: string): Map<number, number> {
    const raw = parseJson(output, '{}') as Record<string, unknown>;
    return new Map(Object.entries(raw).map(([id, ms]) => [Number(id), typeof ms === 'number' ? ms : 0]));
}

/** Every view that is off right now, whatever turned it off. */
export async function listInactiveViews(dbName: string): Promise<ViewRow[]> {
    return parseViewRows(await runSql(dbName, viewRowsSql('v.active = false')));
}

/** The rows for these ids; an id with no view is absent. */
export async function getViewRows(dbName: string, ids: number[]): Promise<ViewRow[]> {
    if (ids.length === 0) {
        return [];
    }
    return parseViewRows(await runSql(dbName, viewRowsSql(`v.id IN (${sqlIdList(ids)})`)));
}

/** upgrade-util's post-upgrade report messages; none on a database without Discuss. */
export async function getReportMessages(dbName: string): Promise<ReportMessage[]> {
    const hasTable = await runSql(dbName, "SELECT to_regclass('mail_message') IS NOT NULL;");
    if (hasTable !== 't') {
        return [];
    }
    return parseReportMessages(await runSql(dbName, REPORT_MESSAGES_SQL));
}

/** write_date of each view in epoch ms; an id with no view is absent. */
export async function getWriteDates(dbName: string, ids: number[]): Promise<Map<number, number>> {
    if (ids.length === 0) {
        return new Map();
    }
    const sql = 'SELECT coalesce(json_object_agg(id, floor(extract(epoch FROM write_date) * 1000)), \'{}\'::json) '
        + `FROM ir_ui_view WHERE id IN (${sqlIdList(ids)});`;
    return parseWriteDates(await runSql(dbName, sql));
}

/** The query for the view with this external id; undefined for a string that is not module.name. */
export function viewByXmlidSql(xmlid: string): string | undefined {
    const dot = xmlid.indexOf('.');
    if (dot <= 0 || dot === xmlid.length - 1) {
        return undefined;
    }
    return viewRowsSql(`v.id IN (SELECT d.res_id FROM ir_model_data d WHERE d.model = 'ir.ui.view'
        AND d.module = ${sqlText(xmlid.slice(0, dot))} AND d.name = ${sqlText(xmlid.slice(dot + 1))})`);
}

/** The view with this external id, if the database has one. */
export async function findViewByXmlid(dbName: string, xmlid: string): Promise<ViewRow | undefined> {
    const sql = viewByXmlidSql(xmlid);
    return sql ? parseViewRows(await runSql(dbName, sql))[0] : undefined;
}

/** The query for the view with this id and every view of the same model and type. */
export function viewsLikeSql(view: Pick<ViewRow, 'id' | 'model' | 'type'>): string {
    // 18.0 renamed the list type from 'tree': an upgraded list view is 'list', its original 'tree'.
    const type = view.type === 'tree' || view.type === 'list'
        ? `v.type IN (${sqlText('tree')}, ${sqlText('list')})`
        : `v.type = ${sqlText(view.type)}`;
    return viewRowsSql(`(v.id = ${sqlIdList([view.id])} OR (v.model = ${sqlText(view.model)} AND ${type}))`);
}

/** What matching a view of another database picks from: the same id, and its model and type's views. */
export async function findViewsLike(dbName: string, view: Pick<ViewRow, 'id' | 'model' | 'type'>): Promise<ViewRow[]> {
    return parseViewRows(await runSql(dbName, viewsLikeSql(view)));
}

/**
 * What tells whether views' arches were edited, for many at once (port of
 * odoo-manager's get_view_fingerprints). arch_md5 hashes the raw arch_db as
 * text, so one query covers the text column of 15 and the per-language jsonb
 * of 16+. written is write_date: any ORM write moves it, turning a view on
 * included, so it only ever proves a view untouched. arch_updated flips only
 * when the arch itself is written. module/noupdate tell a module's own view
 * from one that lives only in the database.
 */
export function fingerprintsSql(ids: number[]): string {
    const unique = [...new Set(ids)].sort((a, b) => a - b);
    return `SELECT coalesce(json_object_agg(v.id, json_build_object(
    'arch_md5', md5(v.arch_db::text),
    'written', floor(extract(epoch FROM v.write_date) * 1000),
    'arch_updated', v.arch_updated,
    'module', ${firstXmlidSql('d.module')},
    'noupdate', ${firstXmlidSql('d.noupdate')}
)), '{}'::json)
FROM ir_ui_view v WHERE v.id IN (${sqlIdList(unique)});`;
}

export function parseFingerprints(output: string): Map<number, Fingerprint> {
    const raw = parseJson(output, '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Unexpected output from the fingerprint query.');
    }
    return new Map(Object.entries(raw as Record<string, Record<string, unknown>>).map(([id, fp]) => [Number(id), {
        archMd5: typeof fp?.arch_md5 === 'string' ? fp.arch_md5 : null,
        written: typeof fp?.written === 'number' ? fp.written : null,
        archUpdated: typeof fp?.arch_updated === 'boolean' ? fp.arch_updated : null,
        module: typeof fp?.module === 'string' ? fp.module : null,
        noupdate: typeof fp?.noupdate === 'boolean' ? fp.noupdate : null
    }]));
}

/** Fingerprints of these views; an id with no view is absent. Throws when they cannot be read. */
export async function getViewFingerprints(dbName: string, ids: number[]): Promise<Map<number, Fingerprint>> {
    if (ids.length === 0) {
        return new Map();
    }
    return parseFingerprints(await runSql(dbName, fingerprintsSql(ids)));
}

/** The database's database.uuid, which a database recreated under the same name does not share. */
export async function getDatabaseUuid(dbName: string): Promise<string | undefined> {
    const raw = parseJson(await runSql(dbName,
        "SELECT coalesce(json_agg(value), '[]'::json) FROM ir_config_parameter WHERE key = 'database.uuid';"), '[]');
    return Array.isArray(raw) && typeof raw[0] === 'string' && raw[0] ? raw[0] : undefined;
}
