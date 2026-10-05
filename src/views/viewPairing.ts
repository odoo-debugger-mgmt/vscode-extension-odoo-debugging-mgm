/**
 * Which two databases a view is compared or rendered across: in Upgrade
 * mode the original (From) and the upgraded (To) database, otherwise the
 * tree's database and one the user picks.
 */
import * as vscode from 'vscode';
import { ensureUpgradeConfigModel } from '../models/upgrade';
import { getRunningInstances } from '../services/runningState';
import { showInfo } from '../services/notifications';
import { findViewByXmlid, findViewsLike, type ViewRow } from '../services/views/viewQueries';
import { matchView } from '../services/views/viewMatch';
import { viewUri } from './viewFileSystem';

/** The project as SettingsStore returns it: plain JSON, not hydrated models. */
export interface PairProject {
    dbs?: Array<{ id: string; versionId?: string; isSelected?: boolean }>;
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

export interface DatabaseChoice {
    dbName: string;
    versionId?: string;
    running: boolean;
}

/** The project's other databases, running ones first, so the default pick is one a server has open. */
export function otherDatabaseChoices(project: PairProject | undefined, current: string, running: ReadonlySet<string>): DatabaseChoice[] {
    return (project?.dbs ?? [])
        .filter(db => db.id !== current)
        .map(db => ({ dbName: db.id, versionId: db.versionId, running: running.has(db.id) }))
        .sort((a, b) => Number(b.running) - Number(a.running));
}

export async function pickOtherDatabase(project: PairProject | undefined, current: string): Promise<DatabaseChoice | undefined> {
    const running = new Set((await getRunningInstances()).map(instance => instance.dbName));
    const choices = otherDatabaseChoices(project, current, running);
    if (choices.length === 0) {
        void showInfo(`The project has no other database to compare ${current} with.`);
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(
        choices.map(choice => ({ label: choice.dbName, description: choice.running ? 'running' : undefined, choice })),
        { title: `Compare with ${current}`, placeHolder: 'The database to show on the left' }
    );
    return picked?.choice;
}

/** The left side of a comparison with this tree row: the upgrade's original, or a database the user picks. */
export async function compareTargets(project: PairProject | undefined, item: { dbName: string }): Promise<string | undefined> {
    const pair = upgradePair(project);
    if (pair && pair.upgraded.dbName === item.dbName) {
        return pair.original.dbName;
    }
    return (await pickOtherDatabase(project, item.dbName))?.dbName;
}

/**
 * The same view in another database. 'none' when that database has no view
 * of its model and type; undefined when the user dismissed the pick.
 */
export async function findCounterpart(view: ViewRow, dbName: string): Promise<ViewRow | 'none' | undefined> {
    const [byXmlid, rows] = await Promise.all([
        view.xmlid ? findViewByXmlid(dbName, view.xmlid) : Promise.resolve(undefined),
        findViewsLike(dbName, view)
    ]);
    const match = matchView(view, { byXmlid, rows });
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

export function diffArguments(
    original: { dbName: string; view: ViewRow },
    upgraded: { dbName: string; view: ViewRow }
): [vscode.Uri, vscode.Uri, string] {
    const uriOf = (side: { dbName: string; view: ViewRow }) => viewUri(side.dbName, side.view.id, side.view.xmlid ?? `view-${side.view.id}`);
    return [uriOf(original), uriOf(upgraded), `${upgraded.view.name}: ${original.dbName} ↔ ${upgraded.dbName}`];
}
