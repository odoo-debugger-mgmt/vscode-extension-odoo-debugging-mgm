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

    const options = { formattingOptions: { tabSize: 4, insertSpaces: true } };
    const edits = existingIndex >= 0
        ? modify(raw, ['configurations', existingIndex], merged, options)
        : modify(raw, ['configurations', 0], merged, { ...options, isArrayInsertion: true });

    await fs.writeFile(launchPath, applyEdits(raw, edits), 'utf8');
    return merged as ManagedLaunchConfig;
}
