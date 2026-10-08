/**
 * Which two databases a view is compared or rendered across: in Upgrade
 * mode the original (From) and the upgraded (To) database, otherwise the
 * tree's database and its comparison partner.
 */
import * as vscode from 'vscode';
import { ensureUpgradeConfigModel } from '../models/upgrade';
import { getRunningInstances } from '../services/runningState';
import { showInfo } from '../services/notifications';
import { findViewByXmlid, findViewsLike, type ViewRow } from '../services/views/viewQueries';
import { matchView, type CounterpartRows } from '../services/views/viewMatch';
import { SettingsStore } from '../settingsStore';
import { stripSettings } from '../utils';
import { isCopyPartner, partnerChoices, resolveStoredPartner, setPartner, type PartnerModel, type PartnerProject, type ResolvedPartner } from '../services/comparisonPartner';

/** The project as SettingsStore returns it: plain JSON, not hydrated models. */
export interface PairProject {
    dbs?: Array<{ id: string; versionId?: string; isSelected?: boolean; comparePartner?: unknown; checkpoints?: unknown; clonedFrom?: unknown }>;
    upgradeConfig?: unknown;
}

export interface PairSide {
    dbName: string;
    versionId?: string;
    series?: string;
}

export interface UpgradePair {
    original: PairSide;
    upgraded: PairSide;
}

export function upgradePair(project: PairProject | undefined): UpgradePair | undefined {
    if (!project) {
        return undefined;
    }
    const config = ensureUpgradeConfigModel(project.upgradeConfig);
    if (!config.isActive() || !config.from?.dbId || !config.to?.dbId) {
        return undefined;
    }
    return {
        original: { dbName: config.from.dbId, versionId: config.from.versionId, series: config.from.series },
        upgraded: { dbName: config.to.dbId, versionId: config.to.versionId, series: config.to.series }
    };
}

/** The upgrade's original database stays as it was, unless odooDebugger.views.allowEditOriginal is on. */
export function isReadOnlyOriginal(project: PairProject | undefined, dbName: string, allowEditOriginal: boolean): boolean {
    return !allowEditOriginal && upgradePair(project)?.original.dbName === dbName;
}

/**
 * The same view in another database. 'none' when that database has no view
 * of its model and type; undefined when the user dismissed the pick.
 */
export async function findCounterpart(view: ViewRow, dbName: string): Promise<ViewRow | 'none' | undefined> {
    return pickCounterpart(view, dbName, await counterpartRows(view, dbName));
}

/** The rows a counterpart is chosen from: the reads only, so a checkpoint is open just for them. */
export async function counterpartRows(view: ViewRow, dbName: string): Promise<CounterpartRows> {
    const [byXmlid, rows] = await Promise.all([
        view.xmlid ? findViewByXmlid(dbName, view.xmlid) : Promise.resolve(undefined),
        findViewsLike(dbName, view)
    ]);
    return { byXmlid, rows };
}

/** The counterpart among those rows, asking the user when none is certainly it. */
export async function pickCounterpart(view: ViewRow, dbName: string, found: CounterpartRows): Promise<ViewRow | 'none' | undefined> {
    const match = matchView(view, found);
    if (match.kind === 'none') {
        return 'none';
    }
    if (match.kind !== 'pick') {
        return match.view;
    }
    const picked = await vscode.window.showQuickPick(match.candidates.map(candidate => ({
        label: candidate.name,
        description: `${candidate.xmlid ?? `#${candidate.id}`}${candidate.active ? '' : ' · off'}`,
        detail: candidate.inheritId ? `Inherits view ${candidate.inheritId}` : 'Base view',
        candidate
    })), { title: `${view.name} in ${dbName}`, placeHolder: `No view in ${dbName} is certainly the same one: pick it`, matchOnDescription: true });
    return picked?.candidate;
}

/** vscode.diff's arguments: the left and right documents, titled `<view>: <left> ↔ <right>`. */
export function diffArguments(
    left: { uri: vscode.Uri; label: string },
    right: { uri: vscode.Uri; label: string },
    viewName: string
): [vscode.Uri, vscode.Uri, string] {
    return [left.uri, right.uri, `${viewName}: ${left.label} ↔ ${right.label}`];
}

/** What partnerFor asks the world; tests replace it. */
export interface PartnerForDeps {
    running(): Promise<ReadonlySet<string>>;
    info(message: string): void;
}

const realPartnerForDeps: PartnerForDeps = {
    running: async () => new Set((await getRunningInstances()).map(instance => instance.dbName)),
    info: message => { void showInfo(message); }
};

/**
 * The database's comparison partner (Part B): the upgrade's other side, else
 * the stored one while it exists, else - when the caller may ask - one the user
 * picks, which is then remembered.
 */
export async function partnerFor(
    project: PairProject | undefined,
    dbId: string,
    /** onStored: the user picked a partner and it was remembered (the trees show it, so refresh them). */
    options: { ask: boolean; quiet?: boolean; onStored?: () => void },
    deps: PartnerForDeps = realPartnerForDeps
): Promise<ResolvedPartner | undefined> {
    const resolved = resolveStoredPartner(project as PartnerProject | undefined, dbId, upgradePair(project));
    if (resolved || !options.ask) {
        return resolved;
    }
    const choices = partnerChoices(project as PartnerProject | undefined, dbId, await deps.running());
    if (choices.length === 0) {
        // Quiet: the caller goes on without a partner (Render shows the view alone).
        if (!options.quiet) {
            deps.info(`The project has no other database or checkpoint to compare ${dbId} with.`);
        }
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(choices.map(choice => ({
        label: choice.kind === 'checkpoint' ? `$(history) ${choice.label}` : choice.dbName,
        description: choice.kind === 'checkpoint' ? `checkpoint of ${dbId}` : (choice.running ? 'running' : undefined),
        choice
    })), { title: `Compare ${dbId} with…`, placeHolder: 'Its comparison partner, remembered for next time' });
    if (!picked) {
        return undefined;
    }
    const stored: PartnerModel = { dbName: picked.choice.dbName, kind: picked.choice.kind };
    await storePartner(dbId, stored);
    options.onStored?.();
    return resolveStoredPartner({ ...(project as PartnerProject), dbs: (project?.dbs ?? []).map(db => db.id === dbId ? { ...db, comparePartner: stored } : db) }, dbId, undefined);
}

/** Saves (or, with undefined, clears) a database's stored partner. */
export async function storePartner(dbId: string, partner: PartnerModel | undefined): Promise<void> {
    const result = await SettingsStore.getSelectedProject();
    const db = (result?.project.dbs as Array<{ id: string; comparePartner?: unknown }> | undefined)?.find(entry => entry.id === dbId);
    if (!result || !db) {
        return;
    }
    setPartner(db, partner);
    await SettingsStore.saveWithoutComments(stripSettings(result.data));
}

/**
 * Whose inactive views the Views tree leaves out as "also off": the partner,
 * only when it is a copy of this database (the upgrade's original, a
 * checkpoint, a clone either way). Never asks. The upgrade's original side has
 * none: it is the one compared against.
 */
export function alsoOffSource(
    project: PairProject | undefined,
    dbId: string,
    pair: UpgradePair | undefined
): { dbName: string; checkpoint: boolean; label: string } | undefined {
    if (pair?.original.dbName === dbId) {
        return undefined;
    }
    const partner = resolveStoredPartner(project as PartnerProject | undefined, dbId, pair);
    if (!partner || !isCopyPartner(project as PartnerProject | undefined, dbId, partner)) {
        return undefined;
    }
    return { dbName: partner.dbName, checkpoint: partner.kind === 'checkpoint', label: partner.label };
}
