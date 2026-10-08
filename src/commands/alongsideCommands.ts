/**
 * Several servers at once: run a database next to the others, and stop one
 * database's server. See services/alongside.ts.
 */
import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { registerCommand } from './registerCommand';
import { SettingsStore } from '../settingsStore';
import type { DatabaseModel } from '../models/db';
import { extractDatabaseFromEvent } from '../dbs';
import { getDatabaseLabel } from '../utils';
import { runAlongside } from '../debugger';
import { runForDatabase, getSessionByName } from '../services/debugSessions';
import { getRunningInstances, runningDescriptionPart } from '../services/runningState';
import { showInfo } from '../services/notifications';

/** The row's database, or one picked from the project's when run from the palette. */
export async function databaseFor(event: unknown, title: string): Promise<DatabaseModel | undefined> {
    const fromRow = extractDatabaseFromEvent(event);
    if (fromRow) {
        return fromRow;
    }
    const result = await SettingsStore.getSelectedProject();
    const dbs = (result?.project.dbs as DatabaseModel[] | undefined) ?? [];
    if (dbs.length === 0) {
        return undefined;
    }
    const running = new Map((await getRunningInstances()).map(instance => [instance.dbName, instance]));
    const picked = await vscode.window.showQuickPick(
        dbs.map(db => ({ label: getDatabaseLabel(db), description: runningDescriptionPart(running.get(db.id)) ?? '', db })),
        { title, placeHolder: 'Which database?' }
    );
    return picked?.db;
}

export function registerAlongsideCommands(deps: CommandDeps): void {
    const { context, refreshAll } = deps;

    for (const [id, noDebug] of [['dbSelector.runAlongside', false], ['dbSelector.runAlongsideNoDebug', true]] as const) {
        context.subscriptions.push(registerCommand(id, async (event?: unknown) => {
            const db = await databaseFor(event, noDebug ? 'Run Alongside Without Debugging' : 'Run Alongside');
            if (!db) {
                return;
            }
            await runAlongside(db.id, { noDebug });
            await refreshAll({ reason: 'ui', debounceMs: 1500 });
        }));
    }

    context.subscriptions.push(registerCommand('dbSelector.stopServer', async (event?: unknown) => {
        const db = await databaseFor(event, "Stop This Database's Server");
        if (!db) {
            return;
        }
        const run = runForDatabase(db.id);
        const session = run ? getSessionByName(run.name) : undefined;
        if (session) {
            await vscode.debug.stopDebugging(session);
            await refreshAll({ reason: 'ui', debounceMs: 1000 });
            return;
        }
        const external = (await getRunningInstances()).find(instance => instance.dbName === db.id);
        void showInfo(external
            ? `"${getDatabaseLabel(db)}" is running outside this window. Stop it there.`
            : `"${getDatabaseLabel(db)}" is not running.`);
    }));
}
