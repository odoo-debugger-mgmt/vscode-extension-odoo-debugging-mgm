/**
 * Everything the View Doctor's UI asks of a database: listings over psql,
 * arches and writes through the database's Odoo shell.
 */
import type { ViewWorkerPool } from './viewWorkerPool';
import { getReportMessages, getViewRows, getWriteDates, listInactiveViews, type ViewRow } from './viewQueries';
import { mergeReports, parseDisabledViews } from './disabledReport';
import { groupViews, type ViewGroups } from './viewGroups';

export interface SaveResult {
    active: boolean;
    /** The save turned the view on. */
    activated: boolean;
    /** The view was off and stays off: Odoo's reason. The arch is saved regardless. */
    activationError: string | null;
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

/** What the arch file system needs; ViewService is the real one. */
export interface ViewBackend {
    /** write_date in epoch ms, or undefined when the view is gone. */
    writeDate(dbName: string, viewId: number): Promise<number | undefined>;
    getArch(dbName: string, viewId: number): Promise<string>;
    save(dbName: string, viewId: number, arch: string): Promise<SaveResult>;
}

export class ViewService implements ViewBackend {
    constructor(private readonly pool: ViewWorkerPool) {}

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
    async recentIds(dbName: string, model: string, limit = 200): Promise<number[]> {
        return (await this.pool.run<{ ids: number[] }>(dbName, 'recent_ids', { model, limit })).ids;
    }

    rows(dbName: string, ids: number[]): Promise<ViewRow[]> {
        return getViewRows(dbName, ids);
    }

    /** The tree's content: psql only, so it shows without waiting for a shell. */
    async doctorGroups(dbName: string): Promise<ViewGroups> {
        const [inactive, messages] = await Promise.all([listInactiveViews(dbName), getReportMessages(dbName)]);
        const reported = mergeReports(messages.map(message => parseDisabledViews(message.body)));
        const inactiveIds = new Set(inactive.map(view => view.id));
        const reEnabled = await getViewRows(dbName, [...reported.keys()].filter(id => !inactiveIds.has(id)));
        return groupViews(inactive, reported, reEnabled);
    }
}
