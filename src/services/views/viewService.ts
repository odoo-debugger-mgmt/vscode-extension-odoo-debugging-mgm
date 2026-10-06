/**
 * Everything the View Doctor's UI asks of a database: listings over psql,
 * arches and writes through the database's Odoo shell.
 */
import type { ViewWorkerPool } from './viewWorkerPool';
import { getReportMessages, getViewRows, getWriteDates, inactiveViewIds, listInactiveViews, type ViewRow } from './viewQueries';
import { mergeReports, parseDisabledViews } from './disabledReport';
import type { ViewNoteService } from './viewNoteService';
import { logger } from '../logger';
import { groupViews, type ViewGroups } from './viewGroups';
import { parseXpathReport, type XpathReport } from './xpathReport';

export interface SaveResult {
    active: boolean;
    /** The save turned the view on. */
    activated: boolean;
    /** The view was off and stays off: Odoo's reason. The arch is saved regardless. */
    activationError: string | null;
    /** The view has a parent, so it has locators to check. */
    inheriting?: boolean;
}

/** A window action that opens a view's root, made by the database's shell. */
export interface RenderAction {
    actionId: number;
    model: string;
    /** The root's view type, or the list type for a search view. */
    viewType: string;
    rootId: number;
    /** odoo.release.serie of the database's code, e.g. "17.0" or "saas~17.2". */
    series: string;
}

/** The report a QWeb template renders, as its database's shell found it. */
export interface ReportTarget {
    /** What /report/html/<report_name>/<id> takes. */
    reportName: string;
    /** The report's name, for the frame header. */
    name: string;
    model: string;
    /** Narrows the records to render it with (account.move: no plain journal entries). */
    domain: unknown[];
    series: string;
    /** ir.actions.report's report_type: qweb-pdf, qweb-html or qweb-text. Only the first two make a PDF. */
    reportType: string;
}

/** What the arch file system needs; ViewService is the real one. */
export interface ViewBackend {
    /** write_date in epoch ms, or undefined when the view is gone. */
    writeDate(dbName: string, viewId: number): Promise<number | undefined>;
    getArch(dbName: string, viewId: number): Promise<string>;
    save(dbName: string, viewId: number, arch: string): Promise<SaveResult>;
}

/**
 * Which views the original database has off; undefined when there is no
 * original to ask, or it cannot be read - the tree then shows everything.
 */
export async function originalInactiveIds(
    read: (dbName: string) => Promise<number[]>,
    dbName: string,
    originalDb?: string
): Promise<Set<number> | undefined> {
    if (!originalDb || originalDb === dbName) {
        return undefined;
    }
    try {
        return new Set(await read(originalDb));
    } catch (error) {
        logger.warn(`Could not read which views are off in ${originalDb}; showing every inactive view:`, error);
        return undefined;
    }
}

export class ViewService implements ViewBackend {
    constructor(private readonly pool: ViewWorkerPool, private readonly notes?: ViewNoteService) {}

    async writeDate(dbName: string, viewId: number): Promise<number | undefined> {
        return (await getWriteDates(dbName, [viewId])).get(viewId);
    }

    async getArch(dbName: string, viewId: number): Promise<string> {
        return (await this.pool.run<{ arch: string }>(dbName, 'get_arch', { view_id: viewId })).arch;
    }

    save(dbName: string, viewId: number, arch: string): Promise<SaveResult> {
        return this.pool.run<SaveResult>(dbName, 'save', { view_id: viewId, arch, activate: true });
    }

    async activate(dbName: string, viewId: number): Promise<void> {
        await this.pool.run(dbName, 'activate', { view_id: viewId });
    }

    async deactivate(dbName: string, viewId: number): Promise<void> {
        await this.pool.run(dbName, 'deactivate', { view_id: viewId });
    }

    /** Checks `arch` - the editor's text, not the stored arch - against the parent's combined arch. */
    async checkXpaths(dbName: string, viewId: number, arch: string): Promise<XpathReport> {
        return parseXpathReport(await this.pool.run<unknown>(dbName, 'check_xpaths', { view_id: viewId, arch }));
    }

    /** An admin session id the database's running server accepts. */
    async newSession(dbName: string): Promise<string> {
        return (await this.pool.run<{ sid: string }>(dbName, 'new_session')).sid;
    }

    async makeAction(dbName: string, viewId: number): Promise<RenderAction> {
        const raw = await this.pool.run<{ action_id: number; model: string; view_type: string; root_id: number; series: string }>(
            dbName, 'make_action', { view_id: viewId });
        return { actionId: raw.action_id, model: raw.model, viewType: raw.view_type, rootId: raw.root_id, series: raw.series };
    }

    /** The newest ids of a model the render user can open, newest first. */
    async recentIds(dbName: string, model: string, limit = 200, domain: unknown[] = []): Promise<number[]> {
        return (await this.pool.run<{ ids: number[] }>(dbName, 'recent_ids', { model, limit, domain })).ids;
    }

    /** The report a QWeb view's template renders; null when no report uses it. */
    async reportTarget(dbName: string, viewId: number): Promise<ReportTarget | null> {
        const raw = await this.pool.run<{ report_name: string; name: string; model: string; domain?: unknown[]; series: string; report_type?: string } | null>(
            dbName, 'report_target', { view_id: viewId });
        return raw ? {
            reportName: raw.report_name, name: raw.name, model: raw.model, domain: raw.domain ?? [], series: raw.series,
            reportType: raw.report_type ?? 'qweb-pdf'
        } : null;
    }

    rows(dbName: string, ids: number[]): Promise<ViewRow[]> {
        return getViewRows(dbName, ids);
    }

    /**
     * The tree's content: psql only, so it shows without waiting for a shell.
     * Keeps the note up to date on the way. With the upgrade's original
     * database, the other inactive views it has off too are set apart.
     */
    async doctorGroups(dbName: string, originalDb?: string): Promise<ViewGroups> {
        const [inactive, messages, alsoOff] = await Promise.all([
            listInactiveViews(dbName), getReportMessages(dbName), originalInactiveIds(inactiveViewIds, dbName, originalDb)
        ]);
        const reported = mergeReports(messages.map(message => parseDisabledViews(message.body)));
        const inactiveIds = new Set(inactive.map(view => view.id));
        const reEnabled = await getViewRows(dbName, [...reported.keys()].filter(id => !inactiveIds.has(id)));
        let edited: ViewRow[] = [];
        if (this.notes) {
            try {
                const rows = new Map([...inactive, ...reEnabled].map(view => [view.id, view]));
                const note = await this.notes.observe(dbName, reported, rows);
                edited = await getViewRows(dbName, note.journal.map(entry => entry.id));
            } catch (error) {
                logger.warn(`Could not update the view note of ${dbName}:`, error);
            }
        }
        return groupViews(inactive, reported, reEnabled, edited, alsoOff);
    }
}
