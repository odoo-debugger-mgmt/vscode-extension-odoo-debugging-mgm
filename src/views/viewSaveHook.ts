/**
 * What follows an arch save: Odoo's reason a view stays off goes on its line,
 * the render tab reloads that database, the note's journal records the save,
 * and - for an inheriting view, unless odooDebugger.views.checkXpathsOnSave is
 * off - the saved text's locators are checked, because a view Odoo turned on
 * can still carry a patch that matches nothing. The message waits for that
 * check, so it can say so; a failed check is only logged. A save that is not
 * checked clears the earlier check, and a check that ends after the arch
 * closed shows nothing.
 */
import * as vscode from 'vscode';
import type { SaveResult } from '../services/views/viewService';
import { brokenLocators, type XpathReport } from '../services/views/xpathReport';
import { archErrorSummary, locateArchError, readableArchError } from '../services/views/archErrors';
import { logger } from '../services/logger';
import type { ViewRef } from './viewFileSystem';
import type { XpathDiagnostics } from './xpathDiagnostics';

export interface SaveHookDeps {
    checkXpaths(dbName: string, viewId: number, arch: string): Promise<XpathReport>;
    checkOnSave(): boolean;
    xpaths: Pick<XpathDiagnostics, 'show' | 'clear'>;
    /** The arch is still open: a check that ends after it closed shows nothing. */
    isOpen(uri: vscode.Uri): boolean;
    /** Odoo's reasons saved views stay off. */
    activationDiagnostics: vscode.DiagnosticCollection;
    reloadDatabase(dbName: string): void;
    recordSave(dbName: string, viewId: number, activated: boolean): Promise<void>;
    refreshTree(): void;
    warn(text: string): void;
    brief(text: string): void;
}

export function saveMessage(result: SaveResult, report?: XpathReport): { warning: boolean; text: string } {
    if (result.activationError) {
        return { warning: true, text: `Saved. The view stays off: ${archErrorSummary(result.activationError)}` };
    }
    const saved = result.activated ? 'Saved, and the view is on' : 'Saved';
    const broken = report ? brokenLocators(report) : undefined;
    return broken ? { warning: true, text: `${saved} — but ${broken}.` } : { warning: false, text: `${saved}.` };
}

export function createSaveHook(deps: SaveHookDeps): (ref: ViewRef, result: SaveResult, uri: vscode.Uri, text: string) => Promise<void> {
    return async (ref, result, uri, text) => {
        if (result.activationError) {
            const where = locateArchError(text, result.activationError);
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(where.line, where.start, where.line, where.end),
                readableArchError(result.activationError),
                vscode.DiagnosticSeverity.Error
            );
            diagnostic.source = 'Odoo';
            deps.activationDiagnostics.set(uri, [diagnostic]);
        } else {
            deps.activationDiagnostics.delete(uri);
        }
        deps.reloadDatabase(ref.dbName);
        // The tree shows the journal, so refresh once the save is in it.
        void deps.recordSave(ref.dbName, ref.viewId, result.activated).then(() => deps.refreshTree());

        let report: XpathReport | undefined;
        if (result.inheriting && deps.checkOnSave()) {
            try {
                report = await deps.checkXpaths(ref.dbName, ref.viewId, text);
                if (report.error) {
                    logger.warn(`Could not check the locators of view ${ref.viewId} in ${ref.dbName}: ${report.error}`);
                }
                if (deps.isOpen(uri)) {
                    deps.xpaths.show(uri, text, report);
                }
            } catch (error) {
                logger.warn(`Could not check the locators of view ${ref.viewId} in ${ref.dbName}:`, error);
            }
        }
        if (!report) {
            // An earlier check's squiggles would sit at offsets the save moved.
            deps.xpaths.clear(uri);
        }
        const message = saveMessage(result, report);
        (message.warning ? deps.warn : deps.brief)(message.text);
    };
}
