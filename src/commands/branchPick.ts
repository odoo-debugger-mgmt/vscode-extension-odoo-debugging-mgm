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
