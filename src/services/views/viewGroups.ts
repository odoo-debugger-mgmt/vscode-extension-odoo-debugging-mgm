/**
 * How the View Doctor sorts a database's views: what an upgrade disabled
 * first, since those are the ones to fix, then every other inactive view.
 */
import type { ViewRow } from './viewQueries';

export type UpgradeDisabledView = ViewRow & { versions: string[] };

export interface ViewGroups {
    /** Listed by an upgrade report: still off first, then re-enabled. */
    upgradeDisabled: UpgradeDisabledView[];
    /** Every version whose upgrade report listed a view, in first-seen order. */
    upgradeVersions: string[];
    /**
     * Inactive views no report lists. A qweb view shows only when it is a
     * report's template: inactive website and report *fragments* are inactive
     * by design and would bury the rest.
     */
    otherInactive: ViewRow[];
    /** Listed by a report, but no longer in the database. */
    missingIds: number[];
    /** Views this extension saved or turned on (the note's journal), whatever their state now. */
    edited: ViewRow[];
}

export function groupViews(inactive: ViewRow[], reported: Map<number, string[]>, reportedRows: ViewRow[], edited: ViewRow[] = []): ViewGroups {
    const byId = new Map<number, ViewRow>();
    for (const view of [...inactive, ...reportedRows]) {
        byId.set(view.id, view);
    }

    const upgradeDisabled: UpgradeDisabledView[] = [];
    const missingIds: number[] = [];
    const upgradeVersions: string[] = [];
    for (const [id, versions] of reported) {
        for (const version of versions) {
            if (!upgradeVersions.includes(version)) {
                upgradeVersions.push(version);
            }
        }
        const view = byId.get(id);
        if (view) {
            upgradeDisabled.push({ ...view, versions });
        } else {
            missingIds.push(id);
        }
    }
    upgradeDisabled.sort((a, b) =>
        Number(a.active) - Number(b.active) || a.model.localeCompare(b.model) || a.id - b.id);
    upgradeVersions.sort();

    const otherInactive = inactive.filter(view =>
        !reported.has(view.id) && (view.type !== 'qweb' || view.isReport));

    return {
        upgradeDisabled,
        upgradeVersions,
        otherInactive,
        missingIds,
        edited: [...edited].sort((a, b) => a.model.localeCompare(b.model) || a.id - b.id)
    };
}
