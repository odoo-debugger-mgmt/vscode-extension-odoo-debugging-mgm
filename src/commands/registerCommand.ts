/**
 * `vscode.commands.registerCommand`, except that a change the data store
 * refused is reported as what it is.
 *
 * A read-only or locked store rejects the save a command ends with. Uncaught,
 * that reached VS Code as "Error running command …. This is likely caused by
 * the extension that contributes …" - blaming the extension for a store doing
 * what it should. Every other error still propagates unchanged.
 */
import * as vscode from 'vscode';
import { StoreBusyError, StoreReadOnlyError } from '../services/sqliteMainStore';
import { showWarning } from '../services/notifications';

/** Whether `error` is the store refusing a change, rather than a failure. */
export function isStoreRefusal(error: unknown): error is Error {
    return error instanceof StoreReadOnlyError || error instanceof StoreBusyError;
}

/** Runs `handler`, turning a store refusal into a warning. */
export async function reportingStoreRefusals<T>(handler: () => T | Thenable<T>): Promise<T | undefined> {
    try {
        return await handler();
    } catch (error) {
        if (isStoreRefusal(error)) {
            void showWarning(`${error.message}.`);
            return undefined;
        }
        throw error;
    }
}

export function registerCommand(
    command: string,
    callback: (...args: any[]) => any,
    thisArg?: unknown
): vscode.Disposable {
    return vscode.commands.registerCommand(
        command,
        (...args: any[]) => reportingStoreRefusals(() => callback.apply(thisArg, args))
    );
}
