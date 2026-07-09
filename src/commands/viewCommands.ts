import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { quickSearchTreeItems, getTreeItemLabel } from './quickSearch';
import { getSortOptions, getDefaultSortOption, SortableViewId } from '../sortOptions';
import { showInfo } from '../services/notifications';
import { setModuleToInstall, setModuleToUpgrade, clearModuleState } from '../module';
import { revealProjectRepo } from '../projectRepos';

/**
 * Generic per-view plumbing: refresh, sort, and quick-search commands.
 */
export function registerViewCommands(deps: CommandDeps): void {
    const { context, providers, sortPreferences, refreshAll } = deps;

    const registerViewSortCommand = (viewId: SortableViewId, provider: { refresh(): void }) => {
        const options = getSortOptions(viewId);
        type SortPickItem = vscode.QuickPickItem & { optionId: string };
        context.subscriptions.push(vscode.commands.registerCommand(`${viewId}.sort`, async () => {
            const current = sortPreferences.get(viewId, getDefaultSortOption(viewId));
            const picks: SortPickItem[] = options.map(option => ({
                label: `${option.id === current ? '$(check) ' : ''}${option.label}`,
                description: option.description,
                optionId: option.id
            }));
            const selection = await vscode.window.showQuickPick(picks, {
                placeHolder: 'Select sort order',
                ignoreFocusOut: true
            });
            if (!selection || selection.optionId === current) {
                return;
            }
            await sortPreferences.set(viewId, selection.optionId);
            provider.refresh();
        }));
    };

    registerViewSortCommand('projectSelector', providers.project);
    registerViewSortCommand('repoSelector', providers.repo);
    registerViewSortCommand('dbSelector', providers.db);
    registerViewSortCommand('moduleSelector', providers.module);
    registerViewSortCommand('versionsManager', providers.versions);
    registerViewSortCommand('projectRepos', providers.projectRepos);

    context.subscriptions.push(vscode.commands.registerCommand('projectSelector.refresh', async () => refreshAll({ reason: 'ui' })));
    context.subscriptions.push(vscode.commands.registerCommand('repoSelector.refresh', async () => refreshAll({ reason: 'ui' })));
    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.refresh', async () => refreshAll({ reason: 'ui' })));
    context.subscriptions.push(vscode.commands.registerCommand('testingSelector.refresh', async () => refreshAll({ reason: 'ui' })));
    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.refresh', async () => refreshAll({ reason: 'ui' })));

    context.subscriptions.push(vscode.commands.registerCommand('repoSelector.quickSearch', async () => {
        const items = ((await providers.repo.getChildren()) ?? [])
            .filter(item => !!item.command && getTreeItemLabel(item).trim().length > 0);

        await quickSearchTreeItems(items, {
            placeHolder: 'Search repositories...',
            title: 'Repository Search',
            emptyMessage: 'No repositories available to search.'
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dbSelector.quickSearch', async () => {
        const items = ((await providers.db.getChildren()) ?? [])
            .filter(item => item.contextValue === 'database' && !!item.command);

        await quickSearchTreeItems(items, {
            placeHolder: 'Search databases...',
            title: 'Database Search',
            emptyMessage: 'No databases available to search.'
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('moduleSelector.quickSearch', async () => {
        const items = ((await providers.module.getChildren()) ?? [])
            .filter(item => item.contextValue === 'module' && !!item.command);

        await quickSearchTreeItems(items, {
            placeHolder: 'Search modules...',
            title: 'Module Search',
            emptyMessage: 'No searchable modules found for the selected database.',
            onPick: async (item) => {
                const moduleData = (item as vscode.TreeItem & { moduleData?: { name?: string } }).moduleData
                    ?? item.command?.arguments?.[0];
                if (!moduleData?.name) {
                    showInfo('Unable to read module details for this selection.');
                    return;
                }

                const stateSelection = await vscode.window.showQuickPick([
                    { label: 'Set to Install', description: moduleData.name, action: 'install' as const },
                    { label: 'Set to Upgrade', description: moduleData.name, action: 'upgrade' as const },
                    { label: 'Clear State', description: moduleData.name, action: 'none' as const }
                ], {
                    placeHolder: `Set state for module "${moduleData.name}"`,
                    ignoreFocusOut: true
                });

                if (!stateSelection) {
                    return;
                }

                if (stateSelection.action === 'install') {
                    await setModuleToInstall(moduleData);
                } else if (stateSelection.action === 'upgrade') {
                    await setModuleToUpgrade(moduleData);
                } else {
                    await clearModuleState(moduleData);
                }

                await refreshAll({ reason: 'ui' });
            }
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('versionsManager.quickSearch', async () => {
        const items = ((await providers.versions.getChildren()) ?? [])
            .filter(item => {
                const contextValue = item.contextValue;
                return (contextValue === 'version' || contextValue === 'activeVersion') && !!item.command;
            })
            .map(item => providers.versions.getTreeItem(item));

        await quickSearchTreeItems(items, {
            placeHolder: 'Search versions...',
            title: 'Version Search',
            emptyMessage: 'No versions available to search.'
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('projectRepos.quickSearch', async () => {
        const rootItems = ((await providers.projectRepos.getChildren()) ?? [])
            .filter(item => item?.metadata?.kind === 'repo');

        await quickSearchTreeItems(rootItems, {
            placeHolder: 'Search project repositories...',
            title: 'Project Repo Search',
            emptyMessage: 'No project repositories available to search.',
            onPick: async (item) => {
                const repo = (item as { metadata?: { repo?: { path?: string } } })?.metadata?.repo;
                if (!repo?.path) {
                    showInfo('Select a repository to reveal.');
                    return;
                }
                await revealProjectRepo(repo as { path: string });
            }
        });
    }));
}
