/**
 * The active version's core checkouts, as multi-root workspace folders. Each
 * version owns its own worktree, so a project workspace that lists only the
 * project repos opens the custom addons without the Odoo source being run -
 * and breakpoints set in a stale checkout bind to the wrong files.
 */
import { normalizePath } from '../utils';
import type { ResolvedRepo } from './repoPaths';

export interface WorkspaceFolderEntry {
    path: string;
    name?: string;
}

interface VersionLike {
    name: string;
    settings: {
        odooPath?: string;
        enterprisePath?: string;
        designThemesPath?: string;
    };
}

export function versionFolderEntries(
    version: VersionLike | undefined,
    existingPaths: string[]
): WorkspaceFolderEntry[] {
    if (!version) {
        return [];
    }

    const seen = new Set(existingPaths.map(entry => normalizePath(entry)));
    const entries: WorkspaceFolderEntry[] = [];

    const add = (rawPath: string | undefined, label: string) => {
        const trimmed = rawPath?.trim();
        if (!trimmed) {
            return;
        }
        const resolved = normalizePath(trimmed);
        if (seen.has(resolved)) {
            return;
        }
        seen.add(resolved);
        entries.push({ path: resolved, name: `${label} (${version.name})` });
    };

    add(version.settings.odooPath, 'odoo');
    add(version.settings.enterprisePath, 'enterprise');
    add(version.settings.designThemesPath, 'design-themes');

    return entries;
}

/**
 * Project repositories as workspace folders, resolved to the active version's
 * worktrees. A worktree is labelled with its branch so two open copies of the
 * same repository are told apart at a glance.
 */
export function repoFolderEntries(resolved: ResolvedRepo[], existingPaths: string[]): WorkspaceFolderEntry[] {
    const seen = new Set(existingPaths.map(entry => normalizePath(entry)));
    const entries: WorkspaceFolderEntry[] = [];

    for (const entry of resolved) {
        const resolvedPath = normalizePath(entry.path);
        if (seen.has(resolvedPath)) {
            continue;
        }
        seen.add(resolvedPath);
        entries.push(entry.isWorktree && entry.branch
            ? { path: resolvedPath, name: `${entry.repo.name} (${entry.branch})` }
            : { path: resolvedPath });
    }

    return entries;
}
