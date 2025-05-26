import * as vscode from 'vscode';
import { ProjectModel } from './models/project';
import { DatabaseModel } from './models/db';
import { ModuleModel } from './models/module';
import { getFolderPathsAndNames } from './common';
import { readFromFile, saveToFile } from './common';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RepoModel } from './models/repo';

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
        let settings = await readFromFile('odoo-debugger-data.json');
        let projects: ProjectModel[] = settings['projects'];
        if (!projects) {
            vscode.window.showErrorMessage('Error reading projects, please create a project first');
            return [];
        }
        if (typeof projects !== 'object') {
            vscode.window.showErrorMessage('Error reading projects');
            return [];
        }
        let project: ProjectModel | undefined;
        project = projects.find((project: ProjectModel) => project.isSelected === true);
        if (!project) {
            vscode.window.showErrorMessage('No project selected');
            return [];
        }
        let dbs: DatabaseModel[] = project.dbs;
        if (!dbs) {
            vscode.window.showErrorMessage('No databases found');
            return [];
        }

        return dbs.map(db => {
            const editedDate = new Date(db.createdAt);
            const formattedDate = `${editedDate.toISOString().split('T')[0]}-${editedDate.toTimeString().split(' ')[0]}`;
            const treeItem = new vscode.TreeItem(`${db.isSelected ? '👉': ''} ${db.name}-${formattedDate}${db.isItABackup ? '-☁️': ''}` );
            treeItem.id = `${db.name}-${formattedDate}`;
            treeItem.command = {
                command: 'dbSelector.selectDb',
                title: 'Select DB',
                arguments: [db]
            };
            return treeItem;
        }
        );
    }
}

export async function createDb(projectName:string, repos:RepoModel[], dumpFolderPath:string): Promise<DatabaseModel | undefined> {
    let allModules: {"path": string, "name": string}[] = [];
    for (const repo of repos) {
        allModules = allModules.concat(getFolderPathsAndNames(repo.path));
    }
    let selectedModules: string[] | [] = [];
    let db: DatabaseModel | undefined;
    let modules: ModuleModel[] = [];

    const createFromBackup = await vscode.window.showQuickPick(["yes","no"], {
        placeHolder: 'Do you want to create a db from a backup?',
        ignoreFocusOut: true});
    let dumpFolder : string | undefined;

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

    const sqlDumpPath: string | undefined = dumpFolderPath && dumpFolder ? path.join(dumpFolder!, 'dump.sql') : undefined;
    for (const module of selectedModules) {
        modules.push(new ModuleModel(module, 'install'));
    }
    const dbName = existingDbName ? existingDbName : `db-${projectName}`;
    db = new DatabaseModel(dbName, new Date(), modules, false, true, sqlDumpPath, isExistingDb === 'yes' ? true : false); // to be updated
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

export async function getDbDumpFolder(dumpsFolder: string): Promise<string | undefined> {

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

export async function selectDatabase(event: any) {
    const database: DatabaseModel = event;
    let settings = await readFromFile('odoo-debugger-data.json');
    if (!settings) {
        vscode.window.showErrorMessage('Error reading settings');
        return;
    }
    let projects: ProjectModel[] = settings['projects'];
    if (!projects) {
        vscode.window.showErrorMessage('Error reading projects');
        return;
    }

    const project = projects.find((project => project.isSelected === true));
    if (!project) {
        vscode.window.showErrorMessage('No project selected');
        return;
    }
    project?.dbs.forEach((db: DatabaseModel) => {
        if (db.id === database.id) {
            db.isSelected = true;
        } else {
            db.isSelected = false;
        }
    });
    await saveToFile(settings, 'odoo-debugger-data.json');
    vscode.window.showInformationMessage(`Database ${database.id} selected successfully!`);
}

export async function deleteDb(event: any) {
    const db: DatabaseModel = event;
    let settings = await readFromFile('odoo-debugger-data.json');
    if (!settings) {
        vscode.window.showErrorMessage('Error reading settings');
        return;
    }
    let projects: ProjectModel[] = settings['projects'];
    if (!projects) {
        vscode.window.showErrorMessage('Error reading projects');
        return;
    }
    const project = projects.find((project => project.isSelected === true));
    if (!project) {
        vscode.window.showErrorMessage('No project selected');
        return;
    }
    setupDatabase(db.id, undefined, true);

    project.dbs = project.dbs.filter((database: DatabaseModel) => database.id !== db.id);
    await saveToFile(settings, 'odoo-debugger-data.json');
}
