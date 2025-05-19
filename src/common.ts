import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectModel } from './models/project';
import { SettingsModel } from './models/settings';

export function checkWorkSpaceOrFolder(): boolean | vscode.TreeItem[] {
    if (!vscode.workspace.workspaceFolders) {
        return false;
    }
    return true;
}

async function createOdooDebuggerFile(filePath:string, workspacePath: string): Promise<any> {
    const vscodeDir = path.join(workspacePath, '.vscode');
    if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir);
    }
    let debuggerData = {
        settings: new SettingsModel(),
        projects: []
    };
    fs.writeFileSync(filePath, JSON.stringify(debuggerData, null, 2), 'utf-8');
    return debuggerData;
}

export async function saveToFile(data:any){
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage("No workspace open.");
        return;
    }
    const workspacePath = workspaceFolder.uri.fsPath;
    const vscodeDir = path.join(workspacePath, '.vscode');
    if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir);
    }
    const filePath = path.join(vscodeDir, 'odoo-debugger-data.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export async function readFromFile(): Promise<any> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage("No workspace open.");
        return;
    }
    const workspacePath = workspaceFolder.uri.fsPath;
    const filePath = path.join(workspacePath, '.vscode', 'odoo-debugger-data.json');
    if (!fs.existsSync(filePath)) {
        vscode.window.showErrorMessage("File not found");
        vscode.window.showInformationMessage("Creating odoo-debugger-data.json file");
        return await createOdooDebuggerFile(filePath, workspacePath);
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
}

// function updateLunchJsonFile(project: ProjectModel){
//     const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
//     if (!workspaceFolder) {
//         vscode.window.showErrorMessage("No workspace open.");
//         return;
//     }
//     const workspacePath = workspaceFolder.uri.fsPath;
//     const filePath = path.join(workspacePath, '.vscode', 'launch.json');
//     if (!fs.existsSync(filePath)) {
//         vscode.window.showErrorMessage("File not found");
//         return;
//     }
//     const data = fs.readFileSync(filePath, 'utf-8');
//     const parsedData = JSON.parse(data);
//     parsedData.configurations[0].env.ODOO_PROJECT_PATH = project.path;
//     fs.writeFileSync(filePath, JSON.stringify(parsedData, null, 2), 'utf-8');
// }

export function camelCaseToTitleCase(str: string): string {
    return str.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase());
}

export function getFolderPathsAndNames(targetPath: string): [string, string][] {
    if (!fs.existsSync(targetPath)) {
        vscode.window.showErrorMessage(`Path does not exist: ${targetPath}`);
        return [];
    }

    return fs.readdirSync(targetPath)
        .map(file => {
            const fullPath = path.join(targetPath, file);
            return { fullPath, file };
        })
        .filter(entry => {
            try {
                return (fs.statSync(entry.fullPath).isDirectory() && !entry.file.startsWith('.'));
            } catch {
                return false;
            }
        })
        .map(entry => [entry.fullPath, entry.file] as [string, string]);
}
