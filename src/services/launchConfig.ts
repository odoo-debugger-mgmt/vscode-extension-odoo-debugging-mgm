import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse, modify, applyEdits } from 'jsonc-parser';

/**
 * Manages the extension's entry in .vscode/launch.json. Only the managed
 * configuration (matched by name) is rewritten - user comments, formatting
 * and other configurations in the file are preserved via jsonc edits.
 */

const EMPTY_LAUNCH_CONTENT = `{
    // For more information, visit: https://go.microsoft.com/fwlink/?linkid=830387
    "version": "0.2.0",

    // The "<debugger name>" entry is managed by the Odoo DevTools extension;
    // it is rewritten whenever the active version, database or modules change.
    "configurations": []
}
`;

export interface ManagedLaunchConfig {
    name: string;
    type: string;
    request: string;
    cwd: string;
    program: string;
    python: string;
    console: string;
    args: string[];
    [key: string]: unknown;
}

/**
 * Where this window's launch configurations live.
 *
 * A folder window keeps them in `<folder>/.vscode/launch.json`. A saved
 * multi-root workspace has no `.vscode` of its own - its first folder is
 * usually a project repository, and writing there put our file in the user's
 * git repository and shared it with every workspace listing that repository
 * first. Its own place is the `launch` section of the `.code-workspace` file.
 */
export type LaunchTarget =
    | { kind: 'folder'; folderPath: string; filePath: string }
    | { kind: 'workspaceFile'; filePath: string; firstFolderPath?: string };

/**
 * The local path of a saved workspace file, or undefined when there is none
 * to write to: an untitled workspace, or one on another machine.
 *
 * `vscode-userdata:` counts. A workspace file kept in the extension's global
 * storage, and opened by that storage URI, reports this scheme rather than
 * `file:` - which is how Open Project Workspace used to open it, and how such
 * a window still reopens from the Recent list.
 */
export function localWorkspaceFilePath(workspaceFile: { scheme: string; fsPath: string } | undefined): string | undefined {
    return workspaceFile && (workspaceFile.scheme === 'file' || workspaceFile.scheme === 'vscode-userdata')
        ? workspaceFile.fsPath
        : undefined;
}

export function launchTarget(
    workspaceFile: { scheme: string; fsPath: string } | undefined,
    folderPaths: readonly string[]
): LaunchTarget | undefined {
    const filePath = localWorkspaceFilePath(workspaceFile);
    if (filePath) {
        return { kind: 'workspaceFile', filePath, firstFolderPath: folderPaths[0] };
    }
    const folderPath = folderPaths[0];
    return folderPath
        ? { kind: 'folder', folderPath, filePath: path.join(folderPath, '.vscode', 'launch.json') }
        : undefined;
}

const EDIT_OPTIONS = { formattingOptions: { tabSize: 4, insertSpaces: true } };

type LaunchSection = { configurations: Array<Record<string, unknown> | null> };

/** Inserts or updates `managedConfig` in the configurations array at `at`, in `raw`. */
function upsertIn(raw: string, at: Array<string | number>, section: LaunchSection, managedConfig: ManagedLaunchConfig) {
    const existingIndex = section.configurations.findIndex(conf => conf?.name === managedConfig.name);
    const existing = existingIndex >= 0 ? section.configurations[existingIndex] : undefined;
    const merged = { ...existing, ...managedConfig };
    const edits = existingIndex >= 0
        ? modify(raw, [...at, existingIndex], merged, EDIT_OPTIONS)
        : modify(raw, [...at, 0], merged, { ...EDIT_OPTIONS, isArrayInsertion: true });
    return { text: applyEdits(raw, edits), merged: merged as ManagedLaunchConfig };
}

/**
 * Updates (or inserts at the top) the launch configuration named
 * `managedConfig.name`, wherever `target` keeps them.
 */
export async function updateManagedLaunchConfigIn(target: LaunchTarget, managedConfig: ManagedLaunchConfig): Promise<ManagedLaunchConfig> {
    if (target.kind === 'folder') {
        return updateManagedLaunchConfig(target.folderPath, managedConfig);
    }

    // The workspace file is the user's: a file that does not parse is left
    // alone rather than replaced by a skeleton, as launch.json would be.
    let raw = await fs.readFile(target.filePath, 'utf8');
    let parsed = parse(raw) as { launch?: { configurations?: unknown } } | undefined;
    if (!parsed || typeof parsed !== 'object') {
        throw new Error(`${target.filePath} is not valid JSON; its launch configurations were not updated`);
    }
    if (!parsed.launch || typeof parsed.launch !== 'object' || !Array.isArray(parsed.launch.configurations)) {
        const launch = { version: '0.2.0', ...(typeof parsed.launch === 'object' ? parsed.launch : {}), configurations: [] };
        raw = applyEdits(raw, modify(raw, ['launch'], launch, EDIT_OPTIONS));
        parsed = parse(raw);
    }

    const { text, merged } = upsertIn(raw, ['launch', 'configurations'], parsed!.launch as LaunchSection, managedConfig);
    await fs.writeFile(target.filePath, text, 'utf8');
    return merged;
}

/**
 * The launch configuration named `name`, as `target` holds it, or undefined
 * when it is not there (yet) or the file cannot be read.
 */
export async function readManagedLaunchConfig(target: LaunchTarget, name: string): Promise<Record<string, unknown> | undefined> {
    let raw: string;
    try {
        raw = await fs.readFile(target.filePath, 'utf8');
    } catch {
        return undefined;
    }
    const parsed = parse(raw) as { configurations?: unknown; launch?: { configurations?: unknown } } | undefined;
    const configurations = target.kind === 'folder' ? parsed?.configurations : parsed?.launch?.configurations;
    if (!Array.isArray(configurations)) {
        return undefined;
    }
    const found = configurations.find(conf => conf && typeof conf === 'object' && conf.name === name);
    return found ? { ...found } : undefined;
}

/**
 * Removes the configurations named in `names` from wherever `target` keeps
 * them. A workspace file is never deleted; a folder's launch.json goes as
 * removeManagedLaunchConfigs decides. Returns the number removed.
 */
export async function removeManagedLaunchConfigIn(target: LaunchTarget, names: ReadonlySet<string>): Promise<number> {
    if (target.kind === 'folder') {
        return removeManagedLaunchConfigs(target.folderPath, names);
    }
    let raw: string;
    try {
        raw = await fs.readFile(target.filePath, 'utf8');
    } catch {
        return 0;
    }
    const configurations = (parse(raw) as { launch?: { configurations?: unknown } } | undefined)?.launch?.configurations;
    if (!Array.isArray(configurations)) {
        return 0;
    }
    const indexes = matchingIndexes(configurations, names);
    for (const index of indexes) {
        raw = applyEdits(raw, modify(raw, ['launch', 'configurations', index], undefined, EDIT_OPTIONS));
    }
    if (indexes.length > 0) {
        await fs.writeFile(target.filePath, raw, 'utf8');
    }
    return indexes.length;
}

/** Indexes of the configurations named in `names`, last first, for removal. */
function matchingIndexes(configurations: unknown[], names: ReadonlySet<string>): number[] {
    return configurations
        .map((conf, index) => {
            const name = conf && typeof conf === 'object' ? (conf as { name?: unknown }).name : undefined;
            return typeof name === 'string' && names.has(name) ? index : -1;
        })
        .filter(index => index >= 0)
        .reverse();
}

/** The skeleton's own comment lines, which do not make a launch.json the user's. */
const SKELETON_COMMENTS = new Set(EMPTY_LAUNCH_CONTENT.split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('//')));

/**
 * Removes the configurations named in `names` from `<folderPath>/.vscode/launch.json`:
 * what an earlier build wrote into a multi-root workspace's first folder. The
 * file, and an empty `.vscode`, go too when nothing of the user's is left.
 *
 * Returns the number of configurations removed.
 */
export async function removeManagedLaunchConfigs(folderPath: string, names: ReadonlySet<string>): Promise<number> {
    const vscodeDir = path.join(folderPath, '.vscode');
    const launchPath = path.join(vscodeDir, 'launch.json');
    let raw: string;
    try {
        raw = await fs.readFile(launchPath, 'utf8');
    } catch {
        return 0;
    }
    const parsed = parse(raw) as { configurations?: unknown } | undefined;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.configurations)) {
        return 0;
    }

    const indexes = matchingIndexes(parsed.configurations, names);
    if (indexes.length === 0) {
        return 0;
    }
    for (const index of indexes) {
        raw = applyEdits(raw, modify(raw, ['configurations', index], undefined, EDIT_OPTIONS));
    }

    const left = parse(raw) as Record<string, unknown>;
    const onlySkeleton = Object.keys(left).every(key => key === 'version' || key === 'configurations')
        && Array.isArray(left.configurations) && left.configurations.length === 0
        && raw.split('\n').map(line => line.trim()).filter(line => line.startsWith('//'))
            .every(line => SKELETON_COMMENTS.has(line));
    if (onlySkeleton) {
        await fs.rm(launchPath);
        // Only when empty: anything else in .vscode is the user's.
        await fs.rmdir(vscodeDir).catch(() => undefined);
    } else {
        await fs.writeFile(launchPath, raw, 'utf8');
    }
    return indexes.length;
}

/**
 * Updates (or inserts at the top) the launch configuration named
 * `managedConfig.name`, keeping any extra user-added keys on that entry and
 * leaving the rest of launch.json untouched.
 */
export async function updateManagedLaunchConfig(workspacePath: string, managedConfig: ManagedLaunchConfig): Promise<ManagedLaunchConfig> {
    const vscodeDir = path.join(workspacePath, '.vscode');
    const launchPath = path.join(vscodeDir, 'launch.json');
    await fs.mkdir(vscodeDir, { recursive: true });

    let raw = await fs.readFile(launchPath, 'utf8').catch(() => EMPTY_LAUNCH_CONTENT);

    let parsed = parse(raw) as { configurations?: unknown } | undefined;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.configurations)) {
        // Unreadable/malformed file: fall back to a fresh skeleton rather
        // than guessing at edits inside broken JSON.
        raw = EMPTY_LAUNCH_CONTENT;
        parsed = parse(raw);
    }

    const { text, merged } = upsertIn(raw, ['configurations'], parsed as LaunchSection, managedConfig);
    await fs.writeFile(launchPath, text, 'utf8');
    return merged;
}
