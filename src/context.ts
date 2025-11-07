import * as vscode from 'vscode';

/**
 * Updates VS Code context keys used by the extension.
 * Exported separately to avoid circular imports between modules.
 */
export function updateTestingContext(isTestingEnabled: boolean): void {
    void vscode.commands.executeCommand('setContext', 'odoo-debugger.testing_enabled', isTestingEnabled);
}

export function updateActiveContext(isActive: boolean): void {
    void vscode.commands.executeCommand('setContext', 'odoo-debugger.is_active', isActive);
}
