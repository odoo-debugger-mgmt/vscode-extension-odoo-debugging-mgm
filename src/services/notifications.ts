import * as vscode from 'vscode';
import { logger } from './logger';

/**
 * User-facing messaging helpers. Every notification shown through these is
 * also logged to the "Odoo DevTools" output channel, which is why direct
 * vscode.window.show*Message calls should be avoided elsewhere.
 */

export enum MessageType {
    Error = 'error',
    Warning = 'warning',
    Info = 'info'
}

/**
 * Shows a message with logging to the output channel.
 * @param message - the message to display
 * @param type - the type of message (error, warning, info)
 * @param actions - optional action buttons
 * @returns the selected action or undefined
 */
export async function showMessage(
    message: string,
    type: MessageType = MessageType.Error,
    ...actions: string[]
): Promise<string | undefined> {
    switch (type) {
        case MessageType.Error:
            logger.error(message);
            return vscode.window.showErrorMessage(message, ...actions);
        case MessageType.Warning:
            logger.warn(message);
            return vscode.window.showWarningMessage(message, ...actions);
        case MessageType.Info:
            logger.info(message);
            return vscode.window.showInformationMessage(message, ...actions);
    }
}

/** Shows an error notification with optional action buttons. */
export async function showError(message: string, ...actions: string[]): Promise<string | undefined> {
    return showMessage(message, MessageType.Error, ...actions);
}

/** Shows an info notification with optional action buttons. */
export async function showInfo(message: string, ...actions: string[]): Promise<string | undefined> {
    return showMessage(message, MessageType.Info, ...actions);
}

/** Shows a warning notification with optional action buttons. */
export async function showWarning(message: string, ...actions: string[]): Promise<string | undefined> {
    return showMessage(message, MessageType.Warning, ...actions);
}

/**
 * Shows a modal warning dialog. Use for destructive confirmations where the
 * user must answer before anything proceeds.
 */
export async function showModalWarning(message: string, ...actions: string[]): Promise<string | undefined> {
    logger.warn(message);
    return vscode.window.showWarningMessage(message, { modal: true }, ...actions);
}

/** Shows a modal information dialog (blocks until dismissed). */
export async function showModalInfo(message: string, ...actions: string[]): Promise<string | undefined> {
    logger.info(message);
    return vscode.window.showInformationMessage(message, { modal: true }, ...actions);
}

/**
 * Shows an auto-dismissing information message that disappears after a specified time.
 * @param message - the info message to display
 * @param timeoutMs - time in milliseconds before auto-dismiss (default: 3000ms)
 */
export function showAutoInfo(message: string, timeoutMs: number = 3000): void {
    logger.info(message);
    void vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: message,
        cancellable: false
    }, () => new Promise<void>(resolve => setTimeout(resolve, timeoutMs)));
}

/**
 * Shows a brief status bar message that disappears automatically.
 * @param message - the message to display in the status bar
 * @param timeoutMs - time in milliseconds before auto-dismiss (default: 2000ms)
 */
export function showBriefStatus(message: string, timeoutMs: number = 2000): void {
    logger.info(message);
    // setStatusBarMessage owns the disposal; no leaked status bar items.
    vscode.window.setStatusBarMessage(`$(info) ${message}`, timeoutMs);
}
