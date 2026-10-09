import * as vscode from 'vscode';
import type { ProjectTreeProvider } from '../project';
import type { RepoTreeProvider } from '../repos';
import type { DbsTreeProvider } from '../views/dbsView';
import type { ModuleTreeProvider } from '../module';
import type { TestingTreeProvider } from '../testing';
import type { UpgradeTreeProvider } from '../upgrade';
import type { VersionsTreeProvider } from '../versionsTreeProvider';
import type { ProjectReposExplorerProvider } from '../projectReposExplorer';
import type { VersionsService } from '../versionsService';
import type { SortPreferences } from '../sortPreferences';
import type { ViewRenderPanel } from '../views/viewRenderPanel';
import type { ViewDoctorTreeProvider } from '../views/viewDoctorView';
import type { ViewNoteService } from '../services/views/viewNoteService';
import type { ViewService } from '../services/views/viewService';
import type { XpathDiagnostics } from '../views/xpathDiagnostics';
import { registerViewCommands } from './viewCommands';
import { registerProjectCommands } from './projectCommands';
import { registerRepoCommands } from './repoCommands';
import { registerDbCommands } from './dbCommands';
import { registerCheckpointCommands } from './checkpointCommands';
import { registerAlongsideCommands } from './alongsideCommands';
import { registerPartnerCommands } from './partnerCommands';
import { registerCompareCommands } from './compareCommands';
import { registerModuleCommands } from './moduleCommands';
import { registerTestingCommands } from './testingCommands';
import { registerVersionCommands } from './versionCommands';
import { registerDebugCommands } from './debugCommands';
import { registerReposExplorerCommands } from './reposExplorerCommands';
import { registerEditorCommands } from './editorCommands';
import { registerHelpCommands } from './helpCommands';
import { registerUpgradeCommand } from './upgradeCommand';
import { registerCustomAddonsCommand } from './customAddonsCommand';
import { registerDataStoreCommands } from './dataStoreCommands';
import { registerRepoLocationCommand } from './repoLocationCommand';
import { registerBindingCommand } from './bindingCommand';
import { registerUpgradeSideCommands } from './upgradeSideCommands';
import { registerViewDoctorCommands } from './viewDoctorCommands';
import { registerDownloadSourcesCommand } from './downloadSourcesCommand';

export type RefreshReason = 'ui' | 'debugger' | 'all';

export interface Providers {
    project: ProjectTreeProvider;
    repo: RepoTreeProvider;
    db: DbsTreeProvider;
    module: ModuleTreeProvider;
    testing: TestingTreeProvider;
    upgrade: UpgradeTreeProvider;
    versions: VersionsTreeProvider;
    projectReposExplorer: ProjectReposExplorerProvider;
    views: ViewDoctorTreeProvider;
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
    /** Arch reads/writes and activation for the View Doctor. */
    viewService: ViewService;
    /** Each database's note of disabled views and the journal of changes made here. */
    viewNotes: ViewNoteService;
    /** Odoo's reasons saved views stay off, on their arch files. */
    viewDiagnostics: vscode.DiagnosticCollection;
    /** The XPath check's results on arch files, and their quick fixes. */
    xpathDiagnostics: XpathDiagnostics;
    /** The render tab, reused by every Render. */
    viewRender: ViewRenderPanel;
    /** TreeView handle for the Modules view (needed for reveal + multi-select). */
    moduleTreeView: vscode.TreeView<vscode.TreeItem>;
    /** TreeView handle for the Databases view (reveal keeps its highlight honest). */
    dbTreeView: vscode.TreeView<vscode.TreeItem>;
    refreshAll(options?: { reason?: RefreshReason; debounceMs?: number }): Promise<void>;
}

/** Registers every command the extension contributes. */
export function registerAllCommands(deps: CommandDeps): void {
    registerViewCommands(deps);
    registerProjectCommands(deps);
    registerRepoCommands(deps);
    registerDbCommands(deps);
    registerCheckpointCommands(deps);
    registerAlongsideCommands(deps);
    registerPartnerCommands(deps);
    registerCompareCommands(deps);
    registerModuleCommands(deps);
    registerTestingCommands(deps);
    registerVersionCommands(deps);
    registerDebugCommands(deps);
    registerReposExplorerCommands(deps);
    registerEditorCommands(deps);
    registerHelpCommands(deps);
    registerUpgradeCommand(deps);
    registerCustomAddonsCommand(deps);
    registerDataStoreCommands(deps);
    registerRepoLocationCommand(deps);
    registerBindingCommand(deps);
    registerUpgradeSideCommands(deps);
    registerViewDoctorCommands(deps);
    registerDownloadSourcesCommand(deps);
}
