import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

import { DatabaseModel, ProjectRepoBranchAssignment } from './models/db';
import { RepoModel } from './models/repo';
import { DatabaseTemplateModel } from './models/dbTemplate';
import { SettingsModel } from './models/settings';
import { normalizePath, getGitBranches, stripSettings, getDatabaseLabel, DebuggerData } from './utils';
import { showError, showInfo, showWarning, showAutoInfo, showBriefStatus, showModalWarning } from './services/notifications';
import { logger, errorMessage } from './services/logger';
import { getRepoBranch } from './services/branches';
import { SettingsStore } from './settingsStore';
import { VersionsService } from './versionsService';
import { rememberDbForVersion } from './services/dbResolution';
import { generateDatabaseIdentifiers, DatabaseKind } from './services/dbNaming';
import { detectOdooSeries } from './services/database';
import {
    RESERVED_DATABASE_NAMES,
    listPostgresDatabases,
    databaseExists,
    createDatabase,
    dropDatabase,
    dropDatabaseIfExists,
    renameDatabase,
    neutralizeDatabase
} from './services/postgres';
import {
    collectDumpSources,
    pathExists,
    prepareDumpForImport,
    prepareDumpViaTempFile,
    importPreparedDump,
    isToolchainUnavailableError,
    DumpSelection,
    PreparedDump
} from './services/dumpImport';
import {
    sanitizeDatabaseTemplates,
    validateTemplateDatabaseName,
    persistDatabaseTemplates
} from './services/templates';
import { findStaleReferences } from './services/reconcile';
import {
    alignEnvironment,
    buildDatabaseEnvironmentTarget,
    captureCurrentRepoBranches,
    resolveProjectRepoBranchAssignments,
    sanitizeProjectRepoBranchAssignments
} from './services/environment';

/**
 * Database UI flows: creation wizard, selection, deletion, restore, version
 * and branch-mapping edits, and template management. All PostgreSQL / dump
 * work is delegated to services/postgres.ts and services/dumpImport.ts.
 */

/**
 * Gets the effective Odoo version for a database object.
 * Works with both DatabaseModel instances and plain database objects.
 */
export function getEffectiveOdooVersion(db: DatabaseModel | (Partial<DatabaseModel> & { getEffectiveOdooVersion?: () => string | undefined })): string | undefined {
    if (db && typeof db.getEffectiveOdooVersion === 'function') {
        return db.getEffectiveOdooVersion();
    }

    if (db && db.versionId) {
        try {
            const versionsService = VersionsService.getInstance();
            const version = versionsService.getVersion(db.versionId);
            if (version) {
                return version.odooVersion;
            }
        } catch (error) {
            logger.warn(`Failed to get version for database ${getDatabaseLabel(db)}:`, error);
        }
    }
    // Fall back to legacy odooVersion property
    return (db as { odooVersion?: string })?.odooVersion || undefined;
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

export async function promptProjectRepoBranchAssignments(
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
            const branch = await getRepoBranch(repoPath);
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
        const currentBranch = await getRepoBranch(repoPath);
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
export function extractDatabaseFromEvent(event: unknown): DatabaseModel | null {
    if (!event || typeof event !== 'object') {
        return null;
    }
    const candidate = event as Record<string, unknown>;

    // Check if we received a VS Code TreeItem (context menu call)
    // TreeItems have properties like collapsibleState, label, and our custom database property
    if ('collapsibleState' in candidate && 'label' in candidate && candidate.database) {
        return candidate.database as DatabaseModel;
    }

    // Check if it's a direct database object (has required DatabaseModel properties)
    if (typeof candidate.name === 'string' && typeof candidate.id === 'string') {
        return event as DatabaseModel;
    }

    return null;
}

async function getDbDumpFolder(dumpsFolder: string, searchFilter?: string): Promise<DumpSelection | undefined> {
    dumpsFolder = normalizePath(dumpsFolder);

    if (!(await pathExists(dumpsFolder))) {
        void showError(`Dumps folder not found: ${dumpsFolder}`);
        return undefined;
    }

    const matches = await collectDumpSources(dumpsFolder);

    if (matches.length === 0) {
        void showInfo(`No dump directories or zip archives found in ${path.basename(dumpsFolder)}.`);
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
    const candidates = (await listPostgresDatabases())
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
    void showInfo(
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
        } catch (error) {
            void showError(`Failed to create version for Odoo ${series}: ${errorMessage(error)}`);
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
                if (!(await pathExists(candidate))) {
                    void showError(`dump.sql not found inside ${selection.path}`);
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
                void showInfo('No database templates found. Use "Manage Database Templates" to create one first.');
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

/** Clones `templateDbName` into `targetDbName`, replacing any existing DB. */
export async function cloneDatabaseFromTemplate(targetDbName: string, templateDbName: string): Promise<void> {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Setting up database ${targetDbName}`,
        cancellable: false
    }, async (progress) => {
        progress.report({ message: 'Checking database existence...', increment: 20 });
        if (await databaseExists(targetDbName)) {
            progress.report({ message: 'Dropping existing database...', increment: 20 });
            await dropDatabase(targetDbName);
        }

        progress.report({ message: `Cloning from template "${templateDbName}"...`, increment: 50 });
        await createDatabase(targetDbName, templateDbName);

        progress.report({ message: 'Complete!', increment: 30 });
    });
}

/**
 * Creates (or drops, with `remove`) the PostgreSQL database, importing and
 * neutralizing a dump when one is provided.
 */
async function setupDatabase(dbName: string, dumpPath: string | undefined, remove: boolean = false): Promise<void> {
    if (dumpPath && !(await pathExists(dumpPath))) {
        void showError(`Dump file not found at: ${dumpPath}`);
        return;
    }

    let preparedDump: PreparedDump | undefined;
    try {
        preparedDump = dumpPath ? await prepareDumpForImport(dumpPath) : undefined;
    } catch (error) {
        void showError(`Unable to read dump file: ${errorMessage(error)}`);
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
                if (await databaseExists(dbName)) {
                    progress.report({ message: 'Dropping existing database...', increment: 20 });
                    logger.debug(`Dropping existing database: ${dbName}`);
                    await dropDatabase(dbName);
                }

                if (remove) {
                    progress.report({ message: 'Complete!', increment: 100 });
                    return;
                }

                progress.report({ message: 'Creating database...', increment: 40 });
                logger.debug(`Creating database: ${dbName}`);
                await createDatabase(dbName);

                if (preparedDump) {
                    progress.report({
                        message: preparedDump.progressMessage ?? 'Importing dump file...',
                        increment: 50
                    });
                    logger.debug(`Importing SQL dump into ${dbName}`);
                    try {
                        await importPreparedDump(dbName, preparedDump);
                    } catch (error) {
                        if (dumpPath && preparedDump.kind === 'stream' && isToolchainUnavailableError(error)) {
                            logger.warn('Streaming import unavailable. Falling back to temporary dump extraction.');
                            progress.report({
                                message: dumpPath.toLowerCase().endsWith('.zip')
                                    ? 'Streaming unavailable. Extracting archive to temporary SQL file...'
                                    : 'Streaming unavailable. Decompressing dump to temporary SQL file...'
                            });
                            const fallbackDump = await prepareDumpViaTempFile(dumpPath);
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

                    progress.report({ message: 'Configuring database for development...', increment: 70 });
                    await neutralizeDatabase(dbName, randomUUID());
                    progress.report({ message: 'Database configured for development', increment: 90 });
                } else {
                    progress.report({ message: 'Database created (empty)...', increment: 90 });
                    logger.debug(`Empty database created: ${dbName}`);
                }

                progress.report({ message: 'Complete!', increment: 100 });
                logger.debug(`Database "${dbName}" is ready.`);
            } catch (error) {
                logger.error(`Database setup failed for ${dbName}:`, error);
                void showError(`Failed to setup database: ${errorMessage(error)}`);
            }
        });
    } finally {
        if (preparedDump?.cleanup) {
            try {
                preparedDump.cleanup();
            } catch (cleanupError) {
                logger.warn('Failed to cleanup temporary dump files:', cleanupError);
            }
        }
    }
}

export async function restoreDb(event: unknown): Promise<void> {
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
    const confirm = await showModalWarning(
        `Are you sure you want to restore the database "${databaseLabel}"? This will overwrite the existing database.`,
        'Restore'
    );

    if (confirm !== 'Restore') {
        return; // User cancelled
    }

    await setupDatabase(database.id, database.sqlFilePath);
    showAutoInfo(`Database "${databaseLabel}" restored successfully`, 3000);
}

export async function selectDatabase(event: unknown) {
    const database = extractDatabaseFromEvent(event);
    if (!database) {
        void showError('Could not identify the database to select.');
        return;
    }
    const databaseLabel = getDatabaseLabel(database);

    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;

    const projectIndex = data.projects.findIndex(p => p.uid === project.uid);
    if (projectIndex === -1) {
        void showError('The selected project could not be found.');
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

    // Remember the choice against the version this database runs under - the
    // one alignEnvironment is about to activate, not the one being left. Keying
    // it off the outgoing active version would file the database under the
    // wrong version whenever the selection also switches versions.
    // `project` is the object inside `data.projects`, so mutating it here is
    // what the save below persists.
    project.selectedDbByVersion = rememberDbForVersion(
        project.selectedDbByVersion,
        selectedDatabase.versionId || VersionsService.getInstance().getActiveVersion()?.id,
        selectedDatabase.id
    );

    await SettingsStore.saveWithoutComments(stripSettings(data));

    // Align the workbench (active version, core branches, project repo
    // branches) to the database through the single switch pipeline.
    try {
        await alignEnvironment(
            buildDatabaseEnvironmentTarget(selectedDatabase, project.repos ?? []),
            { label: `Database "${databaseLabel}"` }
        );
    } catch (error) {
        logger.error('Error while aligning environment for database selection:', error);
        void showWarning(`Database selected, but environment switching failed: ${errorMessage(error)}`);
    }

    showBriefStatus(`Database switched to: ${databaseLabel}`, 2000);
}

export async function deleteDb(event: unknown) {
    const db = extractDatabaseFromEvent(event);
    if (!db) {
        void showError('Could not identify the database to delete.');
        return;
    }
    const dbLabel = getDatabaseLabel(db);

    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;

    // Find the project index in the projects array
    const projectIndex = data.projects.findIndex(p => p.uid === project.uid);
    if (projectIndex === -1) {
        void showError('The selected project could not be found.');
        return;
    }

    // Ask for confirmation
    const confirm = await showModalWarning(
        `Are you sure you want to delete the database "${dbLabel}"?`,
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

/**
 * Clones an existing linked database into a new one (createdb -T) and adds
 * the clone to the current project with the same version/branch metadata.
 */
export async function cloneDatabaseFlow(event: unknown): Promise<void> {
    const db = extractDatabaseFromEvent(event);
    if (!db) {
        void showError('Could not identify the database to clone.');
        return;
    }

    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;

    const existingIdentifiers = await collectExistingDatabaseIdentifiers();
    let suggestion = `${db.id}-copy`;
    for (let i = 2; existingIdentifiers.has(suggestion.toLowerCase()); i++) {
        suggestion = `${db.id}-copy${i}`;
    }

    const nameInput = await vscode.window.showInputBox({
        prompt: `Clone "${db.id}" into a new database`,
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
        return;
    }
    const targetName = nameInput.trim();

    await cloneDatabaseFromTemplate(targetName, db.id);

    const projectRepoBranches = await captureCurrentRepoBranches(project.repos ?? []);
    const clone = new DatabaseModel(targetName, new Date(), {
        isSelected: false,
        isItABackup: false,
        isExisting: false,
        branchName: db.branchName ?? '',
        versionId: db.versionId,
        displayName: targetName,
        internalName: targetName,
        kind: 'template',
        projectRepoBranches
    });
    project.dbs.push(clone);
    await SettingsStore.saveWithoutComments(stripSettings(data));

    showAutoInfo(`Cloned "${db.id}" into "${targetName}" and added it to project "${project.name}"`, 3500);
}

/**
 * Compares stored database/template references against the live PostgreSQL
 * instance and offers to remove the ones that no longer exist.
 */
export async function reconcileDatabasesFlow(): Promise<void> {
    const stale = await findStaleReferences();
    if (!stale) {
        void showWarning('Could not query PostgreSQL to verify database references.');
        return;
    }

    const total = stale.databases.length + stale.templates.length;
    if (total === 0) {
        showAutoInfo('All linked databases and templates exist in PostgreSQL.', 2500);
        return;
    }

    type StalePick = vscode.QuickPickItem & { staleKind: 'db' | 'template'; key: string; projectName?: string };
    const picks: StalePick[] = [
        ...stale.databases.map(entry => ({
            label: `$(database) ${getDatabaseLabel(entry.db)}`,
            description: `Database in project "${entry.projectName}"`,
            detail: `PostgreSQL database "${entry.db.id}" no longer exists`,
            picked: true,
            staleKind: 'db' as const,
            key: entry.db.id,
            projectName: entry.projectName
        })),
        ...stale.templates.map(template => ({
            label: `$(file-symlink-directory) ${template.name}`,
            description: 'Database template',
            detail: `Template database "${template.templateDbName}" no longer exists`,
            picked: true,
            staleKind: 'template' as const,
            key: template.templateDbName
        }))
    ];

    const chosen = await vscode.window.showQuickPick(picks, {
        canPickMany: true,
        placeHolder: 'These references point to PostgreSQL databases that no longer exist - select which to remove',
        ignoreFocusOut: true
    });
    if (!chosen || chosen.length === 0) {
        return;
    }

    const dbKeys = new Map<string, Set<string>>();
    const templateKeys = new Set<string>();
    for (const pick of chosen) {
        if (pick.staleKind === 'db' && pick.projectName) {
            const set = dbKeys.get(pick.projectName) ?? new Set<string>();
            set.add(pick.key.toLowerCase());
            dbKeys.set(pick.projectName, set);
        } else if (pick.staleKind === 'template') {
            templateKeys.add(pick.key.toLowerCase());
        }
    }

    const data = await SettingsStore.get('odoo-debugger-data.json');
    for (const project of data.projects ?? []) {
        const staleForProject = dbKeys.get(project.name);
        if (!staleForProject || !Array.isArray(project.dbs)) {
            continue;
        }
        const hadSelected = project.dbs.some((db: DatabaseModel) => db.isSelected);
        project.dbs = project.dbs.filter((db: DatabaseModel) => !staleForProject.has(db.id.toLowerCase()));
        if (hadSelected && project.dbs.length > 0 && !project.dbs.some((db: DatabaseModel) => db.isSelected)) {
            project.dbs[0].isSelected = true;
        }
    }
    if (templateKeys.size > 0) {
        data.dbTemplates = (data.dbTemplates ?? []).filter(template => !templateKeys.has(template.templateDbName.toLowerCase()));
    }

    await SettingsStore.saveWithoutComments(stripSettings(data));
    showAutoInfo(`Removed ${chosen.length} stale database reference(s)`, 3000);
}

export async function changeDatabaseVersion(event: unknown) {
    try {
        const db = extractDatabaseFromEvent(event);
        if (!db) {
            void showError('Could not identify the database whose version should change.');
            return;
        }
        const dbLabel = getDatabaseLabel(db);

        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            return;
        }
        const { data, project } = result;

        // Find the project index in the projects array
        const projectIndex = data.projects.findIndex(p => p.uid === project.uid);
        if (projectIndex === -1) {
            void showError('The selected project could not be found.');
            return;
        }

        // Find the database index
        const dbIndex = project.dbs.findIndex((database: DatabaseModel) => database.id === db.id);
        if (dbIndex === -1) {
            void showError('The selected database could not be found.');
            return;
        }

        // Get available versions
        const versionsService = VersionsService.getInstance();
        await versionsService.initialize();
        const availableVersions = versionsService.getVersions();

        // Create version choices including "No Version" option
        const versionChoices = [
            {
                label: '$(close) No Version',
                description: 'Remove version association',
                detail: 'Database will use current branch settings without version',
                versionId: undefined as string | undefined
            },
            ...availableVersions.map(version => ({
                label: `$(versions) ${version.name}`,
                description: `Odoo ${version.odooVersion}`,
                detail: `Use settings and configuration from ${version.name}`,
                versionId: version.id as string | undefined
            }))
        ];

        // Show current version in the placeholder
        let currentVersionText = 'No version';
        if (db.versionId) {
            const currentVersion = versionsService.getVersion(db.versionId);
            currentVersionText = currentVersion ? currentVersion.name : 'Unknown version';
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
                // branchName records the core branch this database runs. Leaving
                // the old one behind makes the row read "17.0 • Odoo 19.0", since
                // the view shows branchName whenever it differs from the version.
                project.dbs[dbIndex].branchName = selectedVersion.odooVersion ?? '';
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
            : 'no version';

        showAutoInfo(`Database "${dbNameForMessage}" updated to use ${newVersionText}`, 3000);

        // If this is the currently selected database, align the workbench to the new version.
        if (db.isSelected && selectedChoice.versionId) {
            await alignEnvironment(
                buildDatabaseEnvironmentTarget(project.dbs[dbIndex], project.repos ?? []),
                { label: `Database "${dbNameForMessage}"` }
            );
        }
    } catch (error) {
        void showError(`Failed to change database version: ${errorMessage(error)}`);
        logger.error('Error in changeDatabaseVersion:', error);
    }
}

export async function changeDatabaseProjectRepoBranches(event: unknown): Promise<void> {
    try {
        const db = extractDatabaseFromEvent(event);
        if (!db) {
            void showError('Could not identify the database whose project repo branches should change.');
            return;
        }
        const dbLabel = getDatabaseLabel(db);

        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            return;
        }
        const { data, project } = result;

        const projectIndex = data.projects.findIndex(p => p.uid === project.uid);
        if (projectIndex === -1) {
            void showError('The selected project could not be found.');
            return;
        }

        const dbIndex = project.dbs.findIndex((database: DatabaseModel) => database.id === db.id);
        if (dbIndex === -1) {
            void showError('The selected database could not be found.');
            return;
        }

        const existingAssignments = sanitizeProjectRepoBranchAssignments(project.dbs[dbIndex].projectRepoBranches);
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
    } catch (error) {
        void showError(`Failed to update project repo branch mapping: ${errorMessage(error)}`);
        logger.error('Error in changeDatabaseProjectRepoBranches:', error);
    }
}

// ---------------------------------------------------------------------------
// Database templates
// ---------------------------------------------------------------------------

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

function collectProjectDatabaseNames(data: DebuggerData): string[] {
    if (!Array.isArray(data.projects)) {
        return [];
    }

    const projectDbNames = data.projects.flatMap(project =>
        Array.isArray(project?.dbs)
            ? project.dbs
                .map(db => typeof db?.id === 'string' ? db.id.trim() : '')
                .filter((name: string) => name.length > 0)
            : []
    );

    return Array.from(new Set(projectDbNames)).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

async function promptTemplateSourceDatabase(data: DebuggerData): Promise<string | undefined> {
    const projectDbNames = collectProjectDatabaseNames(data);
    const postgresDbNames = (await listPostgresDatabases())
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

async function createTemplateFromSource(data: DebuggerData, templates: DatabaseTemplateModel[]): Promise<DatabaseTemplateModel[]> {
    const sourceDbName = await promptTemplateSourceDatabase(data);
    if (!sourceDbName) {
        return templates;
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
        return templates;
    }

    const templateDbName = templateNameInput.trim();
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Creating template ${templateDbName}`,
        cancellable: false
    }, async (progress) => {
        progress.report({ message: `Cloning "${sourceDbName}"...`, increment: 30 });
        await createDatabase(templateDbName, sourceDbName);
        progress.report({ message: 'Saving template metadata...', increment: 70 });
    });

    const now = new Date().toISOString();
    const updated = await persistDatabaseTemplates(data, [
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
    return updated;
}

async function importTemplatesFromPostgres(data: DebuggerData, templates: DatabaseTemplateModel[]): Promise<DatabaseTemplateModel[]> {
    const postgresDbNames = (await listPostgresDatabases())
        .filter(name => !RESERVED_DATABASE_NAMES.has(name.toLowerCase()));
    const existingTemplateDbNames = new Set(templates.map(template => template.templateDbName.toLowerCase()));
    const importCandidates = postgresDbNames.filter(name => !existingTemplateDbNames.has(name.toLowerCase()));

    if (importCandidates.length === 0) {
        void showInfo('No PostgreSQL databases available to import as templates.');
        return templates;
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

    if (!selectedCandidates || selectedCandidates.length === 0) {
        return templates;
    }

    const now = new Date().toISOString();
    const updated = await persistDatabaseTemplates(
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
    return updated;
}

async function importTemplatesFromJson(data: DebuggerData, templates: DatabaseTemplateModel[]): Promise<DatabaseTemplateModel[]> {
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
        return templates;
    }

    try {
        const content = await vscode.workspace.fs.readFile(selectedFiles[0]);
        const parsed = JSON.parse(Buffer.from(content).toString('utf8')) as { templates?: DatabaseTemplateModel[] } | DatabaseTemplateModel[];
        const imported = Array.isArray(parsed) ? parsed : parsed.templates;
        const sanitizedImported = sanitizeDatabaseTemplates(imported);
        if (sanitizedImported.length === 0) {
            void showInfo('No valid templates found in the selected file.');
            return templates;
        }

        const existingTemplateDbNames = new Set(templates.map(template => template.templateDbName.toLowerCase()));
        const toAdd = sanitizedImported.filter(template => !existingTemplateDbNames.has(template.templateDbName.toLowerCase()));
        if (toAdd.length === 0) {
            void showInfo('All templates in the selected file already exist.');
            return templates;
        }

        const updated = await persistDatabaseTemplates(data, [...templates, ...toAdd]);
        showAutoInfo(`Imported ${toAdd.length} template(s) from JSON`, 2500);
        return updated;
    } catch (error) {
        void showError(`Failed to import templates: ${errorMessage(error)}`);
        return templates;
    }
}

async function exportTemplatesToJson(templates: DatabaseTemplateModel[]): Promise<void> {
    if (templates.length === 0) {
        void showInfo('No templates available to export.');
        return;
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
        return;
    }

    const payload = {
        exportedAt: new Date().toISOString(),
        templates
    };

    await vscode.workspace.fs.writeFile(saveUri, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
    showAutoInfo(`Exported ${templates.length} template(s)`, 2500);
}

async function manageSingleTemplate(data: DebuggerData, templates: DatabaseTemplateModel[], selectedTemplate: DatabaseTemplateModel): Promise<DatabaseTemplateModel[]> {
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
        return templates;
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
            return templates;
        }

        const newTemplateDbName = newNameInput.trim();
        if (newTemplateDbName.toLowerCase() === selectedTemplate.templateDbName.toLowerCase()) {
            return templates;
        }

        await renameDatabase(selectedTemplate.templateDbName, newTemplateDbName);

        const now = new Date().toISOString();
        const updated = await persistDatabaseTemplates(
            data,
            templates.map(template => template.templateDbName.toLowerCase() === selectedTemplate.templateDbName.toLowerCase()
                ? {
                    ...template,
                    name: newTemplateDbName,
                    templateDbName: newTemplateDbName,
                    updatedAt: now
                }
                : template
            )
        );
        showAutoInfo(`Template renamed to "${newTemplateDbName}"`, 2500);
        return updated;
    }

    const deleteChoice = await showModalWarning(
        `Delete template "${selectedTemplate.name}" (${selectedTemplate.templateDbName})?`,
        'Delete Template DB + Metadata',
        'Delete Metadata Only'
    );

    if (!deleteChoice) {
        return templates;
    }

    if (deleteChoice === 'Delete Template DB + Metadata') {
        await dropDatabaseIfExists(selectedTemplate.templateDbName);
    }

    const updated = await persistDatabaseTemplates(
        data,
        templates.filter(template => template.templateDbName.toLowerCase() !== selectedTemplate.templateDbName.toLowerCase())
    );
    showAutoInfo(`Template "${selectedTemplate.name}" deleted`, 2500);
    return updated;
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

        switch (selectedAction.action) {
            case 'create':
                templates = await createTemplateFromSource(data, templates);
                break;
            case 'importDb':
                templates = await importTemplatesFromPostgres(data, templates);
                break;
            case 'importFile':
                templates = await importTemplatesFromJson(data, templates);
                break;
            case 'exportFile':
                await exportTemplatesToJson(templates);
                break;
            case 'template':
                if (selectedAction.template) {
                    templates = await manageSingleTemplate(data, templates, selectedAction.template);
                }
                break;
        }
    }
}
