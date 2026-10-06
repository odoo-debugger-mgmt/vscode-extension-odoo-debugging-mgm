/**
 * What a View Doctor command acts on. From the Views tree it gets the row;
 * from an arch editor's title it gets the editor's odoo-view: URI; from the
 * Command Palette it gets nothing, and the active editor's view is used. All
 * three come out the same, so every command works from either place.
 */
import * as vscode from 'vscode';
import type { ViewRow } from '../services/views/viewQueries';
import { ViewItem } from './viewDoctorView';
import { VIEW_SCHEME, parseViewUri } from './viewFileSystem';

export interface ViewTarget {
    dbName: string;
    view: ViewRow;
}

export type ReadRows = (dbName: string, ids: number[]) => Promise<ViewRow[]>;

/** Undefined when the argument and the active editor are no view; throws when the URI's view is gone. */
export async function viewTarget(
    arg: unknown,
    readRows: ReadRows,
    activeUri: () => vscode.Uri | undefined = () => vscode.window.activeTextEditor?.document.uri
): Promise<ViewTarget | undefined> {
    if (arg instanceof ViewItem) {
        return { dbName: arg.dbName, view: arg.view };
    }
    const uri = arg instanceof vscode.Uri ? arg : activeUri();
    const ref = uri?.scheme === VIEW_SCHEME ? parseViewUri(uri) : undefined;
    if (!ref) {
        return undefined;
    }
    const [view] = await readRows(ref.dbName, [ref.viewId]);
    if (!view) {
        throw new Error(`View ${ref.viewId} no longer exists in ${ref.dbName}.`);
    }
    return { dbName: ref.dbName, view };
}
