import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import { SettingsModel } from './models/settings';
import { ProjectModel } from './models/project';
import { RepoModel } from './models/repo';
import { getBranchesViaSourceControl } from './services/gitService';

import { parse } from 'jsonc-parser';

const launchJsonFileContent = `{
    // For more information, visit: https://go.microsoft.com/fwlink/?linkid=830387
    "version": "0.2.0",

    // Debug configurations for VS Code
    // Odoo configurations will be automatically added here by the Odoo Debugger extension
    "configurations": []
}`;

const debuggerDataFileContent = `{
    // Odoo Debugger Extension Configuration
    // This file stores your project settings and configurations
    "settings": {
        // Add your Odoo settings here
    },
    "projects": []
}`;

// ============================================================================
// INTERFACES
// ============================================================================

export interface DebuggerData {
    settings?: any;
    projects: ProjectModel[];
    versions?: { [id: string]: any };
    activeVersion?: string;
}

/**
 * Strip settings from DebuggerData to ensure settings are managed exclusively by versions
 */
export function stripSettings(data: DebuggerData): DebuggerData {
    return {
        projects: data.projects,
        versions: data.versions,
        activeVersion: data.activeVersion
    };
}

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Configuration options for file operations
 */
export const CONFIG = {
    tabSize: 4,
    insertSpaces: true
};

// ============================================================================
// UI UTILITIES
// ============================================================================

/**
 * Adds the pointing hand emoji (👉) to the beginning of a string if the condition is true
 * Used consistently across the extension for indicating active/selected items
 * @param text The text to potentially prefix
 * @param isActive Whether to add the pointing hand emoji
 * @returns The text with or without the pointing hand prefix
 */
export function addActiveIndicator(text: string, isActive: boolean): string {
    return `${isActive ? '👉' : ''} ${text}`;
}

/**
 * Returns a user-friendly database label prioritizing displayName, then name, then id.
 */
export function getDatabaseLabel(db: { displayName?: string; name?: string; id?: string } | null | undefined): string {
    if (!db) {
        return 'Unknown Database';
    }

    const candidates = [
        typeof db.displayName === 'string' ? db.displayName.trim() : '',
        typeof db.name === 'string' ? db.name.trim() : '',
        typeof db.id === 'string' ? db.id.trim() : ''
    ].filter(Boolean);

    return candidates[0] || 'Unknown Database';
}


// ============================================================================
// WORKSPACE & PATH UTILITIES
// ============================================================================

/**
 * Gets the workspace folder path with validation
 * @returns workspace path or null if no workspace is open
 */
export function getWorkspacePath(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        showError("Open a workspace to use this command.");
        return null;
    }
    return workspaceFolders[0].uri.fsPath;
}

/**
 * Normalizes a path to be absolute, relative to workspace if needed
 */
export function normalizePath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) {
        return inputPath;
    }

    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
        return inputPath; // Return as-is if no workspace
    }

    return path.join(workspacePath, inputPath);
}


// ============================================================================
// FILE SYSTEM UTILITIES
// ============================================================================

/**
 * Ensures the .vscode directory exists in the workspace
 * @param workspacePath - the workspace root path
 * @returns the .vscode directory path
 */
function ensureVSCodeDirectory(workspacePath: string): string {
    const vscodeDir = path.join(workspacePath, '.vscode');
    try {
        if (!fs.existsSync(vscodeDir)) {
            fs.mkdirSync(vscodeDir, { recursive: true });
        }
    } catch (error) {
        throw new Error(`Failed to create .vscode directory: ${error}`);
    }
    return vscodeDir;
}

export interface SearchOverrides {
    maxDepth?: number;
    maxEntries?: number;
    excludePatterns?: string[];
    token?: vscode.CancellationToken;
}

interface SearchOptions {
    maxDepth: number;
    maxEntries: number;
    excludeRegexes: RegExp[];
    token?: vscode.CancellationToken;
}

type DiscoveryKind = 'modules' | 'repositories';

interface StackEntry {
    dir: string;
    depth: number;
}

const DEFAULT_MODULE_EXCLUDES = [
    '**/node_modules/**',
    '**/.venv/**',
    '**/__pycache__/**',
    '**/.git/**'
];

const DEFAULT_REPOSITORY_EXCLUDES = [
    '**/node_modules/**',
    '**/.venv/**',
    '**/__pycache__/**'
];

function globToRegExp(pattern: string): RegExp {
    const normalizedPattern = pattern.split(path.sep).join('/');

    const placeholders = {
        doubleStar: '__GLOB_DOUBLE_STAR__',
        singleStar: '__GLOB_SINGLE_STAR__',
        question: '__GLOB_QUESTION__'
    };

    let working = normalizedPattern
        .replaceAll('**', placeholders.doubleStar)
        .replaceAll('*', placeholders.singleStar)
        .replaceAll('?', placeholders.question);

    working = working.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);

    working = working
        .replaceAll(new RegExp(placeholders.doubleStar, 'g'), '.*')
        .replaceAll(new RegExp(placeholders.singleStar, 'g'), '[^/]*')
        .replaceAll(new RegExp(placeholders.question, 'g'), '[^/]');

    return new RegExp(`^${working}$`, 'i');
}

function compilePatterns(patterns: string[]): RegExp[] {
    return patterns.map(globToRegExp);
}

function shouldExcludePath(fullPath: string, root: string, regexes: RegExp[]): boolean {
    if (regexes.length === 0) {
        return false;
    }
    const normalized = fullPath.split(path.sep).join('/');
    const relative = normalized.startsWith(root) ? normalized.slice(root.length) : normalized;
    const candidates = new Set<string>();
    candidates.add(normalized);
    candidates.add(`${normalized}/`);
    if (relative) {
        const trimmed = relative.replace(/^\//, '');
        candidates.add(trimmed);
        candidates.add(`${trimmed}/`);
    }
    for (const candidate of candidates) {
        for (const regex of regexes) {
            if (regex.test(candidate)) {
                return true;
            }
        }
    }
    return false;
}

function getSearchOptions(kind: DiscoveryKind, overrides: SearchOverrides = {}): SearchOptions {
    const config = vscode.workspace.getConfiguration('odooDebugger.search');
    const maxDepth = Math.max(0, overrides.maxDepth ?? config.get<number>('maxDepth', 4));
    const maxEntries = Math.max(1, overrides.maxEntries ?? config.get<number>('maxEntries', 100000));
    const patternKey = kind === 'modules' ? 'excludePatterns.modules' : 'excludePatterns.repositories';
    const defaults = kind === 'modules' ? DEFAULT_MODULE_EXCLUDES : DEFAULT_REPOSITORY_EXCLUDES;
    const patterns = overrides.excludePatterns ?? config.get<string[]>(patternKey, defaults);
    return {
        maxDepth,
        maxEntries,
        excludeRegexes: compilePatterns(patterns),
        token: overrides.token
    };
}

function discoverDirectories(targetPath: string, kind: DiscoveryKind, options: SearchOptions): { path: string; name: string }[] {
    if (!targetPath) {
        showError('Enter a target path to continue.');
        return [];
    }

    const normalizedRoot = normalizePath(targetPath);
    if (!fs.existsSync(normalizedRoot)) {
        showError(`Path does not exist: ${normalizedRoot}`);
        return [];
    }

    const stack: StackEntry[] = [{ dir: normalizedRoot, depth: 0 }];
    const visited = new Set<string>();
    const results: { path: string; name: string }[] = [];
    let processed = 0;
    let limitWarningShown = false;
    const rootNormalized = normalizedRoot.split(path.sep).join('/');

    while (stack.length > 0) {
        if (options.token?.isCancellationRequested) {
            break;
        }

        const current = stack.pop()!;
        const resolved = path.resolve(current.dir);
        if (visited.has(resolved)) {
            continue;
        }
        visited.add(resolved);

        if (current.depth > 0 && shouldExcludePath(resolved, rootNormalized, options.excludeRegexes)) {
            continue;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(resolved, { withFileTypes: true });
        } catch (error) {
            console.warn(`Failed to read directory ${resolved}:`, error);
            continue;
        }

        processed++;
        if (processed > options.maxEntries) {
            if (!limitWarningShown) {
                showWarning(`Search limit reached while scanning ${targetPath}. Some folders may be skipped. Adjust "odooDebugger.search.maxEntries" to increase the limit.`);
                limitWarningShown = true;
            }
            break;
        }

        const hasManifest = entries.some(entry => entry.isFile() && entry.name === '__manifest__.py');
        const hasGitDir = entries.some(entry => entry.isDirectory() && entry.name === '.git');

        if (kind === 'modules' && hasManifest) {
            results.push({ path: resolved, name: path.basename(resolved) });
            continue;
        }

        if (kind === 'repositories' && hasGitDir) {
            results.push({ path: resolved, name: path.basename(resolved) });
            // Do not recurse into repository contents.
            continue;
        }

        if (current.depth >= options.maxDepth) {
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            if (entry.name === '.' || entry.name === '..') {
                continue;
            }
            const childPath = path.join(resolved, entry.name);
            stack.push({ dir: childPath, depth: current.depth + 1 });
        }
    }

    return results.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function findModules(targetPath: string, overrides: SearchOverrides = {}): { path: string; name: string }[] {
    const options = getSearchOptions('modules', overrides);
    return discoverDirectories(targetPath, 'modules', options);
}

export function findRepositories(targetPath: string, overrides: SearchOverrides = {}): { path: string; name: string }[] {
    const options = getSearchOptions('repositories', overrides);
    return discoverDirectories(targetPath, 'repositories', options);
}

const PSAE_INTERNAL_REGEX = /^ps[a-z]*-internal$/i;

export interface RepoModuleInfo {
    path: string;
    name: string;
    repoName: string;
    repoPath: string;
    relativePath: string;
    isPsaeInternal: boolean;
    psInternalDirName?: string;
    psInternalDirPath?: string;
}

export interface PsaeInternalDirectoryInfo {
    path: string;
    repoName: string;
    dirName: string;
    moduleNames: string[];
}

export interface ModuleDiscoveryResult {
    modules: RepoModuleInfo[];
    psaeDirectories: PsaeInternalDirectoryInfo[];
}

export interface ModuleDiscoveryOptions {
    search?: SearchOverrides;
    manualIncludePaths?: string[];
}

function findRepoContext(repos: RepoModel[], targetPath: string): { repoName: string; repoPath: string } | undefined {
    for (const repo of repos) {
        const repoPath = normalizePath(repo.path);
        const relative = path.relative(repoPath, targetPath);
        if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
            return { repoName: repo.name, repoPath };
        }
        if (!relative.startsWith('..')) {
            // When target is exactly the repo root, relative can be ''
            return { repoName: repo.name, repoPath };
        }
    }
    return undefined;
}

function addPsaeDirectory(
    psaeMap: Map<string, { repoName: string; dirName: string; moduleNames: Set<string> }>,
    pathKey: string,
    repoName: string,
    dirName: string
) {
    if (!psaeMap.has(pathKey)) {
        psaeMap.set(pathKey, { repoName, dirName, moduleNames: new Set<string>() });
    }
}

function toPosixRelative(relativePath: string): string {
    return relativePath.split(path.sep).join('/');
}

export function discoverModulesInRepos(repos: RepoModel[], options: ModuleDiscoveryOptions = {}): ModuleDiscoveryResult {
    const modulesByPath = new Map<string, RepoModuleInfo>();
    const psaeDirectories = new Map<string, { repoName: string; dirName: string; moduleNames: Set<string> }>();
    const searchOverrides = options.search ?? {};

    const accumulateModule = (entry: { path: string; name: string }, repoName: string, repoRoot: string) => {
        const resolvedRepoRoot = path.resolve(repoRoot);
        const resolvedModulePath = path.resolve(entry.path);
        const relative = path.relative(resolvedRepoRoot, resolvedModulePath);
        const normalizedRelative = relative ? toPosixRelative(relative) : entry.name;
        const segments = normalizedRelative.split('/').filter(Boolean);
        const psaeIndex = segments.findIndex(segment => PSAE_INTERNAL_REGEX.test(segment));

        let isPsaeInternal = false;
        let psInternalDirName: string | undefined;
        let psInternalDirPath: string | undefined;

        if (psaeIndex >= 0) {
            isPsaeInternal = true;
            psInternalDirName = segments[psaeIndex];
            const dirSegments = segments.slice(0, psaeIndex + 1);
            psInternalDirPath = path.join(resolvedRepoRoot, ...dirSegments);
            addPsaeDirectory(psaeDirectories, psInternalDirPath, repoName, psInternalDirName);
            psaeDirectories.get(psInternalDirPath)?.moduleNames.add(entry.name);
        }

        modulesByPath.set(resolvedModulePath, {
            path: resolvedModulePath,
            name: entry.name,
            repoName,
            repoPath: resolvedRepoRoot,
            relativePath: normalizedRelative,
            isPsaeInternal,
            psInternalDirName,
            psInternalDirPath
        });
    };

    for (const repo of repos) {
        const repoPath = normalizePath(repo.path);
        if (!fs.existsSync(repoPath)) {
            continue;
        }
        const repoModules = findModules(repoPath, searchOverrides);
        for (const module of repoModules) {
            accumulateModule(module, repo.name, repoPath);
        }
    }

    for (const manualRaw of options.manualIncludePaths ?? []) {
        const manualPath = normalizePath(manualRaw);
        if (!fs.existsSync(manualPath)) {
            continue;
        }

        const repoContext = findRepoContext(repos, manualPath);
        const repoName = repoContext?.repoName ?? 'unknown';
        const repoRoot = repoContext?.repoPath ?? path.dirname(manualPath);
        const resolvedRepoRoot = path.resolve(repoRoot);
        const dirName = path.basename(manualPath);

        addPsaeDirectory(psaeDirectories, manualPath, repoName, dirName);

        const manualModules = findModules(manualPath, searchOverrides);
        for (const module of manualModules) {
            if (modulesByPath.has(path.resolve(module.path))) {
                psaeDirectories.get(manualPath)?.moduleNames.add(module.name);
                continue;
            }

            const relative = repoContext
                ? toPosixRelative(path.relative(resolvedRepoRoot, module.path))
                : toPosixRelative(path.join(dirName, module.name));

            modulesByPath.set(path.resolve(module.path), {
                path: path.resolve(module.path),
                name: module.name,
                repoName,
                repoPath: resolvedRepoRoot,
                relativePath: relative || module.name,
                isPsaeInternal: true,
                psInternalDirName: dirName,
                psInternalDirPath: manualPath
            });

            psaeDirectories.get(manualPath)?.moduleNames.add(module.name);
        }
    }

    const modules = Array.from(modulesByPath.values()).sort((a, b) => {
        const repoCompare = a.repoName.localeCompare(b.repoName, undefined, { sensitivity: 'base' });
        if (repoCompare !== 0) {
            return repoCompare;
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    const psaeDirs = Array.from(psaeDirectories.entries())
        .map(([dirPath, info]) => ({
            path: dirPath,
            repoName: info.repoName,
            dirName: info.dirName,
            moduleNames: Array.from(info.moduleNames).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        }))
        .sort((a, b) => {
            const repoCompare = a.repoName.localeCompare(b.repoName, undefined, { sensitivity: 'base' });
            if (repoCompare !== 0) {
                return repoCompare;
            }
            return a.dirName.localeCompare(b.dirName, undefined, { sensitivity: 'base' });
        });

    return { modules, psaeDirectories: psaeDirs };
}

/**
 * Creates a read-only tree item used for informational placeholders.
 */
export function createInfoTreeItem(message: string): vscode.TreeItem {
    const item = new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'info';
    return item;
}

// ============================================================================
// FILE I/O UTILITIES
// ============================================================================

/**
 * Creates initial data files for the Odoo debugger
 * @param filePath - full path to the file to create
 * @param workspacePath - workspace root path
 * @param fileName - name of the file to create
 * @returns the initial data object
 */
async function createOdooDebuggerFile(filePath: string, workspacePath: string, fileName: string): Promise<any> {
    try {
        ensureVSCodeDirectory(workspacePath);

        let data;
        let content: string;

        if (fileName === "launch.json") {
            data = {
                version: "0.2.0",
                configurations: []
            };
            content = launchJsonFileContent;
        } else {
            data = {
                settings: new SettingsModel(),
                projects: []
            };
            content = debuggerDataFileContent;
        }

        fs.writeFileSync(filePath, content, 'utf-8');
        return data;
    } catch (error) {
        showError(`Failed to create ${fileName}: ${error}`);
        throw error;
    }
}

/**
 * Reads and parses a JSON file from the .vscode directory
 * @param fileName - the name of the file to read
 * @returns the parsed data or null if reading fails
 */
export async function readFromFile(fileName: string): Promise<any> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
        return null;
    }

    try {
        const filePath = path.join(workspacePath, '.vscode', fileName);

        if (!fs.existsSync(filePath)) {
            showInfo(`Creating ${fileName} file...`);
            return await createOdooDebuggerFile(filePath, workspacePath, fileName);
        }

        const data = fs.readFileSync(filePath, 'utf-8');
        return parse(data);
    } catch (error) {
        showError(`Failed to read ${fileName}: ${error}`);
        return null;
    }
}

// ============================================================================
// UI & MESSAGING UTILITIES
// ============================================================================

/**
 * Output channel for logging messages
 */
let outputChannel: vscode.OutputChannel | null = null;

/**
 * Gets or creates the output channel for logging
 */
function getOutputChannel(): vscode.OutputChannel {
    outputChannel ??= vscode.window.createOutputChannel('Odoo Debugger');
    return outputChannel;
}

/**
 * Message types for the show message function
 */
export enum MessageType {
    Error = 'error',
    Warning = 'warning',
    Info = 'info'
}

/**
 * Shows a message with logging to output channel and console
 * @param message - the message to display
 * @param type - the type of message (error, warning, info)
 * @param actions - optional action buttons
 * @returns the selected action or undefined
 */
export async function showMessage(
    message: string,
    type: MessageType = MessageType.Error,
    ...actions: string[]
): Promise<string | undefined> {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${type.toUpperCase()}: ${message}`;

    // Log to output channel
    const channel = getOutputChannel();
    channel.appendLine(logMessage);

    // Log to console for debugging
    switch (type) {
        case MessageType.Error:
            console.error(`[Odoo Debugger] ${logMessage}`);
            break;
        case MessageType.Warning:
            console.warn(`[Odoo Debugger] ${logMessage}`);
            break;
        case MessageType.Info:
            console.info(`[Odoo Debugger] ${logMessage}`);
            break;
    }

    // Show the appropriate message type
    let result: string | undefined;

    switch (type) {
        case MessageType.Error:
            if (actions.length > 0) {
                result = await vscode.window.showErrorMessage(message, ...actions);
            } else {
                vscode.window.showErrorMessage(message);
            }
            break;
        case MessageType.Warning:
            if (actions.length > 0) {
                result = await vscode.window.showWarningMessage(message, ...actions);
            } else {
                vscode.window.showWarningMessage(message);
            }
            break;
        case MessageType.Info:
            if (actions.length > 0) {
                result = await vscode.window.showInformationMessage(message, ...actions);
            } else {
                vscode.window.showInformationMessage(message);
            }
            break;
    }

    return result;
}

/**
 * Shows an error message with optional actions (backward compatibility)
 * @param message - the error message to display
 * @param actions - optional action buttons
 * @returns the selected action or undefined
 */
export async function showError(message: string, ...actions: string[]): Promise<string | undefined> {
    return showMessage(message, MessageType.Error, ...actions);
}

/**
 * Shows an info message with optional actions
 * @param message - the info message to display
 * @param actions - optional action buttons
 * @returns the selected action or undefined
 */
export async function showInfo(message: string, ...actions: string[]): Promise<string | undefined> {
    return showMessage(message, MessageType.Info, ...actions);
}

/**
 * Shows a warning message with optional actions
 * @param message - the warning message to display
 * @param actions - optional action buttons
 * @returns the selected action or undefined
 */
export async function showWarning(message: string, ...actions: string[]): Promise<string | undefined> {
    return showMessage(message, MessageType.Warning, ...actions);
}

/**
 * Shows an auto-dismissing information message that disappears after a specified time
 * @param message - the info message to display
 * @param timeoutMs - time in milliseconds before auto-dismiss (default: 3000ms = 3 seconds)
 * @returns void
 */
export function showAutoInfo(message: string, timeoutMs: number = 3000): void {
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: message,
        cancellable: false
    }, async (progress) => {
        // Show progress for visual feedback
        progress.report({ increment: 0 });

        // Auto-dismiss after timeout
        return new Promise<void>((resolve) => {
            setTimeout(() => {
                resolve();
            }, timeoutMs);
        });
    });

    // Also log to output channel and console
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] INFO (AUTO): ${message}`;

    const channel = getOutputChannel();
    channel.appendLine(logMessage);
    console.info(`[Odoo Debugger] ${logMessage}`);
}

/**
 * Shows a brief status bar message that disappears automatically
 * @param message - the message to display in status bar
 * @param timeoutMs - time in milliseconds before auto-dismiss (default: 2000ms = 2 seconds)
 */
export function showBriefStatus(message: string, timeoutMs: number = 2000): void {
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = `$(info) ${message}`;
    statusBarItem.show();

    // Auto-dismiss after timeout
    setTimeout(() => {
        statusBarItem.dispose();
    }, timeoutMs);

    // Also log to output channel and console
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] STATUS: ${message}`;

    const channel = getOutputChannel();
    channel.appendLine(logMessage);
    console.info(`[Odoo Debugger] ${logMessage}`);
}

/**
 * Converts a camelCase string to a human-readable title case
 * @param str - the camelCase string to convert
 * @returns the converted title case string
 */
export function camelCaseToTitleCase(str: string): string {
    if (!str) {
        return '';
    }
    return str.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase());
}

/**
 * Gets the display name for a settings key
 * @param key - The settings key in camelCase
 * @returns The human-readable display name
 */
export function getSettingDisplayName(key: string): string {
    const displayNames: Record<string, string> = {
        debuggerName: 'Debugger',
        debuggerVersion: 'Version',
        portNumber: 'Port',
        shellPortNumber: 'Shell Port',
        limitTimeReal: 'Time Limit (Real)',
        limitTimeCpu: 'Time Limit (CPU)',
        maxCronThreads: 'Max Cron Threads',
        extraParams: 'Extra Params',
        devMode: 'Dev Mode',
        installApps: 'Install Apps',
        upgradeApps: 'Upgrade Apps',
        dumpsFolder: 'Dumps Dir',
        odooPath: 'Odoo Dir',
        enterprisePath: 'Enterprise Dir',
        designThemesPath: 'Themes Dir',
        customAddonsPath: 'Custom Addons',
        pythonPath: 'Python Exec',
        subModulesPaths: 'Sub-modules'
    };

    return displayNames[key] || camelCaseToTitleCase(key);
}

/**
 * Gets the display value for a setting, cleaning up internal prefixes for UI display
 * @param key - The settings key
 * @param value - The internal setting value
 * @returns The cleaned value for UI display
 */
export function getSettingDisplayValue(key: string, value: any): string {
    if (key === 'devMode' && typeof value === 'string' && value.startsWith('--dev=')) {
        // Remove --dev= prefix for display, show clean value
        return value.substring(6) || 'none';
    }
    return value?.toString() || '';
}

/**
 * Gets the current git branch for a given repository path.
 * @param repoPath - The path to the git repository.
 * @returns The current branch name, or null if not found or error occurs.
 */
export async function getGitBranch(repoPath: string | undefined): Promise<string | null> {
    if (!repoPath) {return null;}
    const gitHeadPath = path.join(repoPath, '.git', 'HEAD');
    try {
        if (fs.existsSync(gitHeadPath)) {
            const headContent = fs.readFileSync(gitHeadPath, 'utf-8').trim();
            const match = /^ref: refs\/heads\/(.+)$/.exec(headContent);
            return match ? match[1] : headContent;
        }
    } catch (err) {
        console.warn(`Failed to read branch for ${repoPath}: ${err}`);
    }
    return null;
}

/**
 * Gets all available Git branches from a repository path.
 * @param repoPath - The path to the git repository.
 * @returns Array of branch names, or empty array if not found or error occurs.
 */
export async function getGitBranches(repoPath: string | undefined): Promise<string[]> {
    if (!repoPath) {
        return [];
    }

    const normalizedPath = normalizePath(repoPath);

    const apiBranches = await getBranchesViaSourceControl(normalizedPath);
    if (apiBranches && apiBranches.length > 0) {
        return apiBranches;
    }

    try {
        // Check if it's a git repository
        const gitDir = path.join(normalizedPath, '.git');
        if (!fs.existsSync(gitDir)) {
            console.warn(`Not a git repository: ${normalizedPath}`);
            return [];
        }

        return new Promise<string[]>((resolve) => {
            childProcess.exec(
                'git branch -a --format="%(refname:short)"',
                { cwd: normalizedPath },
                (error, stdout, stderr) => {
                    if (error) {
                        console.warn(`Failed to get branches for ${normalizedPath}: ${error.message}`);
                        resolve([]);
                        return;
                    }

                    if (stderr) {
                        console.warn(`Git branch warning for ${normalizedPath}: ${stderr}`);
                    }

                    const branches = stdout
                        .split('\n')
                        .map(branch => branch.trim())
                        .filter(branch => {
                            // Filter out empty lines and HEAD reference
                            if (!branch || branch === 'HEAD') {
                                return false;
                            }
                            // Remove remote prefix for remote branches
                            return true;
                        })
                        .map(branch => {
                            // Clean up branch names
                            if (branch.startsWith('origin/')) {
                                return branch.replace('origin/', '');
                            }
                            if (branch.startsWith('remotes/origin/')) {
                                return branch.replace('remotes/origin/', '');
                            }
                            return branch;
                        })
                        .filter((branch, index, array) => {
                            // Remove duplicates (local and remote of same branch)
                            return array.indexOf(branch) === index;
                        })
                        .sort((a, b) => a.localeCompare(b)); // Sort alphabetically

                    resolve(branches);
                }
            );
        });
    } catch (err) {
        console.warn(`Failed to get branches for ${normalizedPath}: ${err}`);
        return [];
    }
}

/**
 * Get default settings for new versions from VS Code configuration
 * These settings can be configured via VS Code Settings UI or by searching for "odooDebugger.defaultVersion"
 * @returns SettingsModel with default values from configuration
 */
export function getDefaultVersionSettings(): any {
    const config = vscode.workspace.getConfiguration('odooDebugger.defaultVersion');

    return {
        debuggerName: config.get('debuggerName', 'odoo:18.0'),
        debuggerVersion: config.get('debuggerVersion', '1.0.0'),
        portNumber: config.get('portNumber', 8018),
        shellPortNumber: config.get('shellPortNumber', 5018),
        limitTimeReal: config.get('limitTimeReal', 0),
        limitTimeCpu: config.get('limitTimeCpu', 0),
        maxCronThreads: config.get('maxCronThreads', 0),
        extraParams: config.get('extraParams', '--log-handler,odoo.addons.base.models.ir_attachment:WARNING'),
        devMode: config.get('devMode', '--dev=all'),
        dumpsFolder: config.get('dumpsFolder', '/dumps'),
        odooPath: config.get('odooPath', './odoo'),
        enterprisePath: config.get('enterprisePath', './enterprise'),
        designThemesPath: config.get('designThemesPath', './design-themes'),
        customAddonsPath: config.get('customAddonsPath', './custom-addons'),
        pythonPath: config.get('pythonPath', './venv/bin/python'),
        subModulesPaths: config.get('subModulesPaths', ''),
        installApps: config.get('installApps', ''),
        upgradeApps: config.get('upgradeApps', ''),
        preCheckoutCommands: config.get('preCheckoutCommands', []),
        postCheckoutCommands: config.get('postCheckoutCommands', [])
    };
}
