/**
 * Moving data between stores: making paths absolute, and merging one set of
 * data into another.
 *
 * Pure, and tested as data. The commands that use these live in
 * commands/dataStoreCommands.ts.
 */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DebuggerData } from '../utils';
import { projectKey } from './workspaceSelection';

/** Version settings that hold a single path. */
const VERSION_PATH_KEYS = ['odooPath', 'enterprisePath', 'designThemesPath', 'customAddonsPath', 'pythonPath', 'dumpsFolder'];

function absolute(value: unknown, root: string): unknown {
    return typeof value === 'string' && value.trim() !== '' && !path.isAbsolute(value.trim())
        ? path.resolve(root, value.trim())
        : value;
}

function absolutizeSettings(settings: Record<string, unknown> | undefined, root: string): void {
    if (!settings) {
        return;
    }
    for (const key of VERSION_PATH_KEYS) {
        settings[key] = absolute(settings[key], root);
    }
    if (typeof settings.subModulesPaths === 'string' && settings.subModulesPaths.trim()) {
        settings.subModulesPaths = settings.subModulesPaths
            .split(',')
            .map(entry => entry.trim())
            .filter(Boolean)
            .map(entry => absolute(entry, root))
            .join(',');
    }
}

/**
 * A copy of `data` with every workspace-relative path made absolute against
 * `root`, the workspace the data came from. A shared store never holds a
 * relative path: `./custom-addons` would mean a different folder in every
 * window that reads it.
 */
export function absolutizePaths(data: DebuggerData, root: string): DebuggerData {
    const copy = structuredClone(data) as any;
    absolutizeSettings(copy.settings, root);
    for (const version of Object.values(copy.versions ?? {}) as any[]) {
        absolutizeSettings(version?.settings, root);
    }
    for (const project of copy.projects ?? []) {
        for (const repo of project?.repos ?? []) {
            repo.path = absolute(repo.path, root);
        }
        for (const db of project?.dbs ?? []) {
            db.sqlFilePath = absolute(db.sqlFilePath, root);
            for (const assignment of db?.projectRepoBranches ?? []) {
                assignment.repoPath = absolute(assignment.repoPath, root);
            }
        }
        for (const entry of project?.upgradeConfig?.repos ?? []) {
            entry.repoPath = absolute(entry.repoPath, root);
        }
    }
    return copy as DebuggerData;
}

export interface MergeSummary {
    projectsAdded: number;
    projectsMerged: number;
    databasesAdded: number;
    versionsAdded: number;
    versionsMatched: number;
    templatesAdded: number;
}

/** One line per non-zero count, for a confirmation dialog. */
export function describeMerge(summary: MergeSummary): string[] {
    const lines: string[] = [];
    const add = (count: number, text: string) => {
        if (count > 0) {
            lines.push(`${count} ${text}`);
        }
    };
    add(summary.projectsAdded, `new project${summary.projectsAdded === 1 ? '' : 's'}`);
    add(summary.projectsMerged, `existing project${summary.projectsMerged === 1 ? '' : 's'} completed with what is missing`);
    add(summary.databasesAdded, `database${summary.databasesAdded === 1 ? '' : 's'} added`);
    add(summary.versionsAdded, `new version${summary.versionsAdded === 1 ? '' : 's'}`);
    add(summary.versionsMatched, `version${summary.versionsMatched === 1 ? '' : 's'} matched to one already there, by branch`);
    add(summary.templatesAdded, `database template${summary.templatesAdded === 1 ? '' : 's'}`);
    return lines;
}

function addMissing<T>(target: T[], incoming: T[] | undefined, key: (item: T) => unknown): number {
    const known = new Set(target.map(key));
    let added = 0;
    for (const item of incoming ?? []) {
        const id = key(item);
        if (!known.has(id)) {
            target.push(item);
            known.add(id);
            added += 1;
        }
    }
    return added;
}

/**
 * `incoming` merged into `target`. What is already in `target` is never
 * overwritten: incoming data only fills gaps.
 *
 * Versions are matched by branch rather than id, because ids differ between
 * machines and stores. An incoming version whose branch is already there is
 * the same version: every reference to its id is pointed at the existing one.
 */
export function mergeData(target: DebuggerData, incoming: DebuggerData): { data: DebuggerData; summary: MergeSummary } {
    const data = structuredClone(target) as any;
    const source = structuredClone(incoming) as any;
    const summary: MergeSummary = {
        projectsAdded: 0, projectsMerged: 0, databasesAdded: 0, versionsAdded: 0, versionsMatched: 0, templatesAdded: 0
    };

    data.projects = Array.isArray(data.projects) ? data.projects : [];
    data.versions = data.versions ?? {};
    data.dbTemplates = Array.isArray(data.dbTemplates) ? data.dbTemplates : [];

    // 1. Versions, and how incoming ids map onto this store's.
    const idMap = new Map<string, string>();
    for (const [id, version] of Object.entries(source.versions ?? {}) as Array<[string, any]>) {
        const branch = String(version?.odooVersion ?? '').trim();
        const match = Object.entries(data.versions).find(([, existing]: [string, any]) =>
            String(existing?.odooVersion ?? '').trim() === branch && branch !== '');
        if (match) {
            idMap.set(id, match[0]);
            summary.versionsMatched += 1;
            continue;
        }
        const newId = data.versions[id] ? randomUUID() : id;
        idMap.set(id, newId);
        data.versions[newId] = { ...version, id: newId, isActive: false };
        summary.versionsAdded += 1;
    }
    const remap = (id: unknown) => (typeof id === 'string' && idMap.has(id) ? idMap.get(id) : id);

    // 2. References to those versions inside the incoming projects.
    for (const project of source.projects ?? []) {
        for (const db of project?.dbs ?? []) {
            db.versionId = remap(db.versionId);
        }
        if (project?.selectedDbByVersion) {
            project.selectedDbByVersion = Object.fromEntries(
                Object.entries(project.selectedDbByVersion).map(([versionId, dbId]) => [remap(versionId), dbId]));
        }
        for (const side of ['from', 'to']) {
            if (project?.upgradeConfig?.[side]) {
                project.upgradeConfig[side].versionId = remap(project.upgradeConfig[side].versionId);
            }
        }
    }

    // 3. Projects: new ones whole, existing ones completed.
    const byKey = new Map(data.projects.map((project: any) => [projectKey(project), project]));
    for (const project of source.projects ?? []) {
        const existing: any = byKey.get(projectKey(project));
        if (!existing) {
            data.projects.push(project);
            byKey.set(projectKey(project), project);
            summary.projectsAdded += 1;
            summary.databasesAdded += (project.dbs ?? []).length;
            continue;
        }
        summary.projectsMerged += 1;
        existing.dbs = existing.dbs ?? [];
        existing.repos = existing.repos ?? [];
        existing.tickets = existing.tickets ?? [];
        summary.databasesAdded += addMissing(existing.dbs, project.dbs, (db: any) => db?.id);
        addMissing(existing.repos, project.repos, (repo: any) => String(repo?.name ?? '').toLowerCase());
        addMissing(existing.tickets, project.tickets, (ticket: any) => ticket?.id);
        existing.selectedDbByVersion = { ...(project.selectedDbByVersion ?? {}), ...(existing.selectedDbByVersion ?? {}) };
    }

    // 4. Templates, by name.
    summary.templatesAdded = addMissing(data.dbTemplates, source.dbTemplates, (template: any) => template?.name);

    // 5. A legacy settings block only means something to a store with no
    // versions yet: anywhere else it would be migrated into a duplicate.
    if (source.settings && !data.settings && Object.keys(data.versions).length === 0) {
        data.settings = source.settings;
    }

    return { data, summary };
}

/** What an import file holds: an export, or a raw data file. */
export function readImportFile(parsed: unknown): DebuggerData | undefined {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return undefined;
    }
    const value = parsed as Record<string, unknown>;
    const data = (value.schemaVersion !== undefined && value.data && typeof value.data === 'object')
        ? value.data as Record<string, unknown>
        : value;
    return Array.isArray(data.projects) ? data as unknown as DebuggerData : undefined;
}

export const EXPORT_SCHEMA_VERSION = 1;

export function buildExport(data: DebuggerData, exportedAt: Date = new Date()): Record<string, unknown> {
    return { schemaVersion: EXPORT_SCHEMA_VERSION, exportedAt: exportedAt.toISOString(), data };
}
