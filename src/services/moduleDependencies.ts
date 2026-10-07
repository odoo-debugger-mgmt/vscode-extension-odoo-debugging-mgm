/**
 * Resolves a module's dependencies by name to the folder Odoo would load,
 * so the Modules view can expand a dependency into its own dependencies.
 * Lookups happen one name at a time, when a row is expanded, and are cached
 * for the life of the locator (one tree build).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type DependencySource = 'project' | 'core' | 'missing';

export interface ResolvedDependency {
    name: string;
    /** The module folder, absent when the module was found nowhere. */
    path?: string;
    source: DependencySource;
}

/** Odoo module names are plain folder names; anything else is never looked up. */
const MODULE_NAME = /^[A-Za-z0-9_.-]+$/;

export class ModuleLocator {
    private readonly cache = new Map<string, Promise<ResolvedDependency>>();

    /**
     * @param projectModules module name → folder, from the project's repos
     * @param coreAddonsDirs core/enterprise/themes addons folders, in the
     *        order the server's --addons-path lists them (they come first
     *        there, so they win over a project module of the same name)
     */
    constructor(
        private readonly projectModules: ReadonlyMap<string, string>,
        private readonly coreAddonsDirs: readonly string[]
    ) {}

    locate(name: string): Promise<ResolvedDependency> {
        let pending = this.cache.get(name);
        if (!pending) {
            pending = this.lookup(name);
            this.cache.set(name, pending);
        }
        return pending;
    }

    private async lookup(name: string): Promise<ResolvedDependency> {
        if (MODULE_NAME.test(name) && name !== '.' && name !== '..') {
            for (const addonsDir of this.coreAddonsDirs) {
                const candidate = path.join(addonsDir, name);
                if (await isFile(path.join(candidate, '__manifest__.py'))) {
                    return { name, path: candidate, source: 'core' };
                }
            }
        }
        const own = this.projectModules.get(name);
        if (own) {
            return { name, path: own, source: 'project' };
        }
        return { name, source: 'missing' };
    }
}

async function isFile(filePath: string): Promise<boolean> {
    try {
        return (await fs.stat(filePath)).isFile();
    } catch {
        return false;
    }
}

/**
 * Whether a dependency row can expand. `branch` is the chain of module names
 * from the root module down to the row's parent: a dependency already on it
 * would expand forever.
 */
export function dependencyExpansion(
    dependency: ResolvedDependency,
    branch: readonly string[]
): 'expandable' | 'cycle' | 'missing' {
    if (!dependency.path) {
        return 'missing';
    }
    return branch.includes(dependency.name) ? 'cycle' : 'expandable';
}
