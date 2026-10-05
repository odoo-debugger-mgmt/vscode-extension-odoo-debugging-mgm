/**
 * Which views an upgrade script covers, and with or without their arch.
 * Create Upgrade Script covers every view in the note or its journal that is
 * on now; Add to Upgrade Script one view. Still-off and deleted views are
 * left out and counted. Whether an arch is needed is unchangedReason's call,
 * on live fingerprints; arches are read only for the views that need one.
 */
import type { ScriptView } from './upgradeScript';
import type { ViewRow } from './viewQueries';
import { unchangedReason, type Fingerprint, type UnchangedReason, type ViewNote } from './viewNotes';

export interface ScriptCandidate {
    row: ViewRow;
    listedIn: string[];
    why: UnchangedReason | null;
}

export interface ScriptSelection {
    include: ScriptCandidate[];
    stillDisabled: ViewRow[];
    deleted: number[];
}

export interface ScriptSources {
    /** The database's note, up to date, and the views its upgrade report lists that are on now. */
    prepare(dbName: string): Promise<{ note: ViewNote; reEnabled: ViewRow[] }>;
    rows(dbName: string, ids: number[]): Promise<ViewRow[]>;
    fingerprints(dbName: string, ids: number[]): Promise<Map<number, Fingerprint> | undefined>;
    arch(dbName: string, viewId: number): Promise<string>;
}

export interface ScriptBuild {
    views: ScriptView[];
    stillDisabled: ViewRow[];
    deleted: number[];
    noArch: ViewRow[];
    /** Re-enabled views the report lists that the note never saw off. */
    notNoted: ViewRow[];
}

/** Every view the note knows: noted first, then the journal's. */
export function scriptIds(note: ViewNote): number[] {
    return [...new Set([...note.views.map(view => view.id), ...note.journal.map(entry => entry.id)])];
}

export function selectForScript(note: ViewNote, ids: number[], rows: Map<number, ViewRow>, fingerprints: Map<number, Fingerprint> | undefined): ScriptSelection {
    const noted = new Map(note.views.map(view => [view.id, view]));
    const selection: ScriptSelection = { include: [], stillDisabled: [], deleted: [] };
    for (const id of ids) {
        const row = rows.get(id);
        if (!row) {
            selection.deleted.push(id);
        } else if (!row.active) {
            selection.stillDisabled.push(row);
        } else {
            const entry = noted.get(id);
            selection.include.push({ row, listedIn: entry?.listedIn ?? [], why: unchangedReason(entry, fingerprints?.get(id)) });
        }
    }
    selection.include.sort((a, b) => a.row.model.localeCompare(b.row.model) || a.row.id - b.row.id);
    return selection;
}

/** The views for a script of `dbName`: all the note covers, or the one view `viewId`. */
export async function buildScriptViews(sources: ScriptSources, dbName: string, viewId?: number): Promise<ScriptBuild> {
    const { note, reEnabled } = await sources.prepare(dbName);
    const ids = viewId === undefined ? scriptIds(note) : [viewId];
    const rows = new Map((ids.length > 0 ? await sources.rows(dbName, ids) : []).map(view => [view.id, view]));
    const activeIds = ids.filter(id => rows.get(id)?.active);
    const fingerprints = activeIds.length > 0 ? await sources.fingerprints(dbName, activeIds) : new Map<number, Fingerprint>();
    const selection = selectForScript(note, ids, rows, fingerprints);
    const views: ScriptView[] = [];
    const noArch: ViewRow[] = [];
    for (const { row, listedIn, why } of selection.include) {
        let arch: string | null = null;
        if (why === null) {
            arch = await sources.arch(dbName, row.id);
            if (!arch.trim()) {
                noArch.push(row);
                continue;
            }
        }
        views.push({ id: row.id, xmlid: row.xmlid, model: row.model, type: row.type, name: row.name, listedIn, dbName, arch, why });
    }
    const covered = new Set(ids);
    const notNoted = viewId === undefined ? reEnabled.filter(view => !covered.has(view.id)) : [];
    return { views, stillDisabled: selection.stillDisabled, deleted: selection.deleted, noArch, notNoted };
}

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function leftOutText(build: ScriptBuild): string {
    const parts: string[] = [];
    if (build.stillDisabled.length > 0) {
        parts.push(`${build.stillDisabled.length} still off`);
    }
    if (build.deleted.length > 0) {
        parts.push(`${build.deleted.length} deleted`);
    }
    if (build.noArch.length > 0) {
        parts.push(`${build.noArch.length} with no arch`);
    }
    if (build.notNoted.length > 0) {
        const count = build.notNoted.length;
        parts.push(`${plural(count, 're-enabled view')} fixed before the note was taken (use Add to Upgrade Script on ${count === 1 ? 'it' : 'each'})`);
    }
    return parts.length > 0 ? `Left out: ${parts.join(', ')}.` : '';
}

export function scriptSummary(build: ScriptBuild, where: string): string {
    const only = build.views.filter(view => view.arch === null).length;
    return [`${where}: ${plural(build.views.length, 'view')}${only > 0 ? `, ${only} only re-enabled` : ''}.`, leftOutText(build)].filter(Boolean).join(' ');
}

export function nothingToScript(build: ScriptBuild, dbName: string): string {
    return [`Nothing to script in ${dbName} yet: no fixed or edited view is on.`, leftOutText(build)].filter(Boolean).join(' ');
}
