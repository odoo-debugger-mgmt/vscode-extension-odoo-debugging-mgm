import * as vscode from 'vscode';
import { showInfo } from '../services/notifications';

/**
 * Shared quick-pick search over tree items, used by every view's
 * "search" title-bar action.
 */

export function getTreeItemLabel(item: vscode.TreeItem): string {
    if (typeof item.label === 'string') {
        return item.label;
    }
    if (item.label && typeof item.label === 'object' && 'label' in item.label) {
        return item.label.label;
    }
    return '';
}

function getTreeItemDescription(item: vscode.TreeItem): string | undefined {
    return typeof item.description === 'string' ? item.description : undefined;
}

function stripMarkdownForQuickPick(value: string): string {
    return value
        // Convert markdown links to visible text only.
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        // Remove common markdown tokens.
        .replace(/[*_`>#~]/g, '')
        // Normalize line breaks for quick-pick rows.
        .replace(/\r?\n+/g, ' • ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function getTreeItemDetail(item: vscode.TreeItem): string | undefined {
    if (typeof item.tooltip === 'string') {
        return stripMarkdownForQuickPick(item.tooltip);
    }
    if (item.tooltip instanceof vscode.MarkdownString) {
        return stripMarkdownForQuickPick(item.tooltip.value);
    }
    return undefined;
}

export async function quickSearchTreeItems(
    items: vscode.TreeItem[],
    options: {
        placeHolder: string;
        title: string;
        emptyMessage: string;
        onPick?: (item: vscode.TreeItem) => Promise<void>;
    }
): Promise<void> {
    if (!items.length) {
        void showInfo(options.emptyMessage);
        return;
    }

    const picks = items.map(item => ({
        label: getTreeItemLabel(item),
        description: getTreeItemDescription(item),
        detail: getTreeItemDetail(item),
        item
    }));

    const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: options.placeHolder,
        title: options.title,
        ignoreFocusOut: true,
        matchOnDescription: true,
        matchOnDetail: true
    });

    if (!selected) {
        return;
    }

    if (options.onPick) {
        await options.onPick(selected.item);
        return;
    }

    if (!selected.item.command) {
        void showInfo('No action is available for the selected item.');
        return;
    }

    await vscode.commands.executeCommand(
        selected.item.command.command,
        ...(selected.item.command.arguments ?? [])
    );
}
