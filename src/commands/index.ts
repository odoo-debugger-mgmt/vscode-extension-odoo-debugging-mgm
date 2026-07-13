import * as vscode from 'vscode';
import type { ProjectTreeProvider } from '../project';
import type { RepoTreeProvider } from '../repos';
import type { DbsTreeProvider } from '../views/dbsView';
import type { ModuleTreeProvider } from '../module';
import type { TestingTreeProvider } from '../testing';
import type { VersionsTreeProvider } from '../versionsTreeProvider';
import type { ProjectReposExplorerProvider } from '../projectReposExplorer';
import type { VersionsService } from '../versionsService';
import type { SortPreferences } from '../sortPreferences';
import { registerViewCommands } from './viewCommands';
import { registerProjectCommands } from './projectCommands';
import { registerRepoCommands } from './repoCommands';
import { registerDbCommands } from './dbCommands';
import { registerModuleCommands } from './moduleCommands';
import { registerTestingCommands } from './testingCommands';
import { registerVersionCommands } from './versionCommands';
import { registerDebugCommands } from './debugCommands';
import { registerReposExplorerCommands } from './reposExplorerCommands';
import { registerEditorCommands } from './editorCommands';

export type RefreshReason = 'ui' | 'debugger' | 'all';

export interface Providers {
    project: ProjectTreeProvider;
    repo: RepoTreeProvider;
    db: DbsTreeProvider;
    module: ModuleTreeProvider;
    testing: TestingTreeProvider;
    versions: VersionsTreeProvider;
    projectReposExplorer: ProjectReposExplorerProvider;
}

/**
 * Everything command handlers need from the extension entry point. Plain
 * object, no DI framework: activate() builds it once and hands it to
 * registerAllCommands.
 */
export interface CommandDeps {
    context: vscode.ExtensionContext;
    providers: Providers;
    versionsService: VersionsService;
    sortPreferences: SortPreferences;
    /** TreeView handle for the Modules view (needed for reveal + multi-select). */
    moduleTreeView: vscode.TreeView<vscode.TreeItem>;
    refreshAll(options?: { reason?: RefreshReason; debounceMs?: number }): Promise<void>;
}

/** Registers every command the extension contributes. */
export function registerAllCommands(deps: CommandDeps): void {
    registerViewCommands(deps);
    registerProjectCommands(deps);
    registerRepoCommands(deps);
    registerDbCommands(deps);
    registerModuleCommands(deps);
    registerTestingCommands(deps);
    registerVersionCommands(deps);
    registerDebugCommands(deps);
    registerReposExplorerCommands(deps);
    registerEditorCommands(deps);
}
