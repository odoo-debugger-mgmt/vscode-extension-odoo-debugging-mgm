/**
 * The extension's data, as callers see it: the main store (services/mainStore.ts)
 * with this window's selection applied on top.
 *
 * Reads go through an mtime-based cache and writes are debounced and
 * single-flight. The selection - selected project, selected database per
 * project, active version - is a per-window choice, so it is kept in
 * `workspaceState` (services/workspaceSelection.ts) and stripped from what the
 * store holds. Callers never see the split: they read and write the same
 * `isSelected` / `activeVersion` fields as before.
 */
import * as vscode from 'vscode';
import { SettingsModel } from './models/settings';
import { DebuggerData, showError, showWarning, getWorkspacePath, getDefaultVersionSettings, stripSettings } from './utils';
import { ProjectModel } from './models/project';
import { DatabaseTemplateModel } from './models/dbTemplate';
import { logger } from './services/logger';
import { MainStore, StoreRead, currentMainStore } from './services/mainStore';
import { jsonEqual } from './services/mergeDocuments';
import {
    HANDOFF_STATE_PREFIX,
    SEEDED_FIELDS,
    WorkspaceSelection,
    applySelection,
    extractSelection,
    keepLeftDatabase,
    normalizeSelection,
    readSelection,
    stripSelection,
    writeSelection
} from './services/workspaceSelection';

interface CachedFileEntry {
    mtimeMs: number;
    /** Never handed out: callers get clones. */
    read: StoreRead;
}

interface PendingWrite {
    store: MainStore;
    data: DebuggerData;
    /** What the caller read, so a shared store can tell its changes from another window's. */
    base?: StoreRead;
    /**
     * The window's selection as of this save. Recorded only once the write
     * succeeds: a save the store refuses must not change what is selected.
     */
    selection?: { memento: vscode.Memento; value: WorkspaceSelection };
    timer?: NodeJS.Timeout;
    waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}

const WRITE_DEBOUNCE_MS = 25;

/** A save refused because the store could not be read: its data here would be empty. */
export class StoreUnreadableError extends Error {
    constructor(location: string) {
        super(`The data store ${location} could not be read, so nothing was saved to it`);
        this.name = 'StoreUnreadableError';
    }
}

export class SettingsStore {
    /** Keyed by store location, so a re-pointed store never serves the old cache. */
    private static readonly cache = new Map<string, CachedFileEntry>();
    private static readonly pendingWrites = new Map<string, PendingWrite>();
    /**
     * This window's selection. Absent in unit tests and before activation, in
     * which case the selection flags simply stay in the data, as they always did.
     */
    private static selectionState: vscode.Memento | undefined;
    /**
     * The stored snapshot each handed-out object was cloned from, keyed by its
     * `projects` array: `load()` and `stripSettings()` build new top-level
     * objects but keep that array, so every existing save finds its base.
     */
    private static readonly baseOf = new WeakMap<object, StoreRead>();

    /**
     * The last data this window read, with its selection applied, without
     * going back to the store - so a change another window just made is not
     * in it yet. For telling what that change took away.
     */
    static lastRead(): DebuggerData | undefined {
        const store = this.resolveStore();
        const cached = store ? this.cache.get(store.location) : undefined;
        const memento = this.selectionState;
        if (!cached) {
            return undefined;
        }
        const data = this.cloneData(cached.read.data);
        const selection = memento ? readSelection(memento) : undefined;
        return selection ? applySelection(data, selection) : data;
    }

    /** Forgets every cached read; the next `get()` goes to the store. */
    static invalidate(): void {
        this.cache.clear();
    }

    /**
     * Called first thing on activation, before anything reads the data -
     * VersionsService reads `activeVersion` while initializing.
     *
     * A generated project workspace opens with a selection handed over by the
     * window that created it; that is consumed here, once.
     */
    static async initialize(context: vscode.ExtensionContext): Promise<void> {
        this.selectionState = context.workspaceState;

        const workspaceFile = vscode.workspace.workspaceFile;
        if (!workspaceFile) {
            return;
        }
        const key = `${HANDOFF_STATE_PREFIX}${workspaceFile.toString()}`;
        const handedOver = normalizeSelection(context.globalState.get(key));
        if (!handedOver) {
            return;
        }
        await context.globalState.update(key, undefined);
        if (!readSelection(context.workspaceState)) {
            await writeSelection(context.workspaceState, handedOver);
        }
    }

    /**
     * Stores this window's selection for the window about to open
     * `workspaceFile`, which picks it up in `initialize`.
     */
    static async handOffSelection(context: vscode.ExtensionContext, workspaceFile: vscode.Uri): Promise<void> {
        const data = await this.get();
        await context.globalState.update(
            `${HANDOFF_STATE_PREFIX}${workspaceFile.toString()}`,
            extractSelection(data)
        );
    }

    /** Where this window's data lives, for pinning into generated workspaces. */
    static currentLocation(): string | undefined {
        return currentMainStore()?.location;
    }

    private static cloneData<T>(value: T): T {
        if (typeof structuredClone === 'function') {
            return structuredClone(value);
        }
        return JSON.parse(JSON.stringify(value)) as T;
    }

    /** Set only by tests, which cannot point VS Code's settings at a temp file. */
    private static storeOverride: MainStore | undefined;

    /**
     * Test hook: use `store` instead of the configured one, and `workspaceState`
     * as this "window's" state. Passing undefined restores normal resolution.
     */
    static useForTesting(store: MainStore | undefined, workspaceState?: vscode.Memento): void {
        this.storeOverride = store;
        this.selectionState = workspaceState;
        this.cache.clear();
    }

    private static resolveStore(): MainStore | undefined {
        if (this.storeOverride) {
            return this.storeOverride;
        }
        const store = currentMainStore();
        if (!store) {
            // Kept for its notification: every command that needs data in a
            // window with no folder open has always said so this way.
            getWorkspacePath();
        }
        return store;
    }

    /**
     * The selection to apply to `data`: the stored one, or - the first time
     * this workspace runs with a separate selection - whatever the data file
     * itself still records, so an existing user keeps what they had selected.
     */
    private static async selectionFor(data: DebuggerData): Promise<WorkspaceSelection | undefined> {
        const memento = this.selectionState;
        if (!memento) {
            return undefined;
        }
        const stored = readSelection(memento);
        const missing = stored ? SEEDED_FIELDS.filter(field => stored[field] === undefined) : [];
        if (stored && missing.length === 0) {
            return stored;
        }
        if (stored) {
            // Stored by a build before these fields moved to the window: keep
            // the selection, and take the missing ones from the data this once.
            const fromData = extractSelection(data);
            const completed: WorkspaceSelection = { ...stored };
            for (const field of missing) {
                (completed as unknown as Record<string, unknown>)[field] = fromData[field];
            }
            await writeSelection(memento, completed);
            return completed;
        }
        const seeded = extractSelection(data);
        await writeSelection(memento, seeded);
        return seeded;
    }

    private static async flushPendingWrite(location: string): Promise<void> {
        const pending = this.pendingWrites.get(location);
        if (!pending) {
            return;
        }

        this.pendingWrites.delete(location);
        if (pending.timer) {
            clearTimeout(pending.timer);
            pending.timer = undefined;
        }

        try {
            // A save that changes nothing writes nothing: VersionsService saves
            // on every load, and a no-op write would wake every other window
            // sharing the store, which would load, and save, and so on.
            // Compared as it will be stored: a Date and its ISO string are
            // the same value once written.
            const next = JSON.parse(JSON.stringify(pending.data)) as DebuggerData;
            // A shared store is compared without the per-window fields on
            // either side: one written before they were stripped still has them.
            const baseData = pending.base && pending.store.kind === 'sqlite'
                ? stripSelection(pending.base.data)
                : pending.base?.data;
            if (!baseData || !jsonEqual(next, baseData)) {
                await pending.store.commit(pending.base, next);
                // Re-read next time: after a merge the store holds more than
                // this window wrote.
                this.cache.delete(location);
            }
            if (pending.selection) {
                await writeSelection(pending.selection.memento, pending.selection.value);
            }
            pending.waiters.forEach(waiter => waiter.resolve());
        } catch (error) {
            pending.waiters.forEach(waiter => waiter.reject(error));
            throw error;
        }
    }

    private static readonly announcedReadOnly = new Set<string>();

    /** Stores whose last read failed; see readStored. */
    private static readonly unreadable = new Set<string>();

    /**
     * Says once, when a read-only store is opened, that it is - not only when
     * the first save fails. Selecting still works: it is this window's.
     */
    private static announceReadOnly(store: MainStore): void {
        const reason = store.readOnlyReason?.();
        if (!reason || this.announcedReadOnly.has(store.location)) {
            return;
        }
        this.announcedReadOnly.add(store.location);
        void showWarning(
            `The data store ${store.location} is read-only here: ${reason}. `
            + 'Changes to projects, versions and databases cannot be saved; selecting still works in this window.'
        );
    }

    /** The stored data, without this window's selection applied, and the read it came from. */
    private static async readStored(store: MainStore): Promise<{ data: DebuggerData; read: StoreRead }> {
        await this.flushPendingWrite(store.location);

        const mtimeMs = await store.stat();
        const cached = this.cache.get(store.location);
        if (cached && mtimeMs !== undefined && cached.mtimeMs === mtimeMs) {
            return { data: this.cloneData(cached.read.data), read: cached.read };
        }

        let read;
        try {
            read = await store.read();
        } catch (error) {
            // Until it reads again, nothing is written to it: a caller that
            // swallowed this error holds empty data, and saving that would
            // replace everything - or, as a test run found, add a Default
            // Version to a shared store every window then sees.
            this.unreadable.add(store.location);
            void showError(`Failed to read ${store.location}: ${error}`);
            throw new Error(`Error reading file: ${store.location}`);
        }
        this.unreadable.delete(store.location);
        const snapshot: StoreRead = { ...read, data: this.cloneData(read.data) };
        this.cache.set(store.location, { mtimeMs: read.mtimeMs, read: snapshot });
        this.announceReadOnly(store);
        return { data: this.cloneData(snapshot.data), read: snapshot };
    }

    /**
     * The data with this window's selection applied. `fileName` is accepted
     * for the existing call sites; there is only one data store.
     */
    static async get(_fileName?: string): Promise<DebuggerData> {
        const store = this.resolveStore();
        if (!store) {
            throw new Error('Open a workspace before reading the Odoo DevTools data.');
        }

        const { data, read } = await this.readStored(store);
        if (Array.isArray(data.projects)) {
            this.baseOf.set(data.projects, read);
        }
        const selection = await this.selectionFor(data);
        return selection ? applySelection(data, selection) : data;
    }

    /**
     * Saves the entire data object. The selection it carries goes to this
     * window's workspaceState once the write succeeds.
     *
     * A shared store receives the data without it: there, one window's
     * selection would become every window's. The workspace's own JSON file
     * keeps it, as it always did - the window's workspaceState still decides
     * for that window, and the file's copy is what another profile, another
     * editor or an older build starts from.
     */
    static async saveWithoutComments(data: DebuggerData, _fileName?: string): Promise<void> {
        const store = this.resolveStore();
        if (!store) {
            return;
        }

        if (this.unreadable.has(store.location)) {
            throw new StoreUnreadableError(store.location);
        }

        const base = (data.projects && this.baseOf.get(data.projects))
            ?? this.cache.get(store.location)?.read;
        let payload = this.cloneData(data);
        const memento = this.selectionState;
        const previous = memento ? readSelection(memento) : undefined;
        // Before extracting: the version the selection leaves keeps its database.
        keepLeftDatabase(payload, previous);
        const selection = memento
            ? { memento, value: extractSelection(payload, previous) }
            : undefined;
        if (memento && store.kind === 'sqlite') {
            payload = stripSelection(payload);
        }

        const location = store.location;
        await new Promise<void>((resolve, reject) => {
            const existing = this.pendingWrites.get(location);
            if (existing) {
                existing.data = payload;
                existing.base = base;
                existing.selection = selection;
                existing.waiters.push({ resolve, reject });
                if (existing.timer) {
                    clearTimeout(existing.timer);
                }
                existing.timer = setTimeout(() => {
                    this.flushPendingWrite(location).catch(error => {
                        logger.warn(`Failed to flush pending write for ${location}:`, error);
                    });
                }, WRITE_DEBOUNCE_MS);
                return;
            }

            const pending: PendingWrite = {
                store,
                data: payload,
                base,
                selection,
                waiters: [{ resolve, reject }]
            };

            pending.timer = setTimeout(() => {
                this.flushPendingWrite(location).catch(error => {
                    logger.warn(`Failed to flush pending write for ${location}:`, error);
                });
            }, WRITE_DEBOUNCE_MS);
            this.pendingWrites.set(location, pending);
        });
    }

    static async load(): Promise<DebuggerData> {
        const data = await this.get().catch(() => ({ projects: [] } as DebuggerData));

        return {
            settings: data.settings ? Object.assign(new SettingsModel(getDefaultVersionSettings()), data.settings) : undefined,
            projects: data.projects || [],
            versions: data.versions || {},
            activeVersion: data.activeVersion || '',
            dbTemplates: Array.isArray(data.dbTemplates) ? data.dbTemplates as DatabaseTemplateModel[] : []
        };
    }

    static async getProjects(): Promise<ProjectModel[]> {
        const data = await this.load();
        return data.projects || [];
    }

    static async updateProjects(projects: ProjectModel[]): Promise<void> {
        const data = await this.load();
        data.projects = projects;
        await this.saveWithoutComments(stripSettings(data));
    }

    /**
     * The selected project without any notification. Background callers - the
     * debugger sync in particular - must not raise "create a project first"
     * from a refresh the user never asked for.
     */
    static async peekSelectedProject(): Promise<{ data: DebuggerData; project: ProjectModel } | null> {
        const data = await this.get('odoo-debugger-data.json');
        const projects: ProjectModel[] = data.projects;
        if (!Array.isArray(projects) || projects.length === 0) {
            return null;
        }
        const project = projects.find((p: ProjectModel) => p.isSelected === true);
        return project ? { data, project } : null;
    }

    /** Gets the currently selected project, offering the fix when there is none. */
    static async getSelectedProject(): Promise<{ data: DebuggerData; project: ProjectModel } | null> {
        const data = await this.get('odoo-debugger-data.json');

        const projects: ProjectModel[] = data.projects;
        if (!projects || projects.length === 0) {
            // The action is named, so it is offered rather than instructed.
            void showError('No projects yet.', 'Create Project').then(choice => {
                if (choice === 'Create Project') {
                    void vscode.commands.executeCommand('projectSelector.create');
                }
            });
            return null;
        }

        if (typeof projects !== 'object') {
            void showError('Unable to load projects.');
            return null;
        }

        const project = projects.find((p: ProjectModel) => p.isSelected === true);
        if (!project) {
            void showError('No project is selected.', 'Select Project').then(choice => {
                if (choice === 'Select Project') {
                    void vscode.commands.executeCommand('odoo-debugger.quickProjectSearch');
                }
            });
            return null;
        }

        return { data, project };
    }
}

