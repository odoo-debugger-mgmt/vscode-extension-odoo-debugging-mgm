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
