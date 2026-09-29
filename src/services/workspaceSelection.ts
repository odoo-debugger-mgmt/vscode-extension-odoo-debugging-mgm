/**
 * Per-window selection: which project, which database per project and which
 * version this workspace has chosen, and each project's testing mode.
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
    /**
     * Project key -> testing mode in this window. Undefined, rather than
     * empty, until it has been recorded once: a selection stored before
     * testing moved here seeds it from the data instead of switching testing
     * off for anyone who had it on.
     */
    testingByProject?: Record<string, TestingState>;
}

/**
 * Testing mode as one window runs it. The module stash is not here: it
 * belongs to the database it was taken from (`testingModuleStates`).
 */
export interface TestingState {
    isEnabled: boolean;
    testTags: unknown[];
    testFile?: string;
    stopAfterInit: boolean;
    logLevel: string;
}

const DEFAULT_TESTING: TestingState = { isEnabled: false, testTags: [], stopAfterInit: false, logLevel: 'disabled' };

export const EMPTY_SELECTION: WorkspaceSelection = { selectedDbByProject: {} };

export const SELECTION_STATE_KEY = 'odt.workspaceSelection';

/** Prefix of the globalState key a generated workspace's selection is handed over under. */
export const HANDOFF_STATE_PREFIX = 'odt.workspaceHandoff:';

interface ProjectLike {
    uid?: string;
    name?: string;
    isSelected?: boolean;
    dbs?: Array<{ id?: string; isSelected?: boolean }>;
    testingConfig?: Partial<TestingState> & { savedModuleStates?: unknown };
}

function testingStateOf(config: Partial<TestingState>): TestingState {
    const state: TestingState = {
        isEnabled: !!config.isEnabled,
        testTags: Array.isArray(config.testTags) ? structuredClone(config.testTags) : [],
        stopAfterInit: !!config.stopAfterInit,
        logLevel: typeof config.logLevel === 'string' ? config.logLevel : 'disabled'
    };
    if (typeof config.testFile === 'string' && config.testFile) {
        state.testFile = config.testFile;
    }
    return state;
}

/**
 * Replaces the per-window testing fields of a stored config in place. A
 * legacy `savedModuleStates` is kept: the data migration moves it onto its
 * database, and a save that runs first must not drop it.
 */
function setTesting(config: NonNullable<ProjectLike['testingConfig']>, state: TestingState): void {
    config.isEnabled = state.isEnabled;
    config.testTags = structuredClone(state.testTags);
    config.stopAfterInit = state.stopAfterInit;
    config.logLevel = state.logLevel;
    if (state.testFile) {
        config.testFile = state.testFile;
    } else {
        delete config.testFile;
    }
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

    const testingByProject: Record<string, TestingState> = {};
    for (const project of projects) {
        if (project?.testingConfig) {
            testingByProject[projectKey(project)] = testingStateOf(project.testingConfig);
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
            : (activeVersion || undefined),
        testingByProject: hasProjects
            ? testingByProject
            : (previous.testingByProject ? { ...previous.testingByProject } : undefined)
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
        if (project.testingConfig) {
            setTesting(project.testingConfig, DEFAULT_TESTING);
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
        // Undefined means "not recorded yet": the data's own testing stands.
        if (selection.testingByProject) {
            const testing = selection.testingByProject[key];
            if (testing) {
                project.testingConfig = project.testingConfig ?? {};
                setTesting(project.testingConfig, testing);
            } else if (project.testingConfig) {
                setTesting(project.testingConfig, DEFAULT_TESTING);
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
            : undefined,
        testingByProject: normalizeTesting(value.testingByProject)
    };
}

function normalizeTesting(raw: unknown): Record<string, TestingState> | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const result: Record<string, TestingState> = {};
    for (const [key, state] of Object.entries(raw as Record<string, unknown>)) {
        if (state && typeof state === 'object') {
            result[key] = testingStateOf(state as Partial<TestingState>);
        }
    }
    return result;
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
