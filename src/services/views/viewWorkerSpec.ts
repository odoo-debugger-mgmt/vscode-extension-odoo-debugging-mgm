/**
 * How the View Doctor's shell is launched for a database: that database's
 * own version - its python, odoo-bin, addons path and extraParams - so a 17.0
 * database is read by 17.0 code even while 19.0 is the active version.
 */
import { SettingsStore } from '../../settingsStore';
import { SettingsModel } from '../../models/settings';
import type { DatabaseModel } from '../../models/db';
import { collectAddonsPaths, runDirectory } from '../../debugger';
import { getWorkspacePath, normalizePath, resolveOptionalPath } from '../../utils';
import { isVersionProvisioned } from '../provisioning';
import { versionOfDatabase } from '../versionRepos';
import { buildViewWorkerArgs, viewWorkerEnv } from './viewWorkerArgs';
import { workerBootstrap, type WorkerSpawnSpec } from './viewWorker';

export interface WorkerAvailabilityInput {
    dbName: string;
    inProject: boolean;
    versionName?: string;
    provisioned: boolean;
}

/** Why no shell can be started for this database, or undefined when one can. */
export function viewWorkerUnavailableReason(input: WorkerAvailabilityInput): string | undefined {
    if (!input.inProject) {
        return `"${input.dbName}" is not a database of the selected project.`;
    }
    if (!input.versionName) {
        return `"${input.dbName}" has no version to run its code.`;
    }
    if (!input.provisioned) {
        return `"${input.versionName}" has no environment to run.`;
    }
    return undefined;
}

export async function resolveViewWorkerSpec(dbName: string, scriptPath: string): Promise<WorkerSpawnSpec> {
    const result = await SettingsStore.peekSelectedProject();
    const db = (result?.project.dbs as DatabaseModel[] | undefined)?.find(entry => entry.id === dbName);
    const version = db ? versionOfDatabase(db) : undefined;
    const settings = version ? new SettingsModel(version.settings) : undefined;

    const reason = viewWorkerUnavailableReason({
        dbName,
        inProject: !!db,
        versionName: version?.name,
        provisioned: !!settings && isVersionProvisioned(resolveOptionalPath(settings.pythonPath))
    });
    if (reason || !result || !db || !version || !settings) {
        throw new Error(reason ?? `Cannot start an Odoo shell for "${dbName}".`);
    }

    const addonsPaths = await collectAddonsPaths(result.project, settings, db, version.id);
    const workspacePath = getWorkspacePath();
    return {
        command: normalizePath(settings.pythonPath),
        args: buildViewWorkerArgs({
            odooBinPath: `${normalizePath(settings.odooPath)}/odoo-bin`,
            addonsPaths,
            dbName,
            extraParams: settings.extraParams
        }),
        cwd: workspacePath ? runDirectory(workspacePath) : undefined,
        env: viewWorkerEnv(process.env),
        bootstrap: workerBootstrap(scriptPath)
    };
}
