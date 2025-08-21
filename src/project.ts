import * as vscode from 'vscode';
import * as os from 'os';
import { ProjectModel } from './models/project';
import { DatabaseModel } from './models/db';
import { RepoModel } from './models/repo';
import { listSubdirectories, showError, showInfo, getGitBranch, normalizePath, showAutoInfo, addActiveIndicator, stripSettings } from './utils';
import { SettingsStore } from './settingsStore';
import { VersionsService } from './versionsService';
import { randomUUID } from 'crypto';
import { checkoutBranch } from './dbs';

export class ProjectTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }
    constructor(private context: vscode.ExtensionContext) {
        this.context = context;
    }
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }
    async getChildren(element?: any): Promise<vscode.TreeItem[]> {
        const data = await SettingsStore.get('odoo-debugger-data.json');
        if (!data) {
            return [];
        }

        const projects: ProjectModel[] = data.projects;
        if (!projects) {
            showError('Error reading projects, please create a project first');
            return [];
        }

        // Ensure all projects have UIDs (migration for existing data)
        const needsSave = await ensureProjectUIDs(data);
        if (needsSave) {
            await SettingsStore.saveWithoutComments(stripSettings(data));
        }

        return projects.map(project => {
            const treeItem = new vscode.TreeItem(addActiveIndicator(project.name, project.isSelected));
            treeItem.id = project.uid; // Use UID instead of name for uniqueness

            let tooltip = `Project: ${project.name}`;
            treeItem.tooltip = tooltip;

            // Set context value for menu commands
            treeItem.contextValue = 'project';

            treeItem.command = {
                command: 'projectSelector.selectProject',
                title: 'Select Project',
                arguments: [project.uid] // Pass just the UID instead of the whole object
            };
            // Store the project UID in a custom property for easier access
            (treeItem as any).projectUid = project.uid;
            return treeItem;
        });
    }
}

export async function createProject(name: string, repos: RepoModel[], db?: DatabaseModel) {
    // Get current data first to check for existing selected projects
    const data = await SettingsStore.get('odoo-debugger-data.json');
    if (!data.projects) {
        data.projects = [];
    }
    else {
        // Deselect any currently selected project if there are existing projects
        const currentSelectedIndex = data.projects.findIndex((p: ProjectModel) => p.isSelected);
        if (currentSelectedIndex !== -1) {
            data.projects[currentSelectedIndex].isSelected = false;
        }
    }

    let project: ProjectModel;
    if (!db) {
        project = new ProjectModel(name, new Date(), [], repos, true, randomUUID(), []);
    } else {
        project = new ProjectModel(name, new Date(), [db], repos, true, randomUUID(), []);
    }

    // Add the new project to the array
    data.projects.push(project);

    // Save the entire updated data
    await SettingsStore.saveWithoutComments(stripSettings(data));

    // If the project has a database with a version, check if branches need switching
    if (db && db.odooVersion && db.odooVersion !== '') {
        // Get settings from active version
        const versionsService = VersionsService.getInstance();
        const settings = await versionsService.getActiveVersionSettings();

        const currentOdooBranch = await getGitBranch(settings.odooPath);
        const currentEnterpriseBranch = await getGitBranch(settings.enterprisePath);
        const currentDesignThemesBranch = await getGitBranch(settings.designThemesPath || './design-themes');

        const shouldSwitch = await promptBranchSwitch(db.odooVersion, {
            odoo: currentOdooBranch,
            enterprise: currentEnterpriseBranch,
            designThemes: currentDesignThemesBranch
        });

        if (shouldSwitch) {
            await checkoutBranch(settings, db.odooVersion);
        }
    }

    showAutoInfo(`Created project "${project.name}" with ${repos.length} repositories ${db ? `and database ${db.name}` : ''}`, 4000);    // Force a small delay to ensure data is persisted before refresh
    await new Promise(resolve => setTimeout(resolve, 100));
}

async function ensureProjectUIDs(data: any): Promise<boolean> {
    let needsSave = false;
    if (data.projects && Array.isArray(data.projects)) {
        for (const project of data.projects) {
            if (!project.uid) {
                project.uid = randomUUID();
                needsSave = true;
            }
            // Migration: Add includedPsaeInternalPaths field if it doesn't exist
            if (project.includedPsaeInternalPaths === undefined) {
                project.includedPsaeInternalPaths = [];
                needsSave = true;
            }
        }
    }
    return needsSave;
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

export async function selectProject(projectUid: string) {
    const data = await SettingsStore.get('odoo-debugger-data.json');
    const projects: ProjectModel[] = data.projects;
    if (!projects) {
        showError('Error reading projects');
        return;
    }

    // Ensure all projects have UIDs (migration for existing data)
    const needsSave = await ensureProjectUIDs(data);
    if (needsSave) {
        await SettingsStore.saveWithoutComments(stripSettings(data));
    }

    // Find and deselect the currently selected project
    const oldSelectedIndex = projects.findIndex((p: ProjectModel) => p.isSelected);
    if (oldSelectedIndex !== -1) {
        await SettingsStore.saveWithComments(false, ["projects", oldSelectedIndex, "isSelected"], 'odoo-debugger-data.json');
    }

    // Find and select the new project by UID
    const newSelectedIndex = projects.findIndex((p: ProjectModel) => p.uid === projectUid);

    if (newSelectedIndex !== -1) {
        await SettingsStore.saveWithComments(true, ["projects", newSelectedIndex, "isSelected"], 'odoo-debugger-data.json');

        // Get the newly selected project
        const selectedProject = projects[newSelectedIndex];

        // Check if the project has a selected database with a specific version
        const selectedDb = selectedProject.dbs?.find((db: DatabaseModel) => db.isSelected);
        if (selectedDb) {
            await handleDatabaseVersionSwitchForProject(selectedDb);
        }

        showInfo(`Project switched to: ${selectedProject.name}`);

        // Force a small delay and refresh to ensure UI is updated
        await new Promise(resolve => setTimeout(resolve, 100));
    } else {
        showError('Project not found');
    }
}

async function handleDatabaseVersionSwitchForProject(database: DatabaseModel): Promise<void> {
    const versionsService = VersionsService.getInstance();
    await versionsService.initialize();
    const settings = await versionsService.getActiveVersionSettings();

    // Check if database has a version associated with it
    if (database.versionId) {
        const dbVersion = versionsService.getVersion(database.versionId);
        if (dbVersion) {
            // Silently activate the version for project switching (no user prompt)
            await versionsService.setActiveVersion(dbVersion.id);

            const currentOdooBranch = await getGitBranch(settings.odooPath);

            // Check if branch switching is needed
            if (currentOdooBranch !== dbVersion.odooVersion) {
                const shouldSwitch = await promptBranchSwitch(dbVersion.odooVersion, {
                    odoo: currentOdooBranch,
                    enterprise: await getGitBranch(settings.enterprisePath),
                    designThemes: await getGitBranch(settings.designThemesPath || './design-themes')
                });

                if (shouldSwitch) {
                    await checkoutBranch(settings, dbVersion.odooVersion);
                }
            }
            return;
        }
    }

    // Fallback to old behavior for databases without version
    if (database.odooVersion && database.odooVersion !== '') {
        const currentOdooBranch = await getGitBranch(settings.odooPath);
        const currentEnterpriseBranch = await getGitBranch(settings.enterprisePath);
        const currentDesignThemesBranch = await getGitBranch(settings.designThemesPath || './design-themes');

        const shouldSwitch = await promptBranchSwitch(database.odooVersion, {
            odoo: currentOdooBranch,
            enterprise: currentEnterpriseBranch,
            designThemes: currentDesignThemesBranch
        });

        if (shouldSwitch) {
            await checkoutBranch(settings, database.odooVersion);
        }
    }
}

export async function getRepo(targetPath:string, searchFilter?: string): Promise<RepoModel[] > {
    const devsRepos = listSubdirectories(targetPath);
        if (devsRepos.length === 0) {
        showInfo('No folders found in custom-addons.');
        throw new Error('No folders found in custom-addons.');
    }

    // Show QuickPick with both name and path as label and description
    const quickPickItems = devsRepos.map(entry => ({
        label: entry.name,
        description: entry.path
    }));

    // Filter and sort items if search filter is provided
    let itemsToShow = quickPickItems;
    if (searchFilter && searchFilter.trim() !== '') {
        const filterTerm = searchFilter.toLowerCase();

        // Separate exact matches, partial matches, and no matches for sorting
        const exactMatches = quickPickItems.filter(item =>
            item.label.toLowerCase() === filterTerm
        );
        const partialMatches = quickPickItems.filter(item =>
            item.label.toLowerCase().includes(filterTerm) &&
            item.label.toLowerCase() !== filterTerm
        );
        const noMatches = quickPickItems.filter(item =>
            !item.label.toLowerCase().includes(filterTerm)
        );

        // Show exact matches first, then partial matches, then everything else
        itemsToShow = [...exactMatches, ...partialMatches, ...noMatches];
    }

    const selectedItems = await vscode.window.showQuickPick(itemsToShow, {
        placeHolder: searchFilter
            ? `Select folders from custom-addons (showing "${searchFilter}" matches first)`
            : 'Select a folder from custom-addons',
        canPickMany: true,
        matchOnDescription: true,
        matchOnDetail: true
    });

    if (selectedItems) {
        return selectedItems.map(item => {
            return new RepoModel(item.label, item.description, true);
        });
    }else{
        showError("No Folder selected");
        throw new Error("No Folder selected");
    }
}

export async function getProjectName(workspaceFolder: vscode.WorkspaceFolder): Promise<string> {
    const name = await vscode.window.showInputBox({
        prompt: "Enter a name for your new project",
        title: "Project Name",
        placeHolder: "e.g., My Odoo Project"
    });
    if (!name) {
        showError('Project name is required.');
        throw new Error('Project name is required.');
    }
    return name;
}

export async function deleteProject(event: any) {
    // Handle different types of event data:
    // 1. Direct project object (with uid property)
    // 2. Tree item from context menu (with id property containing the uid)
    // 3. String uid directly
    let projectUid: string;

    if (typeof event === 'string') {
        // Direct UID string
        projectUid = event;
    } else if (event && event.uid) {
        // Project object
        projectUid = event.uid;
    } else if (event && event.id) {
        // Tree item from context menu
        projectUid = event.id;
    } else if (event && event.projectUid) {
        // Tree item with custom projectUid property
        projectUid = event.projectUid;
    } else {
        showError('Invalid project data for deletion');
        return;
    }

    const data = await SettingsStore.get('odoo-debugger-data.json');
    const projects: ProjectModel[] = data.projects;
    if (!projects) {
        showError('Error reading projects');
        return;
    }

    // Find the project index in the array by UID
    const projectIndex = projects.findIndex((p: ProjectModel) => p.uid === projectUid);
    if (projectIndex !== -1) {
        const projectToDelete = projects[projectIndex];

        // Ask for confirmation
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete the project "${projectToDelete.name}"?`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') {
            return; // User cancelled
        }

        // Remove the project from the array and save the updated data
        data.projects.splice(projectIndex, 1);
        await SettingsStore.saveWithoutComments(stripSettings(data));

        showInfo(`Project "${projectToDelete.name}" deleted successfully`);

        // If the deleted project was selected and there are other projects, select the first one
        if (projectToDelete.isSelected && data.projects.length > 0) {
            // Use the command to properly select the first project
            await vscode.commands.executeCommand('projectSelector.selectProject', data.projects[0].uid);
        }
    } else {
        showError('Project not found. It may have already been deleted.');
    }
}

export async function duplicateProject(event: any) {
    // Get project UID from event
    let projectUid: string;

    if (typeof event === 'string') {
        projectUid = event;
    } else if (event && event.uid) {
        projectUid = event.uid;
    } else if (event && event.id) {
        projectUid = event.id;
    } else if (event && event.projectUid) {
        projectUid = event.projectUid;
    } else {
        showError('Invalid project data');
        return;
    }

    const data = await SettingsStore.get('odoo-debugger-data.json');
    const projects: ProjectModel[] = data.projects;
    if (!projects) {
        showError('Error reading projects');
        return;
    }

    const projectIndex = projects.findIndex((p: ProjectModel) => p.uid === projectUid);
    if (projectIndex === -1) {
        showError('Project not found');
        return;
    }

    const sourceProject = projects[projectIndex];

    // Get a new name for the duplicate
    const duplicateName = await vscode.window.showInputBox({
        prompt: 'Enter a name for the duplicate project',
        value: `${sourceProject.name} - Copy`,
        ignoreFocusOut: true
    });

    if (!duplicateName) {
        return; // User cancelled
    }

    // Check if name already exists
    if (projects.some(p => p.name === duplicateName)) {
        showError('A project with this name already exists');
        return;
    }

    // Deselect all projects
    projects.forEach(p => p.isSelected = false);

    // Create duplicate project
    const duplicateProject = new ProjectModel(
        duplicateName,
        new Date(),
        [...sourceProject.dbs], // Copy databases array
        [...sourceProject.repos], // Copy repositories array
        true, // Set as selected
        randomUUID(), // New unique ID
        [...(sourceProject.includedPsaeInternalPaths || [])] // Copy included psae-internal paths
    );

    projects.push(duplicateProject);

    await SettingsStore.saveWithoutComments(stripSettings(data));
    showInfo(`Project "${duplicateName}" created as a duplicate of "${sourceProject.name}"`);
}

export async function editProjectSettings(event: any) {
    // Get project UID from event
    let projectUid: string;

    console.log('editProjectSettings called with event:', event);

    if (typeof event === 'string') {
        projectUid = event;
    } else if (event && event.uid) {
        projectUid = event.uid;
    } else if (event && event.id) {
        projectUid = event.id;
    } else if (event && event.projectUid) {
        projectUid = event.projectUid;
    } else {
        console.error('Invalid project data for editing settings:', event);
        showError('Invalid project data for editing settings. Please try clicking on the project first to select it, then try again.');
        return;
    }

    const data = await SettingsStore.get('odoo-debugger-data.json');
    const projects: ProjectModel[] = data.projects;
    if (!projects) {
        showError('Error reading projects');
        return;
    }

    const projectIndex = projects.findIndex((p: ProjectModel) => p.uid === projectUid);
    if (projectIndex === -1) {
        showError('Project not found');
        return;
    }

    const project = projects[projectIndex];

    // Show project settings options
    const settingsOptions = [
        {
            label: "Edit Project Name",
            description: `Current: ${project.name}`,
            detail: "Change the display name of this project",
            action: 'editName'
        },
        {
            label: "View Project Info",
            description: `Created: ${new Date(project.createdAt).toLocaleDateString()}`,
            detail: "View detailed project information",
            action: 'viewInfo'
        }
    ];

    const selectedOption = await vscode.window.showQuickPick(settingsOptions, {
        placeHolder: `Edit settings for project "${project.name}"`,
        ignoreFocusOut: true
    });

    if (!selectedOption) {
        return; // User cancelled
    }

    switch (selectedOption.action) {
        case 'editName':
            await editProjectName(project, data);
            break;

        case 'viewInfo':
            await viewProjectInfo(project);
            break;
    }
}

async function editProjectName(project: ProjectModel, data: any) {
    const newName = await vscode.window.showInputBox({
        prompt: 'Enter new project name',
        value: project.name,
        placeHolder: 'e.g., My Updated Project',
        ignoreFocusOut: true,
        validateInput: (value) => {
            if (!value || value.trim().length === 0) {
                return 'Project name cannot be empty';
            }
            // Check if name already exists (excluding current project)
            const existingProject = data.projects.find((p: ProjectModel) =>
                p.name === value.trim() && p.uid !== project.uid
            );
            if (existingProject) {
                return 'A project with this name already exists';
            }
            return null;
        }
    });

    if (newName && newName.trim() !== project.name) {
        const oldName = project.name;
        project.name = newName.trim();
        await SettingsStore.saveWithoutComments(stripSettings(data));
        showInfo(`Project renamed from "${oldName}" to "${project.name}"`);
    }
}

async function viewProjectInfo(project: ProjectModel) {
    const dbCount = project.dbs?.length || 0;
    const selectedDb = project.dbs?.find((db: DatabaseModel) => db.isSelected);

    let infoMessage = `Project Information

Name: ${project.name}
Created: ${new Date(project.createdAt).toLocaleString()}

Repositories (${project.repos.length}):
${project.repos.map(r => `  • ${r.name}`).join('\n')}

Databases: ${dbCount}${selectedDb ? `
Active Database: ${selectedDb.name}` : `
No active database`}`;

    await vscode.window.showInformationMessage(infoMessage, { modal: true }, 'OK');
}

export async function exportProject(event: any): Promise<void> {
    try {
        // Get project UID from event
        let projectUid: string;

        if (typeof event === 'string') {
            projectUid = event;
        } else if (event && event.uid) {
            projectUid = event.uid;
        } else if (event && event.id) {
            projectUid = event.id;
        } else if (event && event.projectUid) {
            projectUid = event.projectUid;
        } else {
            showError('Invalid project data');
            return;
        }

        const data = await SettingsStore.get('odoo-debugger-data.json');
        const projects: ProjectModel[] = data.projects;
        if (!projects) {
            showError('No projects found');
            return;
        }

        const project = projects.find(p => p.uid === projectUid);
        if (!project) {
            showError('Project not found');
            return;
        }

        // Let user choose export location
        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${project.name}.json`),
            filters: {
                'JSON Files': ['json'],
                'All Files': ['*']
            },
            saveLabel: 'Export Project'
        });

        if (!saveUri) {
            return; // User cancelled
        }

        // Create export data with sanitized paths
        const exportData = {
            name: project.name,
            repositories: project.repos.map((repo: RepoModel) => ({
                name: repo.name,
                path: repo.path.replace(os.homedir(), '~') // Use ~ for home directory
            })),
            exportedAt: new Date().toISOString(),
            exportVersion: '1.0'
        };

        // Write to file
        const content = JSON.stringify(exportData, null, 2);
        await vscode.workspace.fs.writeFile(saveUri, Buffer.from(content, 'utf8'));

        const action = await vscode.window.showInformationMessage(
            `Project "${project.name}" exported successfully!`,
            'Open Export Location',
            'Import Instructions'
        );

        if (action === 'Open Export Location') {
            await vscode.commands.executeCommand('revealFileInOS', saveUri);
        } else if (action === 'Import Instructions') {
            const instructions = `To import this project:
1. Copy the exported file to the target machine
2. Use Command Palette > "Import Odoo Project"
3. Select the exported JSON file
4. Adjust repository paths as needed

Note: Repository paths use ~ for home directory and may need adjustment on different systems.`;

            await vscode.window.showInformationMessage(instructions, { modal: true });
        }

    } catch (error) {
        console.error('Error exporting project:', error);
        vscode.window.showErrorMessage(`Failed to export project: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

export async function importProject(): Promise<void> {
    try {
        // Let user choose import file
        const openUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'JSON Files': ['json'],
                'All Files': ['*']
            },
            openLabel: 'Import Project'
        });

        if (!openUri || openUri.length === 0) {
            return; // User cancelled
        }

        // Read and parse import file
        const fileContent = await vscode.workspace.fs.readFile(openUri[0]);
        const importData = JSON.parse(fileContent.toString());

        // Validate import data
        if (!importData.name || !importData.repositories || !Array.isArray(importData.repositories)) {
            showError('Invalid project export file format');
            return;
        }

        // Load existing data
        const data = await SettingsStore.get('odoo-debugger-data.json');
        const projects: ProjectModel[] = data.projects || [];

        // Get settings from active version
        const versionsService = VersionsService.getInstance();
        const settings = await versionsService.getActiveVersionSettings();

        // Check if project name already exists and suggest alternative
        let projectName = importData.name;
        let counter = 1;
        while (projects.some(p => p.name === projectName)) {
            projectName = `${importData.name} (${counter})`;
            counter++;
        }

        if (projectName !== importData.name) {
            const useNewName = await vscode.window.showWarningMessage(
                `A project named "${importData.name}" already exists. Import as "${projectName}"?`,
                'Yes, Import with New Name',
                'Cancel'
            );

            if (useNewName !== 'Yes, Import with New Name') {
                return;
            }
        }

        const customAddonsPath = normalizePath(settings.customAddonsPath);

        // Process repositories and expand ~ to home directory
        const availableRepos = listSubdirectories(customAddonsPath);
        const validRepos: RepoModel[] = [];
        const missingRepos: string[] = [];

        for (const repo of importData.repositories) {
            // Expand ~ to home directory if present
            const expandedPath = repo.path.startsWith('~')
                ? repo.path.replace('~', os.homedir())
                : repo.path;

            // Try to find the repository in the current custom-addons directory
            const localRepo = availableRepos.find(r => r.name === repo.name);

            if (localRepo) {
                validRepos.push(new RepoModel(localRepo.name, localRepo.path, true));
            } else {
                missingRepos.push(`${repo.name} (originally at: ${expandedPath})`);
            }
        }

        // Create new project
        const newProject = new ProjectModel(
            projectName,
            new Date(),
            [], // No databases in export
            validRepos,
            false, // Not selected by default
            randomUUID(),
            [] // No included psae-internal paths on import
        );

        // Add to projects and save
        projects.push(newProject);
        data.projects = projects;
        await SettingsStore.saveWithoutComments(stripSettings(data));

        // Show import results
        let message = `Project "${projectName}" imported successfully!`;
        if (missingRepos.length > 0) {
            message += `\n\nMissing repositories (not found in current custom-addons):\n${missingRepos.join('\n')}`;
            message += `\n\nYou can manage repositories from the Repositories tab.`;
        }

        await vscode.window.showInformationMessage(message, 'OK');

    } catch (error) {
        console.error('Error importing project:', error);
        if (error instanceof SyntaxError) {
            showError('Invalid JSON format in import file');
        } else {
            showError(`Failed to import project: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
}

export async function quickProjectSearch(): Promise<void> {
    try {
        const data = await SettingsStore.get('odoo-debugger-data.json');
        const projects: ProjectModel[] = data.projects;

        if (!projects || projects.length === 0) {
            showError('No projects found. Create a project first.');
            return;
        }

        // Create quick pick items with project information
        const quickPickItems = projects.map(project => {
            const selectedDb = project.dbs?.find((db: DatabaseModel) => db.isSelected);
            const repoCount = project.repos.length;
            const dbInfo = selectedDb ? ` | DB: ${selectedDb.name}` : ' | No DB';

            return {
                label: `${project.isSelected ? '$(arrow-right) ' : ''}${project.name}`,
                description: `${repoCount} repo${repoCount === 1 ? '' : 's'}${dbInfo}`,
                detail: `Created: ${new Date(project.createdAt).toLocaleDateString()} | Repositories: ${project.repos.map(r => r.name).join(', ')}`,
                projectUid: project.uid
            };
        });

        const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
            placeHolder: 'Search and select a project...',
            matchOnDescription: true,
            matchOnDetail: true,
            ignoreFocusOut: true,
            canPickMany: false,
            title: 'Select Project'
        });

        if (selectedItem) {
            // Use the VS Code command to trigger proper refresh
            await vscode.commands.executeCommand('projectSelector.selectProject', selectedItem.projectUid);
        }

    } catch (error) {
        console.error('Error in quick project search:', error);
        showError('Failed to load projects for search');
    }
}
