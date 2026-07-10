import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import type { ProjectModel } from '../models/project';
import { SettingsStore } from '../settingsStore';
import { showError } from '../services/notifications';
import { logger, errorMessage } from '../services/logger';
import {
    createDb,
    selectDatabase,
    deleteDb,
    restoreDb,
    changeDatabaseVersion,
    changeDatabaseProjectRepoBranches,
    manageDatabaseTemplates,
    cloneDatabaseFlow,
    reconcileDatabasesFlow,
    extractDatabaseFromEvent
} from '../dbs';
import { showBriefStatus } from '../services/notifications';

export function registerDbCommands(deps: CommandDeps): void {
    const { context, versionsService, refreshAll } = deps;

    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.create', async () => {
        try {
            // Get settings from active version
            const settings = await versionsService.getActiveVersionSettings();

            const projects = await SettingsStore.getProjects();
            const project = projects?.find((p: ProjectModel) => p.isSelected);
            if (!project) {
                throw new Error('Select a project before running this action.');
            }
            const db = await createDb(project.name, project.repos, settings.dumpsFolder, settings);
            if (db) {
                project.dbs.push(db);
                // Only save projects, not settings - settings are managed via versions
                const data = await SettingsStore.load();
                await SettingsStore.saveWithoutComments({
                    projects,
                    versions: data.versions,
                    activeVersion: data.activeVersion,
                    dbTemplates: data.dbTemplates
                });
                await selectDatabase(db);
            }
            await refreshAll();
        } catch (err) {
            void showError(errorMessage(err));
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.selectDb', async (event) => {
        try {
            await selectDatabase(event);
            await refreshAll();
        } catch (err) {
            void showError(`Failed to select database: ${errorMessage(err)}`);
            logger.error('Error in database selection:', err);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.delete', async (event) => {
        try {
            await deleteDb(event);
            await refreshAll();
        } catch (err) {
            void showError(`Failed to delete database: ${errorMessage(err)}`);
            logger.error('Error in database deletion:', err);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.restore', async (event) => {
        try {
            // restoreDb shows its own success notification.
            await restoreDb(event);
            await refreshAll();
        } catch (err) {
            void showError(`Failed to restore database: ${errorMessage(err)}`);
            logger.error('Error in database restoration:', err);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.changeVersion', async (event) => {
        try {
            await changeDatabaseVersion(event);
            await refreshAll();
        } catch (err) {
            void showError(`Failed to change database version: ${errorMessage(err)}`);
            logger.error('Error in database version change:', err);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.configureRepoBranches', async (event) => {
        try {
            await changeDatabaseProjectRepoBranches(event);
            await refreshAll({ reason: 'ui' });
        } catch (err) {
            void showError(`Failed to update project repo branch mapping: ${errorMessage(err)}`);
            logger.error('Error in database project repo branch mapping update:', err);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.manageTemplates', async () => {
        try {
            await manageDatabaseTemplates();
            await refreshAll({ reason: 'ui' });
        } catch (err) {
            void showError(`Failed to manage database templates: ${errorMessage(err)}`);
            logger.error('Error in database template management:', err);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.copyName', async (event) => {
        const db = extractDatabaseFromEvent(event);
        if (!db) {
            void showError('Could not identify the database whose name to copy.');
            return;
        }
        await vscode.env.clipboard.writeText(db.id);
        showBriefStatus(`Copied database name: ${db.id}`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.clone', async (event) => {
        try {
            await cloneDatabaseFlow(event);
            await refreshAll({ reason: 'ui' });
        } catch (err) {
            void showError(`Failed to clone database: ${errorMessage(err)}`);
            logger.error('Error in database clone:', err);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.reconcile', async () => {
        try {
            await reconcileDatabasesFlow();
            await refreshAll({ reason: 'ui' });
        } catch (err) {
            void showError(`Failed to reconcile databases: ${errorMessage(err)}`);
            logger.error('Error in database reconciliation:', err);
        }
    }));
}
