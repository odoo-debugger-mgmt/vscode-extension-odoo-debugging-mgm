/**
 * The real CopyBackend, ReleaseHost and dialogs: psql, the file system, this
 * window's debug sessions. Kept apart so databaseCopy.ts and
 * connectionRelease.ts stay testable as data.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CopyBackend } from './databaseCopy';
import { dirExists, linkTree, removeTree, renameDir } from './filestore';
import { filestoreRootOf, resolveOdooDataDir } from './odooDataDir';
import { releaseDatabase, runSql } from './postgres';
import { runCommand } from './process';
import { ownQueryEnv, OWN_QUERY_APP_NAME } from './database';
import { VIEW_WORKER_APP_NAME } from './views/viewWorkerArgs';
import { CONNECTIONS_SQL, DbConnection, describeConnection, parseConnections, releaseForCopy, ReleaseHost, ReleaseUi } from './connectionRelease';
import { getRunningInstances, invalidateRunningState } from './runningState';
import { getSessionByName } from './debugSessions';
import { VersionsService } from '../versionsService';
import { runDirectory, startServerForVersion } from '../debugger';
import { logger, errorMessage } from './logger';
import { showModalWarning, showWarning } from './notifications';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function psqlWithDb(db: string, sql: string, extra: string[] = []): Promise<string> {
    const { stdout } = await runCommand('psql', [
        '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-v', `db=${db}`, ...extra, '-d', 'postgres', '-tA'
    ], { env: ownQueryEnv(), input: sql });
    return stdout;
}

const END_OWN_SQL = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE datname = :'db' AND pid <> pg_backend_pid()
  AND application_name IN ('${OWN_QUERY_APP_NAME}', '${VIEW_WORKER_APP_NAME}');
`;

// Only the pids the user saw and agreed to; a newcomer is not among them.
const END_PIDS_SQL = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE datname = :'db' AND pid = ANY(string_to_array(:'pids', ',')::int[]);
`;

export function realCopyBackend(): CopyBackend {
    return {
        sql: statement => runSql('postgres', statement),
        freeOwnConnections: async db => { await psqlWithDb(db, END_OWN_SQL); },
        files: { exists: dirExists, linkTree: (src, dst) => linkTree(src, dst), rename: renameDir, remove: removeTree },
        log: message => logger.info(message),
        sleep
    };
}

export function realReleaseHost(): ReleaseHost {
    return {
        letGo: db => releaseDatabase(db),
        ownRun: async db => {
            invalidateRunningState();
            const instance = (await getRunningInstances())
                .find(entry => entry.origin === 'managed' && entry.dbName === db && entry.debuggerName && entry.versionId);
            if (!instance?.debuggerName || !instance.versionId) {
                return undefined;
            }
            const session = getSessionByName(instance.debuggerName);
            return { versionId: instance.versionId, debuggerName: instance.debuggerName, noDebug: session?.configuration?.noDebug === true };
        },
        stop: async run => {
            const session = getSessionByName(run.debuggerName);
            if (!session) {
                return;
            }
            await vscode.debug.stopDebugging(session);
            for (let i = 0; i < 120 && getSessionByName(run.debuggerName) === session; i++) {
                await sleep(250);
            }
            if (getSessionByName(run.debuggerName) === session) {
                throw new Error(`"${run.debuggerName}" did not stop within 30 seconds.`);
            }
        },
        start: async run => {
            const result = await startServerForVersion(run.versionId, { noDebug: run.noDebug, quiet: true });
            if (!result.ok) {
                throw new Error(result.message ?? `Could not start "${run.debuggerName}".`);
            }
        },
        connections: async db => parseConnections(await psqlWithDb(db, CONNECTIONS_SQL, ['-F', '\x1f'])),
        endOwnQueries: async db => { await psqlWithDb(db, END_OWN_SQL); },
        end: async (db, pids) => { await psqlWithDb(db, END_PIDS_SQL, ['-v', `pids=${pids.join(',')}`]); },
        sleep
    };
}

/** `purpose` finishes "Stop it to …?": "take the checkpoint", "restore it", "copy it". */
export function dialogReleaseUi(purpose: string): ReleaseUi {
    return {
        confirmStop: async db => (await showModalWarning(
            `"${db}" is running in this window. Stop it to ${purpose}? It restarts afterwards.`,
            'Stop and Continue'
        )) === 'Stop and Continue',
        confirmEnd: async (db, connections: DbConnection[]) => (await showModalWarning(
            `"${db}" has ${connections.length === 1 ? 'another connection' : `${connections.length} other connections`}: `
            + `${connections.map(describeConnection).join(', ')}. End ${connections.length === 1 ? 'it' : 'them'} to continue?`,
            'End Them'
        )) === 'End Them'
    };
}

/** `<data dir>/filestore` for a version's server (the active version's when none is given). */
export function filestoreRootFor(versionId?: string): string {
    const service = VersionsService.getInstance();
    const version = (versionId ? service.getVersion(versionId) : undefined) ?? service.getActiveVersion();
    const settings = version?.settings;
    // Not getWorkspacePath(): it toasts when no folder is open.
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const cwd = runDirectory(workspace);
    const dataDir = resolveOdooDataDir({
        extraParams: settings?.extraParams ?? '',
        env: process.env,
        platform: process.platform,
        home: os.homedir(),
        cwd,
        odooPath: path.resolve(cwd, settings?.odooPath ?? './odoo'),
        readText: file => {
            try {
                return fs.readFileSync(file, 'utf8');
            } catch {
                return undefined;
            }
        }
    });
    return filestoreRootOf(dataDir);
}

/**
 * Runs `work` with `db` released, then restarts what was stopped - even when
 * `work` fails. `{ done: false }` means the user said no.
 */
export async function withReleased<T>(db: string, purpose: string, work: () => Promise<T>): Promise<{ done: true; value: T } | { done: false }> {
    const release = await releaseForCopy(db, realReleaseHost(), dialogReleaseUi(purpose));
    if (!release) {
        return { done: false };
    }
    try {
        return { done: true, value: await work() };
    } finally {
        try {
            await release.restart();
        } catch (error) {
            void showWarning(`The server for "${db}" did not restart: ${errorMessage(error)}`);
        } finally {
            invalidateRunningState();
        }
    }
}
