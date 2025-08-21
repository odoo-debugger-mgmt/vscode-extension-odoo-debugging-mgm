import * as vscode from 'vscode';
import { DatabaseModel } from './models/db';
import { ModuleModel } from './models/module';
import { VersionModel } from './models/version';
import { listSubdirectories, normalizePath, getGitBranch, showError, showInfo, showWarning, showAutoInfo, showBriefStatus, addActiveIndicator, stripSettings } from './utils';
import { SettingsStore } from './settingsStore';
import { VersionsService } from './versionsService';
import { execSync, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RepoModel } from './models/repo';
import { randomUUID } from 'crypto';

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
            console.warn(`Failed to get version for database ${db.name}:`, error);
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
            console.warn(`Failed to get version name for database ${db.name}:`, error);
            return undefined;
        }
    }
    return undefined;
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

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }
    constructor(context: vscode.ExtensionContext) {}
    getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
        return item;
    }
    async getChildren(element?: any): Promise<vscode.TreeItem[]> {
        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            return [];
        }

        const { project } = result;
        const dbs: DatabaseModel[] = project.dbs;
        if (!dbs) {
            showError('No databases found');
            return [];
        }

        return dbs.map(db => {
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

            // Main label is just the database name with active indicator and badges
            const badges = `${db.isItABackup ? ' ☁️' : ''}${db.isExisting ? ' 📂' : ''}`;
            const mainLabel = addActiveIndicator(db.name, db.isSelected) + badges;

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
            treeItem.id = `${db.name}-${formattedDate}`;
            treeItem.description = description;

            // Create tooltip - push each detail into array, join with \n\n at the end
            const tooltipDetails = [];

            // Database name header
            tooltipDetails.push(`**${db.name}**`);

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
            tooltipDetails.push(`**Database ID:** ${db.id}`);

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
    const repos = [
        { name: 'Odoo', path: normalizePath(settings.odooPath) },
        { name: 'Enterprise', path: normalizePath(settings.enterprisePath) },
        { name: 'Design Themes', path: normalizePath(settings.designThemesPath || './design-themes') }
    ];

    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Switching to branch: ${branch}`,
        cancellable: false
    }, async (progress) => {
        const results: { name: string; success: boolean; message: string }[] = [];
        const totalRepos = repos.length;

        // Process each repository
        for (let i = 0; i < repos.length; i++) {
            const repo = repos[i];

            progress.report({
                message: `Processing ${repo.name}...`,
                increment: (i / totalRepos) * 100
            });

            if (!fs.existsSync(repo.path)) {
                results.push({
                    name: repo.name,
                    success: false,
                    message: `Repository path does not exist: ${repo.path}`
                });
                continue;
            }

            try {
                await new Promise<void>((resolve, reject) => {
                    exec(`git checkout ${branch}`, { cwd: repo.path }, (err, stdout, stderr) => {
                        // Check if we're already on the target branch (this is actually success)
                        if (stderr && stderr.includes(`Already on '${branch}'`)) {
                            results.push({
                                name: repo.name,
                                success: true,
                                message: `Already on branch: ${branch}`
                            });
                            resolve();
                            return;
                        }

                        // Check for actual errors
                        if (err || (stderr && !stderr.includes('Switched to branch'))) {
                            results.push({
                                name: repo.name,
                                success: false,
                                message: stderr || err?.message || 'Unknown error'
                            });
                            reject(new Error(`Failed to checkout branch ${branch} in ${repo.name}`));
                            return;
                        }

                        // Success case
                        results.push({
                            name: repo.name,
                            success: true,
                            message: `Switched to branch: ${branch}`
                        });
                        resolve();
                    });
                });
            } catch (error) {
                // Error was already logged in results, continue with next repo
                continue;
            }
        }

        // Check results and provide feedback
        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);

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
    });
}

export async function getDbDumpFolder(dumpsFolder: string, searchFilter?: string): Promise<string | undefined> {
    dumpsFolder = normalizePath(dumpsFolder);

    if (!fs.existsSync(dumpsFolder)) {
        showError(`Dumps folder not found: ${dumpsFolder}`);
        return undefined;
    }

    const foldersInDumpsFolder = fs.readdirSync(dumpsFolder);
    const matchingFolders: string[] = [];

    for (const folder of foldersInDumpsFolder) {
        const fullPath = path.join(dumpsFolder, folder);
        if (fs.statSync(fullPath).isDirectory()) {
            const dumpSqlPath = path.join(fullPath, 'dump.sql');
            if (fs.existsSync(dumpSqlPath)) {
                matchingFolders.push(fullPath);
            }
        }
    }

    if (matchingFolders.length === 0) {
        showInfo(`No folders with dump.sql found in ${path.basename(dumpsFolder)}.`);
        return undefined;
    }

    // Filter and sort folders if search filter is provided
    let foldersToShow = matchingFolders.map(folder => ({
        label: path.basename(folder),
        description: folder,
    }));

    if (searchFilter && searchFilter.trim() !== '') {
        const filterTerm = searchFilter.toLowerCase();

        // Separate exact matches, partial matches, and no matches for sorting
        const exactMatches = foldersToShow.filter(item =>
            item.label.toLowerCase() === filterTerm
        );
        const partialMatches = foldersToShow.filter(item =>
            item.label.toLowerCase().includes(filterTerm) &&
            item.label.toLowerCase() !== filterTerm
        );
        const noMatches = foldersToShow.filter(item =>
            !item.label.toLowerCase().includes(filterTerm)
        );

        // Show exact matches first, then partial matches, then everything else
        foldersToShow = [...exactMatches, ...partialMatches, ...noMatches];
    }

    const selected = await vscode.window.showQuickPick(foldersToShow, {
        placeHolder: searchFilter
            ? `Select a dump folder (showing "${searchFilter}" matches first)`
            : 'Select a folder containing dump.sql',
        ignoreFocusOut: true
    });

    return selected ? selected.description : undefined;
}

export async function createDb(projectName:string, repos:RepoModel[], dumpFolderPath:string, settings: SettingsModel): Promise<DatabaseModel | undefined> {
    let allModules: {"path": string, "name": string, "source": string}[] = [];

    // Collect modules from regular repositories and ps*-internal directories
    for (const repo of repos) {
        // Add regular modules from repo root
        const repoModules = listSubdirectories(repo.path);
        allModules = allModules.concat(repoModules.map(module => ({
            ...module,
            source: repo.name
        })));

        // Check for ps*-internal directories in this repo
        try {
            const repoDirContents = fs.readdirSync(repo.path);
            for (const item of repoDirContents) {
                // Match pattern: ps followed by any letters, then -internal
                if (/^ps[a-z]*-internal$/i.test(item)) {
                    const psInternalPath = `${repo.path}/${item}`;
                    if (fs.existsSync(psInternalPath) && fs.statSync(psInternalPath).isDirectory()) {
                        try {
                            const psModules = listSubdirectories(psInternalPath);
                            allModules = allModules.concat(psModules.map(module => ({
                                ...module,
                                source: `${repo.name}/${item}`
                            })));
                        } catch (error) {
                            console.warn(`Failed to read ${item} modules from ${psInternalPath}:`, error);
                        }
                    }
                }
            }
        } catch (error) {
            console.warn(`Failed to read repo directory ${repo.path}:`, error);
        }
    }

    let selectedModules: string[] = [];
    let db: DatabaseModel | undefined;
    let modules: ModuleModel[] = [];

    // Step 1: Choose database creation method
    const creationMethod = await vscode.window.showQuickPick([
        {
            label: "Fresh Database",
            description: "Create a new empty database and install modules",
            detail: "Start with a clean Odoo installation"
        },
        {
            label: "From Dump File",
            description: "Restore database from a dump/backup file",
            detail: "Import an existing database backup"
        },
        {
            label: "Connect to Existing",
            description: "Reference an already existing database",
            detail: "Use a database that already exists in PostgreSQL"
        }
    ], {
        placeHolder: 'How do you want to create this database?',
        ignoreFocusOut: true
    });

    if (!creationMethod) {
        return undefined; // User cancelled
    }

    let dumpFolder: string | undefined;
    let existingDbName: string | undefined;
    let isExistingDb = false;
    let sqlDumpPath: string | undefined;

    // Step 2: Handle the specific creation method
    switch (creationMethod.label) {
        case "Fresh Database":
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
            }) || [];

            selectedModules = selectedModuleObjects.map(choice => choice.label);
            break;

        case "From Dump File":
            // Select dump folder
            dumpFolder = await getDbDumpFolder(dumpFolderPath, projectName);
            if (!dumpFolder) {
                showError('No dump folder selected');
                return undefined;
            }
            sqlDumpPath = path.join(dumpFolder, 'dump.sql');
            break;

        case "Connect to Existing":
            // Get existing database name
            existingDbName = await vscode.window.showInputBox({
                placeHolder: 'Enter the name of the existing PostgreSQL database',
                prompt: 'Make sure the database exists in your PostgreSQL instance',
                ignoreFocusOut: true
            });
            if (!existingDbName) {
                showError('Database name is required');
                return undefined;
            }
            isExistingDb = true;
            break;
    }

    // Step 3: Get database branch name (optional)
    let branchName: string | undefined = await vscode.window.showInputBox({
        placeHolder: 'Enter a branch/tag name for this database (optional)',
        prompt: 'This helps identify which version/branch this database represents',
        ignoreFocusOut: true
    });

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

        if (selectedChoice) {
            selectedVersionId = selectedChoice.versionId;
            if (selectedVersionId) {
                selectedVersion = versionsService.getVersion(selectedVersionId);
            }
        }
    }

    // Step 5: Create the database model
    for (const module of selectedModules) {
        modules.push(new ModuleModel(module, 'install'));
    }

    // Generate a more descriptive database name
    let dbName: string;
    if (existingDbName) {
        dbName = existingDbName;
    } else {
        const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
        const methodPrefix = creationMethod.label === "From Dump File" ? "dump" : "fresh";
        dbName = `${projectName}-${methodPrefix}-${timestamp}`;
    }
    db = new DatabaseModel(
        dbName,
        new Date(),
        {
            modules,
            isItABackup: false, // isSelected (will be set when added to project)
            isSelected: true, // isActive
            sqlFilePath: sqlDumpPath,
            isExisting: isExistingDb,
            branchName,
            // Only set odooVersion if no version is selected (legacy compatibility)
            odooVersion: selectedVersionId ? undefined : (selectedVersion?.odooVersion || ''),
            versionId: selectedVersionId
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

    // Check if database has a backup file path
    if (!database.sqlFilePath || database.sqlFilePath.trim() === '') {
        throw new Error('No backup file path defined for this database');
    }

    // Ask for confirmation
    const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to restore the database "${database.name}"? This will overwrite the existing database.`,
        { modal: true },
        'Restore'
    );

    if (confirm !== 'Restore') {
        return; // User cancelled
    }

    await setupDatabase(database.id, database.sqlFilePath);
    showAutoInfo(`Database "${database.name}" restored successfully`, 3000);
}

export async function setupDatabase(dbName: string, dumpPath: string | undefined, remove: boolean = false): Promise<void> {
    if (dumpPath && !fs.existsSync(dumpPath)) {
        console.error(`❌ Dump file not found at: ${dumpPath}`);
        return;
    }

    const operation = remove ? 'Removing' : dumpPath ? 'Setting up' : 'Creating';
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `${operation} database ${dbName}`,
        cancellable: false
    }, async (progress) => {
        try {
            // Check if the database exists
            progress.report({ message: 'Checking database existence...', increment: 10 });
            const checkCommand = `psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`;
            const result = execSync(checkCommand).toString().trim();

            if (result === '1') {
                progress.report({ message: 'Dropping existing database...', increment: 20 });
                console.log(`🗑️ Dropping existing database: ${dbName}`);
                execSync(`dropdb ${dbName}`, { stdio: 'inherit' });
            }

            if (!remove) {
                progress.report({ message: 'Creating database...', increment: 40 });
                console.log(`🚀 Creating database: ${dbName}`);
                execSync(`createdb ${dbName}`, { stdio: 'inherit' });

                if (dumpPath) {
                    progress.report({ message: 'Importing dump file...', increment: 50 });
                    console.log(`📥 Importing SQL dump into ${dbName}`);
                    execSync(`psql ${dbName} < "${dumpPath}"`, { stdio: 'inherit', shell: '/bin/sh' });

                    progress.report({ message: 'Configuring database...', increment: 70 });
                    console.log(`� Configuring database for development use`);

                    // Generate a new UUID for the database
                    const newUuid = randomUUID();

                    // Disable crons
                    console.log(`⏸️ Disabling cron jobs`);
                    execSync(`psql ${dbName} -c "UPDATE ir_cron SET active='f';"`, { stdio: 'inherit', shell: '/bin/sh' });

                    // Disable mail servers
                    console.log(`📧 Disabling mail servers`);
                    execSync(`psql ${dbName} -c "UPDATE ir_mail_server SET active=false;"`, { stdio: 'inherit', shell: '/bin/sh' });

                    // Set enterprise expiration date far in the future
                    console.log(`⏰ Extending database expiry`);
                    execSync(`psql ${dbName} -c "UPDATE ir_config_parameter SET value = '2090-09-21 00:00:00' WHERE key = 'database.expiration_date';"`, { stdio: 'inherit', shell: '/bin/sh' });

                    // Change database UUID to avoid conflicts with production
                    console.log(`🔑 Updating database UUID`);
                    execSync(`psql ${dbName} -c "UPDATE ir_config_parameter SET value = '${newUuid}' WHERE key = 'database.uuid';"`, { stdio: 'inherit', shell: '/bin/sh' });

                    // Add mailcatcher server for development
                    console.log(`📨 Adding mailcatcher server`);
                    try {
                        execSync(`psql ${dbName} -c "INSERT INTO ir_mail_server(active,name,smtp_host,smtp_port,smtp_encryption) VALUES (true,'mailcatcher','localhost',1025,false);"`, { stdio: 'inherit', shell: '/bin/sh' });
                    } catch (error) {
                        console.warn(`⚠️ Failed to add mailcatcher server (continuing setup): ${error}`);
                    }

                    // Reset user passwords to their login
                    console.log(`👤 Resetting user passwords to login names`);
                    execSync(`psql ${dbName} -c "UPDATE res_users SET password=login;"`, { stdio: 'inherit', shell: '/bin/sh' });

                    // Configure admin user specifically
                    console.log(`🔐 Configuring admin user`);
                    execSync(`psql ${dbName} -c "UPDATE res_users SET password='admin' WHERE id=2;"`, { stdio: 'inherit', shell: '/bin/sh' });
                    execSync(`psql ${dbName} -c "UPDATE res_users SET login='admin' WHERE id=2;"`, { stdio: 'inherit', shell: '/bin/sh' });
                    execSync(`psql ${dbName} -c "UPDATE res_users SET totp_secret='' WHERE id=2;"`, { stdio: 'inherit', shell: '/bin/sh' });
                    execSync(`psql ${dbName} -c "UPDATE res_users SET active=true WHERE id=2;"`, { stdio: 'inherit', shell: '/bin/sh' });

                    // Clear employee PINs
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
}

export async function selectDatabase(event: any) {
    const database = extractDatabaseFromEvent(event);
    if (!database) {
        showError('Invalid database object for selection');
        return;
    }

    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;

    // Find the project index in the projects array
    const projectIndex = data.projects.findIndex((p: any) => p.uid === project.uid);
    if (projectIndex === -1) {
        showError('Project not found');
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

    showBriefStatus(`Database switched to: ${database.name}`, 2000);
}

async function handleDatabaseVersionSwitch(database: DatabaseModel): Promise<void> {
    const versionsService = VersionsService.getInstance();
    await versionsService.initialize();
    const settings = await versionsService.getActiveVersionSettings();

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
                placeHolder: `Database "${database.name}" uses version "${dbVersion.name}". What would you like to do?`,
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
        const currentDesignThemesBranch = await getGitBranch(settings.designThemesPath || './design-themes');

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
            showAutoInfo(`No version settings to switch to for database "${database.name}"`, 2000);
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
        showError('Invalid database object for deletion');
        return;
    }

    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;

    // Find the project index in the projects array
    const projectIndex = data.projects.findIndex((p: any) => p.uid === project.uid);
    if (projectIndex === -1) {
        showError('Project not found');
        return;
    }

    // Ask for confirmation
    const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to delete the database "${db.name}"?`,
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

    showAutoInfo(`Database "${db.name}" deleted successfully`, 2500);

    if (db.isSelected && project.dbs.length > 0) {
        showBriefStatus(`Switched to database: ${project.dbs[0].name}`, 2000);
    }
}

export async function changeDatabaseVersion(event: any) {
    try {
        const db = extractDatabaseFromEvent(event);
        if (!db) {
            showError('Invalid database object for version change');
            return;
        }

        const result = await SettingsStore.getSelectedProject();
        if (!result) {
            return;
        }
    const { data, project } = result;

    // Find the project index in the projects array
    const projectIndex = data.projects.findIndex((p: any) => p.uid === project.uid);
    if (projectIndex === -1) {
        showError('Project not found');
        return;
    }

    // Find the database index
    const dbIndex = project.dbs.findIndex((database: DatabaseModel) => database.id === db.id);
    if (dbIndex === -1) {
        showError('Database not found');
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
        placeHolder: `Current: ${currentVersionText}. Select a new version for database "${db.name}"`,
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
    const dbNameForMessage = updatedDb?.name || db?.name || 'Unknown Database';
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
