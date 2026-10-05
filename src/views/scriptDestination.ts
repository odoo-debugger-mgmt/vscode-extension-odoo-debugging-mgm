/**
 * Where Create / Add to Upgrade Script puts the script: a module's
 * migrations/<version>/ folder, or an untitled editor. The last choice is
 * remembered per project in workspaceState and offered first. Only the
 * project's own modules are offered, never core or enterprise ones.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { NOT_SHIPPED_MODULES } from '../services/views/viewNotes';
import { bumpVersion, fullVersion, isVersionFolder, manifestVersion } from '../services/views/migrationsFolder';

export interface ModuleChoice {
    name: string;
    path: string;
    repoName: string;
}

export type RememberedDestination = { kind: 'untitled' } | { kind: 'module'; module: string; version: string };
export type ScriptDestination = { kind: 'untitled' } | { kind: 'module'; module: ModuleChoice; version: string };

export interface DestinationItem extends vscode.QuickPickItem {
    destination?: { kind: 'untitled' } | { kind: 'module'; module: ModuleChoice };
}

const UNTITLED_LABEL = '$(new-file) Untitled Python Editor';

export function destinationKey(projectKey: string): string {
    return `viewDoctor.scriptDestination:${projectKey}`;
}

export function normalizeDestination(raw: unknown): RememberedDestination | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const value = raw as Record<string, unknown>;
    if (value.kind === 'untitled') {
        return { kind: 'untitled' };
    }
    if (value.kind === 'module' && typeof value.module === 'string' && value.module
        && typeof value.version === 'string' && isVersionFolder(value.version)) {
        return { kind: 'module', module: value.module, version: value.version };
    }
    return undefined;
}

/** How many of the views each module owns by external id; Studio and export ids own nothing. */
export function ownerCounts(views: Array<{ xmlid: string | null }>): Map<string, number> {
    const owners = new Map<string, number>();
    for (const { xmlid } of views) {
        const dot = xmlid?.indexOf('.') ?? -1;
        const module = xmlid && dot > 0 ? xmlid.slice(0, dot) : undefined;
        if (module && !NOT_SHIPPED_MODULES.includes(module)) {
            owners.set(module, (owners.get(module) ?? 0) + 1);
        }
    }
    return owners;
}

function isInside(child: string, root: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(child));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The modules outside the version's Odoo and enterprise checkouts. */
export function withoutCoreModules(modules: ModuleChoice[], coreRoots: string[]): ModuleChoice[] {
    const roots = coreRoots.filter(Boolean);
    return modules.filter(module => !roots.some(root => isInside(module.path, root)));
}

export function destinationItems(modules: ModuleChoice[], owners: Map<string, number>, total: number, remembered: RememberedDestination | undefined): DestinationItem[] {
    const untitled: DestinationItem = { label: UNTITLED_LABEL, description: 'not saved anywhere', destination: { kind: 'untitled' } };
    const byName = new Map(modules.map(module => [module.name, module]));
    const moduleItem = (module: ModuleChoice, description: string): DestinationItem =>
        ({ label: module.name, description, detail: module.path, destination: { kind: 'module', module } });
    const first: DestinationItem[] = [];
    const used = new Set<string>();
    if (remembered?.kind === 'untitled') {
        first.push({ ...untitled, description: 'last used' });
    } else if (remembered?.kind === 'module' && byName.has(remembered.module)) {
        first.push(moduleItem(byName.get(remembered.module)!, `last used · migrations/${remembered.version}`));
        used.add(remembered.module);
    }
    const owning = [...owners].filter(([name]) => byName.has(name) && !used.has(name))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [name, count] of owning) {
        first.push(moduleItem(byName.get(name)!, total === 1 ? 'owns the view' : `owns ${count} of the ${total} views`));
        used.add(name);
    }
    const rest = modules.filter(module => !used.has(module.name)).sort((a, b) => a.name.localeCompare(b.name))
        .map(module => moduleItem(module, module.repoName));
    const items: DestinationItem[] = [...first];
    if (rest.length > 0) {
        items.push({ label: 'Modules', kind: vscode.QuickPickItemKind.Separator }, ...rest);
    }
    if (remembered?.kind !== 'untitled') {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, untitled);
    }
    return items;
}

export function versionPrefill(module: ModuleChoice, remembered: RememberedDestination | undefined, manifestText: string | undefined,
    folderExists: (dir: string) => boolean, series: string | undefined): string {
    if (remembered?.kind === 'module' && remembered.module === module.name && isVersionFolder(remembered.version, series)
        && folderExists(path.join(module.path, 'migrations', remembered.version))) {
        return remembered.version;
    }
    const version = manifestText === undefined ? undefined : manifestVersion(manifestText);
    const bumped = series ? bumpVersion(fullVersion(version ?? '1.0', series)) : bumpVersion(version);
    // Only a folder Odoo will run and accept as a manifest version is offered.
    return bumped && isVersionFolder(bumped, series) ? bumped : '';
}

function readManifest(modulePath: string): string | undefined {
    try {
        return fs.readFileSync(path.join(modulePath, '__manifest__.py'), 'utf-8');
    } catch {
        return undefined;
    }
}

export async function pickDestination(options: {
    modules: ModuleChoice[];
    owners: Map<string, number>;
    total: number;
    memento: vscode.Memento;
    projectKey: string;
    title: string;
    series: string | undefined;
}): Promise<ScriptDestination | undefined> {
    const key = destinationKey(options.projectKey);
    const remembered = normalizeDestination(options.memento.get(key));
    const picked = await vscode.window.showQuickPick(destinationItems(options.modules, options.owners, options.total, remembered), {
        title: options.title,
        placeHolder: 'Where should the upgrade script go?',
        matchOnDescription: true
    });
    if (!picked?.destination) {
        return undefined;
    }
    if (picked.destination.kind === 'untitled') {
        await options.memento.update(key, { kind: 'untitled' });
        return { kind: 'untitled' };
    }
    const module = picked.destination.module;
    const value = await vscode.window.showInputBox({
        title: options.title,
        prompt: `Version folder under ${module.name}/migrations/. Odoo runs it when the module's version goes up to it.`,
        value: versionPrefill(module, remembered, readManifest(module.path), fs.existsSync, options.series),
        validateInput: input => isVersionFolder(input.trim(), options.series) ? undefined
            : options.series ? `A version such as ${options.series}.1.0.1.` : 'A version such as 1.0.1.'
    });
    if (value === undefined) {
        return undefined;
    }
    const version = value.trim();
    await options.memento.update(key, { kind: 'module', module: module.name, version });
    return { kind: 'module', module, version };
}
