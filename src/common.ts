import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectModel } from './models/project';

export function checkWorkSpaceOrFolder(): boolean | vscode.TreeItem[] {
    if (!vscode.workspace.workspaceFolders) {
        return false;
    }
    return true;
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
        return null;
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
