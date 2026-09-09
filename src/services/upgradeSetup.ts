/**
 * Deduction for upgrade setup.
 *
 * Naming two databases already implies most of an upgrade: each database says
 * which Odoo series it runs, each series picks a version, and a repository's
 * branch names usually say which side they belong to. This module works out
 * what can be known so the flow only asks for what cannot.
 *
 * The pure parts live here and are tested directly; the parts that read a
 * database or the filesystem are thin wrappers around services that already
 * exist.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { branchToSeries } from './versionProposal';
import { detectOdooSeries } from './database';
import { logger } from './logger';

export interface BranchProposal {
    /** The branch to use, when the repository's branches name exactly one. */
    branch?: string;
    /** Branches on that series, for the pick when it has to be asked. */
    candidates: string[];
}

/**
 * Which branch of a repository belongs to a series.
 *
 * One candidate is an answer; several is a question, because `17.0` and
 * `17.0-acme` are both honestly on 17.0 and only the developer knows which one
 * this upgrade runs.
 */
export function proposeBranchForSeries(branches: string[], series: string): BranchProposal {
    const wanted = series.trim();
    if (!wanted) {
        return { candidates: [] };
    }
    const candidates = branches
        .map(branch => branch.trim())
        .filter(branch => branch && branchToSeries(branch) === wanted);

    return {
        branch: candidates.length === 1 ? candidates[0] : undefined,
        candidates
    };
}

export interface ModuleStaging {
    /** Names to mark `install` on the target database. */
    staged: string[];
    /** Source modules the target version does not have. */
    unavailable: string[];
}

/**
 * Splits the source's installed modules into what the target can install and
 * what it cannot.
 *
 * `base` is dropped: Odoo installs it regardless, and naming it in `-i` says
 * nothing. Anything the target version does not ship is held back rather than
 * staged, because `-i` fails on the first unknown module and would take the
 * whole launch down with it.
 *
 * `availableInTarget` is undefined when the target version has not been built
 * yet; nothing can be checked then, so everything is staged and the check is
 * left to the first launch.
 */
export function splitStagedModules(
    sourceInstalled: Iterable<string>,
    availableInTarget?: Set<string>
): ModuleStaging {
    const names = [...new Set(sourceInstalled)]
        .map(name => name.trim())
        .filter(name => name && name !== 'base')
        .sort((left, right) => left.localeCompare(right));

    if (!availableInTarget) {
        return { staged: names, unavailable: [] };
    }

    return {
        staged: names.filter(name => availableInTarget.has(name)),
        unavailable: names.filter(name => !availableInTarget.has(name))
    };
}

/** The Odoo core addons directories a version's source tree provides. */
export function coreAddonsPaths(settings: {
    odooPath?: string;
    enterprisePath?: string;
    designThemesPath?: string;
}): string[] {
    const paths: string[] = [];
    if (settings.enterprisePath?.trim()) {
        paths.push(settings.enterprisePath.trim());
    }
    if (settings.designThemesPath?.trim()) {
        paths.push(settings.designThemesPath.trim());
    }
    const odooPath = settings.odooPath?.trim();
    if (odooPath) {
        paths.push(path.join(odooPath, 'odoo', 'addons'), path.join(odooPath, 'addons'));
    }
    return paths;
}

/**
 * The module names available under a set of addons directories.
 *
 * One level deep and manifest-based, which is how Odoo itself reads an addons
 * path. Returns undefined when none of the directories exist, so callers can
 * tell "this version has no modules" from "this version is not built yet".
 */
export function collectAvailableModules(addonsPaths: string[]): Set<string> | undefined {
    const names = new Set<string>();
    let readAny = false;

    for (const addonsPath of addonsPaths) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(addonsPath, { withFileTypes: true });
        } catch {
            continue;
        }
        readAny = true;
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            if (fs.existsSync(path.join(addonsPath, entry.name, '__manifest__.py'))) {
                names.add(entry.name);
            }
        }
    }

    return readAny ? names : undefined;
}

/**
 * The Odoo series a database runs.
 *
 * Probed from the database itself first, because that is the only source that
 * cannot be stale: a version link is whatever was assigned when the database
 * was created and may never have been revisited.
 */
export async function resolveDatabaseSeries(
    dbId: string,
    linkedSeries: string | undefined
): Promise<string | undefined> {
    try {
        const detected = await detectOdooSeries(dbId);
        if (detected) {
            return detected;
        }
    } catch (error) {
        logger.warn(`Could not read the Odoo series of "${dbId}":`, error);
    }
    const fallback = linkedSeries?.trim();
    return fallback || undefined;
}
