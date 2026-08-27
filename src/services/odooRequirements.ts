/**
 * Reads what Python an Odoo checkout needs, straight from the files the
 * branch itself ships. The floor comes from setup.py's literal
 * `python_requires` (present in 17.0/18.0) or release.py's MIN_PY_VERSION
 * (present in 19.0). The preferred interpreter comes from the distributions
 * named in requirements.txt's header comment.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface OdooPythonWindow {
    /** Series read from release.py, e.g. "19.0". Informational - the branch name wins. */
    series?: string;
    minPython: [number, number];
    preferredPython?: [number, number];
    source: 'setup.py' | 'release.py' | 'fallback';
}

export const FALLBACK_MIN_PYTHON: [number, number] = [3, 10];

/**
 * Default `python3` of each distribution Odoo names in its requirements
 * header. Describes distributions, not Odoo, so it only changes when a new
 * release ships.
 */
const DISTRIBUTION_PYTHON: Array<{ match: string; python: [number, number] }> = [
    { match: 'ubuntu 20.04', python: [3, 8] },
    { match: 'ubuntu 22.04', python: [3, 10] },
    { match: 'ubuntu 24.04', python: [3, 12] },
    { match: 'debian 11', python: [3, 9] },
    { match: 'debian 12', python: [3, 11] },
    { match: 'debian 13', python: [3, 13] }
];

export function parseMinPythonFromSetupPy(content: string): [number, number] | undefined {
    const match = /python_requires\s*=\s*['"]>=\s*(\d+)\.(\d+)/.exec(content);
    return match ? [Number(match[1]), Number(match[2])] : undefined;
}

export function parseMinPythonFromReleasePy(content: string): [number, number] | undefined {
    const match = /^MIN_PY_VERSION\s*=\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/m.exec(content);
    return match ? [Number(match[1]), Number(match[2])] : undefined;
}

export function parseSeriesFromReleasePy(content: string): string | undefined {
    const match = /^version_info\s*=\s*\(\s*(\d+)\s*,\s*(\d+)/m.exec(content);
    return match ? `${match[1]}.${match[2]}` : undefined;
}

/** Leading comment block only - later comments are not the header. */
function readHeaderComment(content: string): string {
    const header: string[] = [];
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') {
            continue;
        }
        if (!trimmed.startsWith('#')) {
            break;
        }
        header.push(trimmed);
    }
    return header.join(' ').toLowerCase();
}

export function parsePreferredPythonFromRequirements(content: string): [number, number] | undefined {
    const header = readHeaderComment(content);
    let best: [number, number] | undefined;
    for (const entry of DISTRIBUTION_PYTHON) {
        if (!header.includes(entry.match)) {
            continue;
        }
        if (!best || entry.python[0] > best[0] || (entry.python[0] === best[0] && entry.python[1] > best[1])) {
            best = entry.python;
        }
    }
    return best;
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
    return fs.readFile(filePath, 'utf-8').catch(() => undefined);
}

export async function readOdooPythonWindow(odooPath: string): Promise<OdooPythonWindow> {
    const [setupPy, releasePy, requirements] = await Promise.all([
        readIfPresent(path.join(odooPath, 'setup.py')),
        readIfPresent(path.join(odooPath, 'odoo', 'release.py')),
        readIfPresent(path.join(odooPath, 'requirements.txt'))
    ]);

    const fromSetup = setupPy ? parseMinPythonFromSetupPy(setupPy) : undefined;
    const fromRelease = releasePy ? parseMinPythonFromReleasePy(releasePy) : undefined;

    let minPython = FALLBACK_MIN_PYTHON;
    let source: OdooPythonWindow['source'] = 'fallback';
    if (fromSetup) {
        minPython = fromSetup;
        source = 'setup.py';
    } else if (fromRelease) {
        minPython = fromRelease;
        source = 'release.py';
    }

    return {
        series: releasePy ? parseSeriesFromReleasePy(releasePy) : undefined,
        minPython,
        preferredPython: requirements ? parsePreferredPythonFromRequirements(requirements) : undefined,
        source
    };
}
