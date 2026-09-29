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

/**
 * The stored shapes as this module handles them: loosely, because it reads
 * data from other stores and other machines, where any field may be missing.
 */
interface LooseVersion {
    id?: string;
    odooVersion?: unknown;
    isActive?: boolean;
    settings?: Record<string, unknown>;
}
interface LooseDb {
    id?: string;
    versionId?: unknown;
    sqlFilePath?: unknown;
    projectRepoBranches?: Array<{ repoPath?: unknown }>;
}
interface LooseSide {
    versionId?: unknown;
}
interface LooseProject {
    uid?: string;
    name?: string;
    dbs?: LooseDb[];
    repos?: Array<{ name?: unknown; path?: unknown }>;
    tickets?: Array<{ id?: unknown }>;
    selectedDbByVersion?: Record<string, unknown>;
    upgradeConfig?: { from?: LooseSide; to?: LooseSide; repos?: Array<{ repoPath?: unknown }> };
}
interface LooseData {
    settings?: Record<string, unknown>;
    projects?: LooseProject[];
    versions?: Record<string, LooseVersion>;
    dbTemplates?: Array<{ name?: unknown }>;
}

const loose = (data: DebuggerData) => structuredClone(data) as unknown as LooseData;

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
    const copy = loose(data);
    absolutizeSettings(copy.settings, root);
    for (const version of Object.values(copy.versions ?? {})) {
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
    return copy as unknown as DebuggerData;
}

export interface MergeSummary {
    projectsAdded: number;
    projectsMerged: number;
    databasesAdded: number;
    versionsAdded: number;
    versionsMatched: number;
    templatesAdded: number;
}

/**
 * What a merge would change, for a confirmation dialog: `adds` lists what it
 * adds, and is empty when it adds nothing; `notes` says what it found already
 * there, which changes nothing and must not read as a change.
 */
export function describeMerge(summary: MergeSummary): { adds: string[]; notes: string[] } {
    const lines = (entries: Array<[number, string, string]>) => entries
        .filter(([count]) => count > 0)
        .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
    return {
        adds: lines([
            [summary.projectsAdded, 'new project', 'new projects'],
            [summary.projectsMerged, 'existing project completed with what it was missing', 'existing projects completed with what they were missing'],
            [summary.databasesAdded, 'database added', 'databases added'],
            [summary.versionsAdded, 'new version', 'new versions'],
            [summary.templatesAdded, 'database template', 'database templates']
        ]),
        notes: lines([
            [summary.versionsMatched, 'version is already there, matched by branch', 'versions are already there, matched by branch']
        ])
    };
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
    const data = loose(target);
    const source = loose(incoming);
    const summary: MergeSummary = {
        projectsAdded: 0, projectsMerged: 0, databasesAdded: 0, versionsAdded: 0, versionsMatched: 0, templatesAdded: 0
    };

    const projects: LooseProject[] = data.projects = Array.isArray(data.projects) ? data.projects : [];
    const versions: Record<string, LooseVersion> = data.versions = data.versions ?? {};
    const templates = data.dbTemplates = Array.isArray(data.dbTemplates) ? data.dbTemplates : [];

    // 1. Versions, and how incoming ids map onto this store's. The same id
    // on the same branch is the same version; otherwise the same branch and
    // name, so a cloned version (same branch, another name) keeps its own
    // match; otherwise the first on that branch not already claimed.
    const idMap = new Map<string, string>();
    const claimed = new Set<string>();
    const branchOf = (version: LooseVersion | undefined) => String(version?.odooVersion ?? '').trim();
    for (const [id, version] of Object.entries(source.versions ?? {})) {
        const branch = branchOf(version);
        const candidates = branch
            ? Object.entries(versions).filter(([existingId, existing]) => branchOf(existing) === branch && !claimed.has(existingId))
            : [];
        const name = (version as { name?: unknown })?.name;
        const match = candidates.find(([existingId]) => existingId === id)
            ?? candidates.find(([, existing]) => name !== undefined && (existing as { name?: unknown }).name === name)
            ?? candidates[0];
        if (match) {
            idMap.set(id, match[0]);
            claimed.add(match[0]);
            summary.versionsMatched += 1;
            continue;
        }
        const newId = versions[id] ? randomUUID() : id;
        idMap.set(id, newId);
        versions[newId] = { ...version, id: newId, isActive: false };
        summary.versionsAdded += 1;
    }
    const remap = (id: unknown): unknown => (typeof id === 'string' && idMap.has(id) ? idMap.get(id) : id);

    // 2. References to those versions inside the incoming projects.
    for (const project of source.projects ?? []) {
        for (const db of project?.dbs ?? []) {
            db.versionId = remap(db.versionId);
        }
        if (project?.selectedDbByVersion) {
            project.selectedDbByVersion = Object.fromEntries(
                Object.entries(project.selectedDbByVersion).map(([versionId, dbId]) => [String(remap(versionId)), dbId]));
        }
        for (const side of [project?.upgradeConfig?.from, project?.upgradeConfig?.to]) {
            if (side) {
                side.versionId = remap(side.versionId);
            }
        }
    }

    // 3. Projects: new ones whole, existing ones completed.
    const byKey = new Map(projects.map(project => [projectKey(project), project]));
    for (const project of source.projects ?? []) {
        const existing = byKey.get(projectKey(project));
        if (!existing) {
            projects.push(project);
            byKey.set(projectKey(project), project);
            summary.projectsAdded += 1;
            summary.databasesAdded += (project.dbs ?? []).length;
            continue;
        }
        existing.dbs = existing.dbs ?? [];
        existing.repos = existing.repos ?? [];
        existing.tickets = existing.tickets ?? [];
        const dbsAdded = addMissing(existing.dbs, project.dbs, db => db?.id);
        const reposAdded = addMissing(existing.repos, project.repos, repo => String(repo?.name ?? '').toLowerCase());
        const ticketsAdded = addMissing(existing.tickets, project.tickets, ticket => ticket?.id);
        summary.databasesAdded += dbsAdded;
        // Counted only when it actually gained something: a project that was
        // already complete is not "completed".
        if (dbsAdded + reposAdded + ticketsAdded > 0) {
            summary.projectsMerged += 1;
        }
        // selectedDbByVersion is not merged: it is a per-window choice.
    }

    // 4. Templates, by name.
    summary.templatesAdded = addMissing(templates, source.dbTemplates, template => template?.name);

    // 5. A legacy settings block only means something to a store with no
    // versions yet: anywhere else it would be migrated into a duplicate.
    if (source.settings && !data.settings && Object.keys(versions).length === 0) {
        data.settings = source.settings;
    }

    return { data: data as unknown as DebuggerData, summary };
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
