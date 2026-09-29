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
import * as path from 'node:path';
import * as vscode from 'vscode';
import { logger } from './logger';

export const DATA_FILE_NAME = 'odoo-debugger-data.json';

/** Setting key, under the `odooDebugger` section. */
export const DATA_STORE_SETTING = 'dataStore.path';

export interface DataLocation {
    /** The data file. */
    file: string;
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
    /** Path of the open `.code-workspace` file, if any. */
    workspaceFile?: string;
    firstFolder?: string;
}

export function dataRootFor(file: string): string {
    const dir = path.dirname(file);
    return path.basename(dir) === '.vscode' ? path.dirname(dir) : dir;
}

/**
 * Only JSON stores exist until the shared store lands, so any other value is
 * ignored rather than half-honoured.
 */
export function isSupportedStorePath(value: string): boolean {
    return value.toLowerCase().endsWith('.json');
}

export function resolveDataLocation(input: DataLocationInput): DataLocation | undefined {
    const configured = input.configured?.trim();
    if (configured && isSupportedStorePath(configured)) {
        // A relative value is relative to where it was written: the
        // workspace file, or the folder whose settings hold it.
        const base = input.workspaceFile ? path.dirname(input.workspaceFile) : input.firstFolder;
        const file = path.isAbsolute(configured)
            ? configured
            : (base ? path.join(base, configured) : undefined);
        if (file) {
            return { file, root: dataRootFor(file), pinned: true };
        }
    }

    if (!input.firstFolder) {
        return undefined;
    }
    const file = path.join(input.firstFolder, '.vscode', DATA_FILE_NAME);
    return { file, root: input.firstFolder, pinned: false };
}

let warnedAbout: string | undefined;

/**
 * This window's data location. Only a **workspace-level** setting is read:
 * a user-level value would point every workspace at one JSON file, and that
 * needs the shared store's concurrency safety, which does not exist yet.
 */
export function currentDataLocation(): DataLocation | undefined {
    const inspected = vscode.workspace
        .getConfiguration('odooDebugger')
        .inspect<string>(DATA_STORE_SETTING);
    const configured = inspected?.workspaceValue?.trim() || undefined;

    if (configured && !isSupportedStorePath(configured) && warnedAbout !== configured) {
        warnedAbout = configured;
        logger.warn(`[store] ignoring odooDebugger.dataStore.path "${configured}": only .json stores are supported yet`);
    }

    const workspaceFile = vscode.workspace.workspaceFile;
    return resolveDataLocation({
        configured,
        workspaceFile: workspaceFile?.scheme === 'file' ? workspaceFile.fsPath : undefined,
        firstFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    });
}
