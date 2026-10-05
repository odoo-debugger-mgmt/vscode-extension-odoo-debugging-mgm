/**
 * Create Upgrade Script and Add to Upgrade Script: build the views, ask where
 * the script goes, write or open it, and say what was left out. Offers to
 * bump the module's manifest when the folder would otherwise never run.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SettingsStore } from '../settingsStore';
import type { ProjectModel } from '../models/project';
import { collectModuleDiscovery } from '../services/psaeInternal';
import { resolveReposForDatabase, versionOfDatabase } from '../services/versionRepos';
import { showBriefStatus, showInfo } from '../services/notifications';
import type { ViewService } from '../services/views/viewService';
import type { ViewNoteService } from '../services/views/viewNoteService';
import { psqlNoteQueries } from '../services/views/viewNoteService';
import { buildScriptViews, nothingToScript, scriptSummary, type ScriptSources } from '../services/views/scriptBuilder';
import { newScript } from '../services/views/upgradeScript';
import { manifestVersion, needsManifestBump, seriesOf, setManifestVersion, writeScriptToFolder } from '../services/views/migrationsFolder';
import { ownerCounts, pickDestination, withoutCoreModules, type ModuleChoice } from './scriptDestination';

export interface ScriptFlowDeps {
    context: vscode.ExtensionContext;
    viewService: ViewService;
    viewNotes: ViewNoteService;
}

type ProjectJson = ProjectModel & { uid?: string; name?: string };

async function scriptModules(project: ProjectJson, dbName: string): Promise<ModuleChoice[]> {
    const db = project.dbs?.find(entry => entry.id === dbName);
    const { modules } = collectModuleDiscovery(project, await resolveReposForDatabase(project, db));
    const settings = versionOfDatabase(db)?.settings;
    return withoutCoreModules(
        modules.map(module => ({ name: module.name, path: module.path, repoName: module.repoName })),
        [settings?.odooPath ?? '', settings?.enterprisePath ?? '']
    );
}

export async function createUpgradeScript(deps: ScriptFlowDeps, dbName: string, viewId?: number): Promise<void> {
    const sources: ScriptSources = {
        prepare: async db => {
            const groups = await deps.viewService.doctorGroups(db);
            return { note: await deps.viewNotes.read(db), reEnabled: groups.upgradeDisabled.filter(view => view.active) };
        },
        rows: (db, ids) => deps.viewService.rows(db, ids),
        fingerprints: (db, ids) => psqlNoteQueries.fingerprints(db, ids),
        arch: (db, id) => deps.viewService.getArch(db, id)
    };
    const build = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Building the upgrade script…' },
        () => buildScriptViews(sources, dbName, viewId)
    );
    if (build.views.length === 0) {
        void showInfo(nothingToScript(build, dbName));
        return;
    }

    const project = (await SettingsStore.peekSelectedProject().catch(() => null))?.project as ProjectJson | undefined;
    const modules = project ? await scriptModules(project, dbName) : [];
    const db = project?.dbs?.find(entry => entry.id === dbName);
    const series = seriesOf(versionOfDatabase(db)?.odooVersion);
    const destination = await pickDestination({
        modules,
        owners: ownerCounts(build.views),
        total: build.views.length,
        memento: deps.context.workspaceState,
        projectKey: project?.uid ?? project?.name ?? 'default',
        title: viewId === undefined ? 'Create Upgrade Script' : 'Add to Upgrade Script',
        series
    });
    if (!destination) {
        return;
    }

    if (destination.kind === 'untitled') {
        const document = await vscode.workspace.openTextDocument({ language: 'python', content: newScript(build.views) });
        await vscode.window.showTextDocument(document);
        void showInfo(scriptSummary(build, 'Untitled script'));
        return;
    }

    const { module, version } = destination;
    const written = await writeScriptToFolder(path.join(module.path, 'migrations', version), build.views);
    await vscode.window.showTextDocument(vscode.Uri.file(written.path));
    const where = `${written.merged ? 'Added to' : 'Wrote'} ${module.name}/${path.relative(module.path, written.path).split(path.sep).join('/')}`;
    const manifestPath = path.join(module.path, '__manifest__.py');
    const manifestText = await fs.readFile(manifestPath, 'utf-8').catch(() => undefined);
    if (manifestText === undefined || !needsManifestBump(version, manifestVersion(manifestText), series)) {
        void showInfo(scriptSummary(build, where));
        return;
    }
    const choice = await showInfo(`${scriptSummary(build, where)} Odoo runs migrations/${version}/ only once ${module.name}'s version is ${version} or higher.`, 'Set Version');
    if (choice === 'Set Version') {
        // Read again: the manifest may have changed while the message was open.
        const current = await fs.readFile(manifestPath, 'utf-8');
        await fs.writeFile(manifestPath, setManifestVersion(current, version));
        showBriefStatus(`${module.name} is now version ${version}.`);
    }
}
