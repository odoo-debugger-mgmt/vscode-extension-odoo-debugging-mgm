/**
 * Switching data stores is not a deletion (sixteenth run).
 *
 * A window's selection and its version binding name things in the store it
 * uses. Moving the window to its own file and back read the other store's
 * data as "deleted in another window", dropped the binding and lost the
 * selection. Each store now keeps the window's state as it left it: stashed
 * when the window leaves a store, given back when it returns.
 */
import type * as vscode from 'vscode';
import { SELECTION_STATE_KEY } from './workspaceSelection';
import { BINDING_STATE_KEY } from './workspaceBinding';

export const PER_STORE_PREFIX = 'odt.perStore:';

interface StoreState {
    selection?: unknown;
    binding?: unknown;
}

/** Keeps what this window had in the store at `location`. */
export async function stashForStore(memento: vscode.Memento, location: string): Promise<void> {
    const state: StoreState = {
        selection: memento.get(SELECTION_STATE_KEY),
        binding: memento.get(BINDING_STATE_KEY)
    };
    await memento.update(PER_STORE_PREFIX + location, state);
}

/**
 * Gives back what this window had in the store at `location`. A store it
 * never used keeps the current selection - it is reconciled with that
 * store's data - and has no binding: one is made in a store, for its
 * versions.
 */
export async function restoreForStore(memento: vscode.Memento, location: string): Promise<void> {
    const state = memento.get<StoreState>(PER_STORE_PREFIX + location);
    if (state?.selection !== undefined) {
        await memento.update(SELECTION_STATE_KEY, state.selection);
    }
    await memento.update(BINDING_STATE_KEY, state?.binding);
}
