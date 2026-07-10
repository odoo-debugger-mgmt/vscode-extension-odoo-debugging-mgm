/**
 * Setup Odoo flow: clones odoo/enterprise for a chosen branch and creates a
 * Python virtualenv in the workspace.
 */
// VSCode Extension Utility: Clone Odoo & Enterprise for a selected branch and setup venv with progress
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getWorkspacePath, showInfo, showError } from './utils';
import { tryRunCommand } from './services/process';
import { logger } from './services/logger';
import { showModalWarning } from './services/notifications';

export async function setupOdooBranch() {
    // Show confirmation dialog with detailed information
    const confirmMessage = `This will:
• Clone Odoo and Enterprise repositories
• Create a Python virtual environment
• Allow you to select a specific branch

This may take several minutes depending on your internet connection.

Continue?`;

    const confirm = await showModalWarning(
        confirmMessage,
        'Continue'
    );

    if (confirm !== 'Continue') {
        return;
    }

    const baseDir = getWorkspacePath();
    if (!baseDir) {
        void showError('Open a workspace folder before running this command.');
        return;
    }

    // Check if directories already exist
    const odooPath = path.join(baseDir, 'odoo');
    const enterprisePath = path.join(baseDir, 'enterprise');
    const venvPath = path.join(baseDir, 'venv');

    const existingPaths = [];
    if (fs.existsSync(odooPath)) {
        existingPaths.push('odoo');
    }
    if (fs.existsSync(enterprisePath)) {
        existingPaths.push('enterprise');
    }
    if (fs.existsSync(venvPath)) {
        existingPaths.push('venv');
    }

    if (existingPaths.length > 0) {
        const overwriteConfirm = await showModalWarning(
            `The following directories already exist: ${existingPaths.join(', ')}\n\nDo you want to continue? This may overwrite existing files.`,
            'Continue Anyway',
            'Cancel'
        );

        if (overwriteConfirm !== 'Continue Anyway') {
            return;
        }
    }

    // Let user select branch
    const branchOptions = [
        { label: '17.0', description: 'Latest stable version' },
        { label: '16.0', description: 'Previous stable version' },
        { label: '15.0', description: 'Legacy stable version' },
        { label: '14.0', description: 'Legacy stable version' },
        { label: 'master', description: 'Development branch (unstable)' },
        { label: 'saas-17.4', description: 'SaaS version' },
        { label: 'saas-17.3', description: 'SaaS version' },
        { label: 'saas-17.2', description: 'SaaS version' },
        { label: 'Custom', description: 'Enter a custom branch name' }
    ];

    const selectedBranch = await vscode.window.showQuickPick(branchOptions, {
        placeHolder: 'Select an Odoo branch to clone',
        ignoreFocusOut: true
    });

    if (!selectedBranch) {
        return;
    }

    let branch = selectedBranch.label;
    if (branch === 'Custom') {
        const customBranch = await vscode.window.showInputBox({
            prompt: 'Enter the branch name',
            placeHolder: 'e.g., 17.0, master, saas-17.4',
            ignoreFocusOut: true
        });

        if (!customBranch) {
            return;
        }
        branch = customBranch.trim();
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Setting up Odoo ${branch}…`,
        cancellable: false
    }, async (progress) => {
        try {
            progress.report({ message: 'Preparing setup…', increment: 5 });

            // Create terminal for operations
            const terminal = vscode.window.createTerminal({
                name: `Odoo Setup (${branch})`,
                cwd: baseDir
            });
            terminal.show();

            // Clone Odoo repository
            progress.report({ message: 'Cloning Odoo repository…', increment: 15 });
            logger.debug(`🔄 Cloning Odoo repository (branch: ${branch})`);

            terminal.sendText(`echo "🔄 Cloning Odoo repository (branch: ${branch})..."`);
            terminal.sendText(`git clone --depth 1 --branch ${branch} https://github.com/odoo/odoo.git`);

            // Wait a bit for the clone to start
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Clone Enterprise repository
            progress.report({ message: 'Cloning Enterprise repository…', increment: 35 });
            logger.debug(`🔄 Cloning Enterprise repository (branch: ${branch})`);

            terminal.sendText(`echo "🔄 Cloning Enterprise repository (branch: ${branch})..."`);
            terminal.sendText(`git clone --depth 1 --branch ${branch} git@github.com:odoo/enterprise.git || git clone --depth 1 --branch ${branch} https://github.com/odoo/enterprise.git`);

            // Wait for enterprise clone
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Check Python availability
            progress.report({ message: 'Checking Python installation…', increment: 55 });
            logger.debug('🐍 Checking Python installation');

            let pythonCmd = 'python3';
            if (await tryRunCommand('python3', ['--version']) === undefined) {
                if (await tryRunCommand('python', ['--version']) !== undefined) {
                    pythonCmd = 'python';
                } else {
                    throw new Error('Python not found. Please install Python 3.8+ first.');
                }
            }

            // Create virtual environment
            progress.report({ message: 'Creating Python virtual environment…', increment: 75 });
            logger.debug('🔧 Creating Python virtual environment');

            terminal.sendText(`echo "🔧 Creating Python virtual environment..."`);
            terminal.sendText(`${pythonCmd} -m venv venv`);

            // Wait for venv creation
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Activate venv and install basic requirements
            progress.report({ message: 'Installing basic Python packages…', increment: 85 });
            logger.debug('📦 Installing basic Python packages');

            terminal.sendText(`echo "📦 Installing basic Python packages..."`);

            // Platform-specific activation
            const isWindows = process.platform === 'win32';
            const activateCmd = isWindows ? '.\\venv\\Scripts\\activate' : 'source venv/bin/activate';

            terminal.sendText(`${activateCmd} && pip install --upgrade pip setuptools wheel`);

            // Install Odoo requirements if they exist
            terminal.sendText(`${activateCmd} && if [ -f odoo/requirements.txt ]; then pip install -r odoo/requirements.txt; else echo "No requirements.txt found in odoo directory"; fi`);

            progress.report({ message: 'Setup complete!', increment: 100 });

            // Show completion message with next steps
            terminal.sendText(`echo ""`);
            terminal.sendText(`echo "✅ Odoo ${branch} setup complete!"`);
            terminal.sendText(`echo ""`);
            terminal.sendText(`echo "Next steps:"`);
            terminal.sendText(`echo "1. Configure your VS Code settings to point to these directories"`);
            terminal.sendText(`echo "2. Activate the virtual environment: ${activateCmd}"`);
            terminal.sendText(`echo "3. Install additional dependencies if needed"`);
            terminal.sendText(`echo "4. Create your custom addons directory"`);
            terminal.sendText(`echo ""`);

            void showInfo(`Odoo ${branch} setup completed successfully!\n\nCheck the terminal for next steps.`);

        } catch (error: any) {
            logger.error('Setup failed:', error);
            void showError(`Setup failed: ${error.message}`);
        }
    });
}
