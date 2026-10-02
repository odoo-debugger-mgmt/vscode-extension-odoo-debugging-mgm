/**
 * Views as files: odoo-view:/<db>/<id>/<xmlid>.xml. VS Code's own editor
 * is the arch editor - XML highlighting, search, multi-cursor - and saving
 * writes through the database's Odoo shell.
 *
 * mtime is the view's write_date, so a view edited in Odoo's UI after it was
 * opened makes VS Code's save report a newer file. Size carries the
 * write_date too, not the arch's length: before saving, VS Code reports a
 * newer file only when the mtime advanced *and* the size differs from the one
 * it last saw (it pairs the new size with the old mtime), so a size that never
 * changes would let a save silently overwrite an edit made in Odoo.
 */
import * as vscode from 'vscode';
import type { SaveResult, ViewBackend } from '../services/views/viewService';

export const VIEW_SCHEME = 'odoo-view';

export interface ViewRef {
    dbName: string;
    viewId: number;
}

export interface ViewFileHooks {
    onSaved(ref: ViewRef, result: SaveResult, uri: vscode.Uri, text: string): void;
}

export function viewUri(dbName: string, viewId: number, label: string): vscode.Uri {
    const safe = label.replace(/[^\w.-]+/g, '_') || `view-${viewId}`;
    return vscode.Uri.from({ scheme: VIEW_SCHEME, path: `/${encodeURIComponent(dbName)}/${viewId}/${safe}.xml` });
}

export function parseViewUri(uri: vscode.Uri): ViewRef | undefined {
    const [, db, id] = uri.path.split('/');
    const viewId = Number(id);
    if (!db || !Number.isSafeInteger(viewId) || viewId <= 0) {
        return undefined;
    }
    return { dbName: decodeURIComponent(db), viewId };
}

/**
 * A stand-in size that changes whenever the write_date does. Kept under a
 * megabyte so no large-file guard ever trips on it; two dates collide only
 * when they are a whole multiple of 1000 s apart to the millisecond.
 */
export function viewFileSize(mtime: number): number {
    return 1 + (mtime % 1_000_000);
}

export class ViewFileSystemProvider implements vscode.FileSystemProvider {
    private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.changes.event;

    constructor(private readonly backend: ViewBackend, private readonly hooks: ViewFileHooks) {}

    watch(): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    /** Tells VS Code these files changed elsewhere; clean editors reload. */
    notifyChanged(uris: vscode.Uri[]): void {
        if (uris.length > 0) {
            this.changes.fire(uris.map(uri => ({ type: vscode.FileChangeType.Changed, uri })));
        }
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const ref = this.ref(uri);
        const mtime = await this.backend.writeDate(ref.dbName, ref.viewId);
        if (mtime === undefined) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return { type: vscode.FileType.File, ctime: 0, mtime, size: viewFileSize(mtime) };
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const ref = this.ref(uri);
        return Buffer.from(await this.backend.getArch(ref.dbName, ref.viewId), 'utf-8');
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean }): Promise<void> {
        const ref = this.ref(uri);
        const text = Buffer.from(content).toString('utf-8');
        // Throws when Odoo rejects the arch: VS Code shows the message and keeps the editor dirty.
        const result = await this.backend.save(ref.dbName, ref.viewId, text);
        this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        this.hooks.onSaved(ref, result, uri, text);
    }

    readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
        throw vscode.FileSystemError.NoPermissions('Views are opened from the Views tree, one at a time.');
    }

    createDirectory(_uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions('Views cannot be created here.');
    }

    delete(_uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions('Views cannot be deleted here.');
    }

    rename(_oldUri: vscode.Uri, _newUri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions('Views cannot be renamed here.');
    }

    private ref(uri: vscode.Uri): ViewRef {
        const ref = parseViewUri(uri);
        if (!ref) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return ref;
    }
}
