import * as vscode from 'vscode';

import { checkWorkSpaceOrFolderOpened, normalizePath } from './utils';
import { ProjectModel } from './models/project';
import { DbsTreeProvider, createDb, selectDatabase, deleteDb, restoreDb } from './dbs';
import { ProjectTreeProvider, createProject, selectProject, getRepo, getProjectName, deleteProject} from './project';
import { RepoTreeProvider, selectRepo } from './repos';
import { ModuleTreeProvider, selectModule } from './module';
import { SettingsTreeProvider, editSetting } from './settings';
import { setupDebugger, startDebugShell, startDebugServer } from './debugger';
import { setupOdooBranch } from './odooInstaller';
import { SettingsStore } from './settingsStore';


export function activate(context: vscode.ExtensionContext) {
	vscode.commands.executeCommand("setContext", "odoo-debugger.is_active", checkWorkSpaceOrFolderOpened() ? "true" : "false");

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

	// Refresh commands
	vscode.commands.registerCommand('projectSelector.refresh', refreshAll),

	// Projects
	vscode.commands.registerCommand('projectSelector.create', async () => {
		try {
			const settings = await SettingsStore.getSettings();
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) {throw new Error("No workspace open.");}
			const name = await getProjectName(workspaceFolder);
			const customAddonsPath = normalizePath(settings.customAddonsPath);
			const repos = await getRepo(customAddonsPath);
			const createADb = await vscode.window.showQuickPick(["Yes", "No"], { placeHolder: 'Create a database?' });
			const db = createADb === "Yes" ? await createDb(name, repos, settings.dumpsFolder, settings) : undefined;
			await createProject(name, repos, db);
			refreshAll();
		} catch (err: any) {
			vscode.window.showErrorMessage(err.message);
		}
	});
	vscode.commands.registerCommand('projectSelector.selectProject', async (event) => {
		await selectProject(event);
		refreshAll();
	});
	vscode.commands.registerCommand('projectSelector.delete', async (event) => {
		await deleteProject(event);
		refreshAll();
	});
	vscode.commands.registerCommand('projectSelector.setup', async (event) => {
		await setupOdooBranch();
		refreshAll();
	});
	// DBS
	vscode.commands.registerCommand('dbSelector.create', async () => {
		try {
			const settings = await SettingsStore.getSettings();
			const projects = await SettingsStore.getProjects();
			const project = projects?.find((p: ProjectModel) => p.isSelected);
			if (!project) {
				throw new Error('No project selected');
			}
			const db = await createDb(project.name, project.repos, settings.dumpsFolder, settings);
			if (db) {
				project.dbs.push(db);
				await SettingsStore.save({ settings, projects });
				await selectDatabase(db);
			}
			refreshAll();
		} catch (err: any) {
			vscode.window.showErrorMessage(err.message);
		}
	});
	vscode.commands.registerCommand('dbSelector.selectDb', async (event) => {
		await selectDatabase(event);
		refreshAll();
	});
	vscode.commands.registerCommand('dbSelector.delete', async (event) => {
		await deleteDb(event);
		refreshAll();
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
