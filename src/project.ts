import * as vscode from 'vscode';
import * as os from 'os';
import { ProjectModel, ProjectTicketModel } from './models/project';
import { DatabaseModel } from './models/db';
import { RepoModel } from './models/repo';
import { findRepositories, showError, showInfo, normalizePath, showAutoInfo, addActiveIndicator, stripSettings, getDatabaseLabel } from './utils';
import { SettingsStore } from './settingsStore';
import { VersionsService } from './versionsService';
import { randomUUID } from 'crypto';
import { alignEnvironment, buildDatabaseEnvironmentTarget } from './services/environment';
import { SortPreferences } from './sortPreferences';
import { getDefaultSortOption } from './sortOptions';
import { logger } from './services/logger';
import { showModalInfo, showWarning } from './services/notifications';
import { showModalWarning } from './services/notifications';
import { BaseTreeProvider } from './views/baseTreeProvider';

let projectMetadataMigrationCompleted = false;

function sanitizeProjectTickets(rawTickets: any): ProjectTicketModel[] {
    if (!Array.isArray(rawTickets)) {
        return [];
    }

    const result: ProjectTicketModel[] = [];
    const seen = new Set<string>();
    for (const rawTicket of rawTickets) {
        const id = (rawTicket?.id ?? '').toString().trim();
        if (!id) {
            continue;
        }
        const normalized = id.toLowerCase();
        if (seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);

        const title = typeof rawTicket?.title === 'string' ? rawTicket.title.trim() : '';
        result.push({
            id,
            title: title || undefined
        });
    }

    return result;
}

function resolveTicketBaseUrl(): string {
    const configured = vscode.workspace.getConfiguration('odooDebugger').get<string>('ticketBaseUrl', 'https://www.odoo.com') ?? 'https://www.odoo.com';
    const trimmed = configured.trim();
    if (!trimmed) {
        return 'https://www.odoo.com';
    }
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return withScheme.replace(/\/+$/, '');
}

function buildTicketUrl(ticketId: string): string {
    const baseUrl = resolveTicketBaseUrl();
    return `${baseUrl}/odoo/all-tasks/${encodeURIComponent(ticketId)}`;
}

function formatTicketLabel(ticket: ProjectTicketModel): string {
    return ticket.title ? `${ticket.id} - ${ticket.title}` : ticket.id;
}

export class ProjectTreeProvider extends BaseTreeProvider<vscode.TreeItem> {
    constructor(private context: vscode.ExtensionContext, private sortPreferences: SortPreferences) {
        super();
    }
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }
    async getChildren(_element?: any): Promise<vscode.TreeItem[]> {
        const data = await SettingsStore.get('odoo-debugger-data.json');
        if (!data) {
            return [];
        }

        const projects: ProjectModel[] = data.projects;
        if (!projects) {
            showError('Unable to load projects, please create a project first');
            return [];
        }

        if (!projectMetadataMigrationCompleted) {
            // Ensure project metadata migration happens only once per session.
            const needsSave = await ensureProjectUIDs(data);
            if (needsSave) {
                await SettingsStore.saveWithoutComments(stripSettings(data));
            }
            projectMetadataMigrationCompleted = true;
        }

        const sortId = this.sortPreferences.get('projectSelector', getDefaultSortOption('projectSelector'));
        const sortedProjects = [...projects].sort((a, b) => this.compareProjects(a, b, sortId));

        return sortedProjects.map(project => {
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

    private compareProjects(a: ProjectModel, b: ProjectModel, sortId: string): number {
        const activeDelta = Number(b.isSelected) - Number(a.isSelected);
        if (activeDelta !== 0) {
            return activeDelta;
        }

        switch (sortId) {
            case 'project:name:asc':
                return a.name.localeCompare(b.name);
            case 'project:name:desc':
                return b.name.localeCompare(a.name);
            case 'project:created:newest':
                return this.getProjectTimestamp(b) - this.getProjectTimestamp(a);
            case 'project:created:oldest':
                return this.getProjectTimestamp(a) - this.getProjectTimestamp(b);
            default:
                return a.name.localeCompare(b.name);
        }
    }

    private getProjectTimestamp(project: ProjectModel): number {
        const value = project.createdAt instanceof Date ? project.createdAt : new Date(project.createdAt as any);
        const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
        return isNaN(timestamp) ? 0 : timestamp;
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

    // Environment alignment happens when the database is selected right after
    // creation, so no branch switching is needed here.
    const databaseMessage = db ? ` and database ${getDatabaseLabel(db)}` : '';
    showAutoInfo(`Created project "${project.name}" with ${repos.length} repositories${databaseMessage}`, 4000);    // Force a small delay to ensure data is persisted before refresh
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
            const originalTickets = Array.isArray(project.tickets) ? project.tickets : [];
            const sanitizedTickets = sanitizeProjectTickets(originalTickets);
            if (JSON.stringify(originalTickets) !== JSON.stringify(sanitizedTickets)) {
                needsSave = true;
            }
            project.tickets = sanitizedTickets;
            if (!project.createdAt) {
                project.createdAt = new Date().toISOString();
                needsSave = true;
            } else if (project.createdAt instanceof Date) {
                project.createdAt = project.createdAt.toISOString();
                needsSave = true;
            }
            if (Array.isArray(project.repos)) {
                for (const repo of project.repos) {
                    if (!repo.addedAt) {
                        repo.addedAt = project.createdAt || new Date().toISOString();
                        needsSave = true;
                    }
                }
            }
        }
    }
    return needsSave;
}

export async function selectProject(projectUid: string) {
    const data = await SettingsStore.get('odoo-debugger-data.json');
    const projects: ProjectModel[] = data.projects;
    if (!projects) {
        showError('Unable to load projects.');
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

        // Align the workbench to the project's selected database, if any.
        const selectedDb = selectedProject.dbs?.find((db: DatabaseModel) => db.isSelected);
        if (selectedDb) {
            await alignEnvironment(
                buildDatabaseEnvironmentTarget(selectedDb, selectedProject.repos ?? []),
                { label: `Project "${selectedProject.name}"` }
            );
        }

        showInfo(`Project switched to: ${selectedProject.name}`);

        // Force a small delay and refresh to ensure UI is updated
        await new Promise(resolve => setTimeout(resolve, 100));
    } else {
        showError('The selected project could not be found.');
    }
}

export async function getRepo(targetPath:string, searchFilter?: string): Promise<RepoModel[] > {
    const devsRepos = findRepositories(targetPath);
    if (devsRepos.length === 0) {
        showInfo('No repositories found in the custom-addons path.');
        throw new Error('No repositories found in the custom-addons path.');
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
        showError("Select at least one folder to continue.");
        throw new Error("Select at least one folder to continue.");
    }
}

export async function getProjectName(_workspaceFolder?: vscode.WorkspaceFolder): Promise<string> {
    const name = await vscode.window.showInputBox({
        prompt: "Enter a name for your new project",
        title: "Project Name",
        placeHolder: "e.g., My Odoo Project"
    });
    if (!name) {
        showError('Enter a project name to continue.');
        throw new Error('Enter a project name to continue.');
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
        showError('The project data is invalid for deletion');
        return;
    }

    const data = await SettingsStore.get('odoo-debugger-data.json');
    const projects: ProjectModel[] = data.projects;
    if (!projects) {
        showError('Unable to load projects.');
        return;
    }

    // Find the project index in the array by UID
    const projectIndex = projects.findIndex((p: ProjectModel) => p.uid === projectUid);
    if (projectIndex !== -1) {
        const projectToDelete = projects[projectIndex];

        // Ask for confirmation
        const confirm = await showModalWarning(
            `Are you sure you want to delete the project "${projectToDelete.name}"?`,
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
        showError('The selected project could not be found. It may have already been deleted.');
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
        showError('The project data is invalid.');
        return;
    }

    const data = await SettingsStore.get('odoo-debugger-data.json');
    const projects: ProjectModel[] = data.projects;
    if (!projects) {
        showError('Unable to load projects.');
        return;
    }

    const projectIndex = projects.findIndex((p: ProjectModel) => p.uid === projectUid);
    if (projectIndex === -1) {
        showError('The selected project could not be found.');
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
        showError('A project with this name already exists. Choose a different name.');
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
        [...(sourceProject.includedPsaeInternalPaths || [])], // Copy included psae-internal paths
        sourceProject.testingConfig,
        [...sanitizeProjectTickets(sourceProject.tickets)] // Copy project tickets
    );

    projects.push(duplicateProject);

    await SettingsStore.saveWithoutComments(stripSettings(data));
    showInfo(`Project "${duplicateName}" created as a duplicate of "${sourceProject.name}"`);
}

async function getProjectContextFromEvent(event: any): Promise<{ data: any; project: ProjectModel; projectIndex: number } | null> {
    let projectUid: string | undefined;

    if (typeof event === 'string') {
        projectUid = event;
    } else if (event && event.uid) {
        projectUid = event.uid;
    } else if (event && event.id) {
        projectUid = event.id;
    } else if (event && event.projectUid) {
        projectUid = event.projectUid;
    }

    const data = await SettingsStore.get('odoo-debugger-data.json');
    const projects: ProjectModel[] = data.projects ?? [];
    if (projects.length === 0) {
        showError('No projects are configured.');
        return null;
    }

    if (!projectUid) {
        const selectedProject = projects.find((p: ProjectModel) => p.isSelected);
        if (!selectedProject) {
            showError('Select a project first.');
            return null;
        }
        projectUid = selectedProject.uid;
    }

    const projectIndex = projects.findIndex((p: ProjectModel) => p.uid === projectUid);
    if (projectIndex === -1) {
        showError('The selected project could not be found.');
        return null;
    }

    const project = projects[projectIndex];
    project.tickets = sanitizeProjectTickets(project.tickets);
    return { data, project, projectIndex };
}

export async function editProjectSettings(event: any) {
    const context = await getProjectContextFromEvent(event);
    if (!context) {
        return;
    }
    const { project, data } = context;

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
        },
        {
            label: "Manage Tickets",
            description: `${project.tickets?.length ?? 0} ticket(s) linked`,
            detail: "Add, edit, and remove project ticket references",
            action: 'manageTickets'
        },
        {
            label: "Open Ticket",
            description: `Open a ticket in ${resolveTicketBaseUrl()}`,
            detail: "Choose and open a linked ticket in your browser",
            action: 'openTicket'
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

        case 'manageTickets':
            await manageProjectTicketsForProject(project, data);
            break;

        case 'openTicket':
            await openProjectTicket(project.uid);
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
                return 'A project with this name already exists. Choose a different name.';
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

async function manageProjectTicketsForProject(project: ProjectModel, data: any): Promise<void> {
    while (true) {
        project.tickets = sanitizeProjectTickets(project.tickets);
        const tickets = project.tickets;

        const ticketOptions: Array<{ label: string; description?: string; detail?: string; action: 'add' | 'edit' | 'remove' | 'open' | 'done'; ticketId?: string }> = [
            {
                label: '$(add) Add Ticket',
                detail: 'Add a ticket ID and optional short title/description',
                action: 'add'
            },
            {
                label: '$(link-external) Open Ticket',
                description: tickets.length > 0 ? `${tickets.length} saved ticket(s)` : 'No tickets saved yet',
                detail: `Open a linked ticket in ${resolveTicketBaseUrl()}`,
                action: 'open'
            },
            {
                label: '$(edit) Edit Ticket',
                description: tickets.length > 0 ? `${tickets.length} saved ticket(s)` : 'No tickets to edit',
                action: 'edit'
            },
            {
                label: '$(trash) Remove Ticket',
                description: tickets.length > 0 ? `${tickets.length} saved ticket(s)` : 'No tickets to remove',
                action: 'remove'
            },
            {
                label: '$(check) Done',
                action: 'done'
            }
        ];

        const selectedAction = await vscode.window.showQuickPick(ticketOptions, {
            placeHolder: `Manage tickets for project "${project.name}"`,
            ignoreFocusOut: true
        });

        if (!selectedAction || selectedAction.action === 'done') {
            return;
        }

        if (selectedAction.action === 'open') {
            await openProjectTicket(project.uid);
            continue;
        }

        if (selectedAction.action === 'add') {
            const ticketIdInput = await vscode.window.showInputBox({
                prompt: 'Enter ticket ID',
                placeHolder: 'e.g. 123456 or OPW-1234567',
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'Ticket ID cannot be empty';
                    }
                    const exists = tickets.some(ticket => ticket.id.toLowerCase() === value.trim().toLowerCase());
                    if (exists) {
                        return 'This ticket ID is already linked to the project';
                    }
                    return null;
                }
            });
            if (ticketIdInput === undefined) {
                continue;
            }

            const ticketTitleInput = await vscode.window.showInputBox({
                prompt: 'Enter ticket name/short description (optional)',
                placeHolder: 'e.g. Fix onboarding flow',
                ignoreFocusOut: true
            });
            if (ticketTitleInput === undefined) {
                continue;
            }

            project.tickets = sanitizeProjectTickets([
                ...tickets,
                {
                    id: ticketIdInput.trim(),
                    title: ticketTitleInput.trim() || undefined
                }
            ]);
            await SettingsStore.saveWithoutComments(stripSettings(data));
            showAutoInfo(`Ticket "${ticketIdInput.trim()}" added to project "${project.name}"`, 2500);
            continue;
        }

        if (tickets.length === 0) {
            showInfo('No project tickets available. Add one first.');
            continue;
        }

        const ticketToModify = await vscode.window.showQuickPick(
            tickets.map(ticket => ({
                label: formatTicketLabel(ticket),
                description: ticket.id,
                detail: buildTicketUrl(ticket.id),
                ticket
            })),
            {
                placeHolder: selectedAction.action === 'edit'
                    ? 'Select a ticket to edit'
                    : 'Select a ticket to remove',
                ignoreFocusOut: true
            }
        );

        if (!ticketToModify) {
            continue;
        }

        if (selectedAction.action === 'remove') {
            project.tickets = tickets.filter(ticket => ticket.id.toLowerCase() !== ticketToModify.ticket.id.toLowerCase());
            await SettingsStore.saveWithoutComments(stripSettings(data));
            showAutoInfo(`Removed ticket "${ticketToModify.ticket.id}" from project "${project.name}"`, 2500);
            continue;
        }

        const newIdInput = await vscode.window.showInputBox({
            prompt: 'Edit ticket ID',
            value: ticketToModify.ticket.id,
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return 'Ticket ID cannot be empty';
                }
                const exists = tickets.some(ticket =>
                    ticket.id.toLowerCase() === value.trim().toLowerCase() &&
                    ticket.id.toLowerCase() !== ticketToModify.ticket.id.toLowerCase()
                );
                if (exists) {
                    return 'Another ticket with this ID already exists';
                }
                return null;
            }
        });
        if (newIdInput === undefined) {
            continue;
        }

        const newTitleInput = await vscode.window.showInputBox({
            prompt: 'Edit ticket name/short description (optional)',
            value: ticketToModify.ticket.title ?? '',
            ignoreFocusOut: true
        });
        if (newTitleInput === undefined) {
            continue;
        }

        const updatedTickets = tickets.map(ticket =>
            ticket.id.toLowerCase() === ticketToModify.ticket.id.toLowerCase()
                ? { id: newIdInput.trim(), title: newTitleInput.trim() || undefined }
                : ticket
        );

        project.tickets = sanitizeProjectTickets(updatedTickets);
        await SettingsStore.saveWithoutComments(stripSettings(data));
        showAutoInfo(`Updated ticket "${newIdInput.trim()}" for project "${project.name}"`, 2500);
    }
}

export async function manageProjectTickets(event: any): Promise<void> {
    const context = await getProjectContextFromEvent(event);
    if (!context) {
        return;
    }
    await manageProjectTicketsForProject(context.project, context.data);
}

export async function openProjectTicket(event?: any): Promise<void> {
    const context = await getProjectContextFromEvent(event);
    if (!context) {
        return;
    }

    const { project } = context;
    project.tickets = sanitizeProjectTickets(project.tickets);
    const tickets = project.tickets;

    if (tickets.length === 0) {
        const addNow = await showInfo(
            `Project "${project.name}" has no linked tickets yet.`,
            'Add Ticket',
            'Cancel'
        );
        if (addNow === 'Add Ticket') {
            await manageProjectTicketsForProject(project, context.data);
        }
        return;
    }

    const selectedTicket = await vscode.window.showQuickPick(
        tickets.map(ticket => ({
            label: formatTicketLabel(ticket),
            description: ticket.id,
            detail: buildTicketUrl(ticket.id),
            ticket
        })),
        {
            placeHolder: `Select a ticket for project "${project.name}"`,
            ignoreFocusOut: true
        }
    );

    if (!selectedTicket) {
        return;
    }

    const ticketUrl = buildTicketUrl(selectedTicket.ticket.id);
    await vscode.env.openExternal(vscode.Uri.parse(ticketUrl));
    showAutoInfo(`Opened ticket "${selectedTicket.ticket.id}"`, 2000);
}

async function viewProjectInfo(project: ProjectModel) {
    const dbCount = project.dbs?.length || 0;
    const selectedDb = project.dbs?.find((db: DatabaseModel) => db.isSelected);
    const tickets = sanitizeProjectTickets(project.tickets);
    const ticketLines = tickets.length > 0
        ? tickets.map(ticket => `  • ${formatTicketLabel(ticket)}`).join('\n')
        : '  • None';

    let infoMessage = `Project Information

Name: ${project.name}
Created: ${new Date(project.createdAt).toLocaleString()}

Repositories (${project.repos.length}):
${project.repos.map(r => `  • ${r.name}`).join('\n')}

Tickets (${tickets.length}):
${ticketLines}

Databases: ${dbCount}${selectedDb ? `
Active Database: ${selectedDb.name}` : `
No active database`}`;

    await showModalInfo(infoMessage, 'OK');
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
            showError('The project data is invalid.');
            return;
        }

        const data = await SettingsStore.get('odoo-debugger-data.json');
        const projects: ProjectModel[] = data.projects;
        if (!projects) {
            showError('No projects are configured.');
            return;
        }

        const project = projects.find(p => p.uid === projectUid);
        if (!project) {
            showError('The selected project could not be found.');
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
            tickets: sanitizeProjectTickets(project.tickets),
            exportedAt: new Date().toISOString(),
            exportVersion: '1.0'
        };

        // Write to file
        const content = JSON.stringify(exportData, null, 2);
        await vscode.workspace.fs.writeFile(saveUri, Buffer.from(content, 'utf8'));

        const action = await showInfo(
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

            await showModalInfo(instructions);
        }

    } catch (error) {
        logger.error('Error exporting project:', error);
        showError(`Failed to export project: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
            showError('The selected file is not a valid project export.');
            return;
        }
        const importedTickets = sanitizeProjectTickets(importData.tickets);

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
            const useNewName = await showWarning(
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
        const availableRepos = findRepositories(customAddonsPath);
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
            [], // No included psae-internal paths on import
            undefined,
            importedTickets
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

        await showInfo(message, 'OK');

    } catch (error) {
        logger.error('Error importing project:', error);
        if (error instanceof SyntaxError) {
            showError('The selected file is not valid JSON.');
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
            showError('No projects are configured. Create a project first.');
            return;
        }

        // Create quick pick items with project information
        const quickPickItems = projects.map(project => {
            const selectedDb = project.dbs?.find((db: DatabaseModel) => db.isSelected);
            const repoCount = project.repos.length;
            const ticketCount = sanitizeProjectTickets(project.tickets).length;
            const dbInfo = selectedDb ? ` | DB: ${selectedDb.name}` : ' | No DB';

            return {
                label: `${project.isSelected ? '$(arrow-right) ' : ''}${project.name}`,
                description: `${repoCount} repo${repoCount === 1 ? '' : 's'} | ${ticketCount} ticket${ticketCount === 1 ? '' : 's'}${dbInfo}`,
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
        logger.error('Error in quick project search:', error);
        showError('Unable to load projects for search.');
    }
}
