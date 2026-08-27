/**
 * Locating and ranking Python interpreters for a version, and building that
 * version's virtualenv. Ranking is the part with judgement in it, so it is
 * pure and tested; discovery and venv creation shell out through runCommand.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tryRunCommand } from './process';
import { OdooPythonWindow } from './odooRequirements';

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
        const tierDelta = tier(a) - tier(b);
        if (tierDelta !== 0) {
            return tierDelta;
        }
        // Within a tier, newest wins.
        return compare(b.version, a.version);
    });
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
