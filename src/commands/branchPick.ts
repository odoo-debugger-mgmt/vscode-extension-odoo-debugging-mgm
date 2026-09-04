/**
 * Shared Odoo branch picker.
 *
 * The picker is shown before the branch list is known, then filled in - the
 * previous flow awaited the full remote branch list first, which on the odoo
 * repository is ~68,700 refs and left the button looking dead for seconds.
 * Only release branches are listed up front; everything else stays reachable
 * behind an explicit "search all" row that pays the cost on demand.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { listSeriesBranches, listAllBranches } from '../services/gitService';

interface BranchPickItem extends vscode.QuickPickItem {
    action: 'branch' | 'manual' | 'all';
    branch?: string;
}

const MANUAL_ITEM: BranchPickItem = {
    label: '$(pencil) Enter branch manually…',
    description: 'e.g. "19.0", "saas-18.4", "master"',
    action: 'manual'
};

const SEARCH_ALL_ITEM: BranchPickItem = {
    label: '$(search) Search all branches…',
    description: 'Includes PR and development branches — slower on large repositories',
    action: 'all'
};

function toItems(branches: string[], includeSearchAll: boolean): BranchPickItem[] {
    const items: BranchPickItem[] = branches.map(branch => ({
        label: branch,
        action: 'branch' as const,
        branch
    }));
    if (includeSearchAll) {
        items.push(SEARCH_ALL_ITEM);
    }
    items.push(MANUAL_ITEM);
    return items;
}

async function promptManualBranch(title: string): Promise<string | undefined> {
    const entered = await vscode.window.showInputBox({
        title,
        placeHolder: 'Enter Odoo version/branch (e.g. "19.0", "saas-18.4", "master")',
        ignoreFocusOut: true,
        validateInput: value => value.trim() ? undefined : 'Branch is required.'
    });
    return entered?.trim() || undefined;
}

/**
 * Asks for an Odoo branch. Resolves to undefined when the user cancels.
 */
export async function pickOdooBranch(odooPath: string | undefined, title: string): Promise<string | undefined> {
    const repoPath = odooPath && fs.existsSync(odooPath) ? odooPath : undefined;
    if (!repoPath) {
        return promptManualBranch(title);
    }

    const picker = vscode.window.createQuickPick<BranchPickItem>();
    picker.title = title;
    picker.placeholder = 'Select the Odoo branch for this version';
    picker.busy = true;
    picker.items = [MANUAL_ITEM];

    try {
        const selection = await new Promise<BranchPickItem | undefined>(resolve => {
            let settled = false;
            const settle = (value: BranchPickItem | undefined) => {
                if (!settled) {
                    settled = true;
                    resolve(value);
                }
            };

            picker.onDidAccept(() => {
                const picked = picker.selectedItems[0];
                if (picked?.action === 'all') {
                    // Explicitly requested: pay the full enumeration now, with
                    // the picker still on screen showing progress.
                    picker.busy = true;
                    void listAllBranches(repoPath).then(all => {
                        picker.items = toItems(all, false);
                        picker.busy = false;
                    });
                    return;
                }
                settle(picked);
                picker.hide();
            });
            picker.onDidHide(() => settle(undefined));
            picker.show();

            void listSeriesBranches(repoPath).then(branches => {
                picker.items = toItems(branches, true);
                picker.busy = false;
            });
        });

        if (!selection) {
            return undefined;
        }
        if (selection.action === 'manual') {
            return promptManualBranch(title);
        }
        return selection.branch;
    } finally {
        picker.dispose();
    }
}

/**
 * Asks for a branch in one of the user's own repositories.
 *
 * Kept separate from `pickOdooBranch`: a custom repository has tens of
 * branches rather than tens of thousands, so the whole list is affordable up
 * front and needs no "search all" escape hatch. The point is the same one -
 * a branch the user has to type from memory is a branch they get wrong.
 */
export async function pickRepoBranch(
    repoPath: string | undefined,
    title: string,
    placeHolder: string,
    current?: string,
    exclude?: string
): Promise<string | undefined> {
    const all = repoPath && fs.existsSync(repoPath)
        ? await listAllBranches(repoPath).catch(() => [])
        : [];
    // An upgrade never runs from a branch to itself, and leaving it in the list
    // meant the "upgrading to" picker opened highlighted on the branch just
    // chosen as "upgrading from".
    const branches = exclude ? all.filter(name => name !== exclude) : all;

    if (branches.length === 0) {
        return promptManualBranch(title);
    }

    const items: BranchPickItem[] = branches.map(branch => ({
        label: branch,
        description: branch === current ? 'current branch' : undefined,
        action: 'branch' as const,
        branch
    }));
    items.push(MANUAL_ITEM);

    // createQuickPick, not showQuickPick: `current` has to *preselect* a row,
    // and showQuickPick always opens on its first item however the rows are
    // described. Without this the seed was decoration - the caller's claim
    // that a shared naming convention is Enter-Enter was simply not true.
    const picker = vscode.window.createQuickPick<BranchPickItem>();
    picker.title = title;
    picker.placeholder = placeHolder;
    picker.ignoreFocusOut = true;
    picker.matchOnDescription = true;
    picker.items = items;

    const preselect = current ? items.find(item => item.branch === current) : undefined;
    if (preselect) {
        picker.activeItems = [preselect];
    }

    const picked = await new Promise<BranchPickItem | undefined>(resolve => {
        let accepted: BranchPickItem | undefined;
        picker.onDidAccept(() => {
            accepted = picker.selectedItems[0] ?? picker.activeItems[0];
            picker.hide();
        });
        picker.onDidHide(() => {
            picker.dispose();
            resolve(accepted);
        });
        picker.show();
    });

    if (!picked) {
        return undefined;
    }
    return picked.action === 'manual' ? promptManualBranch(title) : picked.branch;
}
