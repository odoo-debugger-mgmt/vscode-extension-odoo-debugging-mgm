/**
 * Per-window selection: which project, which database per project and which
 * version this workspace has chosen.
 *
 * These are choices one window makes, not facts about the data, so they live
 * in `workspaceState` rather than in the data file. Two windows sharing one
 * store would otherwise fight over them: selecting a database in one would
 * change what the other launches.
 *
 * The model still carries the flags (`isSelected`, `activeVersion`) that every
 * view and command reads, so the split happens at the SettingsStore seam: the
 * selection is applied on read and extracted on write. The transitions are
 * pure and tested as data; only the accessors at the bottom touch vscode.
 */
import type * as vscode from 'vscode';
import type { DebuggerData } from '../utils';

export interface WorkspaceSelection {
    /** Key of the selected project (see projectKey), if any. */
    selectedProjectUid?: string;
    /** Project key -> id of the database selected in that project. */
    selectedDbByProject: Record<string, string>;
    activeVersionId?: string;
}

export const EMPTY_SELECTION: WorkspaceSelection = { selectedDbByProject: {} };

export const SELECTION_STATE_KEY = 'odt.workspaceSelection';

/** Prefix of the globalState key a generated workspace's selection is handed over under. */
export const HANDOFF_STATE_PREFIX = 'odt.workspaceHandoff:';

interface ProjectLike {
    uid?: string;
    name?: string;
    isSelected?: boolean;
    dbs?: Array<{ id?: string; isSelected?: boolean }>;
}

/**
 * How a project is keyed in the selection. Projects written before uids
 * existed are only given one when a project is next selected, so the name
 * stands in until then rather than making them unselectable.
 */
export function projectKey(project: { uid?: string; name?: string }): string {
    return project.uid || `name:${project.name ?? ''}`;
}

function projectsOf(data: Partial<DebuggerData>): ProjectLike[] {
    return Array.isArray(data.projects) ? (data.projects as ProjectLike[]) : [];
}

/**
 * The selection a data object carries.
 *
 * A field the object does not carry at all keeps its `previous` value: a save
 * built without `activeVersion` must not read as "no version is active".
 */
export function extractSelection(
    data: Partial<DebuggerData>,
    previous: WorkspaceSelection = EMPTY_SELECTION
): WorkspaceSelection {
    const projects = projectsOf(data);
    const hasProjects = Array.isArray(data.projects);

    const selectedDbByProject: Record<string, string> = {};
    for (const project of projects) {
        const db = (project.dbs ?? []).find(entry => entry?.isSelected && entry.id);
        if (db?.id) {
            selectedDbByProject[projectKey(project)] = db.id;
        }
    }

    const selectedProject = projects.find(project => project?.isSelected);
    const activeVersion = typeof data.activeVersion === 'string' ? data.activeVersion.trim() : undefined;

    return {
        selectedProjectUid: hasProjects
            ? (selectedProject ? projectKey(selectedProject) : undefined)
            : previous.selectedProjectUid,
        selectedDbByProject: hasProjects ? selectedDbByProject : { ...previous.selectedDbByProject },
        activeVersionId: data.activeVersion === undefined
            ? previous.activeVersionId
            : (activeVersion || undefined)
    };
}

/**
 * A copy of `data` with every selection flag cleared, ready for the store.
 * The flags are kept as `false` rather than deleted so the stored shape is the
 * one the models construct.
 */
export function stripSelection<T extends Partial<DebuggerData>>(data: T): T {
    const copy = structuredClone(data);
    for (const project of projectsOf(copy)) {
        project.isSelected = false;
        for (const db of project.dbs ?? []) {
            if (db) {
                db.isSelected = false;
            }
        }
    }
    delete copy.activeVersion;
    for (const version of Object.values(copy.versions ?? {})) {
        if (version && typeof version === 'object') {
            (version as { isActive?: boolean }).isActive = false;
        }
    }
    return copy;
}

/**
 * Sets the selection flags on `data` in place and returns it. An id that no
 * longer exists selects nothing, rather than failing.
 */
export function applySelection<T extends Partial<DebuggerData>>(data: T, selection: WorkspaceSelection): T {
    for (const project of projectsOf(data)) {
        const key = projectKey(project);
        project.isSelected = key === selection.selectedProjectUid;
        const selectedDb = selection.selectedDbByProject[key];
        for (const db of project.dbs ?? []) {
            if (db) {
                db.isSelected = !!selectedDb && db.id === selectedDb;
            }
        }
    }

    const versions = data.versions ?? {};
    const active = selection.activeVersionId && versions[selection.activeVersionId]
        ? selection.activeVersionId
        : undefined;
    if (active) {
        data.activeVersion = active;
    } else {
        delete data.activeVersion;
    }
    for (const [id, version] of Object.entries(versions)) {
        if (version && typeof version === 'object') {
            (version as { isActive?: boolean }).isActive = id === active;
        }
    }
    return data;
}

/** Whether the data carries any selection at all, for seeding. */
export function isEmptySelection(selection: WorkspaceSelection): boolean {
    return !selection.selectedProjectUid
        && !selection.activeVersionId
        && Object.keys(selection.selectedDbByProject).length === 0;
}

/** A stored value, or undefined when it cannot describe a selection. */
export function normalizeSelection(raw: unknown): WorkspaceSelection | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const value = raw as Record<string, unknown>;
    const dbs: Record<string, string> = {};
    if (value.selectedDbByProject && typeof value.selectedDbByProject === 'object') {
        for (const [key, id] of Object.entries(value.selectedDbByProject as Record<string, unknown>)) {
            if (typeof id === 'string' && id) {
                dbs[key] = id;
            }
        }
    }
    return {
        selectedProjectUid: typeof value.selectedProjectUid === 'string' && value.selectedProjectUid
            ? value.selectedProjectUid
            : undefined,
        selectedDbByProject: dbs,
        activeVersionId: typeof value.activeVersionId === 'string' && value.activeVersionId
            ? value.activeVersionId
            : undefined
    };
}

// ---------------------------------------------------------------------------
// vscode-backed accessors
// ---------------------------------------------------------------------------

export function readSelection(memento: vscode.Memento): WorkspaceSelection | undefined {
    return normalizeSelection(memento.get(SELECTION_STATE_KEY));
}

export async function writeSelection(memento: vscode.Memento, selection: WorkspaceSelection): Promise<void> {
    await memento.update(SELECTION_STATE_KEY, selection);
}
