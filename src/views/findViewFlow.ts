/**
 * Find View: any view of the tree's database, by id, external id or model;
 * and the pick both it and Views Inheriting This end in. Picking a view
 * opens its arch - the tree itself stays about what is off.
 */
import * as vscode from 'vscode';
import { findViewByXmlid, getViewRows, viewModels, viewsOfModel, type ViewRow } from '../services/views/viewQueries';
import { showInfo } from '../services/notifications';
import { findViewItems, nothingMatches, viewPickItems, viewTree, type FindChoice, type FindItem } from './viewPicker';

export type OpenView = (dbName: string, view: ViewRow) => Promise<void>;

export async function pickView(dbName: string, rows: ViewRow[], title: string, open: OpenView): Promise<void> {
    const picked = await vscode.window.showQuickPick(viewPickItems(viewTree(rows)), { title, matchOnDescription: true });
    if (picked) {
        await open(dbName, picked.view);
    }
}

/** The picked choice; or, for Enter on a value no item matches, what to say; undefined when closed. */
type Answer = { choice: FindChoice } | { unmatched: string };

function askWhat(dbName: string, models: Awaited<ReturnType<typeof viewModels>>): Promise<Answer | undefined> {
    const quickPick = vscode.window.createQuickPick<FindItem>();
    quickPick.title = `Find a view in ${dbName}`;
    quickPick.placeholder = 'A view id, an external ID, or a model';
    quickPick.items = findViewItems('', models);
    return new Promise(resolve => {
        quickPick.onDidChangeValue(value => {
            quickPick.items = findViewItems(value, models);
        });
        quickPick.onDidAccept(() => {
            const choice = quickPick.selectedItems[0]?.choice;
            const unmatched = choice ? undefined : nothingMatches(dbName, quickPick.value);
            resolve(choice ? { choice } : unmatched ? { unmatched } : undefined);
            quickPick.hide();
        });
        quickPick.onDidHide(() => {
            resolve(undefined);
            quickPick.dispose();
        });
        quickPick.show();
    });
}

export async function findView(dbName: string, open: OpenView): Promise<void> {
    const answer = await askWhat(dbName, await viewModels(dbName));
    if (!answer) {
        return;
    }
    if ('unmatched' in answer) {
        void showInfo(answer.unmatched);
        return;
    }
    const { choice } = answer;
    if (choice.kind === 'id') {
        const [view] = await getViewRows(dbName, [choice.id]);
        if (view) {
            await open(dbName, view);
        } else {
            void showInfo(`${dbName} has no view ${choice.id}.`);
        }
        return;
    }
    if (choice.kind === 'xmlid') {
        const view = await findViewByXmlid(dbName, choice.xmlid);
        if (view) {
            await open(dbName, view);
        } else {
            void showInfo(`${dbName} has no view with the external ID ${choice.xmlid}.`);
        }
        return;
    }
    await pickView(dbName, await viewsOfModel(dbName, choice.model), `Views of ${choice.model} in ${dbName}`, open);
}
