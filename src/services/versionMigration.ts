/**
 * Classifies how far an existing version is from the provisioned layout.
 *
 * Versions predate provisioning, or were built under an earlier provisioning
 * root. A version still pointing at a deleted worktree under an old root is
 * what produced the shipped "'odt/19.0' is already used by worktree at ..."
 * failure, so this is offered as a check rather than left to be discovered.
 *
 * Pure: takes an `exists` probe so every branch is testable.
 */
import * as path from 'node:path';

export type VersionHealth = 'healthy' | 'relocated' | 'missing' | 'unprovisioned' | 'source-repo';

export interface VersionDiagnosis {
    versionId: string;
    name: string;
    health: VersionHealth;
    odooPath?: string;
    /** Where provisioning would put this version today. */
    expectedOdooPath: string;
    detail: string;
}

export interface VersionLike {
    id: string;
    name: string;
    odooVersion: string;
    odooPath?: string;
    pythonPath?: string;
}

function slugifyBranch(branch: string): string {
    return branch.replace(/[^A-Za-z0-9._-]+/g, '-');
}

export function diagnoseVersion(
    version: VersionLike,
    root: string,
    exists: (candidate: string) => boolean,
    sourceRepo?: string
): VersionDiagnosis {
    const expectedOdooPath = path.join(root, `odoo-${slugifyBranch(version.odooVersion)}`);
    const odooPath = version.odooPath?.trim() || undefined;
    const pythonPath = version.pythonPath?.trim() || undefined;

    const base = { versionId: version.id, name: version.name, odooPath, expectedOdooPath };

    if (!odooPath || !pythonPath) {
        return { ...base, health: 'unprovisioned', detail: 'No environment has been built for this version.' };
    }
    // Tested before the interpreter guards, not after. The legacy 1.2 shape is
    // a version running out of the source repository whose hand-built venv is
    // also gone; checking the interpreter first classified exactly that case as
    // "unprovisioned" and dropped it from rank 0 to rank 2, losing the only
    // wording that says why it is unsafe rather than untidy.
    if (sourceRepo?.trim() && path.resolve(odooPath) === path.resolve(sourceRepo.trim())) {
        return {
            ...base,
            health: 'source-repo',
            detail: `It runs out of the source repository at ${odooPath}. Activating it switches that repository's `
                + `branch, and switching that repository changes what this version runs. `
                + `Migrating gives it its own worktree at ${expectedOdooPath}.`
        };
    }

    if (!exists(odooPath)) {
        return {
            ...base,
            health: 'missing',
            detail: `Its checkout at ${odooPath} is gone. Re-provisioning rebuilds it at ${expectedOdooPath}.`
        };
    }
    if (!exists(pythonPath)) {
        return { ...base, health: 'unprovisioned', detail: `Its interpreter at ${pythonPath} is gone.` };
    }
    if (path.resolve(odooPath) !== path.resolve(expectedOdooPath)) {
        return {
            ...base,
            health: 'relocated',
            detail: `It works, but lives at ${odooPath} rather than ${expectedOdooPath}. Leaving it is fine; re-provisioning moves it.`
        };
    }

    return { ...base, health: 'healthy', detail: 'Provisioned and in the expected location.' };
}

/** Versions worth offering to fix, worst first. */
export function needsAttention(diagnoses: VersionDiagnosis[]): VersionDiagnosis[] {
    const rank: Record<VersionHealth, number> = {
        'source-repo': 0,
        missing: 1,
        unprovisioned: 2,
        relocated: 3,
        healthy: 4
    };
    return diagnoses
        .filter(entry => entry.health !== 'healthy')
        .sort((a, b) => rank[a.health] - rank[b.health]);
}

/**
 * The healths where something is broken or unsafe. `relocated` is left out
 * deliberately: it works, moving it is optional, and a nag about tidiness is
 * worse than none.
 */
export function migratable(diagnoses: VersionDiagnosis[]): VersionDiagnosis[] {
    const unsafe = new Set<VersionHealth>(['source-repo', 'missing', 'unprovisioned']);
    return needsAttention(diagnoses).filter(entry => unsafe.has(entry.health));
}
