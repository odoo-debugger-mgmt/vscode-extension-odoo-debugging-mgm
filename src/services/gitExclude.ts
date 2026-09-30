/**
 * Keeps the extension's launch.json out of a repository's git status.
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
export function withExcludeLine(content: string, line: string): string | undefined {
    const lines = content.split(/\r?\n/).map(entry => entry.trim());
    if (lines.includes(line) || lines.includes(line.replace(/^\//, ''))) {
        return undefined;
    }
    const separator = content === '' || content.endsWith('\n') ? '' : '\n';
    return `${content}${separator}# Odoo DevTools writes its launch entries here\n${line}\n`;
}

const done = new Set<string>();

/** Adds launch.json to `folder`'s info/exclude when the folder is a clone that does not track it. */
export async function excludeLaunchFromGit(folder: string): Promise<void> {
    if (done.has(folder)) {
        return;
    }
    done.add(folder);
    if (!fs.existsSync(path.join(folder, '.git'))) {
        return;
    }
    try {
        const tracked = await tryRunCommand('git', ['ls-files', '--', '.vscode/launch.json'], { cwd: folder });
        if (tracked) {
            return;
        }
        const relative = await tryRunCommand('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: folder });
        if (!relative) {
            return;
        }
        const excludePath = path.resolve(folder, relative);
        const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
        const next = withExcludeLine(current, LAUNCH_EXCLUDE_LINE);
        if (next !== undefined) {
            fs.mkdirSync(path.dirname(excludePath), { recursive: true });
            fs.writeFileSync(excludePath, next);
            logger.info(`[debugger] ${folder} is a git clone: its launch.json is excluded in ${excludePath}`);
        }
    } catch (error) {
        logger.debug(`[debugger] could not exclude launch.json in ${folder}:`, error);
    }
}
