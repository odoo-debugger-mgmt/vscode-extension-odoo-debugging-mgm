/**
 * Compare a file, or a whole module, with the same code in the comparison
 * partner's version. See services/compare.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { registerCommand } from './registerCommand';
import { SettingsStore } from '../settingsStore';
import { showInfo } from '../services/notifications';
import { findModuleForFile } from '../services/manifest';
import { codeSides, type CodeSides } from '../services/compare/sides';
import { realFsProbe, resolveCounterpart, rootOf, type SideRoots } from '../services/compare/counterpart';
import { diffTrees } from '../services/compare/moduleDiff';
import { compareDocuments } from '../views/compareDocuments';

type Project = Parameters<typeof codeSides>[0];

/** Both sides, or undefined after saying why not (or when the prompt was dismissed). */
async function sidesOrExplain(refresh: () => void): Promise<CodeSides | undefined> {
    const project = (await SettingsStore.getSelectedProject())?.project as Project;
    const sides = await codeSides(project, { ask: true, onStored: refresh });
    if (!sides) {
        return undefined;
    }
    if ('error' in sides) {
        void showInfo(sides.error);
        return undefined;
    }
    return sides;
}

/** The counterpart of `file` (on `from`) in `to`, asking when several match; undefined after explaining. */
async function counterpartOf(file: string, from: SideRoots, to: SideRoots, what: string): Promise<string | undefined> {
    const found = await resolveCounterpart(file, from, to, realFsProbe);
    if (found.kind === 'found') {
        return found.path;
    }
    if (found.kind === 'none') {
        void showInfo(`${what} has no counterpart in ${to.label}.`);
        return undefined;
    }
    const base = rootOf(found.candidates[0], to)?.root.path;
    const picked = await vscode.window.showQuickPick(found.candidates.map(candidate => ({
        label: base ? path.relative(rootOf(candidate, to)?.root.path ?? base, candidate) : candidate,
        candidate
    })), { title: `${what} in ${to.label}`, placeHolder: 'Which file is the counterpart?' });
    return picked?.candidate;
}

function fileOf(arg: unknown): string | undefined {
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === 'file' ? uri.fsPath : undefined;
}

async function moduleDirOf(arg: unknown): Promise<string | undefined> {
    const data = (arg as { moduleData?: { path?: string } } | undefined)?.moduleData;
    if (data?.path) {
        return data.path;
    }
    if (arg instanceof vscode.Uri && arg.scheme === 'file') {
        if (fs.existsSync(path.join(arg.fsPath, '__manifest__.py'))) {
            return arg.fsPath;
        }
        return (await findModuleForFile(path.join(arg.fsPath, '__manifest__.py')))?.path;
    }
    return undefined;
}

export function registerCompareCommands(deps: CommandDeps): void {
    const { context, refreshAll } = deps;
    const refresh = () => { void refreshAll({ reason: 'ui' }); };

    context.subscriptions.push(registerCommand('odoo.compareFileWithPartner', async (arg?: unknown) => {
        const file = fileOf(arg);
        if (!file) {
            void showInfo('Open a file to compare it with the partner.');
            return;
        }
        const sides = await sidesOrExplain(refresh);
        if (!sides) {
            return;
        }
        const onLeft = rootOf(file, sides.left);
        const onRight = onLeft ? undefined : rootOf(file, sides.right);
        if (!onLeft && !onRight) {
            void showInfo(`${path.basename(file)} is not part of ${sides.left.label}'s or ${sides.right.label}'s code.`);
            return;
        }
        const [from, to] = onLeft ? [sides.left, sides.right] : [sides.right, sides.left];
        const other = await counterpartOf(file, from, to, path.basename(file));
        if (!other) {
            return;
        }
        if (path.resolve(other) === path.resolve(file)) {
            void showInfo(`${path.basename(file)} is the same file in ${sides.left.label} and ${sides.right.label}.`);
            return;
        }
        const [leftFile, rightFile] = onLeft ? [file, other] : [other, file];
        await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(leftFile), vscode.Uri.file(rightFile),
            `${path.basename(file)}: ${sides.left.label} ↔ ${sides.right.label}`);
    }));

    context.subscriptions.push(registerCommand('odoo.compareModuleWithPartner', async (arg?: unknown) => {
        const moduleDir = await moduleDirOf(arg);
        if (!moduleDir) {
            void showInfo('Select a module folder to compare it with the partner.');
            return;
        }
        const name = path.basename(moduleDir);
        const sides = await sidesOrExplain(refresh);
        if (!sides) {
            return;
        }
        const manifest = path.join(moduleDir, '__manifest__.py');
        const onLeft = rootOf(manifest, sides.left);
        const onRight = onLeft ? undefined : rootOf(manifest, sides.right);
        if (!onLeft && !onRight) {
            void showInfo(`${name} is not part of ${sides.left.label}'s or ${sides.right.label}'s code.`);
            return;
        }
        const [from, to] = onLeft ? [sides.left, sides.right] : [sides.right, sides.left];
        const otherManifest = await counterpartOf(manifest, from, to, name);
        if (!otherManifest) {
            return;
        }
        const otherDir = path.dirname(otherManifest);
        if (path.resolve(otherDir) === path.resolve(moduleDir)) {
            void showInfo(`${name} is the same file in ${sides.left.label} and ${sides.right.label}.`);
            return;
        }
        const [leftDir, rightDir] = onLeft ? [moduleDir, otherDir] : [otherDir, moduleDir];
        const diff = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Comparing ${name}…` },
            () => diffTrees(leftDir, rightDir)
        );
        const { left, right } = sides;
        if (diff.changed.length + diff.added.length + diff.removed.length === 0) {
            void showInfo(`${name} is the same in ${left.label} and ${right.label}.`);
            return;
        }
        type Item = vscode.QuickPickItem & { rel: string; change: 'changed' | 'added' | 'removed' };
        const items: Item[] = [
            ...diff.changed.map(rel => ({ label: `$(diff) ${rel}`, rel, change: 'changed' as const })),
            ...diff.added.map(rel => ({ label: `$(diff-added) ${rel}`, description: `only in ${right.label}`, rel, change: 'added' as const })),
            ...diff.removed.map(rel => ({ label: `$(diff-removed) ${rel}`, description: `only in ${left.label}`, rel, change: 'removed' as const }))
        ];
        const summary = `${diff.changed.length} changed · ${diff.added.length} added · ${diff.removed.length} removed`;
        const picked = await vscode.window.showQuickPick<vscode.QuickPickItem>(
            [{ label: summary, kind: vscode.QuickPickItemKind.Separator }, ...items],
            { title: `${name}: ${left.label} ↔ ${right.label}`, placeHolder: 'Pick a file to see its diff' }
        ) as Item | undefined;
        if (!picked?.rel) {
            return;
        }
        const title = `${picked.rel}: ${left.label} ↔ ${right.label}`;
        const leftUri = picked.change === 'added'
            ? compareDocuments.snapshotUri('left', `(not in ${left.label})`, '')
            : vscode.Uri.file(path.join(leftDir, picked.rel));
        const rightUri = picked.change === 'removed'
            ? compareDocuments.snapshotUri('right', `(not in ${right.label})`, '')
            : vscode.Uri.file(path.join(rightDir, picked.rel));
        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
    }));
}
