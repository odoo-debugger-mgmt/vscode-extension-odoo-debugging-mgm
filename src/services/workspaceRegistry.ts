/**
 * This window's row in the shared store's workspace registry (design §3), and
 * reading the others'. Discovery only: which workspace runs which version, so
 * it can be opened from another one. Nothing that drives behaviour is read
 * from here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { currentMainStore } from './mainStore';
import { localWorkspaceFilePath } from './launchConfig';
import { boundVersionId } from './workspaceBinding';
import { logger } from './logger';
import type { WorkspaceRow } from './sqliteMainStore';

export type { WorkspaceRow } from './sqliteMainStore';

/** Unseen for this long, a workspace is dropped from the registry. */
export const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

const ID_KEY = 'odt.workspaceId';

/**
 * What reopens this window: its saved workspace file, or its folder when it
 * has exactly one. An untitled multi-root window has nothing to reopen it by.
 */
export function reopenPath(
    workspaceFile: { scheme: string; fsPath: string } | undefined,
    folderPaths: readonly string[]
): string | undefined {
    const file = localWorkspaceFilePath(workspaceFile);
    if (file) {
        return file;
    }
    return !workspaceFile && folderPaths.length === 1 ? folderPaths[0] : undefined;
}

/** Rows to drop: unseen for 90 days, or whose workspace no longer exists. */
export function staleWorkspaces(
    rows: WorkspaceRow[],
    now: number,
    exists: (row: WorkspaceRow) => boolean,
    keepId?: string
): string[] {
    return rows
        .filter(row => row.id !== keepId && (now - row.lastSeen > STALE_AFTER_MS || !exists(row)))
        .map(row => row.id);
}

// ---------------------------------------------------------------------------
// vscode-backed
// ---------------------------------------------------------------------------

let memento: vscode.Memento | undefined;
let cached: WorkspaceRow[] = [];

export function initializeRegistry(workspaceState: vscode.Memento): void {
    memento = workspaceState;
}

/** This workspace's stable id in the registry, created on first use. */
export function thisWorkspaceId(): string | undefined {
    if (!memento) {
        return undefined;
    }
    let id = memento.get<string>(ID_KEY);
    if (!id) {
        id = randomUUID();
        void memento.update(ID_KEY, id);
    }
    return id;
}

function fileExists(uri: string): boolean {
    try {
        const parsed = vscode.Uri.parse(uri);
        return parsed.scheme !== 'file' || fs.existsSync(parsed.fsPath);
    } catch {
        return false;
    }
}

/**
 * Records this window in the shared store's registry - on open, and when its
 * binding changes - and drops rows gone stale. A workspace on its own file,
 * or an untitled window, records nothing.
 */
export async function registerThisWorkspace(): Promise<void> {
    const store = currentMainStore();
    const id = thisWorkspaceId();
    const where = reopenPath(
        vscode.workspace.workspaceFile,
        (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)
    );
    if (!store?.recordWorkspace || !store.listWorkspaces || !id || !where) {
        return;
    }
    try {
        await store.recordWorkspace({
            id,
            name: vscode.workspace.name ?? path.basename(where),
            uri: vscode.Uri.file(where).toString(),
            versionId: boundVersionId(),
            lastSeen: Date.now()
        });
        const rows = await store.listWorkspaces();
        const stale = staleWorkspaces(rows, Date.now(), row => fileExists(row.uri), id);
        await store.forgetWorkspaces?.(stale);
        cached = rows.filter(row => !stale.includes(row.id));
    } catch (error) {
        logger.debug('[registry] could not record this workspace:', error);
    }
}

/** Re-reads the registry into the cache the views read synchronously. */
export async function refreshRegistry(): Promise<WorkspaceRow[]> {
    try {
        cached = (await currentMainStore()?.listWorkspaces?.()) ?? [];
    } catch (error) {
        logger.debug('[registry] could not read the registry:', error);
    }
    return cached;
}

/** Other workspaces bound to `versionId`, as last read. */
export function otherWorkspacesFor(versionId: string): WorkspaceRow[] {
    const own = thisWorkspaceId();
    return cached.filter(row => row.versionId === versionId && row.id !== own);
}
