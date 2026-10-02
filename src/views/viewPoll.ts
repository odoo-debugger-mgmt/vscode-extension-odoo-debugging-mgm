/**
 * Follows edits made in Odoo's own UI to the views open as arch tabs. One
 * query per database at a time: a query stuck behind a lock must not pile up
 * a new connection every tick.
 */
import type * as vscode from 'vscode';
import type { ViewRef } from './viewFileSystem';

export interface OpenArch {
    uri: vscode.Uri;
    ref: ViewRef;
}

export class ViewArchPoller {
    private readonly seen = new Map<string, number>();
    private readonly inFlight = new Set<string>();

    constructor(
        private readonly getDates: (dbName: string, ids: number[]) => Promise<Map<number, number>>,
        /** `edited` is true when a view differed from a date seen before. */
        private readonly onChanged: (uris: vscode.Uri[], edited: boolean) => void,
        private readonly onError: (dbName: string, error: unknown) => void
    ) {}

    tick(open: OpenArch[]): Promise<void> {
        const openKeys = new Set(open.map(entry => entry.uri.toString()));
        for (const key of [...this.seen.keys()]) {
            if (!openKeys.has(key)) {
                this.seen.delete(key);
            }
        }
        const byDb = new Map<string, OpenArch[]>();
        for (const entry of open) {
            byDb.set(entry.ref.dbName, [...(byDb.get(entry.ref.dbName) ?? []), entry]);
        }
        const pending: Promise<void>[] = [];
        for (const [dbName, entries] of byDb) {
            if (this.inFlight.has(dbName)) {
                continue;
            }
            this.inFlight.add(dbName);
            pending.push(this.poll(dbName, entries));
        }
        return Promise.all(pending).then(() => undefined);
    }

    private async poll(dbName: string, entries: OpenArch[]): Promise<void> {
        try {
            const dates = await this.getDates(dbName, entries.map(entry => entry.ref.viewId));
            let edited = false;
            const changed = entries.filter(entry => {
                const key = entry.uri.toString();
                const date = dates.get(entry.ref.viewId);
                const previous = this.seen.get(key);
                if (date === undefined) {
                    return false;
                }
                this.seen.set(key, date);
                if (previous === undefined) {
                    // An edit between loading the tab and the first poll must still reload a clean editor.
                    return true;
                }
                if (date !== previous) {
                    edited = true;
                    return true;
                }
                return false;
            });
            if (changed.length > 0) {
                this.onChanged(changed.map(entry => entry.uri), edited);
            }
        } catch (error) {
            this.onError(dbName, error);
        } finally {
            this.inFlight.delete(dbName);
        }
    }
}
