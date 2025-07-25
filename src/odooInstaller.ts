// VSCode Extension Utility: Clone Odoo & Enterprise for a selected branch and setup venv with progress
import * as vscode from 'vscode';
import * as path from 'path';
import { getWorkspacePath, showInfo, showError } from './utils';

export async function setupOdooBranch() {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Setting up Odoo…',
        cancellable: false
    }, async (progress) => {
        const confirm = await showInfo(
            'Please Know that this command will only download odoo source code and enterprise. Also it will install a venv only.',
            'Continue'
        );
        if (!confirm) {
            return;
        }

        const baseDir = getWorkspacePath();
        if (!baseDir) {
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
            showError('Python venv creation failed: ' + e);
        }
    });
}
