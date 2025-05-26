import * as vscode from 'vscode';
import * as path from 'path';

import { checkWorkSpaceOrFolder, readFromFile, saveToFile } from './common';

import { SettingsModel } from './models/settings';
import { ProjectModel } from './models/project';
import { DatabaseModel } from './models/db';
import { RepoModel } from './models/repo';

import { DbsTreeProvider, createDb, selectDatabase, deleteDb, restoreDb } from './dbs';

import { ProjectTreeProvider, createProject, selectProject, getRepo, getProjectName, deleteProject} from './project';
import { RepoTreeProvider, selectRepo } from './repos';

import { ModuleTreeProvider, selectModule } from './module';

import { SettingsTreeProvider, editSetting } from './settings';
import { setupDebugger } from './debugger';


export function activate(context: vscode.ExtensionContext) {
	vscode.commands.executeCommand("setContext", "odoo-debugger.is_active", "false");
	if (checkWorkSpaceOrFolder() === true) {
		vscode.commands.executeCommand("setContext", "odoo-debugger.is_active", "true");
	}
	const projectTreeProvider = new ProjectTreeProvider(context);
	const repoTreeProvider = new RepoTreeProvider(context);
	const  dbsTreeProvider = new DbsTreeProvider(context);
	const moduleTreeProvider = new ModuleTreeProvider(context);
	const settingsTreeProvider = new SettingsTreeProvider(context);
	vscode.window.registerTreeDataProvider('projectSelector', projectTreeProvider);
	vscode.window.registerTreeDataProvider('repoSelector', repoTreeProvider);
	vscode.window.registerTreeDataProvider('dbSelector', dbsTreeProvider);
	vscode.window.registerTreeDataProvider('moduleSelector', moduleTreeProvider);
	vscode.window.registerTreeDataProvider('workspaceSettings', settingsTreeProvider);
	// Refresh commands
	vscode.commands.registerCommand('projectSelector.refresh', () =>{
		projectTreeProvider.refresh();
		dbsTreeProvider.refresh();
		moduleTreeProvider.refresh();
	});
	vscode.commands.registerCommand('dbSelector.refresh', () => {
		dbsTreeProvider.refresh();
		moduleTreeProvider.refresh();
	});
	vscode.commands.registerCommand('moduleSelector.refresh', () => moduleTreeProvider.refresh());
	vscode.commands.registerCommand('workspaceSettings.refresh', () => settingsTreeProvider.refresh());

	// Projects
	vscode.commands.registerCommand('projectSelector.create', async () => {
		let workspaceSettings = await readFromFile('odoo-debugger-data.json');
		if (!workspaceSettings) {
			vscode.window.showErrorMessage('Error reading settings');
			return;
		}
		let settings : SettingsModel = workspaceSettings['settings'];
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			vscode.window.showErrorMessage("No workspace open.");
			return;
		}
		const name = await getProjectName(workspaceFolder);
		const repos: RepoModel[] = await getRepo(path.join(workspaceFolder.uri.fsPath, settings.customAddonsPath));
		const createADb = await vscode.window.showQuickPick(["Yes", "No"], {
				placeHolder: 'Do you want to create a database?',
		});
		let db: DatabaseModel | undefined;
		if (createADb === "Yes"){
			db = await createDb(name, repos, settings.dumpsFolder);
		}else{
			db = undefined;
		}
		await createProject(name, repos, db);
		projectTreeProvider.refresh();
		dbsTreeProvider.refresh();
		moduleTreeProvider.refresh();
	});
	vscode.commands.registerCommand('projectSelector.selectProject', async (event) => {
		await selectProject(event);
		projectTreeProvider.refresh();
		dbsTreeProvider.refresh();
		moduleTreeProvider.refresh();
	});
	vscode.commands.registerCommand('projectSelector.delete', async (event) => {
		await deleteProject(event);
		projectTreeProvider.refresh();
		dbsTreeProvider.refresh();
		moduleTreeProvider.refresh();
		vscode.window.showInformationMessage(`Project ${event.name} deleted successfully!`);
	});
	// DBS
	vscode.commands.registerCommand('dbSelector.create', async () => {
		let debuggerInfo = await readFromFile('odoo-debugger-data.json');
		if (!debuggerInfo) {
			vscode.window.showErrorMessage('Error reading settings');
			return;
		}
		let settings : SettingsModel = debuggerInfo['settings'];
		let projects : ProjectModel[] = debuggerInfo['projects'] ;
		if (!projects) {
			vscode.window.showErrorMessage('Error reading projects, please create a project first');
			return;
		}
		let project: ProjectModel | undefined = projects.find((project: ProjectModel) => project.isSelected === true);
		if (!project) {
			vscode.window.showErrorMessage('No project selected');
			return;
		}
		const db = await createDb(project.name, project.repos, settings.dumpsFolder);
		if (!db) {
			vscode.window.showErrorMessage('Error creating database');
			return;
		}
		project.dbs.push(db);
		await saveToFile(debuggerInfo, 'odoo-debugger-data.json');
		await selectDatabase(db);
		dbsTreeProvider.refresh();
		moduleTreeProvider.refresh();
	});
	vscode.commands.registerCommand('dbSelector.selectDb', async (event) => {
		await selectDatabase(event);
		dbsTreeProvider.refresh();
		moduleTreeProvider.refresh();
	});
	vscode.commands.registerCommand('dbSelector.delete', async (event) => {
		await deleteDb(event);
		dbsTreeProvider.refresh();
		moduleTreeProvider.refresh();
		vscode.window.showInformationMessage(`Database ${event.name} deleted successfully!`);
	});
	vscode.commands.registerCommand('dbSelector.restore', async (event) => {
		await restoreDb(event);
		dbsTreeProvider.refresh();
		moduleTreeProvider.refresh();
		vscode.window.showInformationMessage(`Database ${event.name} restored successfully!`);
	});
	// Repos
	vscode.commands.registerCommand('repoSelector.selectRepo', async (event) => {
		await selectRepo(event);
		setupDebugger();
		repoTreeProvider.refresh();
		dbsTreeProvider.refresh();
		moduleTreeProvider.refresh();
	});
	// Modules
	vscode.commands.registerCommand('moduleSelector.select', async (event) => {
		await selectModule(event);
		setupDebugger();
		moduleTreeProvider.refresh();
	});
	// SETTINGS
	vscode.commands.registerCommand('workspaceSettings.editSetting', async (event) => {
		await editSetting(event);
		settingsTreeProvider.refresh();
	});
}

// export function deactivate() {}
