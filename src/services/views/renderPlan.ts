/**
 * Where a render frame points: the URL of a view-doctor action on one
 * database's web client, per the series' router, and which record both
 * sides of a comparison show.
 */

export const NO_COMMON_RECORD = 'No record exists in both databases; showing a new one.';

/** saas~17.2 moved the web client to /odoo/... URLs; before it, the hash carries the state. */
export function usesOdooRouter(series: string): boolean {
    const match = /(\d+)\.(\d+)/.exec(series);
    if (!match) {
        return true;
    }
    const [major, minor] = [Number(match[1]), Number(match[2])];
    return major > 17 || (major === 17 && minor >= 2);
}

export interface FramePathInput {
    series: string;
    actionId: number;
    model: string;
    viewType: string;
    /** The record a form shows; none for a new record or a multi-record view. */
    resId?: number;
}

export function framePath(input: FramePathInput): string {
    const record = input.viewType === 'form' ? input.resId : undefined;
    if (usesOdooRouter(input.series)) {
        return `/odoo/action-${input.actionId}${record ? `/${record}` : ''}?debug=1`;
    }
    const hash = [`action=${input.actionId}`, `model=${encodeURIComponent(input.model)}`, `view_type=${encodeURIComponent(input.viewType)}`];
    if (record) {
        hash.push(`id=${record}`);
    }
    return `/web?debug=1#${hash.join('&')}`;
}

/** Ids in both lists, newest first. */
export function commonIds(a: number[], b: number[]): number[] {
    const other = new Set(b);
    return [...new Set(a)].filter(id => other.has(id)).sort((x, y) => y - x);
}

/** What to say instead of rendering a QWeb view. */
export function qwebMessage(isReport: boolean): string {
    return isReport
        ? 'Reports need a record to render; open the report from Odoo.'
        : 'QWeb templates render inside the page that uses them; open it from Odoo.';
}
