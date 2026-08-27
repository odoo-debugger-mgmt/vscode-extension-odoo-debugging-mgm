import * as vscode from 'vscode';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { normalizePath } from '../utils';
import { SettingsModel } from '../models/settings';
import { checkoutBranchViaSourceControl } from './gitService';
import { invalidateGitBranchCache } from './runtimeCache';

const checkoutHooksOutput = vscode.window.createOutputChannel('Odoo Debugger: Branch Hooks');

export interface RepoCheckoutResult {
    name: string;
    success: boolean;
    message: string;
}

function quoteForSingleQuotedShell(value: string): string {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/** Label used in the hook output channel. */
type HookPhase = 'post-switch';

function buildHookExecutionScript(
    commands: string[],
    phase: HookPhase,
    contextLabel: string
): string {
    const lines: string[] = ['set -e'];

    commands.forEach((command, index) => {
        const prefix = `[${phase}] ${contextLabel}: [${index + 1}/${commands.length}]`;
        lines.push(`__odt_cmd=${quoteForSingleQuotedShell(command)}`);
        lines.push(`__odt_prefix=${quoteForSingleQuotedShell(prefix)}`);
        lines.push('printf \'%s\\n\' "$__odt_prefix START $__odt_cmd"');
        lines.push('set +e');
        lines.push('eval "$__odt_cmd"');
        lines.push('__odt_exit=$?');
        lines.push('set -e');
        lines.push('printf \'%s\\n\' "$__odt_prefix END exit=$__odt_exit"');
        lines.push('if [ $__odt_exit -ne 0 ]; then');
        lines.push('  exit $__odt_exit');
        lines.push('fi');
    });

    return lines.join('\n');
}

async function runCheckoutHookCommands(
    commands: string[] | undefined,
    phase: HookPhase,
    cwd: string,
    contextLabel: string,
    progress?: vscode.Progress<{ message?: string; increment?: number; }>
): Promise<boolean> {
    if (!Array.isArray(commands) || commands.length === 0) {
        return true;
    }

    const normalizedCommands = commands.map(cmd => cmd.trim()).filter(Boolean);
    if (normalizedCommands.length === 0) {
        return true;
    }

    progress?.report({ message: `${contextLabel}: ${phase} (${normalizedCommands.length} command(s))` });
    checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: running ${normalizedCommands.length} command(s) in: ${cwd}`);
    normalizedCommands.forEach((command, index) => {
        checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: [${index + 1}/${normalizedCommands.length}] $ ${command}`);
    });

    const script = buildHookExecutionScript(normalizedCommands, phase, contextLabel);
    const taskStartedAt = Date.now();
    let stderrTail = '';
    const exitCode = await new Promise<number | undefined>((resolve) => {
        const child = spawn('/bin/bash', ['-lc', script], {
            cwd,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        const stdoutBuffer = { pending: '' };
        const stderrBuffer = { pending: '' };

        const appendBufferedLines = (chunk: Buffer, buffer: { pending: string }) => {
            const text = chunk.toString();
            if (!text) {
                return;
            }
            const combined = buffer.pending + text;
            const lines = combined.split(/\r?\n/);
            buffer.pending = lines.pop() ?? '';
            for (const line of lines) {
                checkoutHooksOutput.appendLine(line);
            }
        };

        const flushBuffer = (buffer: { pending: string }) => {
            if (!buffer.pending) {
                return;
            }
            checkoutHooksOutput.appendLine(buffer.pending);
            buffer.pending = '';
        };

        child.stdout?.on('data', chunk => {
            appendBufferedLines(chunk, stdoutBuffer);
        });
        child.stderr?.on('data', chunk => {
            appendBufferedLines(chunk, stderrBuffer);
            stderrTail += chunk.toString();
            if (stderrTail.length > 2000) {
                stderrTail = stderrTail.slice(-2000);
            }
        });

        child.on('error', error => {
            stderrTail = error.message;
            resolve(undefined);
        });

        child.on('close', code => {
            flushBuffer(stdoutBuffer);
            flushBuffer(stderrBuffer);
            resolve(code ?? undefined);
        });
    });
    const durationMs = Date.now() - taskStartedAt;

    if (exitCode !== 0) {
        const failureReason = exitCode === undefined ? 'no exit code' : `exit ${exitCode}`;
        if (stderrTail.trim()) {
            checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: stderr tail:\n${stderrTail.trim()}`);
        }
        checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: FAILED (${failureReason}, duration=${durationMs}ms)`);
        checkoutHooksOutput.show(true);
        return false;
    }

    checkoutHooksOutput.appendLine(`[${phase}] ${contextLabel}: OK (duration=${durationMs}ms)`);
    return true;
}

async function runGitCheckoutCli(repoPath: string, branch: string): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve) => {
        const child = spawn('git', ['checkout', branch], { cwd: repoPath, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';

        child.stderr?.on('data', chunk => {
            stderr += chunk.toString();
        });

        child.on('error', error => {
            resolve({ ok: false, message: error.message });
        });

        child.on('close', code => {
            const details = stderr.trim();
            if (code === 0 || details.includes(`Already on '${branch}'`)) {
                resolve({
                    ok: true,
                    message: details.includes(`Already on '${branch}'`)
                        ? `Already on branch "${branch}"`
                        : `Switched to branch "${branch}"`
                });
                return;
            }

            resolve({
                ok: false,
                message: details || `git checkout exited with code ${code ?? 'unknown'}`
            });
        });
    });
}

/**
 * Checks out a branch on a single repository, preferring the VS Code Git API
 * and falling back to the git CLI.
 */
export async function checkoutRepoBranch(repoPath: string, branch: string): Promise<{ ok: boolean; message: string }> {
    const sourceControlSucceeded = await checkoutBranchViaSourceControl(repoPath, branch);
    if (sourceControlSucceeded) {
        invalidateGitBranchCache(repoPath);
        return { ok: true, message: `Switched to branch "${branch}"` };
    }

    const result = await runGitCheckoutCli(repoPath, branch);
    if (result.ok) {
        invalidateGitBranchCache(repoPath);
        try {
            await vscode.commands.executeCommand('git.refresh');
        } catch {
            // Best-effort SCM refresh after external checkout.
        }
    }
    return result;
}

/**
 * Aligns the core Odoo repositories (odoo / enterprise / design-themes) to the
 * given branch, running the version's post-switch commands per repository.
 * When `needsCheckout` is false the repositories are already on the right
 * branch - each version owns its worktree - and only the hooks run.
 * Returns per-repo results; callers own the summary messaging.
 */
export async function alignCoreRepos(
    settings: SettingsModel,
    branch: string,
    needsCheckout: boolean
): Promise<RepoCheckoutResult[]> {
    const repos = [
        { name: 'Odoo', path: settings.odooPath },
        { name: 'Enterprise', path: settings.enterprisePath },
        { name: 'Design Themes', path: settings.designThemesPath }
    ]
        .filter(repo => repo.path && repo.path.trim() !== '')
        .map(repo => ({ name: repo.name, path: normalizePath(repo.path) }));

    if (repos.length === 0) {
        return [{ name: 'Odoo', success: false, message: 'No core repository paths are configured' }];
    }

    // The version's own commands win; the global default is the fallback, so a
    // version that defines none still behaves as configured.
    const configured = vscode.workspace
        .getConfiguration('odooDebugger.defaultVersion')
        .get<string[]>('postSwitchCommands', []);
    const postSwitchCommands = settings.postSwitchCommands.length > 0 ? settings.postSwitchCommands : configured;

    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: needsCheckout ? `Switching to branch: ${branch}` : `Aligning ${branch}`,
        cancellable: false
    }, async (progress) => {
        const operationStartedAt = Date.now();
        const elapsed = () => `${Date.now() - operationStartedAt}ms`;
        const totalRepos = repos.length;
        let completedRepos = 0;

        const processRepository = async (repo: { name: string; path: string }): Promise<RepoCheckoutResult> => {
            checkoutHooksOutput.appendLine(`[checkout] ${repo.name}: pipeline start t+${elapsed()}`);
            progress.report({ message: `${repo.name}: processing` });

            if (!fs.existsSync(repo.path)) {
                return {
                    name: repo.name,
                    success: false,
                    message: `Repository path does not exist: ${repo.path}`
                };
            }

            let checkoutMessage = 'Already on the target branch';
            if (needsCheckout) {
                checkoutHooksOutput.appendLine(`[checkout] ${repo.name}: checkout start t+${elapsed()}`);
                const checkoutResult = await checkoutRepoBranch(repo.path, branch);
                if (!checkoutResult.ok) {
                    checkoutHooksOutput.appendLine(`[checkout] ${repo.name}: pipeline failed during checkout t+${elapsed()}`);
                    return {
                        name: repo.name,
                        success: false,
                        message: checkoutResult.message || 'Failed to checkout branch'
                    };
                }
                checkoutMessage = checkoutResult.message;
            }

            const postOk = await runCheckoutHookCommands(postSwitchCommands, 'post-switch', repo.path, repo.name, progress);
            checkoutHooksOutput.appendLine(`[checkout] ${repo.name}: pipeline ${postOk ? 'complete' : 'complete-with-post-failure'} t+${elapsed()}`);
            return {
                name: repo.name,
                success: postOk,
                message: postOk ? checkoutMessage : `${checkoutMessage} (but post-switch hook(s) failed)`
            };
        };

        const results = await Promise.all(repos.map(async repo => {
            const result = await processRepository(repo);
            completedRepos += 1;
            progress.report({
                message: `${repo.name}: completed (${completedRepos}/${totalRepos})`,
                increment: totalRepos > 0 ? (100 / totalRepos) : 0
            });
            checkoutHooksOutput.appendLine(`[checkout] ${repo.name}: ${result.success ? 'SUCCESS' : 'FAILED'} - ${result.message}`);
            return result;
        }));

        const successCount = results.filter(r => r.success).length;
        checkoutHooksOutput.appendLine(`[checkout] Completed branch switch "${branch}" in ${Date.now() - operationStartedAt}ms (${successCount}/${results.length} succeeded)`);
        return results;
    });
}
