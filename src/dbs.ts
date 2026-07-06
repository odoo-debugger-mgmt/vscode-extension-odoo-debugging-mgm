import * as vscode from 'vscode';
import { DatabaseModel, ProjectRepoBranchAssignment } from './models/db';
import { normalizePath, getGitBranch, getGitBranches, showError, showInfo, showWarning, showAutoInfo, showBriefStatus, addActiveIndicator, stripSettings, getDatabaseLabel } from './utils';
import { SettingsStore } from './settingsStore';
import { VersionsService } from './versionsService';
import { execSync, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RepoModel } from './models/repo';
import { DatabaseTemplateModel } from './models/dbTemplate';
import { randomUUID } from 'crypto';
import { generateDatabaseIdentifiers, DatabaseKind } from './services/dbNaming';
import * as os from 'os';
import { SortPreferences } from './sortPreferences';
import { getDefaultSortOption } from './sortOptions';
import { PassThrough, Readable } from 'stream';
import { clearInstalledModuleCache, detectOdooSeries } from './services/database';
import { SettingsModel } from './models/settings';
import {
    alignEnvironment,
    buildDatabaseEnvironmentTarget,
    captureCurrentRepoBranches,
    resolveProjectRepoBranchAssignments,
    sanitizeProjectRepoBranchAssignments
} from './services/environment';

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

async function promptProjectRepoBranchAssignments(
    repos: RepoModel[],
    existingAssignments: ProjectRepoBranchAssignment[] = [],
    mode: 'create' | 'edit' = 'create'
): Promise<ProjectRepoBranchAssignment[] | undefined> {
    if (repos.length === 0) {
        return [];
    }

    const normalizedExisting = sanitizeProjectRepoBranchAssignments(existingAssignments);
    const existingByPath = new Map<string, ProjectRepoBranchAssignment>();
    const existingByName = new Map<string, ProjectRepoBranchAssignment>();
    for (const entry of normalizedExisting) {
        if (entry.repoPath) {
            existingByPath.set(normalizePath(entry.repoPath), entry);
        }
        if (entry.repoName) {
            existingByName.set(entry.repoName.toLowerCase(), entry);
        }
    }

    const setupChoices: Array<{ label: string; description: string; action: 'keep' | 'use-current' | 'choose-per-repo' | 'clear'; }> = [
        {
            label: 'Use current branches for all project repos',
            description: 'Capture each selected repo current branch and attach it to this DB',
            action: 'use-current'
        },
        {
            label: 'Choose branch per repository',
            description: 'Select an explicit branch for each selected repo',
            action: 'choose-per-repo'
        },
        {
            label: mode === 'edit' ? 'Clear project repo branch mapping' : 'Skip project repo branch mapping',
            description: mode === 'edit'
                ? 'Remove all project repo branch assignments from this DB'
                : 'Do not attach project repo branch assignments to this DB',
            action: 'clear'
        }
    ];

    if (mode === 'edit') {
        setupChoices.unshift({
            label: 'Keep existing project repo branch mapping',
            description: `Keep ${normalizedExisting.length} currently mapped repo branch assignment(s)`,
            action: 'keep'
        });
    }

    const setupChoice = await vscode.window.showQuickPick(setupChoices, {
        placeHolder: mode === 'edit'
            ? 'Edit project repository branches for this database'
            : 'Attach project repository branches to this database?',
        ignoreFocusOut: true
    });

    if (!setupChoice) {
        return undefined;
    }

    if (setupChoice.action === 'keep') {
        return normalizedExisting;
    }

    if (setupChoice.action === 'clear') {
        return [];
    }

    if (setupChoice.action === 'use-current') {
        const mapped = await Promise.all(repos.map(async repo => {
            const repoPath = normalizePath(repo.path);
            const branch = await getGitBranch(repoPath);
            if (!branch) {
                return undefined;
            }
            return {
                repoName: repo.name,
                repoPath,
                branch
            } as ProjectRepoBranchAssignment;
        }));

        return mapped.filter((entry): entry is ProjectRepoBranchAssignment => !!entry);
    }

    const assignments: ProjectRepoBranchAssignment[] = [];
    for (let i = 0; i < repos.length; i++) {
        const repo = repos[i];
        const repoPath = normalizePath(repo.path);
        const existing = existingByPath.get(repoPath) ?? existingByName.get(repo.name.toLowerCase());
        const existingBranch = existing?.branch;
        const currentBranch = await getGitBranch(repoPath);
        const branches = await getGitBranches(repoPath);
        const uniqueBranches = Array.from(new Set([
            ...(existingBranch ? [existingBranch] : []),
            ...(currentBranch ? [currentBranch] : []),
            ...branches
        ]));
        const selectableBranches = uniqueBranches.filter(branch => branch !== currentBranch && branch !== existingBranch);

        const options: Array<{ label: string; description?: string; detail?: string; action: 'use' | 'custom' | 'skip'; branch?: string }> = [
            ...(existingBranch ? [{
                label: `$(bookmark) Keep mapped branch (${existingBranch})`,
                description: repo.name,
                action: 'use' as const,
                branch: existingBranch
            }] : []),
            ...(currentBranch ? [{
                label: `$(git-branch) Keep current branch (${currentBranch})`,
                description: repo.name,
                action: 'use' as const,
                branch: currentBranch
            }] : []),
            ...selectableBranches.map(branch => ({
                label: branch,
                description: repo.name,
                action: 'use' as const,
                branch
            })),
            {
                label: '$(pencil) Enter a custom branch',
                description: repo.name,
                action: 'custom' as const
            },
            {
                label: mode === 'edit' && existingBranch
                    ? '$(close) Keep existing mapping for this repository'
                    : '$(close) Skip this repository',
                description: repo.name,
                action: 'skip' as const
            }
        ];

        const picked = await vscode.window.showQuickPick(options, {
            placeHolder: `[${i + 1}/${repos.length}] Select branch for repository "${repo.name}"${existingBranch ? ` (mapped: ${existingBranch})` : ''}`,
            ignoreFocusOut: true
        });

        if (!picked) {
            return undefined;
        }

        if (picked.action === 'skip') {
            if (mode === 'edit' && existingBranch) {
                assignments.push({
                    repoName: repo.name,
                    repoPath,
                    branch: existingBranch
                });
            }
            continue;
        }

        let branch = picked.branch;
        if (picked.action === 'custom') {
            const customBranchInput = await vscode.window.showInputBox({
                placeHolder: existingBranch ?? currentBranch ?? 'Enter branch name',
                value: existingBranch ?? currentBranch ?? '',
                prompt: `Enter the branch to checkout for "${repo.name}" when this DB is selected`,
                ignoreFocusOut: true
            });
            if (customBranchInput === undefined) {
                return undefined;
            }
            branch = customBranchInput.trim();
        }

        if (!branch) {
            continue;
        }

        assignments.push({
            repoName: repo.name,
            repoPath,
            branch
        });
    }

    return assignments;
}

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
            const projectRepoBranches = sanitizeProjectRepoBranchAssignments((db as any).projectRepoBranches);
            if (projectRepoBranches.length > 0) {
                const formattedRepoBranches = projectRepoBranches
                    .map(entry => `- ${entry.repoName || path.basename(entry.repoPath)}: \`${entry.branch}\``)
                    .join('\n');
                tooltipDetails.push(`**Project Repo Branches:**\n${formattedRepoBranches}`);
            }

            // Database details
            tooltipDetails.push(`**Created:** ${formattedDate}`);

            // Database type
            if (db.kind === 'template') {
                tooltipDetails.push(`**Type:** Created from template`);
            } else if (db.isItABackup) {
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

type CreationMethod = 'fresh' | 'dump' | 'existing' | 'template';

const TEMPLATE_DB_NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;
const RESERVED_DATABASE_NAMES = new Set(['postgres', 'template0', 'template1']);

function sanitizeDatabaseTemplates(source: unknown): DatabaseTemplateModel[] {
    if (!Array.isArray(source)) {
        return [];
    }

    const seenTemplateDbNames = new Set<string>();
    const normalized: DatabaseTemplateModel[] = [];

    for (const entry of source) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }

        const candidate = entry as Partial<DatabaseTemplateModel> & { [key: string]: unknown };
        const templateDbName = typeof candidate.templateDbName === 'string'
            ? candidate.templateDbName.trim()
            : typeof candidate.name === 'string'
                ? candidate.name.trim()
                : '';

        if (!templateDbName) {
            continue;
        }

        const dedupeKey = templateDbName.toLowerCase();
        if (seenTemplateDbNames.has(dedupeKey)) {
            continue;
        }
        seenTemplateDbNames.add(dedupeKey);

        const name = typeof candidate.name === 'string' && candidate.name.trim() !== ''
            ? candidate.name.trim()
            : templateDbName;
        const sourceDbName = typeof candidate.sourceDbName === 'string' && candidate.sourceDbName.trim() !== ''
            ? candidate.sourceDbName.trim()
            : undefined;
        const createdAt = typeof candidate.createdAt === 'string' && candidate.createdAt.trim() !== ''
            ? candidate.createdAt
            : new Date().toISOString();
        const updatedAt = typeof candidate.updatedAt === 'string' && candidate.updatedAt.trim() !== ''
            ? candidate.updatedAt
            : undefined;

        normalized.push({
            name,
            templateDbName,
            sourceDbName,
            createdAt,
            updatedAt
        });
    }

    return normalized.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function validateTemplateDatabaseName(value: string, existingTemplateNames: Set<string>, originalName?: string): string | null {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return 'Template name cannot be empty.';
    }

    if (!TEMPLATE_DB_NAME_PATTERN.test(trimmed)) {
        return 'Use letters, numbers, "-" or "_" only. The name must not start with "-".';
    }

    if (RESERVED_DATABASE_NAMES.has(trimmed.toLowerCase())) {
        return `"${trimmed}" is reserved and cannot be used as a template name.`;
    }

    const isRenamingSameTemplate = originalName && originalName.toLowerCase() === trimmed.toLowerCase();
    if (!isRenamingSameTemplate && existingTemplateNames.has(trimmed.toLowerCase())) {
        return 'A template with this PostgreSQL name already exists.';
    }

    return null;
}

function queryPostgresDatabases(): string[] {
    try {
        const output = execSync(`psql -d postgres -tAc "SELECT datname FROM pg_database ORDER BY datname;"`, {
            stdio: ['ignore', 'pipe', 'pipe']
        }).toString('utf8');

        return output
            .split('\n')
            .map(name => name.trim())
            .filter(name => name.length > 0);
    } catch (error) {
        console.warn('Failed to query PostgreSQL database list:', error);
        return [];
    }
}

function quotePgIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

function quotePgLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

async function runSpawnCommand(command: string, args: string[], cwd?: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';

        child.stderr?.on('data', chunk => {
            stderr += chunk.toString();
        });

        child.on('error', error => {
            reject(new Error(`Failed to execute "${command}": ${error.message}`));
        });

        child.on('close', code => {
            if (code === 0) {
                resolve();
                return;
            }

            const details = stderr.trim();
            reject(new Error(details || `${command} exited with code ${code ?? 'unknown'}`));
        });
    });
}

async function cloneDatabaseFromTemplate(targetDbName: string, templateDbName: string): Promise<void> {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Setting up database ${targetDbName}`,
        cancellable: false
    }, async (progress) => {
        progress.report({ message: 'Checking database existence...', increment: 20 });
        const checkCommand = `psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname=${quotePgLiteral(targetDbName)}"`;
        const exists = execSync(checkCommand).toString().trim() === '1';

        if (exists) {
            progress.report({ message: 'Dropping existing database...', increment: 20 });
            execSync(`dropdb ${targetDbName}`, { stdio: 'inherit' });
        }
        clearInstalledModuleCache(targetDbName);

        progress.report({ message: `Cloning from template "${templateDbName}"...`, increment: 50 });
        await runSpawnCommand('createdb', ['-T', templateDbName, targetDbName]);

        clearInstalledModuleCache(targetDbName);
        progress.report({ message: 'Complete!', increment: 30 });
    });
}

function getTemplateQuickPickItems(templates: DatabaseTemplateModel[]): Array<{ label: string; description: string; detail: string; template: DatabaseTemplateModel; }> {
    return templates.map(template => ({
        label: template.name,
        description: template.templateDbName,
        detail: template.sourceDbName ? `Source DB: ${template.sourceDbName}` : 'Source DB not recorded',
        template
    }));
}

async function promptTemplateSelection(templates: DatabaseTemplateModel[], placeHolder: string): Promise<DatabaseTemplateModel | undefined> {
    if (templates.length === 0) {
        return undefined;
    }

    const selected = await vscode.window.showQuickPick(getTemplateQuickPickItems(templates), {
        placeHolder,
        ignoreFocusOut: true
    });
    return selected?.template;
}

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
    },
    template: {
        label: 'From Template',
        description: 'Create a database by cloning a saved template',
        detail: 'Fast DB creation using createdb -T <template>',
        method: 'template'
    }
};

const NEW_DB_NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

async function pickExistingPostgresDatabase(): Promise<string | undefined> {
    const linkedIdentifiers = await collectExistingDatabaseIdentifiers();
    const candidates = queryPostgresDatabases()
        .filter(name => !RESERVED_DATABASE_NAMES.has(name.toLowerCase()));

    const choices: Array<vscode.QuickPickItem & { dbName?: string; action: 'select' | 'manual' }> = [
        ...candidates.map(name => ({
            label: name,
            description: linkedIdentifiers.has(name.toLowerCase()) ? 'Already linked to a project' : undefined,
            action: 'select' as const,
            dbName: name
        })),
        {
            label: '$(pencil) Enter database name manually',
            detail: 'Use this if the database is not listed.',
            action: 'manual' as const
        }
    ];

    const selection = await vscode.window.showQuickPick(choices, {
        placeHolder: 'Select the existing PostgreSQL database to connect',
        ignoreFocusOut: true
    });
    if (!selection) {
        return undefined;
    }
    if (selection.action === 'select') {
        return selection.dbName;
    }

    const manual = await vscode.window.showInputBox({
        placeHolder: 'Enter the name of the existing PostgreSQL database',
        prompt: 'Make sure the database exists in your PostgreSQL instance',
        ignoreFocusOut: true,
        validateInput: value => value.trim() ? null : 'Enter a database name to continue.'
    });
    return manual?.trim() || undefined;
}

async function linkDatabaseToVersion(dbId: string, versionId: string): Promise<void> {
    const data = await SettingsStore.get('odoo-debugger-data.json');
    let changed = false;
    for (const project of data.projects ?? []) {
        for (const db of project.dbs ?? []) {
            if (db?.id === dbId && !db.versionId) {
                db.versionId = versionId;
                changed = true;
            }
        }
    }
    if (changed) {
        await SettingsStore.saveWithoutComments(stripSettings(data));
    }
}

/**
 * Resolves which version profile a new database should use, without prompting:
 * fresh databases inherit the active version; restored/connected databases are
 * probed for their Odoo series (base module version) and matched to a version.
 */
async function resolveVersionForNewDatabase(dbName: string, method: CreationMethod): Promise<{ versionId?: string; branchLabel?: string }> {
    const versionsService = VersionsService.getInstance();
    await versionsService.initialize();
    const activeVersion = versionsService.getActiveVersion();

    if (method === 'fresh') {
        return { versionId: activeVersion?.id, branchLabel: activeVersion?.odooVersion };
    }

    const series = await detectOdooSeries(dbName);
    if (!series) {
        return { versionId: activeVersion?.id, branchLabel: activeVersion?.odooVersion };
    }

    const match = versionsService.getVersions().find(version => (version.odooVersion ?? '').trim() === series);
    if (match) {
        return { versionId: match.id, branchLabel: series };
    }

    // Non-blocking offer to create the missing version profile.
    void vscode.window.showInformationMessage(
        `Database "${dbName}" runs Odoo ${series}, but no matching version profile exists.`,
        'Create Version',
        'Ignore'
    ).then(async choice => {
        if (choice !== 'Create Version') {
            return;
        }
        try {
            const created = await versionsService.createVersion(`Odoo ${series}`, series);
            await linkDatabaseToVersion(dbName, created.id);
            showAutoInfo(`Created version "Odoo ${series}" and linked it to "${dbName}"`, 3000);
            await vscode.commands.executeCommand('dbSelector.refresh');
        } catch (error: any) {
            showError(`Failed to create version for Odoo ${series}: ${error.message}`);
        }
    });

    return { versionId: undefined, branchLabel: series };
}

export async function createDb(projectName: string, repos: RepoModel[], dumpFolderPath: string, _settings: SettingsModel, options: CreateDbOptions = {}): Promise<DatabaseModel | undefined> {
    // Step 1: creation method — the only decision that cannot be inferred.
    let creationMethod: CreationMethod;
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
            return undefined;
        }
        creationMethod = selection.method;
    }

    // Step 2: method-specific source.
    let sqlDumpPath: string | undefined;
    let selectedTemplate: DatabaseTemplateModel | undefined;
    let existingDbName: string | undefined;

    switch (creationMethod) {
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
        case 'template': {
            const data = await SettingsStore.get('odoo-debugger-data.json');
            const templates = sanitizeDatabaseTemplates(data.dbTemplates);
            if (templates.length === 0) {
                showInfo('No database templates found. Use "Manage Database Templates" to create one first.');
                return undefined;
            }
            selectedTemplate = await promptTemplateSelection(templates, 'Select a template to clone into the new database');
            if (!selectedTemplate) {
                return undefined;
            }
            break;
        }
        case 'existing': {
            existingDbName = await pickExistingPostgresDatabase();
            if (!existingDbName) {
                return undefined;
            }
            break;
        }
        case 'fresh':
            break;
    }

    // Step 3: database name — pre-filled suggestion, one Enter to accept.
    const creationTimestamp = new Date();
    const existingIdentifiers = await collectExistingDatabaseIdentifiers();
    const dbKind: DatabaseKind = creationMethod;

    let dbName: string;
    if (existingDbName) {
        dbName = existingDbName;
    } else {
        const suggestion = generateDatabaseIdentifiers({
            projectName,
            kind: dbKind,
            timestamp: creationTimestamp,
            existingInternalNames: existingIdentifiers
        }).internalName;

        const nameInput = await vscode.window.showInputBox({
            prompt: 'Database name (used as the PostgreSQL identifier)',
            value: suggestion,
            ignoreFocusOut: true,
            validateInput: value => {
                const trimmed = value.trim();
                if (!trimmed) {
                    return 'Database name cannot be empty.';
                }
                if (!NEW_DB_NAME_PATTERN.test(trimmed)) {
                    return 'Use letters, numbers, "-" or "_" only. The name must not start with "-".';
                }
                if (RESERVED_DATABASE_NAMES.has(trimmed.toLowerCase())) {
                    return `"${trimmed}" is a reserved database name.`;
                }
                if (existingIdentifiers.has(trimmed.toLowerCase())) {
                    return 'A database with this name is already linked to a project.';
                }
                return null;
            }
        });
        if (nameInput === undefined) {
            return undefined;
        }
        dbName = nameInput.trim();
    }

    // Step 4: create/restore the PostgreSQL database.
    if (creationMethod === 'dump' && sqlDumpPath) {
        await setupDatabase(dbName, sqlDumpPath);
    } else if (creationMethod === 'template' && selectedTemplate) {
        await cloneDatabaseFromTemplate(dbName, selectedTemplate.templateDbName);
    } else if (creationMethod === 'fresh') {
        await setupDatabase(dbName, undefined);
    }

    // Step 5: infer the environment instead of prompting for it. The version is
    // auto-detected from the database itself; the current branch of every
    // project repo is captured as the database's working state.
    const { versionId, branchLabel } = await resolveVersionForNewDatabase(dbName, creationMethod);
    const projectRepoBranches = await captureCurrentRepoBranches(repos);

    return new DatabaseModel(dbName, creationTimestamp, {
        isSelected: true,
        isItABackup: creationMethod === 'dump',
        sqlFilePath: sqlDumpPath,
        isExisting: creationMethod === 'existing',
        branchName: branchLabel ?? '',
        versionId,
        displayName: dbName,
        internalName: dbName,
        kind: dbKind,
        projectRepoBranches
    });
}

async function persistDatabaseTemplates(data: { dbTemplates?: DatabaseTemplateModel[]; projects: any[]; versions?: { [id: string]: any }; activeVersion?: string }, templates: DatabaseTemplateModel[]): Promise<DatabaseTemplateModel[]> {
    const normalized = sanitizeDatabaseTemplates(templates);
    data.dbTemplates = normalized;
    await SettingsStore.saveWithoutComments(stripSettings(data));
    return normalized;
}

function collectProjectDatabaseNames(data: { projects?: any[] }): string[] {
    if (!Array.isArray(data.projects)) {
        return [];
    }

    const projectDbNames = data.projects.flatMap(project =>
        Array.isArray(project?.dbs)
            ? project.dbs
                .map((db: any) => typeof db?.id === 'string' ? db.id.trim() : '')
                .filter((name: string) => name.length > 0)
            : []
    );

    return Array.from(new Set(projectDbNames)).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

async function promptTemplateSourceDatabase(data: { projects?: any[] }): Promise<string | undefined> {
    const projectDbNames = collectProjectDatabaseNames(data);
    const postgresDbNames = queryPostgresDatabases()
        .filter(name => !RESERVED_DATABASE_NAMES.has(name.toLowerCase()));

    const mergedNames = Array.from(new Set([
        ...projectDbNames,
        ...postgresDbNames
    ])).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    const choices: Array<{ label: string; description?: string; detail?: string; dbName?: string; action: 'select' | 'manual' }> = [
        ...mergedNames.map(dbName => ({
            label: dbName,
            description: projectDbNames.includes(dbName) ? 'Linked project database' : 'PostgreSQL database',
            action: 'select' as const,
            dbName
        })),
        {
            label: '$(pencil) Enter database name manually',
            detail: 'Use this if the source database is not listed.',
            action: 'manual' as const
        }
    ];

    const selection = await vscode.window.showQuickPick(choices, {
        placeHolder: 'Select the source database to clone into a template',
        ignoreFocusOut: true
    });

    if (!selection) {
        return undefined;
    }

    if (selection.action === 'select') {
        return selection.dbName;
    }

    const customInput = await vscode.window.showInputBox({
        prompt: 'Enter source PostgreSQL database name',
        placeHolder: 'e.g. my_migrated_dump',
        ignoreFocusOut: true,
        validateInput: (value) => {
            if (!value || value.trim().length === 0) {
                return 'Database name cannot be empty.';
            }
            if (value.trim().startsWith('-')) {
                return 'Database name cannot start with "-".';
            }
            return null;
        }
    });
    if (customInput === undefined) {
        return undefined;
    }

    return customInput.trim();
}

export async function manageDatabaseTemplates(): Promise<void> {
    const data = await SettingsStore.get('odoo-debugger-data.json');
    let templates = sanitizeDatabaseTemplates(data.dbTemplates);

    while (true) {
        const templateCount = templates.length;
        const actions: Array<{ label: string; description?: string; detail?: string; action: 'create' | 'importDb' | 'importFile' | 'exportFile' | 'template' | 'done'; template?: DatabaseTemplateModel }> = [
            {
                label: '$(add) Create New Template from Existing DB',
                description: 'Clone a source DB into a new template database',
                action: 'create'
            },
            {
                label: '$(cloud-download) Import Existing Template DB',
                description: 'Register an already-created template database (no cloning)',
                action: 'importDb'
            },
            {
                label: '$(folder-opened) Import Templates from JSON',
                description: 'Merge templates from an exported template file',
                action: 'importFile'
            },
            {
                label: '$(export) Export Templates to JSON',
                description: templateCount > 0 ? `${templateCount} template(s) will be exported` : 'No templates to export',
                action: 'exportFile'
            },
            ...templates.map(template => ({
                label: `$(database) ${template.name}`,
                description: template.templateDbName,
                detail: template.sourceDbName ? `Source DB: ${template.sourceDbName}` : 'No source DB metadata',
                action: 'template' as const,
                template
            })),
            {
                label: '$(check) Done',
                action: 'done'
            }
        ];

        const selectedAction = await vscode.window.showQuickPick(actions, {
            placeHolder: 'Manage database templates',
            ignoreFocusOut: true
        });

        if (!selectedAction || selectedAction.action === 'done') {
            return;
        }

        if (selectedAction.action === 'create') {
            const sourceDbName = await promptTemplateSourceDatabase(data);
            if (!sourceDbName) {
                continue;
            }

            const templateDbNames = new Set(templates.map(template => template.templateDbName.toLowerCase()));
            const suggestedName = sourceDbName.startsWith('tpl_') ? sourceDbName : `tpl_${sourceDbName}`;
            const templateNameInput = await vscode.window.showInputBox({
                prompt: `Enter template database name cloned from "${sourceDbName}"`,
                placeHolder: 'e.g. tpl_migration_base',
                value: suggestedName,
                ignoreFocusOut: true,
                validateInput: (value) => validateTemplateDatabaseName(value, templateDbNames)
            });
            if (templateNameInput === undefined) {
                continue;
            }

            const templateDbName = templateNameInput.trim();
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Creating template ${templateDbName}`,
                cancellable: false
            }, async (progress) => {
                progress.report({ message: `Cloning "${sourceDbName}"...`, increment: 30 });
                await runSpawnCommand('createdb', [templateDbName, '-T', sourceDbName]);
                progress.report({ message: 'Saving template metadata...', increment: 70 });
            });

            const now = new Date().toISOString();
            templates = await persistDatabaseTemplates(data, [
                ...templates,
                {
                    name: templateDbName,
                    templateDbName,
                    sourceDbName,
                    createdAt: now,
                    updatedAt: now
                }
            ]);
            showAutoInfo(`Template "${templateDbName}" created from "${sourceDbName}"`, 3000);
            continue;
        }

        if (selectedAction.action === 'importDb') {
            const postgresDbNames = queryPostgresDatabases()
                .filter(name => !RESERVED_DATABASE_NAMES.has(name.toLowerCase()));
            const existingTemplateDbNames = new Set(templates.map(template => template.templateDbName.toLowerCase()));
            const importCandidates = postgresDbNames.filter(name => !existingTemplateDbNames.has(name.toLowerCase()));

            if (importCandidates.length === 0) {
                showInfo('No PostgreSQL databases available to import as templates.');
                continue;
            }

            const selectedCandidates = await vscode.window.showQuickPick(
                importCandidates.map(name => ({
                    label: name,
                    description: 'PostgreSQL database',
                    dbName: name
                })),
                {
                    placeHolder: 'Select database(s) to register as templates',
                    canPickMany: true,
                    ignoreFocusOut: true
                }
            );

            if (selectedCandidates === undefined) {
                continue;
            }

            if (selectedCandidates.length === 0) {
                showInfo('No templates selected for import.');
                continue;
            }

            const now = new Date().toISOString();
            templates = await persistDatabaseTemplates(
                data,
                [
                    ...templates,
                    ...selectedCandidates.map(candidate => ({
                        name: candidate.dbName,
                        templateDbName: candidate.dbName,
                        createdAt: now,
                        updatedAt: now
                    }))
                ]
            );

            showAutoInfo(`Imported ${selectedCandidates.length} template(s)`, 2500);
            continue;
        }

        if (selectedAction.action === 'importFile') {
            const selectedFiles = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'JSON Files': ['json'],
                    'All Files': ['*']
                },
                openLabel: 'Import Templates'
            });

            if (!selectedFiles || selectedFiles.length === 0) {
                continue;
            }

            try {
                const content = await vscode.workspace.fs.readFile(selectedFiles[0]);
                const parsed = JSON.parse(Buffer.from(content).toString('utf8')) as { templates?: DatabaseTemplateModel[] } | DatabaseTemplateModel[];
                const imported = Array.isArray(parsed) ? parsed : parsed.templates;
                const sanitizedImported = sanitizeDatabaseTemplates(imported);
                if (sanitizedImported.length === 0) {
                    showInfo('No valid templates found in the selected file.');
                    continue;
                }

                const existingTemplateDbNames = new Set(templates.map(template => template.templateDbName.toLowerCase()));
                const toAdd = sanitizedImported.filter(template => !existingTemplateDbNames.has(template.templateDbName.toLowerCase()));
                if (toAdd.length === 0) {
                    showInfo('All templates in the selected file already exist.');
                    continue;
                }

                templates = await persistDatabaseTemplates(data, [...templates, ...toAdd]);
                showAutoInfo(`Imported ${toAdd.length} template(s) from JSON`, 2500);
            } catch (error: any) {
                showError(`Failed to import templates: ${error.message}`);
            }
            continue;
        }

        if (selectedAction.action === 'exportFile') {
            if (templates.length === 0) {
                showInfo('No templates available to export.');
                continue;
            }

            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(
                    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
                    'odoo-db-templates.json'
                )),
                filters: {
                    'JSON Files': ['json'],
                    'All Files': ['*']
                },
                saveLabel: 'Export Templates'
            });

            if (!saveUri) {
                continue;
            }

            const payload = {
                exportedAt: new Date().toISOString(),
                templates
            };

            await vscode.workspace.fs.writeFile(saveUri, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
            showAutoInfo(`Exported ${templates.length} template(s)`, 2500);
            continue;
        }

        if (selectedAction.action === 'template') {
            const selectedTemplate = selectedAction.template;
            if (!selectedTemplate) {
                continue;
            }

            const templateAction = await vscode.window.showQuickPick([
                {
                    label: '$(edit) Rename Template',
                    description: `Current DB name: ${selectedTemplate.templateDbName}`,
                    action: 'rename' as const
                },
                {
                    label: '$(trash) Delete Template',
                    description: `Remove "${selectedTemplate.name}"`,
                    action: 'delete' as const
                },
                {
                    label: '$(arrow-left) Back',
                    action: 'back' as const
                }
            ], {
                placeHolder: `Manage template "${selectedTemplate.name}"`,
                ignoreFocusOut: true
            });

            if (!templateAction || templateAction.action === 'back') {
                continue;
            }

            if (templateAction.action === 'rename') {
                const templateDbNames = new Set(templates.map(template => template.templateDbName.toLowerCase()));
                const newNameInput = await vscode.window.showInputBox({
                    prompt: `Rename template "${selectedTemplate.templateDbName}"`,
                    value: selectedTemplate.templateDbName,
                    ignoreFocusOut: true,
                    validateInput: (value) => validateTemplateDatabaseName(value, templateDbNames, selectedTemplate.templateDbName)
                });
                if (newNameInput === undefined) {
                    continue;
                }

                const newTemplateDbName = newNameInput.trim();
                if (newTemplateDbName.toLowerCase() === selectedTemplate.templateDbName.toLowerCase()) {
                    continue;
                }

                const renameSql = `ALTER DATABASE ${quotePgIdentifier(selectedTemplate.templateDbName)} RENAME TO ${quotePgIdentifier(newTemplateDbName)};`;
                await runSpawnCommand('psql', ['-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', renameSql]);

                const now = new Date().toISOString();
                templates = await persistDatabaseTemplates(
                    data,
                    templates.map(template => template.templateDbName.toLowerCase() === selectedTemplate.templateDbName.toLowerCase()
                        ? {
                            ...template,
                            name: template.name === selectedTemplate.templateDbName ? newTemplateDbName : template.name,
                            templateDbName: newTemplateDbName,
                            updatedAt: now
                        }
                        : template
                    )
                );
                showAutoInfo(`Template renamed to "${newTemplateDbName}"`, 2500);
                continue;
            }

            const deleteChoice = await vscode.window.showWarningMessage(
                `Delete template "${selectedTemplate.name}" (${selectedTemplate.templateDbName})?`,
                { modal: true },
                'Delete Template DB + Metadata',
                'Delete Metadata Only'
            );

            if (!deleteChoice) {
                continue;
            }

            if (deleteChoice === 'Delete Template DB + Metadata') {
                await runSpawnCommand('dropdb', ['--if-exists', selectedTemplate.templateDbName]);
            }

            templates = await persistDatabaseTemplates(
                data,
                templates.filter(template => template.templateDbName.toLowerCase() !== selectedTemplate.templateDbName.toLowerCase())
            );
            showAutoInfo(`Template "${selectedTemplate.name}" deleted`, 2500);
            continue;
        }
    }
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
    const selectedDatabase = newSelectedDbIndex !== -1 ? project.dbs[newSelectedDbIndex] : database;

    await SettingsStore.saveWithoutComments(stripSettings(data));

    // Align the workbench (active version, core branches, project repo
    // branches) to the database through the single switch pipeline.
    try {
        await alignEnvironment(
            buildDatabaseEnvironmentTarget(selectedDatabase, project.repos ?? []),
            { label: `Database "${databaseLabel}"` }
        );
    } catch (error: any) {
        console.error('Error while aligning environment for database selection:', error);
        showWarning(`Database selected, but environment switching failed: ${error.message}`);
    }

    showBriefStatus(`Database switched to: ${databaseLabel}`, 2000);
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

    // If this is the currently selected database, align the workbench to the new version.
    if (db.isSelected && selectedChoice.versionId) {
        await alignEnvironment(
            buildDatabaseEnvironmentTarget(project.dbs[dbIndex], project.repos ?? []),
            { label: `Database "${dbNameForMessage}"` }
        );
    }
    } catch (error: any) {
        showError(`Failed to change database version: ${error.message}`);
        console.error('Error in changeDatabaseVersion:', error);
    }
}

export async function changeDatabaseProjectRepoBranches(event: any): Promise<void> {
    try {
        const db = extractDatabaseFromEvent(event);
        if (!db) {
            showError('Could not identify the database whose project repo branches should change.');
            return;
        }
        const dbLabel = getDatabaseLabel(db);

        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            return;
        }
        const { data, project } = result;

        const projectIndex = data.projects.findIndex((p: any) => p.uid === project.uid);
        if (projectIndex === -1) {
            showError('The selected project could not be found.');
            return;
        }

        const dbIndex = project.dbs.findIndex((database: DatabaseModel) => database.id === db.id);
        if (dbIndex === -1) {
            showError('The selected database could not be found.');
            return;
        }

        const existingAssignments = sanitizeProjectRepoBranchAssignments((project.dbs[dbIndex] as any).projectRepoBranches);
        const updatedAssignments = await promptProjectRepoBranchAssignments(project.repos ?? [], existingAssignments, 'edit');
        if (updatedAssignments === undefined) {
            return;
        }

        project.dbs[dbIndex].projectRepoBranches = updatedAssignments;

        const updatedData = stripSettings(data);
        await SettingsStore.saveWithoutComments(updatedData);

        if (updatedAssignments.length > 0) {
            showAutoInfo(`Updated project repo branch mapping for "${dbLabel}" (${updatedAssignments.length} repo(s))`, 3000);
        } else {
            showAutoInfo(`Cleared project repo branch mapping for "${dbLabel}"`, 3000);
        }

        if (project.dbs[dbIndex].isSelected && updatedAssignments.length > 0) {
            // The user explicitly configured this mapping; apply it right away.
            await alignEnvironment(
                { repoAssignments: resolveProjectRepoBranchAssignments(project.dbs[dbIndex], project.repos ?? []) },
                { label: `Database "${dbLabel}"`, behavior: 'auto' }
            );
        }
    } catch (error: any) {
        showError(`Failed to update project repo branch mapping: ${error.message}`);
        console.error('Error in changeDatabaseProjectRepoBranches:', error);
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
