/**
 * Keeps the extension's files out of a repository's git status: launch.json,
 * and - for a clone moved to its own data file - the data file and the
 * settings that point at it.
 *
 * A folder window writes its launch entries to `<folder>/.vscode/launch.json`.
 * When the folder is itself a clone - one workspace per version, opened on
 * the clone - that put an untracked `.vscode/` in the user's repository, one
 * `git add .` from being committed. The file stays where VS Code reads it,
 * and is added to the clone's own `info/exclude`: local, never shared, and
 * never touching a `.gitignore`. A launch.json the repository tracks is left
 * alone.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tryRunCommand } from './process';
import { logger } from './logger';

export const LAUNCH_EXCLUDE_LINE = '/.vscode/launch.json';

/** `content` with `line` added, or undefined when it is already there. */
export function withExcludeLine(content: string, line: string, comment = 'Odoo DevTools writes its launch entries here'): string | undefined {
    const lines = content.split(/\r?\n/).map(entry => entry.trim());
    if (lines.includes(line) || lines.includes(line.replace(/^\//, ''))) {
        return undefined;
    }
    const separator = content === '' || content.endsWith('\n') ? '' : '\n';
    return `${content}${separator}# ${comment}\n${line}\n`;
}

const done = new Set<string>();

/**
 * Adds `line` (`/.vscode/launch.json`) to `folder`'s info/exclude when the
 * folder is a clone that does not track that file.
 */
export async function excludeFromGit(folder: string, line: string, comment?: string): Promise<void> {
    const key = `${folder}\0${line}`;
    if (done.has(key)) {
        return;
    }
    done.add(key);
    if (!fs.existsSync(path.join(folder, '.git'))) {
        return;
    }
    try {
        const tracked = await tryRunCommand('git', ['ls-files', '--', line.replace(/^\//, '')], { cwd: folder });
        if (tracked) {
            return;
        }
        const relative = await tryRunCommand('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: folder });
        if (!relative) {
            return;
        }
        const excludePath = path.resolve(folder, relative);
        const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
        const next = withExcludeLine(current, line, comment);
        if (next !== undefined) {
            fs.mkdirSync(path.dirname(excludePath), { recursive: true });
            fs.writeFileSync(excludePath, next);
            logger.info(`[git] ${folder} is a git clone: ${line} is excluded in ${excludePath}`);
        }
    } catch (error) {
        logger.debug(`[git] could not exclude ${line} in ${folder}:`, error);
    }
}

/** Adds launch.json to `folder`'s info/exclude when the folder is a clone that does not track it. */
export function excludeLaunchFromGit(folder: string): Promise<void> {
    return excludeFromGit(folder, LAUNCH_EXCLUDE_LINE);
}

/**
 * A data file at `<folder>/.vscode/…` - a clone moved to its own file - is
 * kept out of the clone's git status, like launch.json.
 */
export function excludeDataFileFromGit(location: string): Promise<void> {
    const vscodeDir = path.dirname(location);
    if (path.basename(vscodeDir) !== '.vscode') {
        return Promise.resolve();
    }
    return excludeFromGit(path.dirname(vscodeDir), `/.vscode/${path.basename(location)}`, 'Odoo DevTools keeps this workspace\'s data here');
}
