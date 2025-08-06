import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SettingsModel } from './models/settings';
import { ProjectModel } from './models/project';
import { RepoModel } from './models/repo';
import { modify, applyEdits, parse } from 'jsonc-parser';

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
    "projects": {}
}`;

// ============================================================================
// INTERFACES
// ============================================================================

export interface DebuggerData {
    settings: any;
    projects: ProjectModel[];
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
// WORKSPACE & PATH UTILITIES
// ============================================================================

/**
 * Checks if a workspace folder is open
 * @returns true if workspace is open, false otherwise
 */
export function checkWorkSpaceOrFolderOpened(): boolean {
    return !!vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
}

/**
 * Gets the workspace folder path with validation
 * @returns workspace path or null if no workspace is open
 */
export function getWorkspacePath(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        showError("No workspace open.");
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

/**
 * Gets folder paths and names from a target directory, filtering out hidden directories
 * @param targetPath - the path to scan for directories
 * @returns array of objects containing path and name for each directory
 */
export function listSubdirectories(targetPath: string): { path: string; name: string }[] {
    if (!targetPath) {
        showError('Target path is required');
        return [];
    }

    try {
        if (!fs.existsSync(targetPath)) {
            showError(`Path does not exist: ${targetPath}`);
            return [];
        }

        const entries = fs.readdirSync(targetPath);
        const result: { path: string; name: string }[] = [];

        for (const entry of entries) {
            // Skip hidden files/directories
            if (entry.startsWith('.')) {
                continue;
            }

            const fullPath = path.join(targetPath, entry);

            try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    result.push({
                        path: fullPath,
                        name: entry
                    });
                }
            } catch (statError) {
                // Skip entries that can't be stat'd (permission issues, etc.)
                console.warn(`Skipping ${fullPath}: ${statError}`);
            }
        }

        return result;
    } catch (error) {
        showError(`Error reading directory ${targetPath}: ${error}`);
        return [];
    }
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
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Odoo Debugger');
    }
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
            const match = headContent.match(/^ref: refs\/heads\/(.+)$/);
            return match ? match[1] : headContent;
        }
    } catch (err) {
        console.warn(`Failed to read branch for ${repoPath}: ${err}`);
    }
    return null;
}

// ============================================================================
// PSAE-INTERNAL UTILITIES
// ============================================================================

/**
 * Checks if psae-internal directory exists in the given path
 * @param basePath - the base path to check for psae-internal
 * @returns the full path to psae-internal if it exists, null otherwise
 */
export function findPsaeInternalPath(basePath: string): string | null {
    const normalizedPath = normalizePath(basePath);
    const psaeInternalPath = path.join(normalizedPath, 'psae-internal');
    
    try {
        if (fs.existsSync(psaeInternalPath) && fs.statSync(psaeInternalPath).isDirectory()) {
            return psaeInternalPath;
        }
    } catch (error) {
        // Directory doesn't exist or isn't accessible
    }
    
    return null;
}

/**
 * Auto-detects psae-internal paths from project repositories
 * @param repos - array of repository models
 * @returns array of detected psae-internal paths
 */
export function autoDetectPsaeInternal(repos: RepoModel[]): string[] {
    const psaePaths: string[] = [];
    
    for (const repo of repos) {
        const psaePath = findPsaeInternalPath(repo.path);
        if (psaePath) {
            psaePaths.push(psaePath);
        }
    }
    
    return psaePaths;
}
