/**
 * The active version's core checkouts, as multi-root workspace folders. Each
 * version owns its own worktree, so a project workspace that lists only the
 * project repos opens the custom addons without the Odoo source being run -
 * and breakpoints set in a stale checkout bind to the wrong files.
 */
import { normalizePath } from '../utils';

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
