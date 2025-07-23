import * as vscode from 'vscode';
import { DatabaseModel } from './models/db';
import { ModuleModel } from './models/module';
import { listSubdirectories, normalizePath, getGitBranch } from './utils';
import { SettingsStore } from './settingsStore';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RepoModel } from './models/repo';
import { exec } from 'child_process';
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
            vscode.window.showErrorMessage('No databases found');
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
        vscode.window.showErrorMessage(`Repository path does not exist: ${repoPath}`);
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
        vscode.window.showErrorMessage(error.message);
        return undefined;
    }
}

export function checkoutBranch(settings: SettingsModel, branch: string) {
    let odooPath = normalizePath(settings.odooPath);
    settings.odooPath = odooPath;
    exec(`git checkout ${branch}`, { cwd: settings.odooPath }, (err, stdout, stderr) => {
        if (err || stderr) {
            vscode.window.showErrorMessage(`Failed to switch to branch "${branch}": ${stderr || (err?.message || 'Unknown error')}`);
            return;
        }

        vscode.window.showInformationMessage(`Odoo Switched to branch: ${branch}`);
    });
    let enterprisePath = normalizePath(settings.enterprisePath);
    settings.enterprisePath = enterprisePath;
    exec(`git checkout ${branch}`, { cwd: settings.enterprisePath }, (err, stdout, stderr) => {
        if (err || stderr) {
            vscode.window.showErrorMessage(`Failed to switch to branch "${branch}": ${stderr || (err?.message || 'Unknown error')}`);
            return;
        }

        vscode.window.showInformationMessage(`Enterprise Switched to branch: ${branch}`);
    });
}

export async function getDbDumpFolder(dumpsFolder: string): Promise<string | undefined> {
    dumpsFolder = normalizePath(dumpsFolder);

    if (!fs.existsSync(dumpsFolder)) {
        vscode.window.showErrorMessage('Downloads folder not found.');
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
        vscode.window.showInformationMessage('No folders with dump.sql found in Downloads.');
        return undefined;
    }

    const selected = await vscode.window.showQuickPick(
        matchingFolders.map(folder => ({
            label: path.basename(folder),
            description: folder,
        })),
        {
            placeHolder: 'Select a folder containing dump.sql',
            ignoreFocusOut: true
        }
    );

    return selected ? selected.description : undefined;
}

export async function createDb(projectName:string, repos:RepoModel[], dumpFolderPath:string, settings: SettingsModel): Promise<DatabaseModel | undefined> {
    let allModules: {"path": string, "name": string}[] = [];
    for (const repo of repos) {
        allModules = allModules.concat(listSubdirectories(repo.path));
    }
    let selectedModules: string[] | [] = [];
    let db: DatabaseModel | undefined;
    let modules: ModuleModel[] = [];
    const version = await showBranchSelector(settings.odooPath) || '';
    const createFromBackup = await vscode.window.showQuickPick(["yes","no"], {
        placeHolder: 'Do you want to create a db from a backup?',
        ignoreFocusOut: true});
    let dumpFolder : string | undefined;
    if (version !== '' || version !== undefined) {
        checkoutBranch(settings, version);
    }
    let existingDbName: string | undefined;
    let isExistingDb: string | undefined;
    if (createFromBackup === "no") {
        isExistingDb = await vscode.window.showQuickPick(["yes","no"], {
            placeHolder: 'Is it an existing DB?',
            ignoreFocusOut: true
        });
        if( isExistingDb === "yes") {
            existingDbName = await vscode.window.showInputBox({
                placeHolder: 'Enter the name of the existing database',
                ignoreFocusOut: true
            });
            if (!existingDbName) {
                vscode.window.showErrorMessage('Database name is required');
                return undefined;
            }
        }else{
            selectedModules = await vscode.window.showQuickPick(allModules.map(entry => entry.name), {
                placeHolder: 'Select modules',
                canPickMany: true,
                ignoreFocusOut: true
            }) || [];
        }
    }else{
        dumpFolder = await getDbDumpFolder(dumpFolderPath);
    }
    let branchName: string | undefined = await vscode.window.showInputBox({
        placeHolder: 'Enter the name of the db branch',
        ignoreFocusOut: true
    });
    const sqlDumpPath: string | undefined = dumpFolderPath && dumpFolder ? path.join(dumpFolder!, 'dump.sql') : undefined;
    for (const module of selectedModules) {
        modules.push(new ModuleModel(module, 'install'));
    }
    const dbName = existingDbName ? existingDbName : `db-${projectName}`;
    db = new DatabaseModel(dbName, new Date(), modules, false, true, sqlDumpPath, isExistingDb === 'yes' ? true : false, branchName, version); // to be updated
    if (sqlDumpPath) {
        db.isItABackup = true;
        setupDatabase(db.id, sqlDumpPath);
    }
    return db;
}

export async function restoreDb(db: any): Promise<void> {
    const database: DatabaseModel = db;
    if (!db.command.arguments[0].sqlFilePath) {
        throw new Error('SQL dump path is not defined');
    }
    setupDatabase(database.id, db.command.arguments[0].sqlFilePath);
}

export async function setupDatabase(dbName: string, dumpPath: string | undefined, remove: boolean=false): Promise<void> {
    if (dumpPath && !fs.existsSync(dumpPath)) {
        console.error(`❌ Dump file not found at: ${dumpPath}`);
        return;
    }
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Setting up database ${dbName}`,
        cancellable: false
    }, async (progress) => {
        try {
            // Check if the database exists
            const checkCommand = `psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`;
            const result = execSync(checkCommand).toString().trim();

            if (result === '1') {
                console.log(`🗑️ Dropping existing database: ${dbName}`);
                execSync(`dropdb ${dbName}`, { stdio: 'inherit' });
            }

            if(!remove) {
                console.log(`🚀 Creating database: ${dbName}`);
                execSync(`createdb ${dbName}`, { stdio: 'inherit' });
            }

            if (dumpPath) {
                console.log(`📥 Importing SQL dump into ${dbName}`);
                execSync(`psql ${dbName} < "${dumpPath}"`, { stdio: 'inherit', shell: '/bin/sh' });
                console.log(`🔐 Resetting admin credentials for ${dbName}`);
                execSync(`psql ${dbName} -c "UPDATE res_users SET password='admin'"`, { stdio: 'inherit', shell: '/bin/sh' });
                execSync(`psql ${dbName} -c "UPDATE res_users SET login='admin' WHERE id=2;"`, { stdio: 'inherit', shell: '/bin/sh' });
                console.log(` Extending db expiry`);
                execSync(`psql ${dbName} -c "UPDATE ir_config_parameter SET value = '2042-01-01 00:00:00' WHERE key = 'database.expiration_date'"`, { stdio: 'inherit', shell: '/bin/sh' });
            }

            console.log(`✅ Database "${dbName}" is ready.`);
        } catch (error: any) {
            console.error(`❌ Error: ${error.message}`);
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
    const oldSelectedDbIndex = project.dbs.findIndex((db: DatabaseModel) => db.isSelected);
    if (oldSelectedDbIndex !== -1) {
        SettingsStore.save(false, ["projects", project.uid, "dbs", oldSelectedDbIndex, "isSelected"], "odoo-debugger-data.json");
    }
    const newSelectedDbIndex = project.dbs.findIndex((db: DatabaseModel) => db.id === database.id);
    if (newSelectedDbIndex !== -1) {
        SettingsStore.save(true, ["projects", project.uid, "dbs", newSelectedDbIndex, "isSelected"], "odoo-debugger-data.json");
    }
    if (
        database.odooVersion !== '' ||
        database.odooVersion !== undefined ||
        getGitBranch(data.settings.odooPath) !== database.odooVersion ||
        getGitBranch(data.settings.enterprisePath) !== database.odooVersion
    ) {
        checkoutBranch(data.settings, database.odooVersion);
    }
}

export async function deleteDb(event: any) {
    const db: DatabaseModel = event;
    const result = await SettingsStore.getSelectedProject();
    if (!result) {
        return;
    }
    const { data, project } = result;
    setupDatabase(db.id, undefined, true);
    project.dbs = project.dbs.filter((database: DatabaseModel) => database.id !== db.id);
    await SettingsStore.save(project.dbs, ["projects", project.uid, "dbs"], 'odoo-debugger-data.json');
}
