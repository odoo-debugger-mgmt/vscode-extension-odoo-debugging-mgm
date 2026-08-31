/**
 * Locating and ranking Python interpreters for a version, and building that
 * version's virtualenv. Ranking is the part with judgement in it, so it is
 * pure and tested; discovery and venv creation shell out through runCommand.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runCommand, tryRunCommand } from './process';
import { OdooPythonWindow } from './odooRequirements';
import { logger } from './logger';

export interface InterpreterInfo {
    path: string;
    version: [number, number];
}

/** Minor versions probed on PATH as `python3.<minor>`. */
const PROBED_MINORS = [8, 9, 10, 11, 12, 13, 14];

export function parsePythonVersion(output: string): [number, number] | undefined {
    const match = /Python\s+(\d+)\.(\d+)/.exec(output);
    return match ? [Number(match[1]), Number(match[2])] : undefined;
}

function compare(a: [number, number], b: [number, number]): number {
    return a[0] - b[0] || a[1] - b[1];
}

export function isAbovePreferred(interpreter: InterpreterInfo, window: OdooPythonWindow): boolean {
    return !!window.preferredPython && compare(interpreter.version, window.preferredPython) > 0;
}

/**
 * Orders interpreters best-first for the given window. Anything below the
 * floor is unusable and is excluded entirely, so the first entry is always
 * safe to use - or the list is empty and one must be installed.
 *
 * Above the branch's target, *closest* wins rather than newest: running a
 * branch on a much newer Python than it was written for causes failures at
 * server initialization, and the further above the target you go the more
 * likely that is. Odoo 17.0 with 3.12 and 3.14 present should pick 3.12.
 */
export function rankInterpreters(found: InterpreterInfo[], window: OdooPythonWindow): InterpreterInfo[] {
    const usable = found.filter(entry => compare(entry.version, window.minPython) >= 0);

    const tier = (entry: InterpreterInfo): number => {
        if (!window.preferredPython) {
            return 0;
        }
        const delta = compare(entry.version, window.preferredPython);
        if (delta === 0) {
            return 0;
        }
        return delta < 0 ? 1 : 2;
    };

    return [...usable].sort((a, b) => {
        const tierA = tier(a);
        const tierB = tier(b);
        if (tierA !== tierB) {
            return tierA - tierB;
        }
        // Above the target, the closest one wins; otherwise newest.
        return tierA === 2 ? compare(a.version, b.version) : compare(b.version, a.version);
    });
}

/**
 * The next usable interpreter above `current`, for stepping up after a
 * requirements install fails. Some pins only exist to mirror a distribution
 * package and have no Linux wheel - Odoo 17.0's `gevent==21.8.0` on Python
 * 3.10 is the canonical case, and it cannot be built from source either, since
 * the Cython alpha its build requires is gone from PyPI.
 */
export function nextInterpreterAbove(
    found: InterpreterInfo[],
    window: OdooPythonWindow,
    current: [number, number]
): InterpreterInfo | undefined {
    return rankInterpreters(found, window)
        .filter(entry => compare(entry.version, current) > 0)
        .sort((a, b) => compare(a.version, b.version))[0];
}

export function venvPythonPath(venvPath: string): string {
    return process.platform === 'win32'
        ? path.join(venvPath, 'Scripts', 'python.exe')
        : path.join(venvPath, 'bin', 'python');
}

async function probeInterpreter(candidate: string): Promise<InterpreterInfo | undefined> {
    // tryRunCommand yields trimmed stdout, which is where Python 3 prints its
    // version; an empty string means it ran but said nothing useful.
    const output = await tryRunCommand(candidate, ['--version']);
    if (output === undefined) {
        return undefined;
    }
    const version = parsePythonVersion(output);
    return version ? { path: candidate, version } : undefined;
}

/** Candidate interpreters: PATH entries plus any pyenv-managed builds. */
function candidatePaths(): string[] {
    const candidates = PROBED_MINORS.map(minor => `python3.${minor}`);
    candidates.push('python3');

    const pyenvVersions = path.join(os.homedir(), '.pyenv', 'versions');
    if (fs.existsSync(pyenvVersions)) {
        for (const entry of fs.readdirSync(pyenvVersions)) {
            candidates.push(path.join(pyenvVersions, entry, 'bin', 'python'));
        }
    }

    return candidates;
}

export async function discoverInterpreters(): Promise<InterpreterInfo[]> {
    const probed = await Promise.all(candidatePaths().map(probeInterpreter));

    const seen = new Set<string>();
    const found: InterpreterInfo[] = [];
    for (const entry of probed) {
        if (!entry) {
            continue;
        }
        const key = `${entry.version[0]}.${entry.version[1]}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        found.push(entry);
    }
    return found;
}

/**
 * Locates uv: the configured path, then PATH. When uv is absent the caller
 * falls back to the standard library venv and pip, so a missing uv degrades
 * rather than failing.
 */
export async function resolveUv(): Promise<string | undefined> {
    const configured = vscode.workspace
        .getConfiguration('odooDebugger.provisioning')
        .get<string>('uvPath', '')
        .trim();

    const candidates = configured ? [configured, 'uv'] : ['uv'];
    for (const candidate of candidates) {
        if (await tryRunCommand(candidate, ['--version']) !== undefined) {
            return candidate;
        }
    }
    return undefined;
}

/**
 * Returns an interpreter satisfying the version's window, installing one via
 * uv when nothing on the machine qualifies. The warning names a mismatch when
 * the best available interpreter is newer than what the branch targets.
 */
export async function ensureInterpreter(
    window: OdooPythonWindow,
    token?: vscode.CancellationToken
): Promise<{ path: string; version: [number, number]; warning?: string }> {
    const ranked = rankInterpreters(await discoverInterpreters(), window);

    if (ranked.length > 0) {
        const best = ranked[0];
        const warning = isAbovePreferred(best, window) && window.preferredPython
            ? `This branch targets Python ${window.preferredPython.join('.')}; using ${best.version.join('.')}.`
            : undefined;
        return { path: best.path, version: best.version, warning };
    }

    const wanted = window.preferredPython ?? window.minPython;
    const uv = await resolveUv();
    if (!uv) {
        throw new Error(
            `No installed Python satisfies this branch (needs ${window.minPython.join('.')} or newer). ` +
            `Install Python ${wanted.join('.')}, or install uv so it can be provisioned automatically.`
        );
    }

    const target = wanted.join('.');
    logger.info(`[provisioning] installing Python ${target} via uv`);
    await runCommand(uv, ['python', 'install', target], { token });

    const rankedAfter = rankInterpreters(await discoverInterpreters(), window);
    if (rankedAfter.length > 0) {
        return { path: rankedAfter[0].path, version: rankedAfter[0].version };
    }

    // uv-managed builds are not always on PATH; ask uv where it put it.
    const found = await tryRunCommand(uv, ['python', 'find', target], { token });
    if (!found) {
        throw new Error(`uv installed Python ${target} but the interpreter could not be located.`);
    }
    return { path: found, version: wanted };
}

export async function ensureVenv(
    pythonPath: string,
    venvPath: string,
    uvPath: string | undefined,
    token?: vscode.CancellationToken
): Promise<string> {
    const interpreter = venvPythonPath(venvPath);
    if (fs.existsSync(interpreter)) {
        return interpreter;
    }

    if (uvPath) {
        await runCommand(uvPath, ['venv', '--python', pythonPath, venvPath], { token });
    } else {
        await runCommand(pythonPath, ['-m', 'venv', venvPath], { token });
    }
    return interpreter;
}

export async function installRequirements(
    venvPath: string,
    requirementsPath: string,
    uvPath: string | undefined,
    onLine: (line: string) => void,
    token?: vscode.CancellationToken
): Promise<void> {
    const interpreter = venvPythonPath(venvPath);

    if (uvPath) {
        await runCommand(uvPath, ['pip', 'install', '--python', interpreter, '-r', requirementsPath], {
            token,
            onStdoutLine: onLine,
            onStderrLine: onLine
        });
        return;
    }

    await runCommand(interpreter, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'], {
        token,
        onStdoutLine: onLine,
        onStderrLine: onLine
    });
    await runCommand(interpreter, ['-m', 'pip', 'install', '-r', requirementsPath], {
        token,
        onStdoutLine: onLine,
        onStderrLine: onLine
    });
}
