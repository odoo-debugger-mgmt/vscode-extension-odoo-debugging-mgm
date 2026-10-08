/**
 * Database checkpoints: protected copies of a database, kept as PostgreSQL
 * databases and restored by swapping them back in (services/databaseCopy.ts).
 */
import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { registerCommand } from './registerCommand';
import { SettingsStore } from '../settingsStore';
import type { DatabaseModel } from '../models/db';
import { extractDatabaseFromEvent } from '../dbs';
import { extractCheckpointFromEvent } from '../views/dbsView';
import { getDatabaseLabel, stripSettings } from '../utils';
import { listPostgresDatabases, releaseDatabase } from '../services/postgres';
import { clearInstalledModuleCache } from '../services/database';
import { invalidateRunningState } from '../services/runningState';
import {
    checkpointComment, checkpointDbName, checkpointsOf, defaultCheckpointLabel, setCheckpoints, CheckpointModel
} from '../services/checkpoints';
import { copyDatabase, discardDatabase, stageRestore, swapInRestored, verifyCheckpoint } from '../services/databaseCopy';
import { filestoreRootFor, realCopyBackend, withReleased } from '../services/copyRuntime';
import { showAutoInfo, showError, showModalWarning } from '../services/notifications';
import { logger, errorMessage } from '../services/logger';

const RESTORE = 'Restore';
const CHECKPOINT_THEN_RESTORE = 'Checkpoint Current State, then Restore';

/** Re-reads the store and applies `change` to the database's record, then saves. */
async function updateCheckpoints(dbId: string, change: (list: CheckpointModel[]) => CheckpointModel[]): Promise<boolean> {
    const result = await SettingsStore.getSelectedProject();
    const target = (result?.project.dbs as DatabaseModel[] | undefined)?.find(entry => entry.id === dbId);
    if (!result || !target) {
        return false;
    }
    setCheckpoints(target, change(checkpointsOf(target)));
    await SettingsStore.saveWithoutComments(stripSettings(result.data));
    return true;
}

async function takenNames(): Promise<Set<string>> {
    return new Set((await listPostgresDatabases()).map(name => name.toLowerCase()));
}

/** Copies `db` into a new protected checkpoint; the caller has released it. */
async function takeCheckpoint(db: DatabaseModel, label: string, root: string): Promise<CheckpointModel> {
    const now = new Date();
    const id = checkpointDbName(db.id, now, await takenNames());
    const copied = await copyDatabase(realCopyBackend(), db.id, id, { filestoreRoot: root, protect: { comment: checkpointComment(db.id) } });
    const checkpoint: CheckpointModel = { id, label, createdAt: now.toISOString(), filestore: copied.filestore, filestoreRoot: root };
    let reason: string | undefined;
    try {
        if (!await updateCheckpoints(db.id, list => [...list, checkpoint])) {
            reason = 'the database is no longer in the selected project';
        }
    } catch (err) {
        reason = errorMessage(err);
    }
    if (reason !== undefined) {
        // No screen would show the copy, and Reconcile only lists checkpoints whose source is gone.
        await discardDatabase(realCopyBackend(), id, root).catch(error => logger.warn(`Could not drop the unrecorded checkpoint ${id}:`, error));
        throw new Error(`The checkpoint of "${db.id}" could not be recorded, so it was not kept: ${reason}`);
    }
    return checkpoint;
}

async function selectedDatabase(): Promise<DatabaseModel | undefined> {
    const result = await SettingsStore.getSelectedProject();
    return (result?.project.dbs as DatabaseModel[] | undefined)?.find(entry => entry.isSelected);
}

export function registerCheckpointCommands(deps: CommandDeps): void {
    const { context, refreshAll } = deps;

    context.subscriptions.push(registerCommand('dbSelector.createCheckpoint', async (event?: unknown) => {
        try {
            const db = extractDatabaseFromEvent(event) ?? await selectedDatabase();
            if (!db) {
                void showError('Select a database to checkpoint.');
                return;
            }
            const entered = await vscode.window.showInputBox({
                prompt: `Label for the checkpoint of "${getDatabaseLabel(db)}"`,
                value: defaultCheckpointLabel(new Date()),
                ignoreFocusOut: true
            });
            if (entered === undefined) {
                return;
            }
            const label = entered.trim() || defaultCheckpointLabel(new Date());
            const root = filestoreRootFor(db.versionId);
            const outcome = await withReleased(db.id, 'take the checkpoint', async () => vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Creating checkpoint "${label}" of ${db.id}`
            }, () => takeCheckpoint(db, label, root)));
            if (outcome.done) {
                showAutoInfo(`Checkpoint "${label}" of "${getDatabaseLabel(db)}" created.`, 3000);
            }
        } catch (err) {
            void showError(`Failed to create the checkpoint: ${errorMessage(err)}`);
            logger.error('Error creating a checkpoint:', err);
        }
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(registerCommand('dbSelector.restoreCheckpoint', async (event: unknown) => {
        const picked = extractCheckpointFromEvent(event);
        if (!picked) {
            void showError('Right-click a checkpoint to restore it.');
            return;
        }
        const { database: db, checkpoint } = picked;
        const dbLabel = getDatabaseLabel(db);
        const choice = await showModalWarning(
            `Restore "${dbLabel}" to "${checkpoint.label}"? Everything since is lost.`,
            RESTORE,
            CHECKPOINT_THEN_RESTORE
        );
        if (choice !== RESTORE && choice !== CHECKPOINT_THEN_RESTORE) {
            return;
        }
        const backend = realCopyBackend();
        // Where it was taken; the live database's folder is swapped under the same root.
        const root = checkpoint.filestoreRoot ?? filestoreRootFor(db.versionId);
        let staged: string | undefined;
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Restoring ${db.id} to "${checkpoint.label}"`
            }, async progress => {
                progress.report({ message: 'Copying the checkpoint...' });
                await verifyCheckpoint(backend, checkpoint.id, db.id, { mustExist: true });
                staged = await stageRestore(backend, db.id, checkpoint.id, root, { expectFilestore: checkpoint.filestore });
                const outcome = await withReleased(db.id, 'restore it', async () => {
                    if (choice === CHECKPOINT_THEN_RESTORE) {
                        progress.report({ message: 'Checkpointing the current state...' });
                        await takeCheckpoint(db, `Before restoring ${checkpoint.label}`, root);
                    }
                    progress.report({ message: 'Swapping it in...' });
                    await swapInRestored(backend, db.id, staged!, root);
                });
                if (outcome.done) {
                    // The View Doctor still holds what it read from the replaced database.
                    await releaseDatabase(db.id);
                    showAutoInfo(`"${dbLabel}" is back to "${checkpoint.label}".`, 3000);
                }
            });
        } catch (err) {
            void showError(`Failed to restore the checkpoint: ${errorMessage(err)}`);
            logger.error('Error restoring a checkpoint:', err);
        } finally {
            // Gone after a successful swap: it was renamed to the database.
            if (staged) {
                await discardDatabase(backend, staged, root).catch(error => logger.warn(`Could not drop ${staged}:`, error));
            }
            clearInstalledModuleCache(db.id);
            invalidateRunningState();
        }
        await refreshAll();
    }));

    context.subscriptions.push(registerCommand('dbSelector.renameCheckpoint', async (event: unknown) => {
        const picked = extractCheckpointFromEvent(event);
        if (!picked) {
            return;
        }
        const entered = await vscode.window.showInputBox({
            prompt: `New label for this checkpoint of "${getDatabaseLabel(picked.database)}"`,
            value: picked.checkpoint.label,
            ignoreFocusOut: true,
            validateInput: value => (value.trim() ? undefined : 'The label cannot be empty')
        });
        const label = entered?.trim();
        if (!label || label === picked.checkpoint.label) {
            return;
        }
        await updateCheckpoints(picked.database.id, list => list.map(cp => cp.id === picked.checkpoint.id ? { ...cp, label } : cp));
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(registerCommand('dbSelector.deleteCheckpoint', async (event: unknown) => {
        const picked = extractCheckpointFromEvent(event);
        if (!picked) {
            return;
        }
        const { database: db, checkpoint } = picked;
        const confirm = await showModalWarning(
            `Delete the checkpoint "${checkpoint.label}" of "${getDatabaseLabel(db)}"? This cannot be undone.`,
            'Delete'
        );
        if (confirm !== 'Delete') {
            return;
        }
        try {
            const backend = realCopyBackend();
            await verifyCheckpoint(backend, checkpoint.id, db.id, { mustExist: false });
            await discardDatabase(backend, checkpoint.id, checkpoint.filestoreRoot ?? filestoreRootFor(db.versionId));
            await updateCheckpoints(db.id, list => list.filter(cp => cp.id !== checkpoint.id));
            showAutoInfo(`Checkpoint "${checkpoint.label}" deleted.`, 2500);
        } catch (err) {
            void showError(`Failed to delete the checkpoint: ${errorMessage(err)}`);
            logger.error('Error deleting a checkpoint:', err);
        }
        await refreshAll({ reason: 'ui' });
    }));
}
