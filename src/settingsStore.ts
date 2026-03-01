import { SettingsModel } from './models/settings';
import { readFromFile, DebuggerData, showError, getWorkspacePath, stripSettings, getDefaultVersionSettings } from './utils';
import { ProjectModel } from './models/project';
import { modify, applyEdits, parse } from 'jsonc-parser';
import fs from 'fs';
import path from 'path';

interface CachedFileEntry {
    mtimeMs: number;
    raw: string;
    data: DebuggerData;
}

interface PendingWrite {
    fileName: string;
    filePath: string;
    data: DebuggerData;
    timer?: NodeJS.Timeout;
    waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}

const WRITE_DEBOUNCE_MS = 25;

export class SettingsStore {
    private static readonly cache = new Map<string, CachedFileEntry>();
    private static readonly pendingWrites = new Map<string, PendingWrite>();

    private static cloneData<T>(value: T): T {
        if (typeof structuredClone === 'function') {
            return structuredClone(value);
        }
        return JSON.parse(JSON.stringify(value)) as T;
    }

    private static resolveFilePath(fileName: string): string | undefined {
        const workspacePath = getWorkspacePath();
        if (!workspacePath) {
            return undefined;
        }
        return path.join(workspacePath, '.vscode', fileName);
    }

    private static updateCache(fileName: string, filePath: string, raw: string, data: DebuggerData): void {
        let mtimeMs = Date.now();
        try {
            const stats = fs.statSync(filePath);
            mtimeMs = stats.mtimeMs;
        } catch {
            // Keep fallback timestamp when stat fails.
        }

        this.cache.set(fileName, {
            mtimeMs,
            raw,
            data: this.cloneData(data)
        });
    }

    private static async ensureDataLoaded(fileName: string, filePath: string): Promise<DebuggerData> {
        const loaded = await readFromFile(fileName);
        if (!loaded) {
            throw new Error(`Error reading file: ${fileName}`);
        }

        const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : JSON.stringify(loaded, null, 4);
        this.updateCache(fileName, filePath, raw, loaded);
        return this.cloneData(loaded);
    }

    private static async flushPendingWrite(fileName: string): Promise<void> {
        const pending = this.pendingWrites.get(fileName);
        if (!pending) {
            return;
        }

        this.pendingWrites.delete(fileName);
        if (pending.timer) {
            clearTimeout(pending.timer);
            pending.timer = undefined;
        }

        try {
            const jsonString = JSON.stringify(pending.data, null, 4);
            fs.writeFileSync(pending.filePath, jsonString, 'utf8');
            this.updateCache(fileName, pending.filePath, jsonString, pending.data);
            pending.waiters.forEach(waiter => waiter.resolve());
        } catch (error) {
            pending.waiters.forEach(waiter => waiter.reject(error));
            throw error;
        }
    }

    /**
     * Helper function to read raw file content for JSON modification
     */
    private static async readRawFileContent(fileName: string): Promise<string | null> {
        const filePath = this.resolveFilePath(fileName);
        if (!filePath) {
            return null;
        }

        try {
            if (!fs.existsSync(filePath)) {
                return null;
            }

            const stats = fs.statSync(filePath);
            const cached = this.cache.get(fileName);
            if (cached && cached.mtimeMs === stats.mtimeMs) {
                return cached.raw;
            }

            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed = parse(raw) as DebuggerData;
            this.updateCache(fileName, filePath, raw, parsed ?? {});
            return raw;
        } catch (error) {
            showError(`Failed to read raw content from ${fileName}: ${error}`);
            return null;
        }
    }

    static async get(fileName: string): Promise<DebuggerData> {
        const filePath = this.resolveFilePath(fileName);
        if (!filePath) {
            throw new Error(`Open a workspace before reading ${fileName}.`);
        }

        await this.flushPendingWrite(fileName);

        if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            const cached = this.cache.get(fileName);
            if (cached && cached.mtimeMs === stats.mtimeMs) {
                return this.cloneData(cached.data);
            }
        }

        return this.ensureDataLoaded(fileName, filePath);
    }

    static async saveWithComments(value: any, jsonPath: any[], fileName: string, options: any = {}): Promise<void> {
        const filePath = this.resolveFilePath(fileName);
        if (!filePath) {
            return;
        }

        await this.flushPendingWrite(fileName);

        const rawData = await this.readRawFileContent(fileName);
        if (!rawData) {
            return;
        }

        const edits = modify(rawData, jsonPath, value, options);
        const updatedJson = applyEdits(rawData, edits);
        fs.writeFileSync(filePath, updatedJson, 'utf8');
        const parsed = parse(updatedJson) as DebuggerData;
        this.updateCache(fileName, filePath, updatedJson, parsed ?? {});
    }

    /**
     * Saves the entire data object to file
     */
    static async saveWithoutComments(data: DebuggerData, fileName: string = 'odoo-debugger-data.json'): Promise<void> {
        const filePath = this.resolveFilePath(fileName);
        if (!filePath) {
            return;
        }

        const payload = this.cloneData(data);

        await new Promise<void>((resolve, reject) => {
            const existing = this.pendingWrites.get(fileName);
            if (existing) {
                existing.data = payload;
                existing.waiters.push({ resolve, reject });
                if (existing.timer) {
                    clearTimeout(existing.timer);
                }
                existing.timer = setTimeout(() => {
                    this.flushPendingWrite(fileName).catch(error => {
                        console.warn(`Failed to flush pending write for ${fileName}:`, error);
                    });
                }, WRITE_DEBOUNCE_MS);
                return;
            }

            const pending: PendingWrite = {
                fileName,
                filePath,
                data: payload,
                waiters: [{ resolve, reject }]
            };

            pending.timer = setTimeout(() => {
                this.flushPendingWrite(fileName).catch(error => {
                    console.warn(`Failed to flush pending write for ${fileName}:`, error);
                });
            }, WRITE_DEBOUNCE_MS);
            this.pendingWrites.set(fileName, pending);
        });
    }

    static async load(): Promise<DebuggerData> {
        const data = await this.get('odoo-debugger-data.json').catch(async () => {
            const fallback = await readFromFile('odoo-debugger-data.json') || {};
            return fallback as DebuggerData;
        });

        return {
            settings: data.settings ? Object.assign(new SettingsModel(getDefaultVersionSettings()), data.settings) : undefined,
            projects: data.projects || [],
            versions: data.versions || {},
            activeVersion: data.activeVersion || ''
        };
    }

    static async getSettings(): Promise<SettingsModel | null> {
        const data = await this.load();
        return data.settings || null;
    }

    /**
     * @deprecated Settings should only be managed through VersionsService now.
     * This method should not be used as it violates the versions-exclusive settings management.
     */
    static async updateSettings(partial: Partial<SettingsModel>): Promise<void> {
        const data = await this.load();
        const updated = Object.assign(new SettingsModel(getDefaultVersionSettings()), data.settings, partial);
        data.settings = updated;
        // Even though this method sets settings, we must strip them to prevent persistence
        await this.saveWithoutComments(stripSettings(data));
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
     * Gets the currently selected project with validation
     */
    static async getSelectedProject(): Promise<{ data: DebuggerData; project: ProjectModel } | null> {
        const data = await this.get('odoo-debugger-data.json');

        const projects: ProjectModel[] = data.projects;
        if (!projects || projects.length === 0) {
            showError('Unable to load projects, please create a project first');
            return null;
        }

        if (typeof projects !== 'object') {
            showError('Unable to load projects.');
            return null;
        }

        const project = projects.find((p: ProjectModel) => p.isSelected === true);
        if (!project) {
            showError('Select a project before running this action.');
            return null;
        }

        return { data, project };
    }
}
