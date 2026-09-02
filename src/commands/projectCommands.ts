/**
 * Command handlers for the Projects view and project workspaces.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { CommandDeps } from './index';
import { normalizePath } from '../utils';
import { showError } from '../services/notifications';
import { errorMessage } from '../services/logger';
import {
    createProject,
    selectProject,
    getRepo,
    getProjectName,
    deleteProject,
    editProjectSettings,
    duplicateProject,
    exportProject,
    importProject,
    quickProjectSearch,
    manageProjectTickets,
    openProjectTicket,
    detectProjectTickets
} from '../project';
import { createDb, selectDatabase } from '../dbs';
import { cloneOdooRepositories, provisionAndCreateVersion } from '../odooInstaller';
import { openProjectWorkspace, rebuildProjectWorkspace, quickSwitchProjectWorkspace } from '../projectWorkspace';
import type { DatabaseModel } from '../models/db';
import { runSetup } from '../services/setupFlow';
import { readSetupState } from '../services/setupState';
import { updateConfiguredContext } from '../context';
import { proposeVersions } from '../services/versionProposal';
import { collectRepoBranches, pickVersionsToBuild } from './versionPick';
import { listSeriesBranches } from '../services/gitService';
import {
    drainProvisionQueue,
    enqueue,
    offerStop,
    readQueue,
    setQueueSnapshot,
    writeQueue
} from '../services/provisionQueue';

export function registerProjectCommands(deps: CommandDeps): void {
    const { context, versionsService, refreshAll } = deps;

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.create', async () => {
        try {
            // Get settings from active version
            const settings = await versionsService.getActiveVersionSettings();

            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) { throw new Error('Open a workspace to use this command.'); }
            const name = await getProjectName(workspaceFolder);
            const customAddonsPath = normalizePath(settings.customAddonsPath);
            const repos = await getRepo(customAddonsPath, name); // Pass project name as search filter
            const databaseChoice = await vscode.window.showQuickPick([
                {
                    label: 'Create a new database',
                    description: 'Set up a fresh database or restore from a dump',
                    detail: 'You can add more databases later from the Databases view.',
                    value: 'create'
                },
                {
                    label: 'Connect to an existing database',
                    description: 'Link this project to a database that already exists in PostgreSQL',
                    value: 'connect'
                },
                {
                    label: 'Skip for now',
                    description: 'You can configure databases later from the Databases view.',
                    value: 'skip'
                }
            ], {
                placeHolder: 'Set up a database for this project?',
                ignoreFocusOut: true
            });
            if (!databaseChoice) {
                return;
            }

            let db: DatabaseModel | undefined;
            if (databaseChoice.value === 'create') {
                db = await createDb(name, repos, settings.dumpsFolder, settings, { allowExistingOption: false });
            } else if (databaseChoice.value === 'connect') {
                db = await createDb(name, repos, settings.dumpsFolder, settings, { initialMethod: 'existing' });
            }

            if (databaseChoice.value !== 'skip' && !db) {
                // User cancelled within DB creation flow.
                return;
            }

            await createProject(name, repos, db);
            if (db) {
                // Ensure project creation follows the same version/branch switch path as manual DB selection.
                await selectDatabase(db);
            }
            await refreshAll();
        } catch (err) {
            void showError(errorMessage(err));
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.selectProject', async (event) => {
        await selectProject(event);
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.delete', async (event) => {
        await deleteProject(event);
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.editSettings', async (event) => {
        await editProjectSettings(event);
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.manageTickets', async (event) => {
        await manageProjectTickets(event);
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.openTicket', async (event) => {
        await openProjectTicket(event);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.duplicateProject', async (event) => {
        await duplicateProject(event);
        await refreshAll();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.exportProject', async (event) => {
        await exportProject(event);
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.importProject', async () => {
        await importProject();
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.setup', async () => {
        // Detection first: the clone wizard is the fallback, not the entry point.
        const configured = await runSetup({
            cloneFallback: () => cloneOdooRepositories(path.dirname(readSetupState().provisioningRoot))
        });
        updateConfiguredContext(readSetupState().isConfigured);
        await refreshAll({ reason: 'ui' });

        if (!configured) {
            return;
        }

        // The versions are offered here rather than behind a second command:
        // finishing setup and having nothing to run is not a finished setup.
        const setup = readSetupState();
        const candidates = proposeVersions(
            await collectRepoBranches(),
            setup.sourceRepo ? await listSeriesBranches(setup.sourceRepo) : [],
            versionsService.getVersions().map(version => version.odooVersion)
        );

        const branches = await pickVersionsToBuild(candidates);
        if (!branches || branches.length === 0) {
            return;
        }

        // The first is built in the foreground so work can start; the rest
        // are queued and drained one at a time.
        const [first, ...rest] = branches;
        if (rest.length > 0) {
            const queued = enqueue(readQueue(context), rest.map(branch => ({ branch, name: `Odoo ${branch}` })));
            setQueueSnapshot(queued);
            await writeQueue(context, queued);
        }

        await provisionAndCreateVersion(first, `Odoo ${first}`);
        await refreshAll({ reason: 'ui' });
        void drainProvisionQueue(context, () => void refreshAll({ reason: 'ui' }));
        // Offered alongside the drain, so a long build can be abandoned
        // without waiting it out.
        void offerStop(context, rest.length);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo-debugger.quickProjectSearch', async () => {
        await quickProjectSearch();
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('proj.openProjectWorkspace', async () => {
        await openProjectWorkspace(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('proj.rebuildProjectWorkspace', async () => {
        await rebuildProjectWorkspace(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('proj.quickSwitchProject', async () => {
        await quickSwitchProjectWorkspace(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.detectTickets', async () => {
        await detectProjectTickets();
        await refreshAll({ reason: 'ui' });
    }));
}
