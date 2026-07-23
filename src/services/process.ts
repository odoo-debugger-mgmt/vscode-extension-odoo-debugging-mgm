import { spawn } from 'node:child_process';
import type * as vscode from 'vscode';

/**
 * Shared child-process runner. All shell-outs in the extension go through
 * here: no `shell: true`, arguments are always passed as arrays, so
 * user-supplied values (database names, paths) can never be interpreted by a
 * shell.
 */

export interface RunCommandOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Text piped to the child's stdin. */
    input?: string;
    /** Kill the child and reject when exceeded. */
    timeoutMs?: number;
    /** Kills the child when cancelled. */
    token?: vscode.CancellationToken;
    /** Called with each stdout line as it arrives (long-running commands). */
    onStdoutLine?: (line: string) => void;
    /** Called with each stderr line as it arrives (long-running commands). */
    onStderrLine?: (line: string) => void;
}

export interface RunCommandResult {
    stdout: string;
    stderr: string;
}

/** Error thrown when a command exits non-zero, fails to spawn, or is killed. */
export class CommandError extends Error {
    constructor(
        public readonly command: string,
        public readonly args: string[],
        public readonly exitCode: number | null,
        public readonly stderr: string,
        public readonly stdout: string,
        cause?: unknown
    ) {
        const detail = stderr.trim() || stdout.trim() || (cause instanceof Error ? cause.message : '');
        super(`${command} ${args.join(' ')} failed${exitCode === null ? '' : ` (exit code ${exitCode})`}${detail ? `: ${detail}` : ''}`);
        this.name = 'CommandError';
    }
}

function makeLineForwarder(forward: (line: string) => void): (chunk: string) => void {
    let buffer = '';
    return (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
            forward(line);
        }
    };
}

/**
 * Runs a command (no shell) and resolves with its collected output.
 * Rejects with {@link CommandError} on spawn failure, non-zero exit,
 * timeout, or cancellation.
 */
export function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<RunCommandResult> {
    return new Promise<RunCommandResult>((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            shell: false
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        let cancellation: vscode.Disposable | undefined;

        const finish = (fn: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timer) {
                clearTimeout(timer);
            }
            cancellation?.dispose();
            fn();
        };

        const forwardStdout = options.onStdoutLine ? makeLineForwarder(options.onStdoutLine) : undefined;
        const forwardStderr = options.onStderrLine ? makeLineForwarder(options.onStderrLine) : undefined;

        child.stdout.setEncoding('utf-8');
        child.stderr.setEncoding('utf-8');
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
            forwardStdout?.(chunk);
        });
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
            forwardStderr?.(chunk);
        });

        child.on('error', error => {
            finish(() => reject(new CommandError(command, args, null, stderr, stdout, error)));
        });

        child.on('close', code => {
            finish(() => {
                if (code === 0) {
                    resolve({ stdout, stderr });
                } else {
                    reject(new CommandError(command, args, code, stderr, stdout));
                }
            });
        });

        if (options.timeoutMs && options.timeoutMs > 0) {
            timer = setTimeout(() => {
                child.kill();
                finish(() => reject(new CommandError(command, args, null, stderr || 'Command timed out', stdout)));
            }, options.timeoutMs);
        }

        if (options.token) {
            cancellation = options.token.onCancellationRequested(() => {
                child.kill();
                finish(() => reject(new CommandError(command, args, null, stderr || 'Command was cancelled', stdout)));
            });
        }

        if (options.input !== undefined) {
            child.stdin.write(options.input);
        }
        child.stdin.end();
    });
}

/**
 * Runs a command and returns its trimmed stdout, or undefined on any failure.
 * For best-effort probes where the caller has a fallback.
 */
export async function tryRunCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<string | undefined> {
    try {
        const { stdout } = await runCommand(command, args, options);
        return stdout.trim();
    } catch {
        return undefined;
    }
}
