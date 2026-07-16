/**
 * Help commands: a keyboard-shortcut cheat sheet generated from the
 * extension's own package.json contributions, so it never goes stale.
 * Picking an entry runs the command; the last entry opens the Keyboard
 * Shortcuts editor for customization.
 */
import * as vscode from 'vscode';
import type { CommandDeps } from './index';

interface KeybindingContribution {
    command: string;
    key: string;
    mac?: string;
}

interface CommandContribution {
    command: string;
    title: string;
}

/** 'ctrl+alt+o s' → 'Ctrl+Alt+O S' */
function formatKey(key: string): string {
    return key
        .split(' ')
        .map(chord => chord
            .split('+')
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join('+'))
        .join(' ');
}

export function registerHelpCommands(deps: CommandDeps): void {
    const { context } = deps;

    context.subscriptions.push(vscode.commands.registerCommand('odoo.showKeyboardShortcuts', async () => {
        const contributes = vscode.extensions.getExtension('AhmadMansour.odoo-devtools-vscode')?.packageJSON?.contributes as
            | { keybindings?: KeybindingContribution[]; commands?: CommandContribution[] }
            | undefined;
        const keybindings = contributes?.keybindings ?? [];
        const titles = new Map((contributes?.commands ?? []).map(entry => [entry.command, entry.title]));
        const isMac = process.platform === 'darwin';

        type ShortcutPick = vscode.QuickPickItem & { command?: string };
        const picks: ShortcutPick[] = keybindings.map(binding => ({
            label: titles.get(binding.command) ?? binding.command,
            description: formatKey(isMac && binding.mac ? binding.mac : binding.key),
            command: binding.command
        }));
        picks.push(
            { label: '', kind: vscode.QuickPickItemKind.Separator },
            { label: '$(gear) Customize Keyboard Shortcuts…', description: 'Open the Keyboard Shortcuts editor filtered to Odoo' }
        );

        const selected = await vscode.window.showQuickPick(picks, {
            title: 'Odoo DevTools Keyboard Shortcuts',
            placeHolder: 'Pick an entry to run its command',
            matchOnDescription: true
        });
        if (!selected) {
            return;
        }
        if (!selected.command) {
            await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'odoo');
            return;
        }
        await vscode.commands.executeCommand(selected.command);
    }));
}
