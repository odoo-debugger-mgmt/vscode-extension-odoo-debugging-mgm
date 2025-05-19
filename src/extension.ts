import * as vscode from 'vscode';
import { DbsTreeProvider } from './dbs';
import { ProjectTreeProvider, createProject } from './project';
import { SettingsTreeProvider, editSetting } from './settings';
import { ModuleTreeProvider, selectModule } from './module';
import { checkWorkSpaceOrFolder } from './common';

export function activate(context: vscode.ExtensionContext) {
	vscode.commands.executeCommand("setContext", "odoo-debugger.is_active", "false");
	if (checkWorkSpaceOrFolder() === true) {
		vscode.commands.executeCommand("setContext", "odoo-debugger.is_active", "true");
	}
	const projectTreeProvider = new ProjectTreeProvider(context);
	const  dbsTreeProvider = new DbsTreeProvider(context);
	const moduleTreeProvider = new ModuleTreeProvider(context);
	const settingsTreeProvider = new SettingsTreeProvider(context);
	vscode.window.registerTreeDataProvider('projectSelector', projectTreeProvider);
	vscode.window.registerTreeDataProvider('dbSelector', dbsTreeProvider);
	vscode.window.registerTreeDataProvider('moduleSelector', moduleTreeProvider);
	vscode.window.registerTreeDataProvider('workspaceSettings', settingsTreeProvider);
	vscode.commands.registerCommand('projectSelector.refresh', () => projectTreeProvider.refresh());
	vscode.commands.registerCommand('dbSelector.refresh', () => dbsTreeProvider.refresh());
	vscode.commands.registerCommand('moduleSelector.refresh', () => moduleTreeProvider.refresh());
	vscode.commands.registerCommand('workspaceSettings.refresh', () => settingsTreeProvider.refresh());


	vscode.commands.registerCommand('projectSelector.create', async () => {
		await createProject(context);
		projectTreeProvider.refresh();
		dbsTreeProvider.refresh();
		moduleTreeProvider.refresh();
	});
	vscode.commands.registerCommand('moduleSelector.select', async (event) => {
		await selectModule(event);
		moduleTreeProvider.refresh();
	});

	vscode.commands.registerCommand('workspaceSettings.editSetting', async (event) => {
		await editSetting(event);
		settingsTreeProvider.refresh();
	});
}

// export function deactivate() {}
