import * as vscode from 'vscode';
import { DatabaseModel } from './models/db';
import { ModuleModel } from './models/module';
import { listSubdirectories, normalizePath, getGitBranch, showError, showInfo, showWarning, showAutoInfo, showBriefStatus } from './utils';
import { SettingsStore } from './settingsStore';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RepoModel } from './models/repo';
import { exec } from 'child_process';
import { randomUUID } from 'crypto';

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
            const editedDate = new Date(db.createdAt);
            const formattedDate = `${editedDate.toISOString().split('T')[0]}-${editedDate.toTimeString().split(' ')[0]}`;
            const branchName = db.branchName ? `🌿 ${db.branchName} ` : '';
            const version = db.odooVersion ? `🛠️ ${db.odooVersion} ` : '';
            let itemName = `${db.isSelected ? '👉' : ''} ${db.name} ${branchName}${version}🕒 ${formattedDate} ${db.isItABackup ? ' ☁️' : ''} ${db.isExisting ? ' 📂' : ''}`;
            const treeItem = new vscode.TreeItem(itemName);
            treeItem.id = `${db.name}-${formattedDate}`;
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

    // Step 4: Select the Odoo version/branch
    const version = await showBranchSelector(settings.odooPath) || '';
    if (!version) {
        showInfo('No version selected, using current branch');
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
        modules,
        false, // isSelected (will be set when added to project)
        true, // isActive
        sqlDumpPath,
        isExistingDb,
        branchName,
        version
    );

    // Step 6: Set up the database if needed
    if (sqlDumpPath) {
        db.isItABackup = true;
        await setupDatabase(db.id, sqlDumpPath);
    } else if (!isExistingDb) {
        // Create fresh database
        await setupDatabase(db.id, undefined);
    }

    // Step 7: Check if branches need switching at the end, after all configuration is done
    if (version && version !== '') {
        const currentOdooBranch = await getGitBranch(settings.odooPath);
        const currentEnterpriseBranch = await getGitBranch(settings.enterprisePath);
        const currentDesignThemesBranch = await getGitBranch(settings.designThemesPath || './design-themes');

        const shouldSwitch = await promptBranchSwitch(version, {
            odoo: currentOdooBranch,
            enterprise: currentEnterpriseBranch,
            designThemes: currentDesignThemesBranch
        });

        if (shouldSwitch) {
            await checkoutBranch(settings, version);
        }
    }

    return db;
}

export async function restoreDb(db: any): Promise<void> {
    const database: DatabaseModel = db;
    if (!db.command.arguments[0].sqlFilePath) {
        throw new Error('SQL dump path is not defined');
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

    await setupDatabase(database.id, db.command.arguments[0].sqlFilePath);
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
    const database: DatabaseModel = event;
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
        await SettingsStore.saveWithComments(false, ["projects", projectIndex, "dbs", oldSelectedDbIndex, "isSelected"], "odoo-debugger-data.json");
    }
    const newSelectedDbIndex = project.dbs.findIndex((db: DatabaseModel) => db.id === database.id);
    if (newSelectedDbIndex !== -1) {
        await SettingsStore.saveWithComments(true, ["projects", projectIndex, "dbs", newSelectedDbIndex, "isSelected"], "odoo-debugger-data.json");
    }

    // Check if we need to switch branches (only if database has a version and it's different from current)
    if (database.odooVersion && database.odooVersion !== '') {
        const currentOdooBranch = await getGitBranch(data.settings.odooPath);
        const currentEnterpriseBranch = await getGitBranch(data.settings.enterprisePath);
        const currentDesignThemesBranch = await getGitBranch(data.settings.designThemesPath || './design-themes');

        const shouldSwitch = await promptBranchSwitch(database.odooVersion, {
            odoo: currentOdooBranch,
            enterprise: currentEnterpriseBranch,
            designThemes: currentDesignThemesBranch
        });

        if (shouldSwitch) {
            await checkoutBranch(data.settings, database.odooVersion);
        }
    }

    showBriefStatus(`Database switched to: ${database.name}`, 2000);
}

export async function deleteDb(event: any) {
    const db: DatabaseModel = event;
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
    await SettingsStore.saveWithComments(project.dbs, ["projects", projectIndex, "dbs"], 'odoo-debugger-data.json');

    showAutoInfo(`Database "${db.name}" deleted successfully`, 2500);

    // If the deleted database was selected and there are other databases, select the first one
    if (db.isSelected && project.dbs.length > 0) {
        project.dbs[0].isSelected = true;
        await SettingsStore.saveWithComments(project.dbs, ["projects", projectIndex, "dbs"], 'odoo-debugger-data.json');
        showBriefStatus(`Switched to database: ${project.dbs[0].name}`, 2000);
    }
}
