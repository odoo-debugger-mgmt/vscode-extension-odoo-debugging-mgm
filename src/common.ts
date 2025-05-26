import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectModel } from './models/project';
import { SettingsModel } from './models/settings';
import { modify, applyEdits, parse } from 'jsonc-parser';

export function checkWorkSpaceOrFolder(): boolean | vscode.TreeItem[] {
    if (!vscode.workspace.workspaceFolders) {
        return false;
    }
    return true;
}

async function createOdooDebuggerFile(filePath:string, workspacePath: string, fileName:string): Promise<any> {
    const vscodeDir = path.join(workspacePath, '.vscode');
    if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir);
    }
    let Data;
    if(fileName === "launch.json"){
        Data = {
            version: "0.2.0",
            configurations: []
        };
    }
    else{
        Data = {
            settings: new SettingsModel(),
            projects: []
        };
    }
    fs.writeFileSync(filePath, JSON.stringify(Data, null, 2), 'utf-8');
    return Data;
}

export async function saveToFile(data:any, fileName: string){
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
    const filePath = path.join(vscodeDir, fileName);

    let originalContent = '{}';
    if (fs.existsSync(filePath)) {
        originalContent = fs.readFileSync(filePath, 'utf-8');
    }
    const edits = modify(originalContent, [], data, {
        formattingOptions: {
            insertSpaces: true,
            tabSize: 4,
        }
    });

    const updatedContent = applyEdits(originalContent, edits);

    fs.writeFileSync(filePath, updatedContent, 'utf-8');

}

export async function readFromFile(fileName: string): Promise<any> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage("No workspace open.");
        return;
    }
    const workspacePath = workspaceFolder.uri.fsPath;
    const filePath = path.join(workspacePath, '.vscode', fileName);
    if (!fs.existsSync(filePath)) {
        vscode.window.showErrorMessage("File not found");
        vscode.window.showInformationMessage(`Creating ${fileName} file...`);
        return await createOdooDebuggerFile(filePath, workspacePath, fileName);
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    return parse(data);
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

export function getFolderPathsAndNames(targetPath: string): { "path": string, "name": string }[] {
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
        .map(entry => ({ path: entry.fullPath, name: entry.file }) );
}
