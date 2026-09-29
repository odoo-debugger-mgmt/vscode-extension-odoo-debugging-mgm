/**
 * Where the extension's data lives for this window, and the directory that
 * relative paths in it resolve against.
 *
 * By default that is `<first workspace folder>/.vscode/odoo-debugger-data.json`,
 * as it always was. A workspace can pin a store with `odooDebugger.dataStore.path`
 * - generated project workspaces do, because their first folder is a project
 * repository, and reading the data from there is how the projects used to
 * "vanish" in the window Open Project Workspace opened.
 *
 * Kept free of `utils` so `normalizePath` can use it without an import cycle.
 * The resolution is pure; only `currentDataLocation` touches vscode.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { logger } from './logger';
import { localWorkspaceFilePath } from './launchConfig';

export const DATA_FILE_NAME = 'odoo-debugger-data.json';

/** Setting key, under the `odooDebugger` section. */
export const DATA_STORE_SETTING = 'dataStore.path';

export type StoreKind = 'json' | 'sqlite';

export interface DataLocation {
    /** The data file. */
    file: string;
    kind: StoreKind;
    /**
     * The directory relative paths in the data resolve against: the folder
     * holding `.vscode/`, or the file's own directory otherwise.
     */
    root: string;
    /** True when a setting chose the file rather than the workspace. */
    pinned: boolean;
}

export interface DataLocationInput {
    /** The workspace-level `odooDebugger.dataStore.path`, if any. */
    configured?: string;
    /** The user-level value, used when the workspace sets none. */
    configuredGlobally?: string;
    /** Path of the open `.code-workspace` file, if any. */
    workspaceFile?: string;
    firstFolder?: string;
}

export function dataRootFor(file: string): string {
    const dir = path.dirname(file);
    return path.basename(dir) === '.vscode' ? path.dirname(dir) : dir;
}

/** Which kind of store a path names, or undefined for one that is not supported. */
export function storeKindOf(value: string): StoreKind | undefined {
    const lower = value.toLowerCase();
    if (lower.endsWith('.db') || lower.endsWith('.sqlite') || lower.endsWith('.sqlite3')) {
        return 'sqlite';
    }
    return lower.endsWith('.json') ? 'json' : undefined;
}

function expandHome(value: string, home: string): string {
    return value === '~' || value.startsWith('~/') ? path.join(home, value.slice(1)) : value;
}

/**
 * The store for this window:
 *
 * - a workspace-level value wins, then a user-level one, then the workspace's
 *   own `.vscode/odoo-debugger-data.json`;
 * - a SQLite store (`.db`) is honoured at either level. It is built for
 *   several windows at once;
 * - a JSON store only at workspace level: shared by every workspace, one
 *   JSON file would lose edits whenever two windows saved together;
 * - anything else is ignored rather than half-honoured.
 */
export function resolveDataLocation(input: DataLocationInput, home: string = os.homedir()): DataLocation | undefined {
    // A relative value is relative to where it was written: the workspace
    // file, or the folder whose settings hold it. A user-level one has no
    // such place, so it must be absolute (or start with ~).
    const workspaceBase = input.workspaceFile ? path.dirname(input.workspaceFile) : input.firstFolder;
    const candidates: Array<{ value?: string; base?: string; allowJson: boolean }> = [
        { value: input.configured, base: workspaceBase, allowJson: true },
        { value: input.configuredGlobally, base: undefined, allowJson: false }
    ];

    for (const candidate of candidates) {
        const value = candidate.value?.trim();
        const kind = value ? storeKindOf(value) : undefined;
        if (!value || !kind || (kind === 'json' && !candidate.allowJson)) {
            continue;
        }
        const expanded = expandHome(value, home);
        const file = path.isAbsolute(expanded)
            ? expanded
            : (candidate.base ? path.join(candidate.base, expanded) : undefined);
        if (file) {
            // A pinned JSON file is one workspace's data, so its paths are
            // relative to that workspace. A shared store holds absolute paths
            // (imports make them so); what is still relative there is a
            // default like `./custom-addons`, which means this window's folder.
            const root = kind === 'sqlite' && input.firstFolder ? input.firstFolder : dataRootFor(file);
            return { file, kind, root, pinned: true };
        }
    }

    return workspaceDataLocation(input.firstFolder);
}

/** The workspace's own data file: the default, and the fallback. */
export function workspaceDataLocation(firstFolder: string | undefined): DataLocation | undefined {
    if (!firstFolder) {
        return undefined;
    }
    const file = path.join(firstFolder, '.vscode', DATA_FILE_NAME);
    return { file, kind: 'json', root: firstFolder, pinned: false };
}

let warnedAbout: string | undefined;

/** This window's data location, as the rules in resolveDataLocation decide. */
export function currentDataLocation(): DataLocation | undefined {
    const inspected = vscode.workspace
        .getConfiguration('odooDebugger')
        .inspect<string>(DATA_STORE_SETTING);
    const configured = inspected?.workspaceValue?.trim() || undefined;
    const configuredGlobally = inspected?.globalValue?.trim() || undefined;

    for (const [value, level] of [[configured, 'workspace'], [configuredGlobally, 'user']] as const) {
        const kind = value ? storeKindOf(value) : undefined;
        const ignored = value && (!kind || (kind === 'json' && level === 'user'));
        if (ignored && warnedAbout !== `${level}:${value}`) {
            warnedAbout = `${level}:${value}`;
            logger.warn(kind === 'json'
                ? `[store] ignoring the user-level odooDebugger.dataStore.path "${value}": a JSON store is per workspace only; use a .db store to share`
                : `[store] ignoring odooDebugger.dataStore.path "${value}": use a .db (shared) or .json (this workspace) file`);
        }
    }

    const workspaceFile = vscode.workspace.workspaceFile;
    return resolveDataLocation({
        configured,
        configuredGlobally,
        workspaceFile: localWorkspaceFilePath(workspaceFile),
        firstFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    });
}
