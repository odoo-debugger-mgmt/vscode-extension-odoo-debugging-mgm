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

const EDIT_OPTIONS = { formattingOptions: { tabSize: 4, insertSpaces: true } };

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
 * Removes the configurations named in `names` from
 * `<workspacePath>/.vscode/launch.json`, leaving comments and every other
 * configuration as they are. Returns the number removed; a file with none of
 * them is not rewritten.
 */
export async function removeManagedLaunchConfigs(workspacePath: string, names: ReadonlySet<string>): Promise<number> {
    const launchPath = path.join(workspacePath, '.vscode', 'launch.json');
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

    // Last first, so each removal leaves the earlier indexes valid.
    const indexes = (parsed.configurations as Array<{ name?: unknown } | null>)
        .map((conf, index) => (typeof conf?.name === 'string' && names.has(conf.name) ? index : -1))
        .filter(index => index >= 0)
        .reverse();
    if (indexes.length === 0) {
        return 0;
    }
    for (const index of indexes) {
        raw = applyEdits(raw, modify(raw, ['configurations', index], undefined, EDIT_OPTIONS));
    }
    await fs.writeFile(launchPath, raw, 'utf8');
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

    const configurations = (parsed as { configurations: Array<Record<string, unknown> | null> }).configurations;
    const existingIndex = configurations.findIndex(conf => conf?.name === managedConfig.name);
    const existing = existingIndex >= 0 ? configurations[existingIndex] : undefined;
    const merged = { ...existing, ...managedConfig };

    const edits = existingIndex >= 0
        ? modify(raw, ['configurations', existingIndex], merged, EDIT_OPTIONS)
        : modify(raw, ['configurations', 0], merged, { ...EDIT_OPTIONS, isArrayInsertion: true });

    await fs.writeFile(launchPath, applyEdits(raw, edits), 'utf8');
    return merged as ManagedLaunchConfig;
}
