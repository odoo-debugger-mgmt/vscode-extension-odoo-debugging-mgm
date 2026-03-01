import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface FilesExcludeRule {
    regex: RegExp;
    when?: string;
}

export interface FilesExcludeMatcher {
    isExcluded(fsPath: string, entryName: string): boolean;
}

function globToRegExp(pattern: string): RegExp {
    const normalizedPattern = pattern.split(path.sep).join('/');

    const placeholders = {
        doubleStar: '__GLOB_DOUBLE_STAR__',
        singleStar: '__GLOB_SINGLE_STAR__',
        question: '__GLOB_QUESTION__'
    };

    let working = normalizedPattern
        .replaceAll('**', placeholders.doubleStar)
        .replaceAll('*', placeholders.singleStar)
        .replaceAll('?', placeholders.question);

    working = working.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);

    working = working
        .replaceAll(new RegExp(placeholders.doubleStar, 'g'), '.*')
        .replaceAll(new RegExp(placeholders.singleStar, 'g'), '[^/]*')
        .replaceAll(new RegExp(placeholders.question, 'g'), '[^/]');

    return new RegExp(`^${working}$`, 'i');
}

function normalizeForMatch(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.?\//, '');
}

function resolveWorkspaceRoot(scopeUri?: vscode.Uri): string | undefined {
    if (scopeUri) {
        const folder = vscode.workspace.getWorkspaceFolder(scopeUri);
        if (folder) {
            return folder.uri.fsPath;
        }
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function resolveFilesExcludeRules(scopeUri?: vscode.Uri): FilesExcludeRule[] {
    const config = vscode.workspace.getConfiguration('files', scopeUri);
    const excludes = config.get<Record<string, boolean | { when?: string }>>('exclude', {});
    if (!excludes || typeof excludes !== 'object') {
        return [];
    }

    const rules: FilesExcludeRule[] = [];
    for (const [pattern, rawValue] of Object.entries(excludes)) {
        if (rawValue === false) {
            continue;
        }

        if (rawValue === true) {
            rules.push({ regex: globToRegExp(pattern) });
            continue;
        }

        if (!rawValue || typeof rawValue !== 'object') {
            continue;
        }

        rules.push({
            regex: globToRegExp(pattern),
            when: typeof rawValue.when === 'string' ? rawValue.when : undefined
        });
    }

    return rules;
}

function ruleMatchesPath(rule: FilesExcludeRule, relativePath: string, absolutePath: string, entryName: string): boolean {
    return rule.regex.test(relativePath)
        || rule.regex.test(`/${relativePath}`)
        || rule.regex.test(entryName)
        || rule.regex.test(absolutePath);
}

function whenClauseMatches(whenClause: string | undefined, fsPath: string, entryName: string): boolean {
    if (!whenClause || whenClause.trim() === '') {
        return true;
    }

    const basename = path.parse(entryName).name;
    const siblingName = whenClause.replaceAll('$(basename)', basename);
    const siblingPath = path.join(path.dirname(fsPath), siblingName);
    return fs.existsSync(siblingPath);
}

export function createFilesExcludeMatcher(scopeUri?: vscode.Uri): FilesExcludeMatcher {
    const rules = resolveFilesExcludeRules(scopeUri);
    const workspaceRoot = resolveWorkspaceRoot(scopeUri);

    return {
        isExcluded(fsPath: string, entryName: string): boolean {
            if (rules.length === 0) {
                return false;
            }

            const normalizedAbsolute = normalizeForMatch(fsPath);
            const relativeCandidate = workspaceRoot
                ? normalizeForMatch(path.relative(workspaceRoot, fsPath))
                : normalizedAbsolute;
            const relative = relativeCandidate && relativeCandidate !== '.'
                ? relativeCandidate
                : normalizedAbsolute;

            for (const rule of rules) {
                if (!ruleMatchesPath(rule, relative, normalizedAbsolute, entryName)) {
                    continue;
                }

                if (!whenClauseMatches(rule.when, fsPath, entryName)) {
                    continue;
                }

                return true;
            }

            return false;
        }
    };
}
