/**
 * Things deleted underneath a window (design §9). Another window on a shared
 * store can delete the project, database or version this window has
 * selected; the selection then quietly falls back - to nothing, or to the
 * first version - and without a word it looks like this window lost them.
 */
import { getDatabaseLabel } from '../utils';

export interface SelectionFacts {
    projectKey?: string;
    projectName?: string;
    dbId?: string;
    dbLabel?: string;
    versionId?: string;
    versionName?: string;
}

export interface StoreFacts {
    projectKeys: string[];
    /** Database ids of the project `before` had selected, when it still exists. */
    dbIds: string[];
    versionIds: string[];
    /** The version this window runs now. */
    activeVersionName?: string;
}

/** What went missing between two reads, in words; each said once. */
export function describeGone(before: SelectionFacts, after: StoreFacts, alreadySaid: Set<string>): string[] {
    const messages: string[] = [];
    const say = (key: string, message: string) => {
        if (!alreadySaid.has(key)) {
            alreadySaid.add(key);
            messages.push(message);
        }
    };
    if (before.projectKey && !after.projectKeys.includes(before.projectKey)) {
        say(`project:${before.projectKey}`, `Project "${before.projectName}" was deleted in another window, so no project is selected here.`);
    } else if (before.dbId && !after.dbIds.includes(before.dbId)) {
        say(`db:${before.dbId}`, `"${before.dbLabel ?? before.dbId}" was deleted in another window, so no database is selected here.`);
    }
    if (before.versionId && !after.versionIds.includes(before.versionId)) {
        say(`version:${before.versionId}`, after.activeVersionName
            ? `"${before.versionName}" was deleted in another window; this window now runs ${after.activeVersionName}.`
            : `"${before.versionName}" was deleted in another window.`);
    }
    return messages;
}

/** The facts `describeGone` needs from a loaded project and version. */
export function selectionFacts(
    project: { uid?: string; name?: string; dbs?: Array<{ id: string; isSelected?: boolean }> } | undefined,
    version: { id: string; name: string } | undefined
): SelectionFacts {
    const db = project?.dbs?.find(entry => entry.isSelected);
    return {
        projectKey: project ? project.uid || `name:${project.name ?? ''}` : undefined,
        projectName: project?.name,
        dbId: db?.id,
        dbLabel: db ? getDatabaseLabel(db as never) : undefined,
        versionId: version?.id,
        versionName: version?.name
    };
}
