// VSCode Extension Utility: Clone Odoo & Enterprise for a selected branch and setup venv with progress
import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function execShellCommand(cmd: string, cwd?: string): Promise<string> {
    try {
        const { stdout, stderr } = await execAsync(cmd, {
            cwd,
            env: process.env,
            maxBuffer: 1024 * 1024 * 10
        });
        if (stderr) {
            console.warn('stderr:', stderr); // Optional
        }
        return stdout;
    } catch (error: any) {
        throw error.stderr || error.stdout || error.message || error;
    }
}

async function getOdooBranches(): Promise<string[]> {
    const output = await execShellCommand('git ls-remote --heads https://github.com/odoo/odoo.git');
    return output
        .split('\n')
        .map(line => line.split('refs/heads/')[1])
        .filter(branch => branch);
}

export async function setupOdooBranch() {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Setting up Odoo…',
        cancellable: false
    }, async (progress) => {
        const confirm = await vscode.window.showInformationMessage(
            'Please Know that this command will only download odoo source code and enterprise. Also it will install a venv only.',
            { modal: true },
            'Continue'
        );
        if (!confirm) return;

        const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!baseDir) {
            vscode.window.showErrorMessage('Open a workspace folder first.');
            return;
        }

        progress.report({ message: 'Cloning Odoo and Enterprise repositories…' });
        const terminal = vscode.window.createTerminal({ name: 'Odoo Setup' });
        terminal.show();
        terminal.sendText(`git clone https://github.com/odoo/odoo.git `);
        terminal.sendText(`git clone git@github.com:odoo/enterprise.git`);

        progress.report({ message: 'Creating Python virtual environment…' });
        const venvPath = path.join(baseDir, 'venv');
        const pythonCmd = 'python3';
        try {
            terminal.sendText(`${pythonCmd} -m venv ${venvPath}`);
        } catch (e) {
            vscode.window.showErrorMessage('Python venv creation failed: ' + e);
        }
    });
}
