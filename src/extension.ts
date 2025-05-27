import * as vscode from 'vscode';
import * as path from 'path';

import { checkWorkSpaceOrFolder, readFromFile, saveToFile } from './common';

import { SettingsModel } from './models/settings';
import { ProjectModel } from './models/project';
import { DatabaseModel } from './models/db';
import { RepoModel } from './models/repo';

import { DbsTreeProvider, createDb, selectDatabase, deleteDb, restoreDb } from './dbs';

import { ProjectTreeProvider, createProject, selectProject, getRepos, getProjectName, deleteProject} from './project';
import { RepoTreeProvider, selectRepo } from './repos';

import { ModuleTreeProvider, selectModule } from './module';

import { SettingsTreeProvider, editSetting } from './settings';
import { setupDebugger, startDebugShell, startDebugServer } from './debugger';


export function activate(context: vscode.ExtensionContext) {
	vscode.commands.executeCommand("setContext", "odoo-debugger.is_active", checkWorkSpaceOrFolder() ? "true" : "false");

	const providers = {
        project: new ProjectTreeProvider(context),
        repo: new RepoTreeProvider(context),
        db: new DbsTreeProvider(context),
        module: new ModuleTreeProvider(context),
        settings: new SettingsTreeProvider(context)
    };

    vscode.window.registerTreeDataProvider('projectSelector', providers.project);
    vscode.window.registerTreeDataProvider('repoSelector', providers.repo);
    vscode.window.registerTreeDataProvider('dbSelector', providers.db);
    vscode.window.registerTreeDataProvider('moduleSelector', providers.module);
    vscode.window.registerTreeDataProvider('workspaceSettings', providers.settings);

    const refreshAll = () => {
        setupDebugger();
        Object.values(providers).forEach(provider => provider.refresh());
    };
    const loadDebuggerInfo = async () => {
        const debuggerInfo = await readFromFile('odoo-debugger-data.json');
        if (!debuggerInfo) {throw new Error('Error reading settings');}
        return debuggerInfo;
    };

	// Refresh commands
	vscode.commands.registerCommand('projectSelector.refresh', refreshAll);

	// Projects
	vscode.commands.registerCommand('projectSelector.create', async () => {
		try {
			const { settings } = await loadDebuggerInfo();
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) {throw new Error("No workspace open.");}
			const name = await getProjectName(workspaceFolder);
			const repos = await getRepos([path.join(workspaceFolder.uri.fsPath, settings.customAddonsPath)]);
			const createADb = await vscode.window.showQuickPick(["Yes", "No"], { placeHolder: 'Create a database?' });
			const db = createADb === "Yes" ? await createDb(name, repos, settings.dumpsFolder) : undefined;
			await createProject(name, repos, db);
			refreshAll();
		} catch (err) {
			if (err instanceof Error) {
				vscode.window.showErrorMessage(err.message);
			} else {
				vscode.window.showErrorMessage(String(err));
			}
		}
	});
	vscode.commands.registerCommand('projectSelector.selectProject', async (event) => {
		await selectProject(event);
		refreshAll();
	});
	vscode.commands.registerCommand('projectSelector.delete', async (event) => {
		await deleteProject(event);
		refreshAll();
		vscode.window.showInformationMessage(`Project ${event.name} deleted successfully!`);
	});
	// DBS
	vscode.commands.registerCommand('dbSelector.create', async () => {
		try {
			const { settings, projects } = await loadDebuggerInfo();
			const project = projects?.find((p: ProjectModel) => p.isSelected);
			if (!project) {throw new Error('No project selected')}
			const db = await createDb(project.name, project.repos, settings.dumpsFolder);
			project.dbs.push(db);
			await saveToFile({ settings, projects }, 'odoo-debugger-data.json');
			await selectDatabase(db);
			refreshAll();
		} catch (err) {
			if (err instanceof Error) {
				vscode.window.showErrorMessage(err.message);
			} else {
				vscode.window.showErrorMessage(String(err));
			}
		}
	});
	vscode.commands.registerCommand('dbSelector.selectDb', async (event) => {
		await selectDatabase(event);
		refreshAll();
	});
	vscode.commands.registerCommand('dbSelector.delete', async (event) => {
		await deleteDb(event);
		refreshAll();
		vscode.window.showInformationMessage(`Database ${event.name} deleted successfully!`);
	});
	vscode.commands.registerCommand('dbSelector.restore', async (event) => {
		await restoreDb(event);
		refreshAll();
		vscode.window.showInformationMessage(`Database ${event.id} restored successfully!`);
	});
	// Repos
	vscode.commands.registerCommand('repoSelector.selectRepo', async (event) => {
		await selectRepo(event);
		refreshAll();
	});
	// Modules
	vscode.commands.registerCommand('moduleSelector.select', async (event) => {
		await selectModule(event);
		refreshAll();
	});
	// SETTINGS
	vscode.commands.registerCommand('workspaceSettings.editSetting', async (event) => {
		await editSetting(event);
		refreshAll();
	});

	vscode.commands.registerCommand('workspaceSettings.startServer', startDebugServer);
	vscode.commands.registerCommand('workspaceSettings.startShell', startDebugShell);
}

// export function deactivate() {}
