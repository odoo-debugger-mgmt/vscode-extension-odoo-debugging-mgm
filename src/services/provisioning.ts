/**
 * Provisioning orchestrator. Probes what already exists on disk, plans only
 * the missing steps, and executes those - so a failed run resumes where it
 * stopped and an environment built by hand is adopted rather than rebuilt.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import { readOdooPythonWindow } from './odooRequirements';
import { ensureWorktree } from './worktree';
import { ensureInterpreter, ensureVenv, installRequirements, resolveUv, venvPythonPath } from './pythonToolchain';
import { checkSystemDeps, SystemDepReport } from './systemDeps';
import { logger } from './logger';

export interface ProvisionSpec {
    branch: string;
    sourceRepoPath: string;
    enterpriseRepoPath?: string;
    designThemesRepoPath?: string;
    root: string;
}

export interface ProvisionProbe {
    odooWorktree: boolean;
    enterpriseWorktree: boolean;
    designThemesWorktree: boolean;
    venv: boolean;
    requirements: boolean;
}

export interface ProvisionStep {
    id: string;
    label: string;
    status: 'satisfied' | 'needed';
}

export interface ProvisionPaths {
    odooPath: string;
    enterprisePath?: string;
    designThemesPath?: string;
    venvPath: string;
}

export interface ProvisionResult {
    paths: ProvisionPaths;
    managedPaths: string[];
    pythonVersion: string;
    warnings: string[];
    deps: SystemDepReport[];
}

export function slugifyBranch(branch: string): string {
    return branch.replace(/[^A-Za-z0-9._-]+/g, '-');
}

export function resolveProvisionPaths(spec: ProvisionSpec): ProvisionPaths {
    const slug = slugifyBranch(spec.branch);
    return {
        odooPath: path.join(spec.root, `odoo-${slug}`),
        enterprisePath: spec.enterpriseRepoPath ? path.join(spec.root, `enterprise-${slug}`) : undefined,
        designThemesPath: spec.designThemesRepoPath ? path.join(spec.root, `design-themes-${slug}`) : undefined,
        venvPath: path.join(spec.root, `venv-${slug}`)
    };
}

export function buildPlan(spec: ProvisionSpec, probe: ProvisionProbe): ProvisionStep[] {
    const mark = (satisfied: boolean): ProvisionStep['status'] => (satisfied ? 'satisfied' : 'needed');
    const steps: ProvisionStep[] = [
        { id: 'worktree:odoo', label: `Worktree for odoo (${spec.branch})`, status: mark(probe.odooWorktree) }
    ];

    if (spec.enterpriseRepoPath) {
        steps.push({
            id: 'worktree:enterprise',
            label: `Worktree for enterprise (${spec.branch})`,
            status: mark(probe.enterpriseWorktree)
        });
    }
    if (spec.designThemesRepoPath) {
        steps.push({
            id: 'worktree:design-themes',
            label: `Worktree for design-themes (${spec.branch})`,
            status: mark(probe.designThemesWorktree)
        });
    }

    steps.push({ id: 'venv', label: 'Virtualenv', status: mark(probe.venv) });
    steps.push({ id: 'requirements', label: 'Python requirements', status: mark(probe.requirements) });
    return steps;
}

export function isFullySatisfied(plan: ProvisionStep[]): boolean {
    return plan.every(step => step.status === 'satisfied');
}

export async function probeProvision(spec: ProvisionSpec): Promise<ProvisionProbe> {
    const paths = resolveProvisionPaths(spec);
    const venvExists = fs.existsSync(venvPythonPath(paths.venvPath));

    // Requirements count as installed when the venv can import the packages
    // Odoo cannot start without.
    let requirements = false;
    if (venvExists) {
        const deps = await checkSystemDeps(paths.venvPath);
        requirements = deps.find(entry => entry.id === 'buildDeps')?.present ?? false;
    }

    return {
        odooWorktree: fs.existsSync(path.join(paths.odooPath, 'odoo-bin')),
        enterpriseWorktree: !paths.enterprisePath || fs.existsSync(paths.enterprisePath),
        designThemesWorktree: !paths.designThemesPath || fs.existsSync(paths.designThemesPath),
        venv: venvExists,
        requirements
    };
}

export async function executeProvision(
    spec: ProvisionSpec,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token?: vscode.CancellationToken
): Promise<ProvisionResult> {
    const paths = resolveProvisionPaths(spec);
    const managedPaths: string[] = [];
    const warnings: string[] = [];

    fs.mkdirSync(spec.root, { recursive: true });

    progress.report({ message: `Worktree for odoo (${spec.branch})` });
    const odooTree = await ensureWorktree(spec.sourceRepoPath, spec.branch, paths.odooPath, token);
    paths.odooPath = odooTree.path;
    if (odooTree.created) {
        managedPaths.push(odooTree.path);
    }

    if (spec.enterpriseRepoPath && paths.enterprisePath) {
        progress.report({ message: `Worktree for enterprise (${spec.branch})` });
        try {
            const tree = await ensureWorktree(spec.enterpriseRepoPath, spec.branch, paths.enterprisePath, token);
            paths.enterprisePath = tree.path;
            if (tree.created) {
                managedPaths.push(tree.path);
            }
        } catch (error) {
            warnings.push(`enterprise: ${error instanceof Error ? error.message : String(error)}`);
            paths.enterprisePath = undefined;
        }
    }

    if (spec.designThemesRepoPath && paths.designThemesPath) {
        progress.report({ message: `Worktree for design-themes (${spec.branch})` });
        try {
            const tree = await ensureWorktree(spec.designThemesRepoPath, spec.branch, paths.designThemesPath, token);
            paths.designThemesPath = tree.path;
            if (tree.created) {
                managedPaths.push(tree.path);
            }
        } catch (error) {
            warnings.push(`design-themes: ${error instanceof Error ? error.message : String(error)}`);
            paths.designThemesPath = undefined;
        }
    }

    progress.report({ message: 'Resolving Python interpreter' });
    const window = await readOdooPythonWindow(paths.odooPath);
    if (window.source === 'fallback') {
        warnings.push(`Could not read this branch's Python requirement; assuming ${window.minPython.join('.')}.`);
    }
    const interpreter = await ensureInterpreter(window, token);
    if (interpreter.warning) {
        warnings.push(interpreter.warning);
    }

    const uv = await resolveUv();
    if (!uv) {
        warnings.push('uv is not available; using the standard library venv and pip.');
    }

    progress.report({ message: 'Creating virtualenv' });
    await ensureVenv(interpreter.path, paths.venvPath, uv, token);
    if (!managedPaths.includes(paths.venvPath)) {
        managedPaths.push(paths.venvPath);
    }

    progress.report({ message: 'Installing requirements (this takes a few minutes)' });
    await installRequirements(
        paths.venvPath,
        path.join(paths.odooPath, 'requirements.txt'),
        uv,
        line => {
            const trimmed = line.trim();
            if (trimmed) {
                progress.report({ message: trimmed.slice(0, 120) });
            }
        },
        token
    );

    progress.report({ message: 'Checking system dependencies' });
    const deps = await checkSystemDeps(paths.venvPath);

    logger.info(`[provisioning] ${spec.branch} provisioned at ${paths.odooPath}`);
    return {
        paths,
        managedPaths,
        pythonVersion: interpreter.version.join('.'),
        warnings,
        deps
    };
}
