/**
 * Multi-root workspace files built from a project's repositories
 * (open/rebuild/quick-switch).
 */
import * as vscode from 'vscode';
import { parse } from 'jsonc-parser';
import { SettingsStore } from './settingsStore';
import { logger } from './services/logger';
import { ProjectModel } from './models/project';
import { RepoModel } from './models/repo';
import { showInfo, normalizePath } from './utils';
import { VersionsService } from './versionsService';
import { versionFolderEntries, repoFolderEntries } from './services/workspaceFolders';
import { resolveProjectRepos } from './services/repoPaths';
import { resolveProjectRepoBranchAssignments } from './services/environment';
import { readSetupState } from './services/setupState';

interface ProjectSelectionResult {
    project: ProjectModel;
    projectIndex: number;
    data: any;
}

async function getActiveProjectOrPrompt(): Promise<ProjectSelectionResult | undefined> {
    const data = await SettingsStore.get('odoo-debugger-data.json');
    if (!data?.projects || data.projects.length === 0) {
        void showInfo('No projects yet.', 'Create Project').then(choice => {
            if (choice === 'Create Project') {
                void vscode.commands.executeCommand('projectSelector.create');
            }
        });
        return undefined;
    }

    let projectIndex = data.projects.findIndex((p: ProjectModel) => p.isSelected);
    if (projectIndex === -1) {
        const pick = await vscode.window.showQuickPick(
            data.projects.map((p: ProjectModel, idx: number) => ({
                label: p.name,
                description: `${p.repos?.length ?? 0} repos`,
                index: idx
            })),
            { placeHolder: 'Select a project' }
        );
        if (!pick) {
            return undefined;
        }
        projectIndex = pick.index;
        data.projects.forEach((p: ProjectModel, idx: number) => (p.isSelected = idx === projectIndex));
        await SettingsStore.saveWithoutComments(data);
    }

    return { project: data.projects[projectIndex], projectIndex, data };
}

async function buildWorkspaceFile(context: vscode.ExtensionContext, project: ProjectModel): Promise<vscode.Uri | undefined> {
    if (!project.repos || project.repos.length === 0) {
        void showInfo(`Project "${project.name}" has no repositories. Add repos first.`);
        return undefined;
    }

    const workspacesDir = vscode.Uri.joinPath(context.globalStorageUri, 'workspaces');
    await vscode.workspace.fs.createDirectory(workspacesDir);

    const workspaceFile = vscode.Uri.joinPath(workspacesDir, `${project.uid || project.name}.code-workspace`);

    const folders: Array<{ path: string; name?: string }> = [];
    for (const repo of project.repos as RepoModel[]) {
        const repoPath = normalizePath(repo.path);
        const folderEntry: { path: string; name?: string } = { path: repoPath };
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(repoPath));
        } catch {
            folderEntry.name = `${repo.name} (missing)`;
        }
        folders.push(folderEntry);
    }

    // The active version's own checkouts, so files opened from this workspace
    // belong to the version being run.
    const versionsService = VersionsService.getInstance();
    await versionsService.initialize();
    folders.push(...versionFolderEntries(
        versionsService.getActiveVersion(),
        folders.map(folder => folder.path)
    ));

    // Project repos resolved to the active version's worktrees, so opening a
    // file from this workspace cannot land in another version's copy.
    const selectedDb = project.dbs?.find(entry => entry.isSelected);
    folders.push(...repoFolderEntries(
        resolveProjectRepos(
            project.repos ?? [],
            selectedDb ? resolveProjectRepoBranchAssignments(selectedDb, project.repos ?? []) : [],
            readSetupState().provisioningRoot
        ),
        folders.map(folder => folder.path)
    ));

    // Pin the data: the new window's first folder is a project repository,
    // and without this it would read (and create) a data file inside it.
    const settings: Record<string, string> = {};
    const dataLocation = SettingsStore.currentLocation();
    if (dataLocation) {
        settings['odooDebugger.dataStore.path'] = dataLocation;
    }

    // Rebuilding keeps the launch configurations the debugger sync wrote into
    // this file: they are this workspace's, and live nowhere else.
    const workspaceData: Record<string, unknown> = {
        folders,
        settings
    };
    const previousLaunch = await readLaunchSection(workspaceFile);
    if (previousLaunch !== undefined) {
        workspaceData.launch = previousLaunch;
    }

    const content = Buffer.from(JSON.stringify(workspaceData, null, 2), 'utf8');
    await vscode.workspace.fs.writeFile(workspaceFile, content);
    return workspaceFile;
}

async function readLaunchSection(workspaceFile: vscode.Uri): Promise<unknown> {
    try {
        const parsed = parse(Buffer.from(await vscode.workspace.fs.readFile(workspaceFile)).toString('utf8'));
        return parsed && typeof parsed === 'object' ? (parsed as { launch?: unknown }).launch : undefined;
    } catch {
        return undefined;
    }
}

export async function rebuildProjectWorkspace(context: vscode.ExtensionContext): Promise<vscode.Uri | undefined> {
    const selection = await getActiveProjectOrPrompt();
    if (!selection) {
        return undefined;
    }

    return buildWorkspaceFile(context, selection.project);
}

export async function openProjectWorkspace(context: vscode.ExtensionContext): Promise<void> {
    const workspaceFile = await rebuildProjectWorkspace(context);
    if (!workspaceFile) {
        return;
    }

    const choice = await showInfo(
        'Open project workspace?',
        'This window',
        'New window'
    );
    if (!choice) {
        return;
    }
    const forceNewWindow = choice === 'New window';
    // Opened by its path, not by the global-storage URI it was written
    // through: that URI made the window a vscode-userdata workspace, which
    // the Python debugger refuses to run in.
    const target = vscode.Uri.file(workspaceFile.fsPath);
    // The selection is per window; the opened workspace starts from this one's.
    await SettingsStore.handOffSelection(context, target);
    await vscode.commands.executeCommand('vscode.openFolder', target, forceNewWindow);
}

const REOPEN_MESSAGE = 'This workspace was opened in a way that keeps the Python debugger from running. '
    + 'Reopen it from its file to fix that.';

/**
 * A project workspace opened by an earlier build - and reopened from the
 * Recent list since - still carries its vscode-userdata URI. Says so once, in
 * that window, and keeps a status bar item up until it is reopened: the
 * message alone hides itself before it can be clicked.
 */
export function offerToReopenByPath(context: vscode.ExtensionContext): void {
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile?.scheme !== 'vscode-userdata') {
        return;
    }
    const reopen = async () => {
        // Otherwise Recent lists the workspace twice under one label, and the
        // old entry keeps reopening it the way that needs this again.
        try {
            await vscode.commands.executeCommand('vscode.removeFromRecentlyOpened', workspaceFile);
        } catch (error) {
            logger.debug('Could not remove the old Recent entry:', error);
        }
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspaceFile.fsPath), false);
    };

    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    item.text = '$(warning) Reopen for debugger';
    item.tooltip = REOPEN_MESSAGE;
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    item.command = 'odt.workspace.reopenByPath';
    item.show();
    context.subscriptions.push(item, vscode.commands.registerCommand('odt.workspace.reopenByPath', reopen));

    void showInfo(REOPEN_MESSAGE, 'Reopen It').then(choice => {
        if (choice === 'Reopen It') {
            void reopen();
        }
    });
}

export async function quickSwitchProjectWorkspace(context: vscode.ExtensionContext): Promise<void> {
    const data = await SettingsStore.get('odoo-debugger-data.json');
    if (!data?.projects || data.projects.length === 0) {
        void showInfo('No projects yet.', 'Create Project').then(choice => {
            if (choice === 'Create Project') {
                void vscode.commands.executeCommand('projectSelector.create');
            }
        });
        return;
    }

    const pick = await vscode.window.showQuickPick(
        data.projects.map((p: ProjectModel, idx: number) => ({
            label: p.name,
            description: `${p.repos?.length ?? 0} repos`,
            index: idx
        })),
        { placeHolder: 'Select a project to open its workspace' }
    );
    if (!pick) {
        return;
    }

    data.projects.forEach((p: ProjectModel, idx: number) => (p.isSelected = idx === pick.index));
    await SettingsStore.saveWithoutComments(data);

    await openProjectWorkspace(context);
}
