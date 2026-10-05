/**
 * Which view of another database is "the same view": by external id, then
 * by id when the model and type agree (an upgraded database is a copy, so
 * ids carry over), then by the one view with the same model, type and name.
 * Anything less certain is left to the user, likeliest first.
 */
import type { ViewRow } from './viewQueries';

export interface CounterpartRows {
    /** The view with the source's external id there, if any. */
    byXmlid?: ViewRow;
    /** The view with the source's id, and every view of its model and type. */
    rows: ViewRow[];
}

export type ViewMatch =
    | { kind: 'xmlid' | 'id' | 'name'; view: ViewRow }
    | { kind: 'pick'; candidates: ViewRow[] }
    | { kind: 'none' };

export function matchView(source: ViewRow, found: CounterpartRows): ViewMatch {
    if (found.byXmlid) {
        return { kind: 'xmlid', view: found.byXmlid };
    }
    const similar = found.rows.filter(view => view.model === source.model && view.type === source.type);
    const sameId = similar.find(view => view.id === source.id);
    if (sameId) {
        return { kind: 'id', view: sameId };
    }
    const named = similar.filter(view => view.name === source.name);
    if (named.length === 1) {
        return { kind: 'name', view: named[0] };
    }
    if (similar.length === 0) {
        return { kind: 'none' };
    }
    const isBase = (view: ViewRow) => view.inheritId === null;
    const likeness = (view: ViewRow) => (view.name === source.name ? 2 : 0) + (isBase(view) === isBase(source) ? 1 : 0);
    return { kind: 'pick', candidates: [...similar].sort((a, b) => likeness(b) - likeness(a) || a.id - b.id) };
}
