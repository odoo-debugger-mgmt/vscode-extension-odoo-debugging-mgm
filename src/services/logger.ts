import * as vscode from 'vscode';

/**
 * Central logging for the extension. Everything user-relevant that used to go
 * to the developer console is appended to a single "Odoo DevTools" output
 * channel so users can actually see it (View -> Output -> Odoo DevTools).
 */

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
    channel ??= vscode.window.createOutputChannel('Odoo DevTools');
    return channel;
}

/**
 * Registers the output channel for disposal with the extension context.
 * Safe to call before the channel exists; disposal is lazy.
 */
export function registerLogger(context: vscode.ExtensionContext): void {
    context.subscriptions.push({
        dispose: () => {
            channel?.dispose();
            channel = undefined;
        }
    });
}

/** Reveals the output channel in the panel. */
export function showLogOutput(): void {
    getChannel().show(true);
}

/**
 * Normalizes an unknown thrown value into a human-readable message,
 * so raw `${error}` interpolation (which prints stacks/objects) is avoided.
 */
export function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

function formatDetail(detail: unknown): string {
    if (detail instanceof Error) {
        return detail.stack ?? detail.message;
    }
    if (typeof detail === 'string') {
        return detail;
    }
    try {
        return JSON.stringify(detail);
    } catch {
        return String(detail);
    }
}

function append(level: string, message: string, details: unknown[]): void {
    const timestamp = new Date().toISOString();
    const suffix = details.length > 0 ? ` ${details.map(formatDetail).join(' ')}` : '';
    getChannel().appendLine(`[${timestamp}] ${level}: ${message}${suffix}`);
}

export const logger = {
    debug(message: string, ...details: unknown[]): void {
        append('DEBUG', message, details);
    },
    info(message: string, ...details: unknown[]): void {
        append('INFO', message, details);
    },
    warn(message: string, ...details: unknown[]): void {
        append('WARN', message, details);
    },
    error(message: string, ...details: unknown[]): void {
        append('ERROR', message, details);
    }
};
