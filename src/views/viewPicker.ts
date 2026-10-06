/**
 * The QuickPicks that find a view: what Find View offers for what is typed,
 * and a list of views laid out as their inheritance - base views first, each
 * inheriting view indented under its parent. Pure: the flows show them.
 */
import type * as vscode from 'vscode';
import type { ViewModelCount, ViewRow } from '../services/views/viewQueries';

export interface ViewPickEntry {
    view: ViewRow;
    depth: number;
}

function byTypeThenName(a: ViewRow, b: ViewRow): number {
    return Number(a.inheritId !== null) - Number(b.inheritId !== null)
        || a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.id - b.id;
}

/** Depth-first, children by id. A view whose parent is not listed starts a branch after the base views. */
export function viewTree(rows: ViewRow[]): ViewPickEntry[] {
    const listed = new Set(rows.map(row => row.id));
    const children = new Map<number, ViewRow[]>();
    const roots: ViewRow[] = [];
    for (const row of rows) {
        if (row.inheritId !== null && row.inheritId !== row.id && listed.has(row.inheritId)) {
            children.set(row.inheritId, [...(children.get(row.inheritId) ?? []), row]);
        } else {
            roots.push(row);
        }
    }
    const entries: ViewPickEntry[] = [];
    const seen = new Set<number>();
    const visit = (view: ViewRow, depth: number): void => {
        if (seen.has(view.id)) {
            return;
        }
        seen.add(view.id);
        entries.push({ view, depth });
        for (const child of [...(children.get(view.id) ?? [])].sort((a, b) => a.id - b.id)) {
            visit(child, depth + 1);
        }
    };
    roots.sort(byTypeThenName).forEach(root => visit(root, 0));
    // Views in a cycle never reach a root: listed flat rather than lost.
    rows.filter(row => !seen.has(row.id)).sort((a, b) => a.id - b.id).forEach(row => visit(row, 0));
    return entries;
}

export interface ViewPickItem extends vscode.QuickPickItem {
    view: ViewRow;
}

export function viewPickItems(entries: ViewPickEntry[]): ViewPickItem[] {
    return entries.map(({ view, depth }) => ({
        // Em spaces: HTML does not collapse them, so deeper views stay indented.
        label: `${depth > 0 ? `${'\u2003'.repeat(depth - 1)}↳ ` : ''}$(${view.active ? 'pass' : 'circle-slash'}) ${view.name}`,
        description: [view.model, view.type, view.xmlid ?? `#${view.id}`].filter(Boolean).join(' · '),
        view
    }));
}

export type FindChoice = { kind: 'id'; id: number } | { kind: 'xmlid'; xmlid: string } | { kind: 'model'; model: string };

export interface FindItem extends vscode.QuickPickItem {
    choice: FindChoice;
}

/** What Find View lists for the typed value: the value as an id or an external id first, then the models. */
export function findViewItems(value: string, models: ViewModelCount[]): FindItem[] {
    const typed = value.trim();
    const items: FindItem[] = [];
    const id = Number(typed);
    if (/^\d+$/.test(typed) && Number.isSafeInteger(id) && id > 0) {
        items.push({ label: `$(symbol-number) View ${id}`, alwaysShow: true, choice: { kind: 'id', id } });
    } else if (/^[\w-]+\.[\w.-]+$/.test(typed) && !models.some(entry => entry.model === typed)) {
        items.push({ label: `$(symbol-key) ${typed}`, description: 'external ID', alwaysShow: true, choice: { kind: 'xmlid', xmlid: typed } });
    }
    return [...items, ...models.map(entry => ({
        label: entry.model,
        description: `${entry.count} view${entry.count === 1 ? '' : 's'}`,
        choice: { kind: 'model', model: entry.model } as FindChoice
    }))];
}

/**
 * What Enter with nothing selected says: the typed value matches no item.
 * Undefined when nothing was typed, so the pick just closes.
 */
export function nothingMatches(dbName: string, value: string): string | undefined {
    const typed = value.trim();
    return typed ? `Nothing matches '${typed}' in ${dbName}.` : undefined;
}
