import * as vscode from 'vscode';
import { DatabaseModel } from './models/db';
import { ModuleModel } from './models/module';
import { VersionModel } from './models/version';
import { discoverModulesInRepos, normalizePath, getGitBranch, showError, showInfo, showWarning, showAutoInfo, showBriefStatus, addActiveIndicator, stripSettings, getDatabaseLabel } from './utils';
import { SettingsStore } from './settingsStore';
import { VersionsService } from './versionsService';
import { execSync, exec, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RepoModel } from './models/repo';
import { randomUUID } from 'crypto';
import { checkoutBranchViaSourceControl } from './services/gitService';
import { generateDatabaseIdentifiers, DatabaseKind } from './services/dbNaming';
import * as os from 'os';
import { SortPreferences } from './sortPreferences';
import { getDefaultSortOption } from './sortOptions';
import { PassThrough, Readable } from 'stream';
import { clearInstalledModuleCache } from './services/database';
import { invalidateGitBranchCache } from './services/runtimeCache';

const checkoutHooksOutput = vscode.window.createOutputChannel('Odoo Debugger: Branch Hooks');

/**
 * Gets the effective Odoo version for a database object.
 * Works with both DatabaseModel instances and plain database objects.
 */
function getEffectiveOdooVersion(db: DatabaseModel | any): string | undefined {
    // If it's a DatabaseModel instance, use its method
    if (db && typeof db.getEffectiveOdooVersion === 'function') {
        return db.getEffectiveOdooVersion();
    }

    // For plain objects, implement the same logic
    if (db && db.versionId) {
        try {
            const versionsService = VersionsService.getInstance();
            const version = versionsService.getVersion(db.versionId);
            if (version) {
                return version.odooVersion;
            }
        } catch (error) {
            console.warn(`Failed to get version for database ${getDatabaseLabel(db)}:`, error);
        }
    }
    // Fall back to legacy odooVersion property
    return db?.odooVersion || undefined;
}

/**
 * Gets the version name for a database object if it has a version assigned.
 * Works with both DatabaseModel instances and plain database objects.
 */
function getVersionName(db: DatabaseModel | any): string | undefined {
    // If it's a DatabaseModel instance, use its method
    if (db && typeof db.getVersionName === 'function') {
        return db.getVersionName();
    }

    // For plain objects, implement the same logic
    if (db && db.versionId) {
        try {
            const versionsService = VersionsService.getInstance();
            const version = versionsService.getVersion(db.versionId);
            return version?.name;
        } catch (error) {
            console.warn(`Failed to get version name for database ${getDatabaseLabel(db)}:`, error);
            return undefined;
        }
    }
    return undefined;
}

async function collectExistingDatabaseIdentifiers(): Promise<Set<string>> {
    const data = await SettingsStore.get('odoo-debugger-data.json');
    const identifiers = new Set<string>();

    for (const project of data.projects ?? []) {
        for (const db of project.dbs ?? []) {
            if (db && typeof db.id === 'string') {
                identifiers.add(db.id.toLowerCase());
            }
        }
    }

    return identifiers;
}

function buildDumpDeterministicSeed(sqlDumpPath: string, projectName: string, repoSignature: string): string {
    try {
        const stats = fs.statSync(sqlDumpPath);
        return [
            path.resolve(sqlDumpPath),
            projectName,
            repoSignature,
            stats.size,
            Math.floor(stats.mtimeMs)
        ].join('|');
    } catch (error) {
        console.warn(`Failed to read dump metadata from ${sqlDumpPath}:`, error);
        return [path.resolve(sqlDumpPath), projectName, repoSignature].join('|');
    }
}

function buildStandardDeterministicSeed(projectName: string, kind: string, timestamp: Date, branchName: string | undefined, versionId: string | undefined, repoSignature: string): string {
    return [
        projectName,
        kind,
        branchName ?? '',
        versionId ?? '',
        repoSignature,
        timestamp.toISOString()
    ].join('|');
}

function buildRepoSignature(repos: RepoModel[]): string {
    return repos
        .map(repo => normalizePath(repo.path))
        .sort((a, b) => a.localeCompare(b))
        .join('|');
}

async function promptBranchSwitch(targetVersion: string, currentBranches: {odoo: string | null, enterprise: string | null, designThemes: string | null}): Promise<boolean> {
    const mismatchedRepos = [];
    if (currentBranches.odoo !== targetVersion) {
        mismatchedRepos.push(`Odoo (currently: ${currentBranches.odoo || 'unknown'})`);
    }
    if (currentBranches.enterprise !== targetVersion) {
        mismatchedRepos.push(`Enterprise (currently: ${currentBranches.enterprise || 'unknown'})`);
    }
    if (currentBranches.designThemes !== targetVersion) {
        mismatchedRepos.push(`Design Themes (currently: ${currentBranches.designThemes || 'unknown'})`);
    }

    if (mismatchedRepos.length === 0) {
        return false; // No switch needed
    }

    const message = `Database requires Odoo version ${targetVersion}, but the following repositories are on different branches:\n\n${mismatchedRepos.join('\n')}\n\nWould you like to switch all repositories to version ${targetVersion}?`;

    const choice = await vscode.window.showWarningMessage(
        message,
        { modal: false },
        'Switch Branches',
        'Keep Current Branches'
    );

    return choice === 'Switch Branches';
}
import { SettingsModel } from './models/settings';

/**
 * Helper function to extract DatabaseModel from various event sources
 * (direct database object, VS Code TreeItem, or command arguments)
 */
function extractDatabaseFromEvent(event: any): DatabaseModel | null {
    if (!event) {
        return null;
    }

    // Check if we received a VS Code TreeItem (context menu call)
    // TreeItems have properties like collapsibleState, label, id, and our custom database property
    if (typeof event === 'object' &&
        'collapsibleState' in event &&
        'label' in event &&
        'database' in event &&
        event.database) {
        return event.database;
    }

    // Check if it's a direct database object (has required DatabaseModel properties)
    if (typeof event === 'object' &&
        event.name &&
        event.id &&
        typeof event.name === 'string' &&
        typeof event.id === 'string') {
        return event;
    }

    return null;
}


export class DbsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private readonly sortPreferences: SortPreferences) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
        return item;
    }
    async getChildren(_element?: any): Promise<vscode.TreeItem[]> {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            return [];
        }

        const { project } = result;
        const dbs: DatabaseModel[] = project.dbs;
        if (!dbs) {
            showError('No databases are configured for this project.');
            return [];
        }

        const sortId = this.sortPreferences.get('dbSelector', getDefaultSortOption('dbSelector'));
        const sortedDbs = [...dbs].sort((a, b) => this.compareDatabases(a, b, sortId));

        return sortedDbs.map(db => {
            // Handle date parsing defensively
            let editedDate: Date;
            try {
                editedDate = new Date(db.createdAt);
                if (isNaN(editedDate.getTime())) {
                    // If date is invalid, use current date
                    editedDate = new Date();
                }
            } catch {
                // If date parsing fails, use current date
                editedDate = new Date();
            }

            const formattedDate = `${editedDate.toISOString().split('T')[0]} ${editedDate.toTimeString().split(' ')[0]}`;

            const dbLabel = getDatabaseLabel(db);
            const badges = `${db.isItABackup ? ' ☁️' : ''}${db.isExisting ? ' 📂' : ''}`;
            const mainLabel = addActiveIndicator(dbLabel, db.isSelected) + badges;

                        // Description shows branch and version info as subtext
            let description = '';
            if (db.versionId) {
                // Try to get version name from versions service
                try {
                    const versionsService = VersionsService.getInstance();
                    const version = versionsService.getVersion(db.versionId);
                    if (version) {
                        // Show branch first if different from version's odoo version, then version
                        if (db.branchName && db.branchName !== version.odooVersion) {
                            description = `🌿 ${db.branchName} • 📦 ${version.name}`;
                        } else {
                            description = `📦 ${version.name}`;
                        }
                    } else {
                        // Fallback to version ID if version not found
                        if (db.branchName) {
                            description = `🌿 ${db.branchName} • 📦 ${db.versionId.substring(0, 8)}...`;
                        } else {
                            description = `📦 ${db.versionId.substring(0, 8)}...`;
                        }
                    }
                } catch (error) {
                    // Fallback to version ID if versions service fails
                    if (db.branchName) {
                        description = `🌿 ${db.branchName} • 📦 ${db.versionId.substring(0, 8)}...`;
                    } else {
                        description = `📦 ${db.versionId.substring(0, 8)}...`;
                    }
                }
            } else if (db.branchName && db.branchName.trim() !== '') {
                // Show branch when no version is selected
                description = `🌿 ${db.branchName}`;
                const effectiveOdooVersion = getEffectiveOdooVersion(db);
                if (effectiveOdooVersion && effectiveOdooVersion !== db.branchName) {
                    description += ` • 🛠️ ${effectiveOdooVersion}`;
                }
            } else {
                const effectiveOdooVersion = getEffectiveOdooVersion(db);
                if (effectiveOdooVersion && effectiveOdooVersion.trim() !== '') {
                    description = `🛠️ ${effectiveOdooVersion}`;
                } else {
                    description = '';
                }
            }

            const treeItem = new vscode.TreeItem(mainLabel, vscode.TreeItemCollapsibleState.None);
            treeItem.id = `${db.id}-${formattedDate}`;
            treeItem.description = description;

            // Create tooltip - push each detail into array, join with \n\n at the end
            const tooltipDetails = [];

            // Database name header
            tooltipDetails.push(`**${dbLabel}**`);
            tooltipDetails.push(`**Internal name:** ${db.id}`);

            // Version information
            if (db.versionId) {
                try {
                    const versionsService = VersionsService.getInstance();
                    const version = versionsService.getVersion(db.versionId);
                    if (version) {
                        tooltipDetails.push(`**Version:** ${version.name}`);
                        tooltipDetails.push(`**Odoo Version:** ${version.odooVersion}`);
                    } else {
                        tooltipDetails.push(`**Version ID:** ${db.versionId}`);
                    }
                } catch (error) {
                    tooltipDetails.push(`**Version ID:** ${db.versionId}`);
                }
            } else {
                tooltipDetails.push(`**Version:** None`);
                // Get Odoo version from effective lookup (legacy odooVersion property)
                const effectiveOdooVersion = getEffectiveOdooVersion(db);
                if (effectiveOdooVersion) {
                    tooltipDetails.push(`**Odoo Version:** ${effectiveOdooVersion}`);
                }
            }

            // Branch information
            if (db.branchName) {
                tooltipDetails.push(`**Branch:** ${db.branchName}`);
            }

            // Database details
            tooltipDetails.push(`**Created:** ${formattedDate}`);

            // Database type
            if (db.isItABackup) {
                tooltipDetails.push(`**Type:** Restored from backup`);
                if (db.sqlFilePath) {
                    tooltipDetails.push(`**Backup Path:** ${db.sqlFilePath}`);
                }
            } else if (db.isExisting) {
                tooltipDetails.push(`**Type:** Connected to existing database`);
            } else {
                tooltipDetails.push(`**Type:** Fresh database`);
            }

            // Status
            if (db.isSelected) {
                tooltipDetails.push(`**Status:** Currently selected`);
            }

            // Module information
            if (db.modules && db.modules.length > 0) {
                tooltipDetails.push(`**Modules:** ${db.modules.length} installed`);
            }

            // Join all details with double newlines
            const tooltip = tooltipDetails.join('\n\n');

            treeItem.tooltip = new vscode.MarkdownString(tooltip);

            // Set contextValue to enable right-click context menu
            treeItem.contextValue = 'database';

            // Store the database object for commands that need it
            (treeItem as any).database = db;

            treeItem.command = {
                command: 'dbSelector.selectDb',
                title: 'Select DB',
                arguments: [db]
            };
            return treeItem;
        });
    }

    private compareDatabases(a: DatabaseModel, b: DatabaseModel, sortId: string): number {
        const activeDelta = Number(b.isSelected) - Number(a.isSelected);
        if (activeDelta !== 0) {
            return activeDelta;
        }

        switch (sortId) {
            case 'db:name:asc':
                return this.getNameValue(a).localeCompare(this.getNameValue(b));
            case 'db:name:desc':
                return this.getNameValue(b).localeCompare(this.getNameValue(a));
            case 'db:created:newest':
                return this.getCreatedTimestamp(b) - this.getCreatedTimestamp(a);
            case 'db:created:oldest':
                return this.getCreatedTimestamp(a) - this.getCreatedTimestamp(b);
            case 'db:branch:asc':
                return this.compareBranch(a, b, false);
            case 'db:branch:desc':
                return this.compareBranch(a, b, true);
            default:
                return this.getNameValue(a).localeCompare(this.getNameValue(b));
        }
    }

    private getCreatedTimestamp(db: DatabaseModel): number {
        if (db.createdAt instanceof Date) {
            return db.createdAt.getTime();
        }
        const date = new Date(db.createdAt);
        return isNaN(date.getTime()) ? 0 : date.getTime();
    }

    private getBranchValue(db: DatabaseModel): string {
        if (db.branchName && db.branchName.trim() !== '') {
            return db.branchName.toLowerCase();
        }
        const effective = getEffectiveOdooVersion(db);
        return effective ? effective.toLowerCase() : '';
    }

    private getNameValue(db: DatabaseModel): string {
        return getDatabaseLabel(db).toLowerCase();
    }

    private compareBranch(a: DatabaseModel, b: DatabaseModel, descending: boolean): number {
        const aBranch = this.getBranchValue(a);
        const bBranch = this.getBranchValue(b);
        const aHas = aBranch.trim().length > 0;
        const bHas = bBranch.trim().length > 0;

        const missingDelta = Number(bHas) - Number(aHas);
        if (missingDelta !== 0) {
            return descending ? -missingDelta : missingDelta;
        }

        if (descending) {
            return bBranch.localeCompare(aBranch);
        }
        return aBranch.localeCompare(bBranch);
    }
}

export async function showBranchSelector(repoPath: string): Promise<string | undefined> {
    repoPath = normalizePath(repoPath);
    if (!repoPath || !fs.existsSync(repoPath)) {
        showError(`Repository path does not exist: ${repoPath}`);
        return undefined;
    }
    try {
        const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
            exec('git branch --all --format="%(refname:short)"', { cwd: repoPath }, (err, stdout, stderr) => {
                if (err || stderr) {
                    reject(new Error(`Failed to fetch branches in ${repoPath}: ${stderr || (err?.message || 'Unknown error')}`));
                } else {
                    resolve({ stdout });
                }
            });
        });

        const branches = stdout
            .split('\n')
            .map((b: string) => b.trim())
            .filter((b: string) => b.length && !b.includes('->'));

        const result = await vscode.window.showQuickPick(branches, {
            placeHolder: 'Select a branch to switch to',
            canPickMany: false,
            ignoreFocusOut: true
        });
        return result;
    } catch (error: any) {
        showError(error.message);
        return undefined;
    }
}

export async function checkoutBranch(settings: SettingsModel, branch: string): Promise<void> {
    const quoteForSingleQuotedShell = (value: string): string => `'${value.replace(/'/g, `'\"'\"'`)}'`;

    const buildHookExecutionScript = (
        commands: string[],
        phase: 'pre-checkout' | 'post-checkout',
        contextLabel: string
    ): string => {
        const lines: string[] = [
            'set -e',
            '__odt_now_ms() {',
            '  local __odt_now',
            '  __odt_now="$(date +%s%3N 2>/dev/null)"',
            '  if [ -n "$__odt_now" ]; then',
            '    printf \'%s\\n\' "$__odt_now"',
            '    return',
            '  fi',
            '  __odt_now="$(date +%s)"',
            '  printf \'%s\\n\' "$((__odt_now * 1000))"',
            '}'
        ];

        commands.forEach((command, index) => {
            const prefix = `[${phase}] ${contextLabel}: [${index + 1}/${commands.length}]`;
            lines.push(`__odt_cmd=${quoteForSingleQuotedShell(command)}`);
            lines.push(`__odt_prefix=${quoteForSingleQuotedShell(prefix)}`);
            lines.push('__odt_start=$(__odt_now_ms)');
            lines.push('printf \'%s\\n\' "$__odt_prefix START $__odt_cmd"');
            lines.push('set +e');
            lines.push('eval "$__odt_cmd"');
            lines.push('__odt_exit=$?');
            lines.push('set -e');
            lines.push('__odt_end=$(__odt_now_ms)');
            lines.push('printf \'%s\\n\' "$__odt_prefix END exit=$__odt_exit duration_ms=$((__odt_end - __odt_start))"');
            lines.push('if [ $__odt_exit -ne 0 ]; then');
            lines.push('  exit $__odt_exit');
            lines.push('fi');
        });

        return lines.join('\n');
    };

    const runCheckoutHookCommands = async (
        commands: string[] | undefined,
        phase: 'pre-checkout' | 'post-checkout',
        cwd: string,
        contextLabel: string,
        progress?: vscode.Progress<{ message?: string; increment?: number; }>
    ): Promise<boolean> => {
        if (!Array.isArray(commands) || commands.length === 0) {
            return true;
        }

        const normalizedCommands = commands.map(cmd => cmd.trim()).filter(Boolean);
        if (normalizedCommands.length === 0) {
            return true;
        }

        progress?.report({ message: `${contextLabel}: ${phase} (${normalizedCommands.length} command(s))` });
        checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: running ${normalizedCommands.length} command(s) in: ${cwd}`);
        normalizedCommands.forEach((command, index) => {
            checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: [${index + 1}/${normalizedCommands.length}] $ ${command}`);
        });

        const taskName = `Odoo Debugger: ${contextLabel} ${phase}`;
        const script = buildHookExecutionScript(normalizedCommands, phase, contextLabel);
        const sanitizedLabel = contextLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
        const scriptPath = path.join(
            os.tmpdir(),
            `odoo-branch-hooks-${phase}-${sanitizedLabel}-${Date.now()}-${Math.random().toString(16).slice(2)}.sh`
        );
        fs.writeFileSync(scriptPath, script, { encoding: 'utf8' });
        const task = new vscode.Task(
            { type: 'odooDebugger.branchHooks', phase, contextLabel },
            vscode.TaskScope.Workspace,
            taskName,
            'odooDebugger',
            new vscode.ShellExecution('/bin/bash', [scriptPath], { cwd }),
            []
        );
        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Silent,
            echo: false,
            focus: false,
            panel: vscode.TaskPanelKind.Dedicated,
            clear: false,
            showReuseMessage: false,
            close: true
        };

        const taskStartedAt = Date.now();
        let exitCode: number | undefined;
        try {
            const execution = await vscode.tasks.executeTask(task);
            exitCode = await new Promise<number | undefined>((resolve) => {
                const disposable = vscode.tasks.onDidEndTaskProcess(event => {
                    if (event.execution === execution) {
                        disposable.dispose();
                        resolve(event.exitCode);
                    }
                });
            });
        } finally {
            try {
                fs.rmSync(scriptPath, { force: true });
            } catch {
                // Ignore temporary script cleanup failures.
            }
        }
        const durationMs = Date.now() - taskStartedAt;

        if (exitCode !== 0 && exitCode !== undefined) {
            showError(`${contextLabel}: failed during ${phase} command batch (exit code ${exitCode})`);
            checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: FAILED (exit ${exitCode}, duration=${durationMs}ms)`);
            checkoutHooksOutput.show(true);
            return false;
        }

        if (exitCode === undefined) {
            showError(`${contextLabel}: failed during ${phase} command batch (no exit code)`);
            checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: FAILED (no exit code, duration=${durationMs}ms)`);
            checkoutHooksOutput.show(true);
            return false;
        }

        checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: OK (duration=${durationMs}ms)`);
        return true;
    };

    const repos = [
        { name: 'Odoo', path: normalizePath(settings.odooPath) },
        { name: 'Enterprise', path: normalizePath(settings.enterprisePath) },
        { name: 'Design Themes', path: normalizePath(settings.designThemesPath) }
    ];

    // Pull hook commands directly from VS Code settings (not per-version settings)
    const config = vscode.workspace.getConfiguration('odooDebugger.defaultVersion');
    const preCheckoutCommands = config.get<string[]>('preCheckoutCommands', []);
    const postCheckoutCommands = config.get<string[]>('postCheckoutCommands', []);

    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Switching to branch: ${branch}`,
        cancellable: false
    }, async (progress) => {
        const operationStartedAt = Date.now();
        const totalRepos = repos.length;
        let completedRepos = 0;

        const processRepository = async (repo: { name: string; path: string }): Promise<{ name: string; success: boolean; message: string }> => {
            progress.report({ message: `${repo.name}: processing` });

            if (!repo.path || repo.path.trim() === '') {
                return {
                    name: repo.name,
                    success: false,
                    message: 'Path not configured'
                };
            }

            if (!fs.existsSync(repo.path)) {
                return {
                    name: repo.name,
                    success: false,
                    message: `Repository path does not exist: ${repo.path}`
                };
            }

            const preOk = await runCheckoutHookCommands(preCheckoutCommands, 'pre-checkout', repo.path, repo.name, progress);
            if (!preOk) {
                return {
                    name: repo.name,
                    success: false,
                    message: `Pre-checkout hook(s) failed`
                };
            }

            const apiCheckoutSucceeded = await checkoutBranchViaSourceControl(repo.path, branch);

            let checkoutSucceededForRepo = false;
            let checkoutMessage = '';

            if (!apiCheckoutSucceeded) {
                try {
                    await new Promise<void>((resolve, reject) => {
                        exec(`git checkout ${branch}`, { cwd: repo.path }, (err, _stdout, stderr) => {
                            if (stderr && stderr.includes(`Already on '${branch}'`)) {
                                checkoutSucceededForRepo = true;
                                checkoutMessage = `Already on branch: ${branch}`;
                                resolve();
                                return;
                            }

                            if (err || (stderr && !stderr.includes('Switched to branch'))) {
                                checkoutSucceededForRepo = false;
                                checkoutMessage = stderr || err?.message || 'Unknown error';
                                reject(new Error(`Failed to checkout branch ${branch} in ${repo.name}`));
                                return;
                            }

                            checkoutSucceededForRepo = true;
                            checkoutMessage = `Switched to branch: ${branch}`;
                            resolve();
                        });
                    });
                } catch (error) {
                    return {
                        name: repo.name,
                        success: false,
                        message: checkoutMessage || 'Failed to checkout branch'
                    };
                }
            } else {
                checkoutSucceededForRepo = true;
                checkoutMessage = `Switched to branch ${branch}`;
            }

            if (checkoutSucceededForRepo) {
                invalidateGitBranchCache(repo.path);
                const postOk = await runCheckoutHookCommands(postCheckoutCommands, 'post-checkout', repo.path, repo.name, progress);
                return {
                    name: repo.name,
                    success: postOk,
                    message: postOk ? checkoutMessage : `${checkoutMessage} (but post-checkout hook(s) failed)`
                };
            }

            return {
                name: repo.name,
                success: false,
                message: checkoutMessage || 'Failed to checkout branch'
            };
        };

        const results = await Promise.all(repos.map(async repo => {
            const result = await processRepository(repo);
            completedRepos += 1;
            progress.report({
                message: `${repo.name}: completed (${completedRepos}/${totalRepos})`,
                increment: totalRepos > 0 ? (100 / totalRepos) : 0
            });
            checkoutHooksOutput.appendLine(`[checkout] ${repo.name}: ${result.success ? 'SUCCESS' : 'FAILED'} - ${result.message}`);
            return result;
        }));

        // Check results and provide feedback
        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);
        const totalDurationMs = Date.now() - operationStartedAt;

        if (failed.length === 0) {
            showInfo(`All repositories switched to branch: ${branch}`);
        } else if (successful.length > 0) {
            showWarning(`Partially switched to branch ${branch}. Failed: ${failed.map(f => f.name).join(', ')}`);
            // Show details of failures
            failed.forEach(f => {
                console.error(`${f.name}: ${f.message}`);
            });
        } else {
            showError(`Failed to switch any repository to branch: ${branch}`);
            // Show details of all failures
            failed.forEach(f => {
                console.error(`${f.name}: ${f.message}`);
            });
        }

        // Log successful switches
        successful.forEach(s => {
            console.log(`${s.name}: ${s.message}`);
        });
        checkoutHooksOutput.appendLine(`[checkout] Completed branch switch "${branch}" in ${totalDurationMs}ms (${successful.length}/${results.length} succeeded)`);
    });
}

interface DumpSelection {
    label: string;
    kind: 'folder' | 'zip' | 'file';
    path: string;
}

interface PreparedDump {
    kind: 'file' | 'stream';
    originalPath: string;
    progressMessage?: string;
    sqlPath?: string;
    openStream?: () => OpenedDumpStream;
    cleanup?: () => void;
}

interface OpenedDumpStream {
    stream: Readable;
    dispose: () => void;
}

function collectDumpSources(root: string, maxDepth = 2): DumpSelection[] {
    const results: DumpSelection[] = [];
    const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];

    while (stack.length > 0) {
        const { dir, depth } = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (error) {
            console.warn(`Failed to read dumps directory ${dir}:`, error);
            continue;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativeLabel = path.relative(root, fullPath) || entry.name;

            if (entry.isDirectory()) {
                const dumpSqlPath = path.join(fullPath, 'dump.sql');
                if (fs.existsSync(dumpSqlPath)) {
                    results.push({
                        label: relativeLabel,
                        kind: 'folder',
                        path: fullPath
                    });
                }
                if (depth < maxDepth) {
                    stack.push({ dir: fullPath, depth: depth + 1 });
                }
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
                results.push({
                    label: relativeLabel,
                    kind: 'zip',
                    path: fullPath
                });
            } else if (entry.isFile() && (entry.name.toLowerCase().endsWith('.sql') || entry.name.toLowerCase().endsWith('.gz'))) {
                results.push({
                    label: relativeLabel,
                    kind: 'file',
                    path: fullPath
                });
            }
        }
    }

    return results;
}

export async function getDbDumpFolder(dumpsFolder: string, searchFilter?: string): Promise<DumpSelection | undefined> {
    dumpsFolder = normalizePath(dumpsFolder);

    if (!fs.existsSync(dumpsFolder)) {
        showError(`Dumps folder not found: ${dumpsFolder}`);
        return undefined;
    }

    const matches = collectDumpSources(dumpsFolder);

    if (matches.length === 0) {
        showInfo(`No dump directories or zip archives found in ${path.basename(dumpsFolder)}.`);
        return undefined;
    }

    let foldersToShow = matches.map(item => ({
        label: item.label,
        description: item.path,
        detail: item.kind === 'zip' ? 'Zip archive' : item.kind === 'file' ? 'SQL dump file' : 'Folder',
        item
    }));

    if (searchFilter && searchFilter.trim() !== '') {
        const filterTerm = searchFilter.toLowerCase();
        const exact = foldersToShow.filter(item => item.label.toLowerCase() === filterTerm);
        const partial = foldersToShow.filter(item => item.label.toLowerCase().includes(filterTerm) && item.label.toLowerCase() !== filterTerm);
        const rest = foldersToShow.filter(item => !item.label.toLowerCase().includes(filterTerm));
        foldersToShow = [...exact, ...partial, ...rest];
    }

    const selected = await vscode.window.showQuickPick(foldersToShow, {
        placeHolder: searchFilter
            ? `Select a dump source (showing "${searchFilter}" matches first)`
            : 'Select a folder or zip archive containing dump.sql',
        ignoreFocusOut: true
    });

    return selected?.item;
}

type CreationMethod = 'fresh' | 'dump' | 'existing';

interface CreateDbOptions {
    allowExistingOption?: boolean;
    initialMethod?: CreationMethod;
}

const CREATION_METHOD_ITEMS: Record<CreationMethod, { label: string; description: string; detail: string; method: CreationMethod }> = {
    fresh: {
        label: 'Fresh Database',
        description: 'Create a new empty database and install modules',
        detail: 'Start with a clean Odoo installation',
        method: 'fresh'
    },
    dump: {
        label: 'From Dump File',
        description: 'Restore database from a dump/backup file',
        detail: 'Import an existing database backup',
        method: 'dump'
    },
    existing: {
        label: 'Connect to Existing',
        description: 'Reference an already existing database',
        detail: 'Use a database that already exists in PostgreSQL',
        method: 'existing'
    }
};

export async function createDb(projectName:string, repos:RepoModel[], dumpFolderPath:string, _settings: SettingsModel, options: CreateDbOptions = {}): Promise<DatabaseModel | undefined> {
    let selectedModules: string[] = [];
    let db: DatabaseModel | undefined;
    let modules: ModuleModel[] = [];

    // Step 1: Choose database creation method
    let creationMethod: CreationMethod | undefined;
    if (options.initialMethod) {
        creationMethod = options.initialMethod;
    } else {
        const methodItems = Object.values(CREATION_METHOD_ITEMS)
            .filter(item => options.allowExistingOption !== false || item.method !== 'existing');

        const selection = await vscode.window.showQuickPick(methodItems, {
            placeHolder: 'How do you want to create this database?',
            ignoreFocusOut: true
        });

        if (!selection) {
            return undefined; // User cancelled
        }
        creationMethod = selection.method;
    }

    let existingDbName: string | undefined;
    let isExistingDb = false;
    let sqlDumpPath: string | undefined;

    // Step 2: Handle the specific creation method
    switch (creationMethod) {
        case 'fresh':
            const allModules = discoverModulesInRepos(repos).modules.map(module => ({
                path: module.path,
                name: module.name,
                source: module.isPsaeInternal && module.psInternalDirName
                    ? `${module.repoName}/${module.psInternalDirName}`
                    : module.repoName
            }));

            // Select modules to install
            const moduleChoices = allModules.map(entry => ({
                label: entry.name,
                description: entry.source,
                detail: entry.path
            }));

            const selectedModuleObjects = await vscode.window.showQuickPick(moduleChoices, {
                placeHolder: 'Select modules to install (optional)',
                canPickMany: true,
                ignoreFocusOut: true
            });

            if (selectedModuleObjects === undefined) {
                return undefined;
            }

            selectedModules = selectedModuleObjects.map(choice => choice.label);
            break;

        case 'dump': {
            const selection = await getDbDumpFolder(dumpFolderPath, projectName);
            if (!selection) {
                return undefined;
            }
            if (selection.kind === 'folder') {
                const candidate = path.join(selection.path, 'dump.sql');
                if (!fs.existsSync(candidate)) {
                    showError(`dump.sql not found inside ${selection.path}`);
                    return undefined;
                }
                sqlDumpPath = candidate;
            } else {
                sqlDumpPath = selection.path;
            }
            break;
        }

        case 'existing':
            // Get existing database name
            existingDbName = await vscode.window.showInputBox({
                placeHolder: 'Enter the name of the existing PostgreSQL database',
                prompt: 'Make sure the database exists in your PostgreSQL instance',
                ignoreFocusOut: true
            });
            if (existingDbName === undefined) {
                return undefined;
            }
            if (!existingDbName.trim()) {
                showError('Enter a database name to continue.');
                return undefined;
            }
            existingDbName = existingDbName.trim();
            isExistingDb = true;
            break;
    }

    // Step 3: Get database branch name (optional)
    const branchInput = await vscode.window.showInputBox({
        placeHolder: 'Enter a branch/tag name for this database (optional)',
        prompt: 'This helps identify which version/branch this database represents',
        ignoreFocusOut: true
    });
    if (branchInput === undefined) {
        return undefined;
    }
    const branchName = branchInput.trim() || undefined;

    // Step 4: Select the Odoo version from available versions
    const versionsService = VersionsService.getInstance();
    await versionsService.initialize();
    const availableVersions = versionsService.getVersions();

    let selectedVersion: VersionModel | undefined;
    let selectedVersionId: string | undefined;

    if (availableVersions.length > 0) {
        const versionChoices = [
            {
                label: "$(close) No Version",
                description: "Use current branch settings",
                detail: "Database will use the current repository branches",
                versionId: undefined
            },
            ...availableVersions.map(version => ({
                label: `$(versions) ${version.name}`,
                description: `Odoo ${version.odooVersion}`,
                detail: `Use settings and configuration from ${version.name}`,
                versionId: version.id
            }))
        ];

        const selectedChoice = await vscode.window.showQuickPick(versionChoices, {
            placeHolder: 'Select a version for this database (optional)',
            ignoreFocusOut: true
        });

        if (selectedChoice === undefined) {
            return undefined;
        }

        selectedVersionId = selectedChoice.versionId;
        if (selectedVersionId) {
            selectedVersion = versionsService.getVersion(selectedVersionId);
        }
    }

    // Step 5: Create the database model
    for (const module of selectedModules) {
        modules.push(new ModuleModel(module, 'install'));
    }

    const creationTimestamp = new Date();
    const existingIdentifiers = await collectExistingDatabaseIdentifiers();
    const repoSignature = buildRepoSignature(repos);
    let dbKind: DatabaseKind = creationMethod === 'dump' ? 'dump' : 'fresh';
    let internalDbName: string;
    let displayDbName: string;

    if (isExistingDb) {
        if (!existingDbName) {
            throw new Error('Enter a database name to continue.');
        }
        internalDbName = existingDbName;
        displayDbName = existingDbName;
        dbKind = 'existing';
    } else {
        const deterministicSeed = creationMethod === 'dump' && sqlDumpPath
            ? buildDumpDeterministicSeed(sqlDumpPath, projectName, repoSignature)
            : buildStandardDeterministicSeed(projectName, dbKind, creationTimestamp, branchName, selectedVersionId, repoSignature);

        const identifiers = generateDatabaseIdentifiers({
            projectName,
            kind: dbKind,
            timestamp: creationTimestamp,
            deterministicSeed,
            existingInternalNames: existingIdentifiers
        });

        internalDbName = identifiers.internalName;
        displayDbName = identifiers.displayName;
        existingIdentifiers.add(internalDbName.toLowerCase());
    }

    db = new DatabaseModel(
        displayDbName,
        creationTimestamp,
        {
            modules,
            isItABackup: false, // isSelected (will be set when added to project)
            isSelected: true, // isActive
            sqlFilePath: sqlDumpPath,
            isExisting: isExistingDb,
            branchName,
            // Only set odooVersion if no version is selected (legacy compatibility)
            odooVersion: selectedVersionId ? undefined : (selectedVersion?.odooVersion || ''),
            versionId: selectedVersionId,
            displayName: displayDbName,
            internalName: internalDbName,
            kind: dbKind
        }
    );

    // Step 6: Set up the database if needed
    if (sqlDumpPath) {
        db.isItABackup = true;
        await setupDatabase(db.id, sqlDumpPath);
    } else if (!isExistingDb) {
        // Create fresh database
        await setupDatabase(db.id, undefined);
    }

    // Note: Version switching will be handled when the database is selected or activated,
    // not during creation, to avoid redundant prompts

    return db;
}

export async function restoreDb(event: any): Promise<void> {
    const database = extractDatabaseFromEvent(event);
    if (!database) {
        throw new Error('Invalid database object for restoration');
    }
    const databaseLabel = getDatabaseLabel(database);

    // Check if database has a backup file path
    if (!database.sqlFilePath || database.sqlFilePath.trim() === '') {
        throw new Error('No backup file path defined for this database');
    }

    // Ask for confirmation
    const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to restore the database "${databaseLabel}"? This will overwrite the existing database.`,
        { modal: true },
        'Restore'
    );

    if (confirm !== 'Restore') {
        return; // User cancelled
    }

    await setupDatabase(database.id, database.sqlFilePath);
    showAutoInfo(`Database "${databaseLabel}" restored successfully`, 3000);
}

export async function setupDatabase(dbName: string, dumpPath: string | undefined, remove: boolean = false): Promise<void> {
    if (dumpPath && !fs.existsSync(dumpPath)) {
        console.error(`❌ Dump file not found at: ${dumpPath}`);
        return;
    }

    let preparedDump: PreparedDump | undefined;
    try {
        preparedDump = dumpPath ? await prepareDumpForImport(dumpPath) : undefined;
    } catch (error: any) {
        showError(`Unable to read dump file: ${error.message ?? error}`);
        return;
    }

    const operation = remove ? 'Removing' : preparedDump ? 'Setting up' : 'Creating';

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `${operation} database ${dbName}`,
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ message: 'Checking database existence...', increment: 10 });
                const checkCommand = `psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`;
                const result = execSync(checkCommand).toString().trim();

                if (result === '1') {
                    progress.report({ message: 'Dropping existing database...', increment: 20 });
                    console.log(`🗑️ Dropping existing database: ${dbName}`);
                    execSync(`dropdb ${dbName}`, { stdio: 'inherit' });
                }
                clearInstalledModuleCache(dbName);

                if (!remove) {
                    progress.report({ message: 'Creating database...', increment: 40 });
                    console.log(`🚀 Creating database: ${dbName}`);
                    execSync(`createdb ${dbName}`, { stdio: 'inherit' });

                    if (preparedDump) {
                        progress.report({
                            message: preparedDump.progressMessage ?? 'Importing dump file...',
                            increment: 50
                        });
                        console.log(`📥 Importing SQL dump into ${dbName}`);
                        try {
                            await importPreparedDump(dbName, preparedDump);
                        } catch (error) {
                            if (dumpPath && preparedDump.kind === 'stream' && isToolchainUnavailableError(error)) {
                                console.warn('Streaming import unavailable. Falling back to temporary dump extraction.');
                                progress.report({
                                    message: dumpPath.toLowerCase().endsWith('.zip')
                                        ? 'Streaming unavailable. Extracting archive to temporary SQL file...'
                                        : 'Streaming unavailable. Decompressing dump to temporary SQL file...'
                                });
                                const fallbackDump = prepareDumpViaTempFile(dumpPath);
                                try {
                                    progress.report({ message: 'Importing extracted SQL dump...' });
                                    await importPreparedDump(dbName, fallbackDump);
                                } finally {
                                    fallbackDump.cleanup?.();
                                }
                            } else {
                                throw error;
                            }
                        }
                        clearInstalledModuleCache(dbName);

                        progress.report({ message: 'Configuring database...', increment: 70 });
                        console.log(`⚙️ Configuring database for development use`);

                        const newUuid = randomUUID();

                        console.log(`⏸️ Disabling cron jobs`);
                        execSync(`psql ${dbName} -c "UPDATE ir_cron SET active='f';"`, { stdio: 'inherit', shell: '/bin/sh' });

                        console.log(`📧 Disabling mail servers`);
                        execSync(`psql ${dbName} -c "UPDATE ir_mail_server SET active=false;"`, { stdio: 'inherit', shell: '/bin/sh' });

                        console.log(`⏰ Extending database expiry`);
                        execSync(`psql ${dbName} -c "UPDATE ir_config_parameter SET value = '2090-09-21 00:00:00' WHERE key = 'database.expiration_date';"`, { stdio: 'inherit', shell: '/bin/sh' });

                        console.log(`🔑 Updating database UUID`);
                        execSync(`psql ${dbName} -c "UPDATE ir_config_parameter SET value = '${newUuid}' WHERE key = 'database.uuid';"`, { stdio: 'inherit', shell: '/bin/sh' });

                        console.log(`📨 Adding mailcatcher server`);
                        try {
                            execSync(`psql ${dbName} -c "INSERT INTO ir_mail_server(active,name,smtp_host,smtp_port,smtp_encryption) VALUES (true,'mailcatcher','localhost',1025,false);"`, { stdio: 'inherit', shell: '/bin/sh' });
                        } catch (error) {
                            console.warn(`⚠️ Failed to add mailcatcher server (continuing setup): ${error}`);
                        }

                        console.log(`👤 Resetting user passwords to login names`);
                        execSync(`psql ${dbName} -c "UPDATE res_users SET password=login;"`, { stdio: 'inherit', shell: '/bin/sh' });

                        console.log(`🔐 Configuring admin user`);
                        execSync(`psql ${dbName} -c "UPDATE res_users SET password='admin' WHERE id=2;"`, { stdio: 'inherit', shell: '/bin/sh' });
                        execSync(`psql ${dbName} -c "UPDATE res_users SET login='admin' WHERE id=2;"`, { stdio: 'inherit', shell: '/bin/sh' });
                        execSync(`psql ${dbName} -c "UPDATE res_users SET totp_secret='' WHERE id=2;"`, { stdio: 'inherit', shell: '/bin/sh' });
                        execSync(`psql ${dbName} -c "UPDATE res_users SET active=true WHERE id=2;"`, { stdio: 'inherit', shell: '/bin/sh' });

                        console.log(`🏢 Clearing employee PINs`);
                        execSync(`psql ${dbName} -c "UPDATE hr_employee SET pin = '';"`, { stdio: 'inherit', shell: '/bin/sh' });

                        progress.report({ message: 'Database configured for development', increment: 90 });
                    } else {
                        progress.report({ message: 'Database created (empty)...', increment: 90 });
                        console.log(`📝 Empty database created: ${dbName}`);
                    }
                }

                progress.report({ message: 'Complete!', increment: 100 });
                console.log(`✅ Database "${dbName}" is ready.`);
            } catch (error: any) {
                console.error(`❌ Error: ${error.message}`);
                showError(`Failed to setup database: ${error.message}`);
            }
        });
    } finally {
        if (preparedDump?.cleanup) {
            try {
                preparedDump.cleanup();
            } catch (cleanupError) {
                console.warn('Failed to cleanup temporary dump files:', cleanupError);
            }
        }
    }
}

export async function selectDatabase(event: any) {
    const database = extractDatabaseFromEvent(event);
    if (!database) {
        showError('Could not identify the database to select.');
        return;
    }
    const databaseLabel = getDatabaseLabel(database);

    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;

    // Find the project index in the projects array
    const projectIndex = data.projects.findIndex((p: any) => p.uid === project.uid);
    if (projectIndex === -1) {
        showError('The selected project could not be found.');
        return;
    }

    // Update database selection
    const oldSelectedDbIndex = project.dbs.findIndex((db: DatabaseModel) => db.isSelected);
    if (oldSelectedDbIndex !== -1) {
        project.dbs[oldSelectedDbIndex].isSelected = false;
    }
    const newSelectedDbIndex = project.dbs.findIndex((db: DatabaseModel) => db.id === database.id);
    if (newSelectedDbIndex !== -1) {
        project.dbs[newSelectedDbIndex].isSelected = true;
    }

    // Save the updated databases array without settings
    const updatedData = stripSettings(data);
    await SettingsStore.saveWithoutComments(updatedData);

    // Handle version and branch switching with enhanced options
    try {
        await handleDatabaseVersionSwitch(database);
    } catch (error: any) {
        console.error('Error in database version switching:', error);
        showWarning(`Database selected, but version switching failed: ${error.message}`);
    }

    showBriefStatus(`Database switched to: ${databaseLabel}`, 2000);
}

async function handleDatabaseVersionSwitch(database: DatabaseModel): Promise<void> {
    const versionsService = VersionsService.getInstance();
    await versionsService.initialize();
    const settings = await versionsService.getActiveVersionSettings();
    const databaseLabel = getDatabaseLabel(database);

    // Get the database switch behavior setting
    const switchBehavior = vscode.workspace.getConfiguration('odooDebugger').get('databaseSwitchBehavior', 'ask') as string;

    // Check if database has a version associated with it
    if (database.versionId) {
        const dbVersion = versionsService.getVersion(database.versionId);
        if (dbVersion) {
            // Handle automatic behaviors first
            if (switchBehavior !== 'ask') {
                switch (switchBehavior) {
                    case 'auto-both':
                        // Automatically switch both version and branch
                        await versionsService.setActiveVersion(dbVersion.id);
                        const currentOdooBranch = await getGitBranch(settings.odooPath);
                        if (currentOdooBranch !== dbVersion.odooVersion) {
                            await checkoutBranch(settings, dbVersion.odooVersion);
                            showAutoInfo(`Auto-switched to version "${dbVersion.name}" and branch "${dbVersion.odooVersion}"`, 3000);
                        } else {
                            showAutoInfo(`Auto-switched to version "${dbVersion.name}" (branch already correct)`, 3000);
                        }
                        return;

                    case 'auto-version-only':
                        // Automatically switch version settings only
                        await versionsService.setActiveVersion(dbVersion.id);
                        showAutoInfo(`Auto-switched to version "${dbVersion.name}" settings`, 3000);
                        return;

                    case 'auto-branch-only':
                        // Automatically switch branches only (no version change)
                        const currentOdooBranchOnly = await getGitBranch(settings.odooPath);
                        if (currentOdooBranchOnly !== dbVersion.odooVersion) {
                            await checkoutBranch(settings, dbVersion.odooVersion);
                            showAutoInfo(`Auto-switched to branch "${dbVersion.odooVersion}"`, 3000);
                        } else {
                            showAutoInfo(`Branch "${dbVersion.odooVersion}" already active`, 2000);
                        }
                        return;
                }
            }

            // Show enhanced switching options (when switchBehavior is 'ask')
            const switchOptions = [
                {
                    label: "$(rocket) Switch to Version Settings Only",
                    description: "Use version settings without changing branches",
                    detail: `Apply settings from ${dbVersion.name} but keep current branches`,
                    action: 'version-only'
                },
                {
                    label: "$(git-branch) Switch Version + Branch",
                    description: "Use version settings and switch to matching branch",
                    detail: `Apply settings from ${dbVersion.name} and switch to ${dbVersion.odooVersion} branch`,
                    action: 'version-and-branch'
                },
                {
                    label: "$(close) Do Nothing",
                    description: "Keep current settings and branches",
                    detail: "No changes will be made",
                    action: 'nothing'
                }
            ];

            const selectedOption = await vscode.window.showQuickPick(switchOptions, {
                placeHolder: `Database "${databaseLabel}" uses version "${dbVersion.name}". What would you like to do?`,
                ignoreFocusOut: true
            });

            if (selectedOption) {
                switch (selectedOption.action) {
                    case 'version-only':
                        // Activate the version (which applies its settings)
                        await versionsService.setActiveVersion(dbVersion.id);
                        showAutoInfo(`Switched to version "${dbVersion.name}" settings`, 3000);
                        break;

                    case 'version-and-branch': {
                        // Activate the version and switch branches
                        await versionsService.setActiveVersion(dbVersion.id);

                        const currentOdooBranch = await getGitBranch(settings.odooPath);

                        // Check if branch switching is needed
                        if (currentOdooBranch !== dbVersion.odooVersion) {
                            await checkoutBranch(settings, dbVersion.odooVersion);
                            showAutoInfo(`Switched to version "${dbVersion.name}" and branch "${dbVersion.odooVersion}"`, 3000);
                        } else {
                            showAutoInfo(`Switched to version "${dbVersion.name}" (branch already correct)`, 3000);
                        }
                        break;
                    }

                    case 'nothing':
                        // Do nothing
                        break;
                }
            }
            return;
        }
    }

    // Fallback to old behavior for databases without version (only branch switching available)
    const effectiveOdooVersion = getEffectiveOdooVersion(database);
    if (effectiveOdooVersion && effectiveOdooVersion !== '') {
        const currentOdooBranch = await getGitBranch(settings.odooPath);
        const currentEnterpriseBranch = await getGitBranch(settings.enterprisePath);
        const currentDesignThemesBranch = await getGitBranch(settings.designThemesPath);

        // Handle automatic branch switching for databases without version
        if (switchBehavior === 'auto-both' || switchBehavior === 'auto-branch-only') {
            // For databases without version, we can only do branch switching
            if (currentOdooBranch !== effectiveOdooVersion) {
                await checkoutBranch(settings, effectiveOdooVersion);
                showAutoInfo(`Auto-switched to branch "${effectiveOdooVersion}"`, 3000);
            } else {
                showAutoInfo(`Branch "${effectiveOdooVersion}" already active`, 2000);
            }
        } else if (switchBehavior === 'auto-version-only') {
            // Can't switch version for databases without version - do nothing
            showAutoInfo(`No version settings to switch to for database "${databaseLabel}"`, 2000);
        } else {
            // Ask user (default behavior)
            const shouldSwitch = await promptBranchSwitch(effectiveOdooVersion, {
                odoo: currentOdooBranch,
                enterprise: currentEnterpriseBranch,
                designThemes: currentDesignThemesBranch
            });

            if (shouldSwitch) {
                await checkoutBranch(settings, effectiveOdooVersion);
            }
        }
    }
}

export async function deleteDb(event: any) {
    const db = extractDatabaseFromEvent(event);
    if (!db) {
        showError('Could not identify the database to delete.');
        return;
    }
    const dbLabel = getDatabaseLabel(db);

    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;

    // Find the project index in the projects array
    const projectIndex = data.projects.findIndex((p: any) => p.uid === project.uid);
    if (projectIndex === -1) {
        showError('The selected project could not be found.');
        return;
    }

    // Ask for confirmation
    const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to delete the database "${dbLabel}"?`,
        { modal: true },
        'Delete'
    );

    if (confirm !== 'Delete') {
        return; // User cancelled
    }

    // Delete the database from PostgreSQL
    await setupDatabase(db.id, undefined, true);

    // Remove from project data
    project.dbs = project.dbs.filter((database: DatabaseModel) => database.id !== db.id);

    // If the deleted database was selected and there are other databases, select the first one
    if (db.isSelected && project.dbs.length > 0) {
        project.dbs[0].isSelected = true;
    }

    // Save the updated data without settings
    const updatedData = stripSettings(data);
    await SettingsStore.saveWithoutComments(updatedData);

    showAutoInfo(`Database "${dbLabel}" deleted successfully`, 2500);

    if (db.isSelected && project.dbs.length > 0) {
        showBriefStatus(`Switched to database: ${getDatabaseLabel(project.dbs[0])}`, 2000);
    }
}

export async function changeDatabaseVersion(event: any) {
    try {
        const db = extractDatabaseFromEvent(event);
        if (!db) {
            showError('Could not identify the database whose version should change.');
            return;
        }
        const dbLabel = getDatabaseLabel(db);

        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            return;
        }
    const { data, project } = result;

    // Find the project index in the projects array
    const projectIndex = data.projects.findIndex((p: any) => p.uid === project.uid);
    if (projectIndex === -1) {
        showError('The selected project could not be found.');
        return;
    }

    // Find the database index
    const dbIndex = project.dbs.findIndex((database: DatabaseModel) => database.id === db.id);
    if (dbIndex === -1) {
        showError('The selected database could not be found.');
        return;
    }

    // Get available versions
    const versionsService = VersionsService.getInstance();
    await versionsService.initialize();
    const availableVersions = versionsService.getVersions();

    // Create version choices including "No Version" option
    const versionChoices = [
        {
            label: "$(close) No Version",
            description: "Remove version association",
            detail: "Database will use current branch settings without version",
            versionId: undefined
        },
        ...availableVersions.map(version => ({
            label: `$(versions) ${version.name}`,
            description: `Odoo ${version.odooVersion}`,
            detail: `Use settings and configuration from ${version.name}`,
            versionId: version.id
        }))
    ];

    // Show current version in the placeholder
    let currentVersionText = "No version";
    if (db.versionId) {
        const currentVersion = versionsService.getVersion(db.versionId);
        currentVersionText = currentVersion ? currentVersion.name : "Unknown version";
    } else {
        const effectiveOdooVersion = getEffectiveOdooVersion(db);
        if (effectiveOdooVersion) {
            currentVersionText = `Branch: ${effectiveOdooVersion}`;
        }
    }

    const selectedChoice = await vscode.window.showQuickPick(versionChoices, {
        placeHolder: `Current: ${currentVersionText}. Select a new version for database "${dbLabel}"`,
        ignoreFocusOut: true
    });

    if (!selectedChoice) {
        return; // User cancelled
    }

    // Update the database version - modify the existing database object in place
    // to avoid date serialization issues
    if (selectedChoice.versionId) {
        const selectedVersion = versionsService.getVersion(selectedChoice.versionId);
        if (selectedVersion) {
            project.dbs[dbIndex].versionId = selectedChoice.versionId;
            // Don't set odooVersion when version is assigned - it should come from the version
            project.dbs[dbIndex].odooVersion = undefined;
        }
    } else {
        // Remove version association but preserve original branch name
        project.dbs[dbIndex].versionId = undefined;
        // When no version, we can fall back to empty odooVersion (will use branchName if available)
        project.dbs[dbIndex].odooVersion = undefined;
        // Keep branchName - it's independent of version management
    }

    // Save only the databases array to avoid touching settings
    const updatedData = stripSettings(data);
    await SettingsStore.saveWithoutComments(updatedData);

    // Show confirmation message
    const updatedDb = project.dbs[dbIndex]; // Use the updated database object
    const dbNameForMessage = getDatabaseLabel(updatedDb) || dbLabel;
    const newVersionText = selectedChoice.versionId
        ? `version "${availableVersions.find(v => v.id === selectedChoice.versionId)?.name}"`
        : "no version";

    showAutoInfo(`Database "${dbNameForMessage}" updated to use ${newVersionText}`, 3000);

    // If this is the currently selected database, offer to switch to the new version
    if (db.isSelected && selectedChoice.versionId) {
        const switchChoice = await vscode.window.showInformationMessage(
            `Would you like to immediately switch to the new version settings?`,
            { modal: false },
            'Switch Now',
            'Not Now'
        );

        if (switchChoice === 'Switch Now') {
            // Use the same switching logic as database selection
            await handleDatabaseVersionSwitch(project.dbs[dbIndex]);
        }
    }
    } catch (error: any) {
        showError(`Failed to change database version: ${error.message}`);
        console.error('Error in changeDatabaseVersion:', error);
    }
}

function normalizeErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function isToolchainUnavailableError(error: unknown): boolean {
    const message = normalizeErrorMessage(error).toLowerCase();
    return message.includes('enoent') || message.includes('not found') || message.includes('failed to start unzip') || message.includes('failed to start gunzip');
}

function createProcessStream(process: ChildProcess, label: string): OpenedDumpStream {
    if (!process.stdout || !process.stderr) {
        throw new Error(`${label} process did not expose readable stdio streams.`);
    }

    const output = new PassThrough();
    let stderr = '';

    process.stderr.on('data', chunk => {
        stderr += chunk.toString();
    });
    process.stdout.pipe(output);

    process.on('error', error => {
        output.destroy(new Error(`Failed to start ${label}: ${normalizeErrorMessage(error)}`));
    });
    process.on('close', code => {
        if (code !== 0) {
            const details = stderr.trim();
            output.destroy(new Error(`${label} exited with code ${code}${details ? `: ${details}` : ''}`));
        }
    });

    return {
        stream: output,
        dispose: () => {
            if (!process.killed) {
                process.kill('SIGTERM');
            }
            output.destroy();
        }
    };
}

function createCommandStream(command: string, args: string[], label: string): OpenedDumpStream {
    const process = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    return createProcessStream(process, label);
}

function createZipGzipStream(dumpPath: string, entry: string): OpenedDumpStream {
    const unzipProcess = spawn('unzip', ['-p', dumpPath, entry], { stdio: ['ignore', 'pipe', 'pipe'] });
    const gunzipProcess = spawn('gunzip', ['-c'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = new PassThrough();

    let unzipStderr = '';
    let gunzipStderr = '';

    unzipProcess.stderr.on('data', chunk => {
        unzipStderr += chunk.toString();
    });
    gunzipProcess.stderr.on('data', chunk => {
        gunzipStderr += chunk.toString();
    });

    unzipProcess.stdout.pipe(gunzipProcess.stdin);
    gunzipProcess.stdout.pipe(output);

    unzipProcess.on('error', error => {
        output.destroy(new Error(`Failed to start unzip: ${normalizeErrorMessage(error)}`));
    });
    gunzipProcess.on('error', error => {
        output.destroy(new Error(`Failed to start gunzip: ${normalizeErrorMessage(error)}`));
    });

    unzipProcess.on('close', code => {
        if (code !== 0) {
            const details = unzipStderr.trim();
            output.destroy(new Error(`unzip exited with code ${code}${details ? `: ${details}` : ''}`));
            if (!gunzipProcess.killed) {
                gunzipProcess.kill('SIGTERM');
            }
        }
    });
    gunzipProcess.on('close', code => {
        if (code !== 0) {
            const details = gunzipStderr.trim();
            output.destroy(new Error(`gunzip exited with code ${code}${details ? `: ${details}` : ''}`));
        }
    });

    return {
        stream: output,
        dispose: () => {
            if (!unzipProcess.killed) {
                unzipProcess.kill('SIGTERM');
            }
            if (!gunzipProcess.killed) {
                gunzipProcess.kill('SIGTERM');
            }
            output.destroy();
        }
    };
}

async function inspectZipEntries(dumpPath: string): Promise<{ firstEntry?: string; sqlEntry?: string; gzEntry?: string; }> {
    return new Promise((resolve, reject) => {
        const inspectProcess = spawn('unzip', ['-Z1', dumpPath], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        let lineBuffer = '';
        let firstEntry: string | undefined;
        let sqlEntry: string | undefined;
        let gzEntry: string | undefined;
        let entriesCount = 0;

        const processLine = (line: string) => {
            const entry = line.trim();
            if (!entry) {
                return;
            }
            entriesCount++;
            if (!firstEntry) {
                firstEntry = entry;
            }
            const lower = entry.toLowerCase();
            if (!sqlEntry && lower.endsWith('.sql') && !lower.endsWith('.sql.gz')) {
                sqlEntry = entry;
            }
            if (!gzEntry && lower.endsWith('.sql.gz')) {
                gzEntry = entry;
            }
        };

        inspectProcess.stdout.on('data', chunk => {
            lineBuffer += chunk.toString();
            let newlineIndex = lineBuffer.indexOf('\n');
            while (newlineIndex !== -1) {
                processLine(lineBuffer.slice(0, newlineIndex));
                lineBuffer = lineBuffer.slice(newlineIndex + 1);
                newlineIndex = lineBuffer.indexOf('\n');
            }
        });

        inspectProcess.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });

        inspectProcess.on('error', error => {
            reject(new Error(`Failed to start unzip: ${normalizeErrorMessage(error)}`));
        });

        inspectProcess.on('close', code => {
            if (lineBuffer.trim().length > 0) {
                processLine(lineBuffer);
            }
            if (code !== 0) {
                const details = stderr.trim();
                reject(new Error(`unzip exited with code ${code}${details ? `: ${details}` : ''}`));
                return;
            }
            if (entriesCount === 0) {
                reject(new Error('Archive is empty.'));
                return;
            }
            resolve({ firstEntry, sqlEntry, gzEntry });
        });
    });
}

async function prepareDumpForImport(dumpPath: string): Promise<PreparedDump> {
    if (dumpPath.endsWith('.zip')) {
        const inspection = await inspectZipEntries(dumpPath);
        const selectedEntry = inspection.sqlEntry ?? inspection.gzEntry ?? inspection.firstEntry;
        if (!selectedEntry) {
            throw new Error('Archive does not contain any files.');
        }

        if (selectedEntry.toLowerCase().endsWith('.sql.gz')) {
            return {
                kind: 'stream',
                originalPath: dumpPath,
                progressMessage: 'Unzipping, decompressing, and importing dump archive...',
                openStream: () => createZipGzipStream(dumpPath, selectedEntry)
            };
        }

        return {
            kind: 'stream',
            originalPath: dumpPath,
            progressMessage: 'Unzipping and importing dump archive...',
            openStream: () => createCommandStream('unzip', ['-p', dumpPath, selectedEntry], 'unzip')
        };
    }

    if (dumpPath.endsWith('.gz')) {
        return {
            kind: 'stream',
            originalPath: dumpPath,
            progressMessage: 'Decompressing and importing dump file...',
            openStream: () => createCommandStream('gunzip', ['-c', dumpPath], 'gunzip')
        };
    }

    return {
        kind: 'file',
        originalPath: dumpPath,
        progressMessage: 'Importing dump file...',
        sqlPath: dumpPath
    };
}

async function importDumpStream(dbName: string, stream: Readable): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const psqlProcess = spawn('psql', ['-d', dbName], { stdio: ['pipe', 'inherit', 'pipe'] });
        let stderr = '';
        let settled = false;

        const finish = (error?: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            if (error) {
                reject(error);
                return;
            }
            resolve();
        };

        psqlProcess.stderr.on('data', chunk => {
            stderr += chunk.toString();
            process.stderr.write(chunk);
        });
        psqlProcess.on('error', error => {
            finish(new Error(`Failed to start psql: ${normalizeErrorMessage(error)}`));
        });
        psqlProcess.on('close', code => {
            if (code === 0) {
                finish();
                return;
            }
            const details = stderr.trim();
            finish(new Error(`psql exited with code ${code}${details ? `: ${details}` : ''}`));
        });

        stream.on('error', error => {
            if (!psqlProcess.killed) {
                psqlProcess.kill('SIGTERM');
            }
            finish(error);
        });
        psqlProcess.stdin.on('error', error => {
            const ioError = error as NodeJS.ErrnoException;
            if (ioError.code !== 'EPIPE') {
                finish(error);
            }
        });

        stream.pipe(psqlProcess.stdin);
    });
}

async function importPreparedDump(dbName: string, preparedDump: PreparedDump): Promise<void> {
    if (preparedDump.kind === 'file') {
        if (!preparedDump.sqlPath) {
            throw new Error('No dump path available for file-based import.');
        }
        execSync(`psql ${dbName} < "${preparedDump.sqlPath}"`, { stdio: 'inherit', shell: '/bin/sh' });
        return;
    }

    if (!preparedDump.openStream) {
        throw new Error('No stream provider configured for this dump source.');
    }

    const openedStream = preparedDump.openStream();
    try {
        await importDumpStream(dbName, openedStream.stream);
    } finally {
        openedStream.dispose();
    }
}

function prepareDumpViaTempFile(dumpPath: string): PreparedDump {
    if (dumpPath.endsWith('.zip')) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-dump-'));
        const tempSqlPath = path.join(tempDir, 'dump.sql');
        try {
            const listOutput = execSync(`unzip -Z1 "${dumpPath}"`, { encoding: 'utf8', shell: '/bin/sh' });
            const entries = listOutput.split('\n').map(line => line.trim()).filter(Boolean);
            if (entries.length === 0) {
                throw new Error('Archive is empty.');
            }

            const sqlEntry = entries.find(entry => entry.toLowerCase().endsWith('.sql') && !entry.toLowerCase().endsWith('.sql.gz'));
            const gzEntry = entries.find(entry => entry.toLowerCase().endsWith('.sql.gz'));

            if (sqlEntry) {
                execSync(`unzip -p "${dumpPath}" "${sqlEntry}" > "${tempSqlPath}"`, { stdio: 'inherit', shell: '/bin/sh' });
            } else if (gzEntry) {
                execSync(`unzip -p "${dumpPath}" "${gzEntry}" | gunzip -c > "${tempSqlPath}"`, { stdio: 'inherit', shell: '/bin/sh' });
            } else {
                execSync(`unzip -p "${dumpPath}" > "${tempSqlPath}"`, { stdio: 'inherit', shell: '/bin/sh' });
            }

            return {
                kind: 'file',
                originalPath: dumpPath,
                sqlPath: tempSqlPath,
                cleanup: () => {
                    try {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    } catch (cleanupError) {
                        console.warn('Failed to cleanup temporary unzip folder:', cleanupError);
                    }
                }
            };
        } catch (error) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {
                // ignore
            }
            throw error;
        }
    }

    if (dumpPath.endsWith('.gz')) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-dump-'));
        const tempSqlPath = path.join(tempDir, 'dump.sql');
        try {
            execSync(`gunzip -c "${dumpPath}" > "${tempSqlPath}"`, { stdio: 'inherit', shell: '/bin/sh' });
            return {
                kind: 'file',
                originalPath: dumpPath,
                sqlPath: tempSqlPath,
                cleanup: () => {
                    try {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    } catch (cleanupError) {
                        console.warn('Failed to cleanup temporary gunzip folder:', cleanupError);
                    }
                }
            };
        } catch (error) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {
                // ignore
            }
            throw error;
        }
    }

    return {
        kind: 'file',
        originalPath: dumpPath,
        sqlPath: dumpPath
    };
}
