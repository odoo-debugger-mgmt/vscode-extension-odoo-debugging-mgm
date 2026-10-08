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
import { counterpartModuleDir, realFsProbe, resolveCounterpart, rootOf, type Counterpart, type SideRoots } from '../services/compare/counterpart';
import { candidatesOf, leftRight, locateCounterpart, orderSides, qualifiedAt, type SymbolNode } from '../services/compare/locate';
import { diffTrees, listTree } from '../services/compare/moduleDiff';
import { enclosingSymbol, findMethodInSources, modelKeyOf, scanPythonSymbols, symbolText, type PySymbol } from '../services/compare/pythonSymbols';
import { findXmlElementById, xmlElementAt } from '../services/compare/xmlElements';
import { compareDocuments } from '../views/compareDocuments';
import { extractDatabaseFromEvent } from '../dbs';
import { partnerFor, upgradePair, type PairProject } from '../views/viewPairing';
import { resolveViewDoctorTarget } from '../views/viewDoctorView';
import { comparisonSides } from '../services/comparisonPartner';
import { withCheckpointOpen } from '../services/checkpointReads';
import { runSql } from '../services/postgres';
import { parseRecordRef, planSides, readRecord } from '../services/compare/recordCompare';

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

/** The file of a resolution, asking when several match; undefined after explaining. */
async function pickCounterpart(found: Counterpart, to: SideRoots, what: string): Promise<string | undefined> {
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

/** The counterpart of `file` (on `from`) in `to`, asking when several match; undefined after explaining. */
async function counterpartOf(file: string, from: SideRoots, to: SideRoots, what: string): Promise<string | undefined> {
    return pickCounterpart(await withBusy(() => resolveCounterpart(file, from, to, realFsProbe)), to, what);
}

/** Runs a slow file-system lookup under a progress notification. */
function withBusy<T>(work: () => Promise<T>): Promise<T> {
    return Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Looking for the counterpart…' }, work));
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
    // From the palette: the module of the active editor's file.
    const active = fileOf(undefined);
    return active ? (await findModuleForFile(active))?.path : undefined;
}

/** The qualified name of the class or function around `position`, from the language server; undefined without one. */
async function qualifiedFromServer(uri: vscode.Uri, position: vscode.Position): Promise<string | undefined> {
    const symbols = await Promise.resolve(
        vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri)
    ).catch(() => undefined);
    const kinds = [vscode.SymbolKind.Class, vscode.SymbolKind.Function, vscode.SymbolKind.Method];
    const nodes = (list: vscode.DocumentSymbol[]): SymbolNode<vscode.Position>[] => list.map(s => ({
        name: s.name,
        isScope: kinds.includes(s.kind),
        contains: p => Boolean(s.range?.contains(p)),
        children: nodes(s.children ?? [])
    }));
    return qualifiedAt(nodes(Array.isArray(symbols) ? symbols : []), position);
}

async function readText(file: string): Promise<string> {
    return fs.promises.readFile(file, 'utf8');
}

async function filesOf(dir: string, ext: string): Promise<string[]> {
    return [...(await listTree(dir)).keys()].filter(rel => rel.endsWith(ext)).map(rel => path.join(dir, rel));
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
        const order = orderSides(file, sides);
        if (!order) {
            void showInfo(`${path.basename(file)} is not part of ${sides.left.label}'s or ${sides.right.label}'s code.`);
            return;
        }
        const { from, to, fileOnLeft: onLeft } = order;
        const other = await counterpartOf(file, from, to, path.basename(file));
        if (!other) {
            return;
        }
        if (path.resolve(other) === path.resolve(file)) {
            void showInfo(`${path.basename(file)} is the same file in ${sides.left.label} and ${sides.right.label}.`);
            return;
        }
        const [leftFile, rightFile] = leftRight(onLeft, file, other);
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
        const order = orderSides(manifest, sides);
        if (!order) {
            void showInfo(`${name} is not part of ${sides.left.label}'s or ${sides.right.label}'s code.`);
            return;
        }
        const { from, to, fileOnLeft: onLeft } = order;
        // A module is found by its name only: a removed or renamed module has no counterpart, and no
        // unrelated module is offered in its place.
        const otherDir = await withBusy(() => counterpartModuleDir(manifest, from, to, realFsProbe));
        if (!otherDir) {
            void showInfo(`${name} has no counterpart in ${to.label}.`);
            return;
        }
        if (path.resolve(otherDir) === path.resolve(moduleDir)) {
            void showInfo(`${name} is the same module in ${sides.left.label} and ${sides.right.label}.`);
            return;
        }
        const [leftDir, rightDir] = leftRight(onLeft, moduleDir, otherDir);
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

    context.subscriptions.push(registerCommand('odoo.compareThisWithPartner', async (arg?: unknown) => {
        const file = fileOf(arg);
        const ext = file ? path.extname(file) : '';
        if (!file || (ext !== '.py' && ext !== '.xml')) {
            void showInfo('Open a Python or XML file to compare a class, method or record with the partner.');
            return;
        }
        const editor = vscode.window.activeTextEditor;
        const here = editor && path.resolve(editor.document.uri.fsPath) === path.resolve(file) ? editor : undefined;
        if (!here) {
            void showInfo('Put the cursor in the file to compare a class, method or record.');
            return;
        }
        const sides = await sidesOrExplain(refresh);
        if (!sides) {
            return;
        }
        const order = orderSides(file, sides);
        if (!order) {
            void showInfo(`${path.basename(file)} is not part of ${sides.left.label}'s or ${sides.right.label}'s code.`);
            return;
        }
        const { from, to, fileOnLeft: onLeft } = order;
        const text = here.document.getText();
        const position = here.selection.active;
        const show = async (what: string, thisText: string, otherText: string): Promise<void> => {
            const [leftText, rightText] = leftRight(onLeft, thisText, otherText);
            await vscode.commands.executeCommand('vscode.diff',
                compareDocuments.snapshotUri('left', `${what} · ${sides.left.label}${ext}`, leftText),
                compareDocuments.snapshotUri('right', `${what} · ${sides.right.label}${ext}`, rightText),
                `${what}: ${sides.left.label} ↔ ${sides.right.label}`);
        };
        const locate = (what: string, search: (files: string[], moduleDir: string | undefined) => Promise<string | undefined>) =>
            locateCounterpart(file, from, to, sides, what, {
                fs: realFsProbe,
                moduleOf: async f => (await findModuleForFile(f))?.path,
                pick: (found, label) => pickCounterpart(found, to, label),
                info: message => { void showInfo(message); },
                busy: withBusy,
                search
            });
        const candidates = async (first: string[], moduleDir: string | undefined): Promise<string[]> =>
            candidatesOf(first, moduleDir ? await filesOf(moduleDir, ext) : [], file);

        if (ext === '.xml') {
            const el = xmlElementAt(text, here.document.offsetAt(position));
            if (!el) {
                void showInfo('Put the cursor inside a <record>, <template> or <menuitem>.');
                return;
            }
            const other = await locate(el.id, async (first, moduleDir) => {
                const moduleName = moduleDir ? path.basename(moduleDir) : '';
                for (const candidate of await candidates(first, moduleDir)) {
                    const otherText = await readText(candidate).catch(() => undefined);
                    const found = otherText === undefined ? undefined : findXmlElementById(otherText, el.id, moduleName);
                    if (found && otherText !== undefined) {
                        return otherText.slice(found.start, found.end);
                    }
                }
                return undefined;
            });
            if (other !== undefined) {
                await show(el.id, text.slice(el.start, el.end), other);
            }
            return;
        }

        const symbols = scanPythonSymbols(text);
        const serverName = await qualifiedFromServer(here.document.uri, position);
        const named = serverName ? symbols.filter(s => s.qualified === serverName) : [];
        const mine: PySymbol | undefined = named.find(s => s.start <= position.line && position.line < s.end) ?? named[0]
            ?? enclosingSymbol(symbols, position.line);
        if (!mine) {
            void showInfo('Put the cursor inside a class or a method.');
            return;
        }
        const owner = symbols.find(s => s.kind === 'class' && mine.qualified === `${s.qualified}.${mine.name}`);
        const other = await locate(mine.qualified, async (first, moduleDir) => {
            const sources: Array<{ file: string; text: string }> = [];
            for (const candidate of await candidates(first, moduleDir)) {
                sources.push({ file: candidate, text: await readText(candidate).catch(() => '') });
            }
            for (const source of sources) {
                const theirs = scanPythonSymbols(source.text).find(s => s.qualified === mine.qualified);
                if (theirs) {
                    return symbolText(source.text, theirs);
                }
            }
            if (owner) {
                const hit = findMethodInSources(sources, modelKeyOf(symbolText(text, owner)), mine.name);
                if (hit) {
                    return symbolText(sources.find(s => s.file === hit.file)!.text, hit.symbol);
                }
            }
            return undefined;
        });
        if (other !== undefined) {
            await show(mine.qualified, symbolText(text, mine), other);
        }
    }));

    context.subscriptions.push(registerCommand('dbSelector.compareRecord', async (event?: unknown) => {
        const project = (await SettingsStore.getSelectedProject())?.project as (PairProject & { dbs?: Array<{ id: string; isSelected?: boolean }> }) | undefined;
        const thisDb = extractDatabaseFromEvent(event)?.id ?? resolveViewDoctorTarget(project)?.dbName;
        if (!project || !thisDb) {
            void showInfo(project ? 'Select a database first.' : 'Open a project first.');
            return;
        }
        const partner = await partnerFor(project, thisDb, { ask: true, onStored: refresh });
        if (!partner) {
            return;
        }
        const input = await vscode.window.showInputBox({
            title: `Compare Record: ${thisDb} with ${partner.label}`,
            prompt: 'A record: an external id (sale.order_1) or model and id (res.partner,3)',
            validateInput: value => parseRecordRef(value) ? undefined : 'An external id (module.name) or a model and an id (res.partner,3)'
        });
        const ref = input === undefined ? undefined : parseRecordRef(input);
        if (!ref) {
            return;
        }
        const names = comparisonSides(thisDb, partner, upgradePair(project));
        const labelOf = (name: string) => name === partner.dbName ? partner.label : name;
        const readSide = (name: string) => name === partner.dbName && partner.kind === 'checkpoint'
            ? withCheckpointOpen(name, () => readRecord(name, ref, runSql))
            : readRecord(name, ref, runSql);
        let reads;
        try {
            reads = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Reading the record…' },
                async () => [await readSide(names.left), await readSide(names.right)] as const
            );
        } catch (error) {
            void showInfo(`Could not read the record: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const [left, right] = reads;
        const what = ref.kind === 'xmlid' ? `${ref.module}.${ref.name}` : `${ref.model},${ref.id}`;
        const leftLabel = labelOf(names.left);
        const rightLabel = labelOf(names.right);
        const plan = planSides(left, right, leftLabel, rightLabel, what);
        if ('message' in plan) {
            void showInfo(plan.message);
            return;
        }
        await vscode.commands.executeCommand('vscode.diff',
            compareDocuments.snapshotUri('left', `${what} · ${leftLabel}.txt`, plan.left),
            compareDocuments.snapshotUri('right', `${what} · ${rightLabel}.txt`, plan.right),
            `${what}: ${leftLabel} ↔ ${rightLabel}`);
    }));
}
