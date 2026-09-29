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
import { DebuggerData, showError, getWorkspacePath, getDefaultVersionSettings, stripSettings } from './utils';
import { ProjectModel } from './models/project';
import { DatabaseTemplateModel } from './models/dbTemplate';
import { logger } from './services/logger';
import { MainStore, currentMainStore } from './services/mainStore';
import {
    HANDOFF_STATE_PREFIX,
    WorkspaceSelection,
    applySelection,
    extractSelection,
    normalizeSelection,
    readSelection,
    stripSelection,
    writeSelection
} from './services/workspaceSelection';

interface CachedFileEntry {
    mtimeMs: number;
    data: DebuggerData;
}

interface PendingWrite {
    store: MainStore;
    data: DebuggerData;
    timer?: NodeJS.Timeout;
    waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}

const WRITE_DEBOUNCE_MS = 25;

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

    private static resolveStore(): MainStore | undefined {
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
        if (stored?.testingByProject) {
            return stored;
        }
        if (stored) {
            // Stored before testing mode moved to the window: keep the
            // selection, and take testing from the data this once.
            const seededTesting = { ...stored, testingByProject: extractSelection(data).testingByProject };
            await writeSelection(memento, seededTesting);
            return seededTesting;
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
            const jsonString = JSON.stringify(pending.data, null, 4);
            const mtimeMs = await pending.store.write(jsonString);
            this.cache.set(location, { mtimeMs, data: this.cloneData(pending.data) });
            pending.waiters.forEach(waiter => waiter.resolve());
        } catch (error) {
            pending.waiters.forEach(waiter => waiter.reject(error));
            throw error;
        }
    }

    /** The stored data, without this window's selection applied. */
    private static async readStored(store: MainStore): Promise<DebuggerData> {
        await this.flushPendingWrite(store.location);

        const mtimeMs = await store.stat();
        const cached = this.cache.get(store.location);
        if (cached && mtimeMs !== undefined && cached.mtimeMs === mtimeMs) {
            return this.cloneData(cached.data);
        }

        let read;
        try {
            read = await store.read();
        } catch (error) {
            void showError(`Failed to read ${store.location}: ${error}`);
            throw new Error(`Error reading file: ${store.location}`);
        }
        this.cache.set(store.location, { mtimeMs: read.mtimeMs, data: this.cloneData(read.data) });
        return this.cloneData(read.data);
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

        const data = await this.readStored(store);
        const selection = await this.selectionFor(data);
        return selection ? applySelection(data, selection) : data;
    }

    /**
     * Saves the entire data object. The selection it carries goes to this
     * window's workspaceState; the store receives the data without it.
     */
    static async saveWithoutComments(data: DebuggerData, _fileName?: string): Promise<void> {
        const store = this.resolveStore();
        if (!store) {
            return;
        }

        let payload = this.cloneData(data);
        const memento = this.selectionState;
        if (memento) {
            await writeSelection(memento, extractSelection(payload, readSelection(memento)));
            payload = stripSelection(payload);
        }

        const location = store.location;
        await new Promise<void>((resolve, reject) => {
            const existing = this.pendingWrites.get(location);
            if (existing) {
                existing.data = payload;
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

