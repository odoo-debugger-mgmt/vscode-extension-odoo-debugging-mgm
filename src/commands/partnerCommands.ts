/**
 * A database's comparison partner: set, clear, and run it alongside.
 * See services/comparisonPartner.ts.
 */
import * as vscode from 'vscode';
import type { CommandDeps } from './index';
import { registerCommand } from './registerCommand';
import { databaseFor } from './alongsideCommands';
import { SettingsStore } from '../settingsStore';
import { runAlongside } from '../debugger';
import { getRunningInstances } from '../services/runningState';
import { showError, showInfo } from '../services/notifications';
import { partnerChoices, type PartnerProject } from '../services/comparisonPartner';
import { partnerFor, storePartner, upgradePair, type PairProject } from '../views/viewPairing';

async function currentProject(): Promise<PairProject | undefined> {
    return (await SettingsStore.getSelectedProject())?.project as PairProject | undefined;
}

export function registerPartnerCommands(deps: CommandDeps): void {
    const { context, refreshAll } = deps;

    context.subscriptions.push(registerCommand('dbSelector.setComparisonPartner', async (event?: unknown) => {
        const db = await databaseFor(event, 'Set Comparison Partner');
        if (!db) {
            return;
        }
        const project = await currentProject();
        const running = new Set((await getRunningInstances()).map(instance => instance.dbName));
        const choices = partnerChoices(project as PartnerProject | undefined, db.id, running);
        if (choices.length === 0) {
            void showInfo(`The project has no other database or checkpoint to compare ${db.id} with.`);
            return;
        }
        const picked = await vscode.window.showQuickPick(choices.map(choice => ({
            label: choice.kind === 'checkpoint' ? `$(history) ${choice.label}` : choice.dbName,
            description: choice.kind === 'checkpoint' ? `checkpoint of ${db.id}` : (choice.running ? 'running' : undefined),
            choice
        })), { title: `Compare ${db.id} with…`, placeHolder: 'Its comparison partner' });
        if (!picked) {
            return;
        }
        await storePartner(db.id, { dbName: picked.choice.dbName, kind: picked.choice.kind });
        const pair = upgradePair(project);
        if (pair && (pair.original.dbName === db.id || pair.upgraded.dbName === db.id)) {
            void showInfo(`In Upgrade mode, ${db.id}'s partner is the other side of the upgrade.`);
        }
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(registerCommand('dbSelector.clearComparisonPartner', async (event?: unknown) => {
        const db = await databaseFor(event, 'Clear Comparison Partner');
        if (!db) {
            return;
        }
        await storePartner(db.id, undefined);
        void showInfo(`${db.id} no longer has a comparison partner.`);
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(registerCommand('dbSelector.runPartnerAlongside', async (event?: unknown) => {
        const db = await databaseFor(event, 'Run Partner Alongside');
        if (!db) {
            return;
        }
        const partner = await partnerFor(await currentProject(), db.id, { ask: true });
        if (!partner) {
            return;
        }
        if (partner.kind === 'checkpoint') {
            void showInfo('A checkpoint cannot be run: restore it, or clone it, to run it.');
            return;
        }
        await runAlongside(partner.dbName, {});
        await refreshAll({ reason: 'ui' });
    }));

    context.subscriptions.push(registerCommand('dbSelector.runPairAlongside', async (...dbIds: string[]) => {
        const failures: string[] = [];
        for (const id of dbIds) {
            const result = await runAlongside(id, { quiet: true });
            if (!result.ok) {
                failures.push(`${id}: ${result.message ?? 'did not start'}`);
            }
        }
        if (failures.length > 0) {
            void showError(`Could not start: ${failures.join('; ')}`);
        }
        await refreshAll({ reason: 'ui' });
    }));
}
