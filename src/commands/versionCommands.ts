/**
 * Command handlers for the Versions view and version settings.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import type { CommandDeps } from './index';
import { extractVersionId, extractVersionSettingRef } from './args';
import { getSettingDisplayName, resolveOptionalPath } from '../utils';
import { isDerivedSetting } from '../services/versionIdentity';
import { showError, showInfo, showWarning, showModalWarning } from '../services/notifications';
import { errorMessage, logger } from '../services/logger';
import { pickOdooBranch } from './branchPick';
import { invalidateModuleDiscoveryCache, invalidateRepositoryDiscoveryCache } from '../services/runtimeCache';
import { alignEnvironment } from '../services/environment';
import { provisionAndCreateVersion, provisionExistingVersion } from '../odooInstaller';
import { removeWorktree, removeManagedBranch, resolveSourceRepo } from '../services/worktree';
import { buildServerUrl, waitForPort } from '../services/server';
import { resolveDbForVersion } from '../services/dbResolution';
import { SettingsStore } from '../settingsStore';
import { readSetupState } from '../services/setupState';
import { diagnoseVersion, needsAttention } from '../services/versionMigration';

export function registerVersionCommands(deps: CommandDeps): void {
    const { context, versionsService, refreshAll } = deps;

    context.subscriptions.push(vscode.commands.registerCommand('odoo.checkVersions', async () => {
        try {
            const setup = readSetupState();
            const diagnoses = versionsService.getVersions().map(version => diagnoseVersion(
                {
                    id: version.id,
                    name: version.name,
                    odooVersion: version.odooVersion,
                    odooPath: resolveOptionalPath(version.settings.odooPath),
                    pythonPath: resolveOptionalPath(version.settings.pythonPath)
                },
                setup.provisioningRoot,
                candidate => fs.existsSync(candidate),
                setup.sourceRepo
            ));

            const problems = needsAttention(diagnoses);
            if (problems.length === 0) {
                void showInfo(`All ${diagnoses.length} version(s) are provisioned and in the expected location.`);
                return;
            }

            const picked = await vscode.window.showQuickPick(
                problems.map(entry => ({
                    label: `$(warning) ${entry.name}`,
                    description: entry.health,
                    detail: entry.detail,
                    diagnosis: entry
                })),
                { title: 'Version environments', placeHolder: 'Pick a version to re-provision', ignoreFocusOut: true }
            );
            if (!picked) {
                return;
            }

            // Re-provisioning is the existing, resumable flow: it probes what
            // exists and builds only what is missing.
            await provisionExistingVersion(picked.diagnosis.versionId);
            await refreshAll();
        } catch (error) {
            void showError(`Could not check the version environments: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.openVersionInBrowser', async (versionIdOrTreeItem?: unknown) => {
        try {
            let versionId = extractVersionId(versionIdOrTreeItem);
            if (!versionId) {
                const picked = await vscode.window.showQuickPick(
                    versionsService.getVersions().map(version => ({
                        label: version.name,
                        description: version.settings.portNumber ? `:${version.settings.portNumber}` : version.odooVersion,
                        versionId: version.id
                    })),
                    { title: 'Open which version in the browser?', placeHolder: 'Select a version' }
                );
                if (!picked) { return; }
                versionId = picked.versionId;
            }

            const version = versionsService.getVersion(versionId);
            if (!version) {
                void showError('The selected version could not be found.');
                return;
            }

            const port = Number(version.settings.portNumber);
            if (!Number.isInteger(port) || port <= 0) {
                void showError(`"${version.name}" has no server port.`);
                return;
            }

            // The database this version runs, not the project's selection:
            // with several versions up they are usually different.
            const result = await SettingsStore.getSelectedProject();
            const db = result
                ? resolveDbForVersion(result.project.dbs, result.project.selectedDbByVersion, version.id)
                : undefined;
            const url = buildServerUrl(port, db?.id);

            if (await waitForPort(port, 400)) {
                await vscode.env.openExternal(url);
                return;
            }
            const choice = await showWarning(
                `No Odoo server is answering on port ${port} for "${version.name}".`,
                'Open Anyway'
            );
            if (choice === 'Open Anyway') {
                await vscode.env.openExternal(url);
            }
        } catch (error) {
            void showError(`Failed to open the server in the browser: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.createVersion', async () => {
        try {
            // Two prompts: branch, then name. Paths and ports come from the
            // odooDebugger.defaultVersion.* settings and stay editable in the
            // Versions tree after creation.
            //
            // The branch list comes from the source repository, not the active
            // version's worktree: on a first run there is no active version,
            // and the picker would fall back to a free-text box seconds after
            // setup configured a repository full of branches.
            const odooVersion = await pickOdooBranch(readSetupState().sourceRepo, 'Create Version');
            if (!odooVersion) { return; }

            const name = (await vscode.window.showInputBox({
                title: 'Create Version',
                prompt: 'Version name',
                value: `Odoo ${odooVersion}`,
                ignoreFocusOut: true,
                validateInput: value => value.trim() ? undefined : 'Name is required.'
            }))?.trim();
            if (!name) { return; }

            // Provisioning gives the version its own worktree, interpreter and
            // virtualenv; the flow offers a profile-only path for anyone who
            // already has an environment set up by hand.
            const version = await provisionAndCreateVersion(odooVersion, name);
            if (!version) { return; }
            await refreshAll({ reason: 'ui' });

            const action = await showInfo(
                `Version "${name}" created on branch "${odooVersion}".`,
                'Activate Now'
            );

            if (action === 'Activate Now') {
                await vscode.commands.executeCommand('odoo.setActiveVersion', version.id);
            }
        } catch (error) {
            void showError(`Failed to create version: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.openVersionDefaults', async () => {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:AhmadMansour.odoo-devtools-vscode odooDebugger.defaultVersion');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.changeBranch', async (versionIdOrTreeItem?: unknown) => {
        try {
            const versionId = extractVersionId(versionIdOrTreeItem);
            if (!versionId) {
                void showError('Select a version before continuing.');
                return;
            }

            const version = versionsService.getVersion(versionId);
            if (!version) {
                void showError('The selected version could not be found.');
                return;
            }

            // Get Odoo path from the specific version being edited
            const odooPath = version.settings.odooPath;

            let newBranch: string | undefined;

            if (odooPath) {
                newBranch = await pickOdooBranch(
                    odooPath,
                    `Change branch for "${version.name}" (current: ${version.odooVersion})`
                );
            } else {
                // No Odoo path configured: manual entry is the only option.
                const result = await showWarning(
                    'Odoo path is not configured. Please set the Odoo path in settings first, or enter the branch manually.',
                    'Enter Manually', 'Cancel'
                );

                if (result === 'Enter Manually') {
                    newBranch = await vscode.window.showInputBox({
                        placeHolder: version.odooVersion,
                        prompt: 'Enter new Odoo version/branch',
                        value: version.odooVersion
                    });
                }
            }

            if (!newBranch || newBranch === version.odooVersion) {
                return; // No change or cancelled
            }

            await versionsService.updateVersion(versionId, { odooVersion: newBranch });
            void showInfo(`Branch changed from "${version.odooVersion}" to "${newBranch}" for version "${version.name}"`);
        } catch (error) {
            void showError(`Failed to change branch: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.setActiveVersion', async (versionIdOrTreeItem?: unknown) => {
        try {
            let versionId = extractVersionId(versionIdOrTreeItem);
            if (!versionId) {
                // No version provided - show version picker
                const versions = versionsService.getVersions();
                const items = versions.map(v => ({
                    label: v.name,
                    description: v.odooVersion,
                    detail: v.isActive ? '$(check) Currently active' : '',
                    versionId: v.id
                }));

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select version to activate'
                });
                if (!selected) {
                    return;
                }

                versionId = selected.versionId;
            }

            const success = await versionsService.setActiveVersion(versionId);
            if (success) {
                const version = versionsService.getVersion(versionId);
                void showInfo(`Activated version: ${version?.name}`);
                if (version) {
                    // Align the core repos to the version's branch through the
                    // shared switch pipeline (honors databaseSwitchBehavior).
                    await alignEnvironment({ versionId: version.id }, { label: `Version "${version.name}"` });
                }
                await refreshAll(); // Refresh all views to reflect new active version
            } else {
                void showError('Unable to activate the selected version.');
            }
        } catch (error) {
            void showError(`Unable to activate the selected version: ${errorMessage(error)}`);
        }
    }));

    // Helper functions for setting editing
    const editNumberSetting = async (settingKey: string, currentValue: unknown) => {
        const displayValue = currentValue?.toString() || '';
        const newValue = await vscode.window.showInputBox({
            placeHolder: `Enter ${settingKey} (number)`,
            value: displayValue,
            prompt: `Edit ${settingKey}`,
            validateInput: (input) => {
                const num = parseFloat(input);
                if (isNaN(num) || num < 0) {
                    return 'Please enter a valid non-negative number';
                }
                if ((settingKey === 'portNumber' || settingKey === 'shellPortNumber') && (num < 1024 || num > 65535)) {
                    return 'Port number must be between 1024 and 65535';
                }
                return undefined;
            }
        });
        return newValue !== undefined ? parseFloat(newValue) : undefined;
    };

    const editPathSetting = async (settingKey: string, currentValue: unknown) => {
        const pathAction = await vscode.window.showQuickPick([
            { label: 'Enter Path Manually', value: 'manual' },
            { label: 'Browse for Folder', value: 'browse' }
        ], { placeHolder: `How would you like to set ${settingKey}?` });

        if (pathAction?.value === 'manual') {
            return await vscode.window.showInputBox({
                placeHolder: `Enter ${settingKey}`,
                value: currentValue?.toString() || '',
                prompt: `Edit ${settingKey}`
            });
        } else if (pathAction?.value === 'browse') {
            const result = await vscode.window.showOpenDialog({
                canSelectFolders: settingKey !== 'pythonPath',
                canSelectFiles: settingKey === 'pythonPath',
                canSelectMany: false,
                title: `Select ${settingKey}`
            });
            return result?.[0]?.fsPath;
        }
        return undefined;
    };

    const editDevModeSetting = async (currentValue: unknown) => {
        const devModeOption = await vscode.window.showQuickPick([
            { label: 'all', description: 'Enable all development features' },
            { label: 'xml', description: 'Enable XML development features' },
            { label: 'reload', description: 'Enable auto-reload' },
            { label: 'qweb', description: 'Enable QWeb development' },
            { label: 'Custom', description: 'Enter custom development parameters' },
            { label: 'None', description: 'Disable development mode' }
        ], {
            placeHolder: 'Select development mode',
            title: 'Development Mode Settings'
        });

        if (!devModeOption) {
            return undefined;
        }

        if (devModeOption.label === 'Custom') {
            const userInput = await vscode.window.showInputBox({
                placeHolder: 'Enter development mode value (e.g., xml, reload, qweb)',
                value: currentValue?.toString().replace('--dev=', '') || '',
                prompt: 'Development mode value (--dev= will be added automatically)'
            });
            return userInput ? `--dev=${userInput}` : '';
        } else if (devModeOption.label === 'None') {
            return '';
        } else {
            return `--dev=${devModeOption.label}`;
        }
    };

    context.subscriptions.push(vscode.commands.registerCommand('odoo.editVersionSetting', async (versionIdOrTreeItem?: unknown, settingKey?: string, currentValue?: unknown) => {
        try {
            const ref = extractVersionSettingRef(versionIdOrTreeItem, settingKey, currentValue);
            if (!ref) {
                void showError('This command was invoked with invalid parameters.');
                return;
            }
            const { versionId, key, value } = ref;

            if (isDerivedSetting(key)) {
                void showInfo(
                    `"${getSettingDisplayName(key)}" is derived from this version's branch so two versions can run at once. ` +
                    `Change the version's branch to change it.`
                );
                return;
            }

            let newValue: unknown = undefined;

            // Handle different types of settings
            if (['portNumber', 'shellPortNumber', 'limitTimeReal', 'limitTimeCpu', 'maxCronThreads'].includes(key)) {
                newValue = await editNumberSetting(key, value);
            } else if (['odooPath', 'enterprisePath', 'designThemesPath', 'customAddonsPath', 'pythonPath', 'dumpsFolder'].includes(key)) {
                newValue = await editPathSetting(key, value);
            } else if (key === 'devMode') {
                newValue = await editDevModeSetting(value);
            } else {
                // Default string input for other settings
                newValue = await vscode.window.showInputBox({
                    placeHolder: `Enter ${key}`,
                    value: value?.toString() || '',
                    prompt: `Edit ${key}`
                });
            }

            if (newValue === undefined) {
                return; // User cancelled
            }

            await versionsService.updateVersion(versionId, {
                settings: { [key]: newValue }
            } as never);

            if (['customAddonsPath'].includes(key)) {
                invalidateRepositoryDiscoveryCache();
                invalidateModuleDiscoveryCache();
            } else if (['odooPath', 'enterprisePath', 'designThemesPath', 'subModulesPaths'].includes(key)) {
                invalidateModuleDiscoveryCache();
            }

            void showInfo(`Updated ${key} successfully`);
            await refreshAll();
        } catch (error) {
            void showError(`Failed to edit setting: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.cloneVersion', async (versionIdOrTreeItem?: unknown) => {
        try {
            let versionId = extractVersionId(versionIdOrTreeItem);
            if (!versionId) {
                // No version provided - show version picker
                const versions = versionsService.getVersions();
                const items = versions.map(v => ({
                    label: v.name,
                    description: v.odooVersion,
                    versionId: v.id
                }));

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select version to clone'
                });
                if (!selected) {
                    return;
                }

                versionId = selected.versionId;
            }

            const name = await vscode.window.showInputBox({
                placeHolder: 'Enter name for the cloned version',
                prompt: 'Version name'
            });
            if (!name) {
                return;
            }

            const clonedVersion = await versionsService.cloneVersion(versionId, name);
            if (clonedVersion) {
                void showInfo(`Version "${name}" cloned successfully`);
            } else {
                void showError('Failed to clone the selected version.');
            }
        } catch (error) {
            void showError(`Failed to clone the selected version: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.deleteVersion', async (versionIdOrTreeItem?: unknown) => {
        try {
            let versionId = extractVersionId(versionIdOrTreeItem);
            if (!versionId) {
                // No version provided - show version picker
                const versions = versionsService.getVersions();
                const items = versions.filter(v => !v.isActive).map(v => ({
                    label: v.name,
                    description: v.odooVersion,
                    versionId: v.id
                }));

                if (items.length === 0) {
                    void showInfo('There are no versions available to delete (the active version cannot be removed).');
                    return;
                }

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select version to delete'
                });
                if (!selected) {
                    return;
                }

                versionId = selected.versionId;
            }

            const version = versionsService.getVersion(versionId);
            if (!version) {
                void showError('The selected version could not be found.');
                return;
            }

            const confirm = await showModalWarning(
                `Are you sure you want to delete version "${version.name}"?`,
                'Delete'
            );
            if (confirm !== 'Delete') {
                return;
            }

            const managedPaths = version.settings.managedPaths ?? [];
            if (managedPaths.length > 0) {
                const removeChoice = await showModalWarning(
                    `Also delete the ${managedPaths.length} folder(s) this extension created for "${version.name}"?\n\n${managedPaths.join('\n')}`,
                    'Delete Folders',
                    'Keep Folders'
                );
                if (removeChoice === 'Delete Folders') {
                    const sourceRepos = new Set<string>();
                    for (const managedPath of managedPaths) {
                        // Worktrees must go through git so the parent repo's
                        // administrative entry goes with them; anything git
                        // refuses (a venv, a stale directory) is a plain delete.
                        // The source repo has to be resolved before removal,
                        // because afterwards there is nothing left to ask.
                        const sourceRepo = await resolveSourceRepo(managedPath);
                        let removed = false;
                        if (sourceRepo) {
                            removed = await removeWorktree(sourceRepo, managedPath)
                                .then(() => true)
                                .catch(() => false);
                            if (removed) {
                                sourceRepos.add(sourceRepo);
                            }
                        }
                        if (!removed) {
                            try {
                                await fs.promises.rm(managedPath, { recursive: true, force: true });
                            } catch (error) {
                                logger.warn(`Failed to remove ${managedPath}:`, error);
                            }
                        }
                    }
                    // git worktree remove leaves the managed branch behind.
                    for (const sourceRepo of sourceRepos) {
                        await removeManagedBranch(sourceRepo, version.odooVersion);
                    }
                }
            }

            const success = await versionsService.deleteVersion(versionId);
            if (success) {
                void showInfo(`Version "${version.name}" deleted successfully`);
            } else {
                void showError('Failed to delete the selected version.');
            }
        } catch (error) {
            void showError(`Failed to delete the selected version: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.setSettingToDefault', async (settingTreeItem?: unknown) => {
        try {
            const ref = extractVersionSettingRef(settingTreeItem);
            if (!ref) {
                void showError('Select a setting before continuing.');
                return;
            }

            const success = await versionsService.setSettingToDefault(ref.versionId, ref.key);
            if (!success) {
                void showError('Unable to reset this setting to its default value.');
            }
        } catch (error) {
            void showError(`Failed to reset setting to default: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.setSettingAsDefault', async (settingTreeItem?: unknown) => {
        try {
            const ref = extractVersionSettingRef(settingTreeItem);
            if (!ref) {
                void showError('Select a setting before continuing.');
                return;
            }

            const success = await versionsService.setSettingAsDefault(ref.versionId, ref.key);
            if (!success) {
                void showError('Unable to save this setting as the default.');
            }
        } catch (error) {
            void showError(`Unable to save this setting as the default: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.setAllSettingsToDefault', async (versionTreeItem?: unknown) => {
        try {
            const versionId = extractVersionId(versionTreeItem);
            if (!versionId) {
                void showError('Select a version before continuing.');
                return;
            }

            const version = versionsService.getVersion(versionId);
            if (!version) {
                void showError('The selected version could not be found.');
                return;
            }

            const confirm = await showWarning(
                `Are you sure you want to reset ALL settings for version "${version.name}" to their default values?`,
                'Reset All',
                'Cancel'
            );
            if (confirm !== 'Reset All') {
                return;
            }

            const success = await versionsService.setAllSettingsToDefault(versionId);
            if (!success) {
                void showError('Unable to reset all settings to their default values.');
            }
        } catch (error) {
            void showError(`Failed to reset all settings to default: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.setAllSettingsAsDefault', async (versionTreeItem?: unknown) => {
        try {
            const versionId = extractVersionId(versionTreeItem);
            if (!versionId) {
                void showError('Select a version before continuing.');
                return;
            }

            const version = versionsService.getVersion(versionId);
            if (!version) {
                void showError('The selected version could not be found.');
                return;
            }

            const confirm = await showWarning(
                `Are you sure you want to save ALL settings from version "${version.name}" as new default values?`,
                'Save All as Default',
                'Cancel'
            );
            if (confirm !== 'Save All as Default') {
                return;
            }

            const success = await versionsService.setAllSettingsAsDefault(versionId);
            if (!success) {
                void showError('Unable to save these settings as the new defaults.');
            }
        } catch (error) {
            void showError(`Unable to save these settings as the new defaults: ${errorMessage(error)}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.refreshVersions', async () => {
        await versionsService.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('odoo.manageVersions', async () => {
        const actions = [
            'Create New Version',
            'Switch Active Version',
            'Clone Version',
            'Delete Version'
        ];

        const action = await vscode.window.showQuickPick(actions, {
            placeHolder: 'Choose version management action'
        });

        switch (action) {
            case 'Create New Version':
                vscode.commands.executeCommand('odoo.createVersion');
                break;
            case 'Switch Active Version':
                vscode.commands.executeCommand('odoo.setActiveVersion');
                break;
            case 'Clone Version':
                vscode.commands.executeCommand('odoo.cloneVersion');
                break;
            case 'Delete Version':
                vscode.commands.executeCommand('odoo.deleteVersion');
                break;
        }
    }));
}
