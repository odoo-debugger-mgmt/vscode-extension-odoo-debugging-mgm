/**
 * Back navigation for multi-step prompts.
 *
 * `showQuickPick` and `showInputBox` have exactly two outcomes: an answer, or
 * gone. In a flow that asks five questions that makes the fourth answer
 * expensive to get wrong - picking the wrong repository meant escaping the
 * whole wizard and retyping the project name. VS Code's own Back button exists
 * for this (`QuickInputButtons.Back`), but only on the `createQuickPick` /
 * `createInputBox` forms, so every backable prompt goes through here.
 *
 * A step returns one of three things, and callers must handle all three:
 * a value, `BACK`, or `undefined` for cancelled.
 */
import * as vscode from 'vscode';

/** The user asked to return to the previous question. */
export const BACK = Symbol('wizard.back');
export type Back = typeof BACK;

/** A value, a request to go back, or undefined when the user cancelled. */
export type StepResult<T> = T | Back | undefined;

export function isBack<T>(result: StepResult<T>): result is Back {
    return result === BACK;
}

interface CommonOptions {
    title?: string;
    /** False on the first question, where there is nowhere to go back to. */
    canGoBack?: boolean;
    ignoreFocusOut?: boolean;
}

export interface PickOptions extends CommonOptions {
    placeHolder?: string;
    matchOnDescription?: boolean;
    matchOnDetail?: boolean;
    /** Preselects a row. `showQuickPick` cannot do this; this form can. */
    activeItem?: (item: vscode.QuickPickItem) => boolean;
}

export interface MultiPickOptions extends PickOptions {
    /** Rows to start ticked. */
    selected?: (item: vscode.QuickPickItem) => boolean;
}

export interface InputOptions extends CommonOptions {
    prompt?: string;
    placeHolder?: string;
    value?: string;
    password?: boolean;
    validateInput?(value: string): string | undefined | Promise<string | undefined>;
}

function backButtons(canGoBack: boolean | undefined): vscode.QuickInputButton[] {
    return canGoBack ? [vscode.QuickInputButtons.Back] : [];
}

/** One quick pick, with a Back button when there is somewhere to go back to. */
export async function pickStep<T extends vscode.QuickPickItem>(
    items: T[],
    options: PickOptions = {}
): Promise<StepResult<T>> {
    const picker = vscode.window.createQuickPick<T>();
    picker.title = options.title;
    picker.placeholder = options.placeHolder;
    picker.matchOnDescription = options.matchOnDescription ?? false;
    picker.matchOnDetail = options.matchOnDetail ?? false;
    picker.ignoreFocusOut = options.ignoreFocusOut ?? true;
    picker.buttons = backButtons(options.canGoBack);
    picker.items = items;

    const active = options.activeItem ? items.find(options.activeItem) : undefined;
    if (active) {
        picker.activeItems = [active];
    }

    return new Promise<StepResult<T>>(resolve => {
        let outcome: StepResult<T>;
        picker.onDidTriggerButton(button => {
            if (button === vscode.QuickInputButtons.Back) {
                outcome = BACK;
                picker.hide();
            }
        });
        picker.onDidAccept(() => {
            outcome = picker.selectedItems[0] ?? picker.activeItems[0];
            picker.hide();
        });
        picker.onDidHide(() => {
            picker.dispose();
            resolve(outcome);
        });
        picker.show();
    });
}

/** A multi-select quick pick, with the same three outcomes. */
export async function multiPickStep<T extends vscode.QuickPickItem>(
    items: T[],
    options: MultiPickOptions = {}
): Promise<StepResult<T[]>> {
    const picker = vscode.window.createQuickPick<T>();
    picker.title = options.title;
    picker.placeholder = options.placeHolder;
    picker.canSelectMany = true;
    picker.matchOnDescription = options.matchOnDescription ?? false;
    picker.matchOnDetail = options.matchOnDetail ?? false;
    picker.ignoreFocusOut = options.ignoreFocusOut ?? true;
    picker.buttons = backButtons(options.canGoBack);
    picker.items = items;

    if (options.selected) {
        picker.selectedItems = items.filter(options.selected);
    }

    return new Promise<StepResult<T[]>>(resolve => {
        let outcome: StepResult<T[]>;
        picker.onDidTriggerButton(button => {
            if (button === vscode.QuickInputButtons.Back) {
                outcome = BACK;
                picker.hide();
            }
        });
        picker.onDidAccept(() => {
            outcome = [...picker.selectedItems];
            picker.hide();
        });
        picker.onDidHide(() => {
            picker.dispose();
            resolve(outcome);
        });
        picker.show();
    });
}

/** One input box, with a Back button when there is somewhere to go back to. */
export async function inputStep(options: InputOptions = {}): Promise<StepResult<string>> {
    const box = vscode.window.createInputBox();
    box.title = options.title;
    box.prompt = options.prompt;
    box.placeholder = options.placeHolder;
    box.value = options.value ?? '';
    box.password = options.password ?? false;
    box.ignoreFocusOut = options.ignoreFocusOut ?? true;
    box.buttons = backButtons(options.canGoBack);

    return new Promise<StepResult<string>>(resolve => {
        let outcome: StepResult<string>;
        let validating = false;

        const validate = async (value: string): Promise<string | undefined> => {
            if (!options.validateInput) {
                return undefined;
            }
            return options.validateInput(value);
        };

        box.onDidChangeValue(async value => {
            box.validationMessage = await validate(value);
        });

        box.onDidTriggerButton(button => {
            if (button === vscode.QuickInputButtons.Back) {
                outcome = BACK;
                box.hide();
            }
        });

        box.onDidAccept(async () => {
            if (validating) {
                return;
            }
            validating = true;
            box.busy = true;
            try {
                const message = await validate(box.value);
                box.validationMessage = message;
                if (message) {
                    return;
                }
                outcome = box.value;
                box.hide();
            } finally {
                validating = false;
                box.busy = false;
            }
        });

        box.onDidHide(() => {
            box.dispose();
            resolve(outcome);
        });
        box.show();
    });
}

/** What a wizard step did. */
export type StepOutcome = 'next' | 'back' | 'cancel';

export interface WizardStep {
    /** Runs the prompt and records its answer. */
    run(canGoBack: boolean): Promise<StepOutcome>;
    /**
     * Set when a step cannot be returned to - it did irreversible work, or it
     * had nothing to ask. Going back from the step after it skips past it.
     */
    skipOnBack?: boolean;
}

/**
 * The three ways a wizard ends. `back` means the user asked to go back from
 * the first answerable step, which lets one wizard be nested inside another:
 * the caller returns to whatever it asked before handing over.
 */
export type WizardOutcome = 'completed' | 'cancelled' | 'back';

/**
 * Runs steps in order, honouring Back.
 *
 * Steps re-run from scratch on the way forward again, so each one must read
 * whatever it needs from shared state rather than assuming it runs once.
 */
export async function runWizard(steps: WizardStep[]): Promise<WizardOutcome> {
    let index = 0;
    while (index < steps.length) {
        // A step is backable only if some earlier step can be returned to.
        const canGoBack = steps.slice(0, index).some(step => !step.skipOnBack);
        const outcome = await steps[index].run(canGoBack);

        if (outcome === 'cancel') {
            return 'cancelled';
        }
        if (outcome === 'back') {
            let target = index - 1;
            while (target >= 0 && steps[target].skipOnBack) {
                target -= 1;
            }
            // Nothing behind the first answerable step, so the answer belongs
            // to whoever called this - it may have a question of its own.
            if (target < 0) {
                return 'back';
            }
            index = target;
            continue;
        }
        index += 1;
    }
    return 'completed';
}

/** Turns a plain prompt into a step that stores its answer. */
export function step<T>(
    run: (canGoBack: boolean) => Promise<StepResult<T>>,
    accept: (value: T) => void,
    options: { skipOnBack?: boolean } = {}
): WizardStep {
    return {
        skipOnBack: options.skipOnBack,
        async run(canGoBack) {
            const result = await run(canGoBack);
            if (result === undefined) {
                return 'cancel';
            }
            if (isBack(result)) {
                return 'back';
            }
            accept(result);
            return 'next';
        }
    };
}
