import * as vscode from 'vscode';
import * as path from 'node:path';
import { SettingsStore } from './settingsStore';
import { ProjectModel } from './models/project';
import { RepoModel } from './models/repo';
import { showInfo, normalizePath } from './utils';

interface ProjectSelectionResult {
    project: ProjectModel;
    projectIndex: number;
    data: any;
}

async function getActiveProjectOrPrompt(): Promise<ProjectSelectionResult | undefined> {
    const data = await SettingsStore.get('odoo-debugger-data.json');
    if (!data?.projects || data.projects.length === 0) {
        showInfo('No projects found. Create a project first.');
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
        showInfo(`Project "${project.name}" has no repositories. Add repos first.`);
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

    const workspaceData = {
        folders,
        settings: {}
    };

    const content = Buffer.from(JSON.stringify(workspaceData, null, 2), 'utf8');
    await vscode.workspace.fs.writeFile(workspaceFile, content);
    return workspaceFile;
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

    const choice = await vscode.window.showInformationMessage(
        'Open project workspace?',
        { modal: false },
        'This window',
        'New window'
    );
    if (!choice) {
        return;
    }
    const forceNewWindow = choice === 'New window';
    await vscode.commands.executeCommand('vscode.openFolder', workspaceFile, forceNewWindow);
}

export async function quickSwitchProjectWorkspace(context: vscode.ExtensionContext): Promise<void> {
    const data = await SettingsStore.get('odoo-debugger-data.json');
    if (!data?.projects || data.projects.length === 0) {
        showInfo('No projects found. Create a project first.');
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
