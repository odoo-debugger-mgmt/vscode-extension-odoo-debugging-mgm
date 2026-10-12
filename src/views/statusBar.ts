import * as vscode from 'vscode';
import { SettingsStore } from '../settingsStore';
import { VersionsService } from '../versionsService';
import { getDatabaseLabel } from '../utils';
import { logger } from '../services/logger';
import { getRunningInstances } from '../services/runningState';
import { statusBarDatabase } from '../services/dbResolution';

/**
 * Status bar indicators for the active project, database and version.
 * Clicking each opens the corresponding quick-switch picker, so the current
 * context is visible (and switchable) without opening the side bar.
 */
export class StatusBarIndicators implements vscode.Disposable {
    private readonly projectItem: vscode.StatusBarItem;
    private readonly dbItem: vscode.StatusBarItem;
    private readonly versionItem: vscode.StatusBarItem;

    constructor() {
        this.projectItem = vscode.window.createStatusBarItem('odooDevtools.project', vscode.StatusBarAlignment.Left, 100);
        this.projectItem.name = 'Odoo DevTools: Project';
        this.projectItem.command = 'odoo-debugger.quickProjectSearch';

        this.dbItem = vscode.window.createStatusBarItem('odooDevtools.database', vscode.StatusBarAlignment.Left, 99);
        this.dbItem.name = 'Odoo DevTools: Database';
        this.dbItem.command = 'dbSelector.quickSearch';

        this.versionItem = vscode.window.createStatusBarItem('odooDevtools.version', vscode.StatusBarAlignment.Left, 98);
        this.versionItem.name = 'Odoo DevTools: Version';
        this.versionItem.command = 'odoo.setActiveVersion';
    }

    /** Re-reads the active project/db/version and updates the items. */
    async update(): Promise<void> {
        const enabled = vscode.workspace.getConfiguration('odooDebugger').get<boolean>('statusBar.enabled', true);
        if (!enabled || !vscode.workspace.workspaceFolders?.length) {
            this.hideAll();
            return;
        }

        try {
            // Read without getSelectedProject(): no project selected must not toast.
            const data = await SettingsStore.get('odoo-debugger-data.json');
            const project = data.projects?.find(p => p.isSelected);
            const version = VersionsService.getInstance().getActiveVersion();
            // What the active version launches, as Start Server and
            // launch.json resolve it - not merely the selected database,
            // which can belong to another version.
            const shown = statusBarDatabase(project, version?.id);

            if (project) {
                this.projectItem.text = `$(folder-library) ${project.name}`;
                this.projectItem.tooltip = `Odoo project: ${project.name} - click to switch`;
                this.projectItem.show();
            } else {
                this.projectItem.hide();
            }

            if (shown && 'db' in shown) {
                this.dbItem.text = `$(database) ${getDatabaseLabel(shown.db)}`;
                this.dbItem.tooltip = `Selected database: ${shown.db.id} - click to switch`;
                this.dbItem.backgroundColor = undefined;
                this.dbItem.command = 'dbSelector.quickSearch';
                this.dbItem.show();
            } else if (shown && version) {
                this.dbItem.text = `$(database) no ${version.odooVersion} database`;
                this.dbItem.tooltip = `No database of ${version.name} is selected - click to choose one`;
                this.dbItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                this.dbItem.command = {
                    title: 'Choose a database',
                    command: 'dbSelector.quickSearch',
                    arguments: [{ versionId: shown.missingFor }]
                };
                this.dbItem.show();
            } else {
                this.dbItem.hide();
            }

            if (version) {
                // The port belongs on the indicator: with several versions
                // runnable at once, "which localhost" is the question this
                // item is most often consulted for.
                const port = Number(version.settings?.portNumber) || undefined;
                const running = (await getRunningInstances()).some(instance => instance.versionId === version.id);
                const marker = running ? '$(debug-alt)' : '$(versions)';
                this.versionItem.text = port
                    ? `${marker} ${version.odooVersion} :${port}`
                    : `${marker} ${version.odooVersion}`;
                this.versionItem.tooltip = [
                    `Active version: ${version.name} (${version.odooVersion})`,
                    port ? `Server: http://localhost:${port}` : undefined,
                    running ? 'Currently running' : 'Not running',
                    'Click to switch'
                ].filter(Boolean).join('\n');
                this.versionItem.show();
            } else {
                this.versionItem.hide();
            }
        } catch (error) {
            logger.debug('Status bar update failed:', error);
            this.hideAll();
        }
    }

    private hideAll(): void {
        this.projectItem.hide();
        this.dbItem.hide();
        this.versionItem.hide();
    }

    dispose(): void {
        this.projectItem.dispose();
        this.dbItem.dispose();
        this.versionItem.dispose();
    }
}
