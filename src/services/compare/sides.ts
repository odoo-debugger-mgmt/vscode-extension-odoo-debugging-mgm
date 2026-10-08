/**
 * The code roots of the two sides of a comparison.
 */
import * as path from 'node:path';
import type { DatabaseModel } from '../../models/db';
import type { ProjectModel } from '../../models/project';
import { VersionsService } from '../../versionsService';
import { resolveOptionalPath } from '../../utils';
import { partnerFor, upgradePair, type PairProject } from '../../views/viewPairing';
import { resolveViewDoctorTarget } from '../../views/viewDoctorView';
import { comparisonSides, type ResolvedPartner } from '../comparisonPartner';
import { resolveReposForDatabase } from '../versionRepos';
import { coreAddonsPaths } from '../upgradeSetup';
import type { CodeRoot, SideRoots } from './counterpart';

/** The roots a version and a set of resolved repos give; pure. */
export function sideRolesFor(
    settings: { odooPath?: string; enterprisePath?: string; designThemesPath?: string },
    repos: Array<{ repo: { name: string }; path: string }>
): CodeRoot[] {
    const roots: CodeRoot[] = [];
    const odoo = settings.odooPath?.trim();
    if (odoo) {
        roots.push({ role: 'odoo', path: odoo });
    }
    const enterprise = settings.enterprisePath?.trim();
    const themes = settings.designThemesPath?.trim();
    const odooAddons = odoo ? path.join(odoo, 'odoo', 'addons') : undefined;
    const addons = odoo ? path.join(odoo, 'addons') : undefined;
    for (const p of coreAddonsPaths(settings)) {
        const role = p === enterprise ? 'core:enterprise'
            : p === themes ? 'core:themes'
            : p === odooAddons ? 'core:odoo/odoo/addons'
            : p === addons ? 'core:odoo/addons'
            : undefined;
        if (role) {
            roots.push({ role, path: p });
        }
    }
    for (const { repo, path: repoPath } of repos) {
        roots.push({ role: `repo:${repo.name}`, path: repoPath });
    }
    return roots;
}

export async function sideRootsFor(
    project: Pick<ProjectModel, 'repos'> & { dbs?: DatabaseModel[] },
    db: { id: string; versionId?: string },
    label: string
): Promise<SideRoots | undefined> {
    const version = db.versionId ? VersionsService.getInstance().getVersion(db.versionId) : undefined;
    if (!version) {
        return undefined;
    }
    const model = (project.dbs ?? []).find(d => d.id === db.id) ?? (db as DatabaseModel);
    const repos = await resolveReposForDatabase(project, model);
    return { label, roots: sideRolesFor({
        odooPath: resolveOptionalPath(version.settings.odooPath),
        enterprisePath: resolveOptionalPath(version.settings.enterprisePath),
        designThemesPath: resolveOptionalPath(version.settings.designThemesPath)
    }, repos) };
}

export type CodeSides = {
    thisDb: string;
    partner: ResolvedPartner;
    left: SideRoots;
    right: SideRoots;
    thisSide: 'left' | 'right';
};

export async function codeSides(
    project: (PairProject & Pick<ProjectModel, 'repos'> & { dbs?: DatabaseModel[] }) | undefined,
    options: { ask: boolean; onStored?: () => void; db?: string }
): Promise<CodeSides | { error: string } | undefined> {
    if (!project) {
        return { error: 'Open a project first.' };
    }
    const thisDb = options.db ?? resolveViewDoctorTarget(project as Parameters<typeof resolveViewDoctorTarget>[0])?.dbName;
    if (!thisDb) {
        return { error: 'Select a database first.' };
    }
    const partner = await partnerFor(project, thisDb, { ask: options.ask, onStored: options.onStored });
    if (!partner) {
        return undefined;
    }
    if (partner.kind === 'checkpoint') {
        return { error: `A checkpoint runs the same code as ${thisDb}. Compare code with a database partner.` };
    }
    const names = comparisonSides(thisDb, partner, upgradePair(project));
    const dbs = project.dbs ?? [];
    const rootsOf = (name: string) => sideRootsFor(
        project,
        dbs.find(d => d.id === name) ?? { id: name, versionId: name === partner.dbName ? partner.versionId : undefined },
        name
    );
    const [left, right] = await Promise.all([rootsOf(names.left), rootsOf(names.right)]);
    if (!left || !right) {
        return { error: `The version of ${!left ? names.left : names.right} is unknown, so its code cannot be found.` };
    }
    return { thisDb, partner, left, right, thisSide: names.left === thisDb ? 'left' : 'right' };
}
