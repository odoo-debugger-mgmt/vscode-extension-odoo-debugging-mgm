/**
 * Read-only SQL for the View Doctor, through psql. Every query returns one
 * JSON value (json_agg / json_object_agg): view names and Discuss bodies are
 * free text with tabs and newlines, which the `|`-separated readers in
 * database.ts would split. Ported from odoo-manager's docker_manager.py
 * (list_disabled_views, _first_xmlid, the Discuss report query). Ids are
 * validated integers; nothing else is ever interpolated.
 */
import { runSql } from '../postgres';

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
    'xmlid', (SELECT d.module || '.' || d.name FROM ir_model_data d
              WHERE d.model = 'ir.ui.view' AND d.res_id = v.id
              ORDER BY d.module, d.name LIMIT 1),
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
