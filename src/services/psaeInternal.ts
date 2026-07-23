import { normalizePath, discoverModulesInRepos, ModuleDiscoveryResult, PsaeInternalDirectoryInfo } from '../utils';
import { ProjectModel } from '../models/project';

/**
 * Single source of truth for "psae-internal" module directories (Odoo PS
 * convention: directories matching ps*-internal hold internal modules that
 * are only added to the addons path when needed). Both the Modules tree and
 * the debugger arg builder resolve inclusion through this module, and the
 * project's `includedPsaeInternalPaths` override list ("path" to force
 * include, "!path" to force exclude) is only interpreted here.
 */

export const PSAE_INTERNAL_REGEX = /^ps[a-z]*-internal$/i;

export interface PsaeDirectoryState extends PsaeInternalDirectoryInfo {
    isManuallyIncluded: boolean;
    isManuallyExcluded: boolean;
    hasSelectedModules: boolean;
    hasDbModules: boolean;
    /** Final resolution: part of the addons path or not. */
    isIncluded: boolean;
}

/** Runs module discovery for the project, honoring its manual includes. */
export function collectModuleDiscovery(project: ProjectModel): ModuleDiscoveryResult {
    const manualIncludes = (project.includedPsaeInternalPaths ?? []).filter(entry => !entry.startsWith('!'));
    return discoverModulesInRepos(project.repos, { manualIncludePaths: manualIncludes });
}

/** Splits the raw override list into normalized include/exclude path sets. */
export function parsePsaeOverrides(includedPsaeInternalPaths: string[] | undefined): { manualIncludes: Set<string>; manualExcludes: Set<string> } {
    const manualIncludes = new Set<string>();
    const manualExcludes = new Set<string>();
    for (const entry of includedPsaeInternalPaths ?? []) {
        if (entry.startsWith('!')) {
            manualExcludes.add(normalizePath(entry.substring(1)));
        } else {
            manualIncludes.add(normalizePath(entry));
        }
    }
    return { manualIncludes, manualExcludes };
}

/**
 * Resolves the inclusion state of every discovered psae-internal directory.
 * A directory is included when it is manually included, or when it contains
 * selected or installed modules and is not manually excluded.
 */
export function resolvePsaeDirectories(args: {
    psaeDirectories: PsaeInternalDirectoryInfo[];
    includedPsaeInternalPaths: string[] | undefined;
    selectedModuleNames: Set<string>;
    installedModuleNames: Set<string>;
}): PsaeDirectoryState[] {
    const { manualIncludes, manualExcludes } = parsePsaeOverrides(args.includedPsaeInternalPaths);

    return args.psaeDirectories.map(dir => {
        const normalized = normalizePath(dir.path);
        const isManuallyIncluded = manualIncludes.has(normalized);
        const isManuallyExcluded = manualExcludes.has(normalized);
        const hasSelectedModules = dir.moduleNames.some(name => args.selectedModuleNames.has(name));
        const hasDbModules = dir.moduleNames.some(name => args.installedModuleNames.has(name));

        return {
            ...dir,
            path: normalized,
            isManuallyIncluded,
            isManuallyExcluded,
            hasSelectedModules,
            hasDbModules,
            isIncluded: isManuallyIncluded || (!isManuallyExcluded && (hasSelectedModules || hasDbModules))
        };
    });
}

/**
 * Rewrites the project's override list so that `dir` resolves to `include`.
 * Intent-based: clears any contradicting override first, then adds a manual
 * include/exclude only when the automatic resolution would not already give
 * the requested result. Returns the module names whose selections must be
 * dropped (when excluding a directory that has selected modules).
 */
export function setPsaeDirectoryIncluded(project: ProjectModel, dir: PsaeDirectoryState, include: boolean): { removedModuleNames: string[] } {
    const overrides = (project.includedPsaeInternalPaths ?? []).filter(entry => {
        const normalized = normalizePath(entry.startsWith('!') ? entry.substring(1) : entry);
        return normalized !== dir.path;
    });

    let removedModuleNames: string[] = [];

    if (include) {
        // Auto-inclusion only triggers with selected/installed modules;
        // otherwise pin the directory with a manual include.
        if (!dir.hasSelectedModules && !dir.hasDbModules) {
            overrides.push(dir.path);
        }
    } else {
        if (dir.hasSelectedModules || dir.hasDbModules) {
            overrides.push(`!${dir.path}`);
        }
        if (dir.hasSelectedModules) {
            removedModuleNames = [...dir.moduleNames];
        }
    }

    project.includedPsaeInternalPaths = overrides;
    return { removedModuleNames };
}
