import * as assert from 'assert';
import { BACK, runWizard, step, WizardStep } from '../services/wizard';

/** Records the order steps ran in, and answers each one from a script. */
function scripted(
    log: string[],
    name: string,
    answers: Array<'value' | 'back' | 'cancel'>,
    options: { skipOnBack?: boolean } = {}
): WizardStep {
    let call = 0;
    return step<string>(
        async canGoBack => {
            log.push(`${name}${canGoBack ? '' : ' (first)'}`);
            const answer = answers[Math.min(call, answers.length - 1)];
            call += 1;
            if (answer === 'back') {
                return BACK;
            }
            return answer === 'cancel' ? undefined : name;
        },
        () => undefined,
        options
    );
}

suite('Wizard back navigation', () => {
    test('runs steps in order and reports completion', async () => {
        const log: string[] = [];
        const done = await runWizard([
            scripted(log, 'a', ['value']),
            scripted(log, 'b', ['value']),
            scripted(log, 'c', ['value'])
        ]);
        assert.strictEqual(done, 'completed');
        assert.deepStrictEqual(log, ['a (first)', 'b', 'c']);
    });

    test('back re-runs the previous step', async () => {
        const log: string[] = [];
        const done = await runWizard([
            scripted(log, 'a', ['value', 'value']),
            scripted(log, 'b', ['back', 'value'])
        ]);
        assert.strictEqual(done, 'completed');
        assert.deepStrictEqual(log, ['a (first)', 'b', 'a (first)', 'b']);
    });

    test('the first step is told it cannot go back', async () => {
        const log: string[] = [];
        await runWizard([scripted(log, 'only', ['value'])]);
        assert.deepStrictEqual(log, ['only (first)']);
    });

    test('back out of the first answerable step reports back, not cancelled', async () => {
        // So a caller can nest wizards and return to its own earlier question.
        const done = await runWizard([scripted([], 'a', ['back'])]);
        assert.strictEqual(done, 'back');
    });

    test('cancel stops immediately and reports it', async () => {
        const log: string[] = [];
        const done = await runWizard([
            scripted(log, 'a', ['value']),
            scripted(log, 'b', ['cancel']),
            scripted(log, 'c', ['value'])
        ]);
        assert.strictEqual(done, 'cancelled');
        assert.deepStrictEqual(log, ['a (first)', 'b']);
    });

    test('back skips past a step that cannot be returned to', async () => {
        // A step that did irreversible work, or had nothing to ask.
        const log: string[] = [];
        const done = await runWizard([
            scripted(log, 'a', ['value', 'value']),
            scripted(log, 'work', ['value', 'value'], { skipOnBack: true }),
            scripted(log, 'c', ['back', 'value'])
        ]);
        assert.strictEqual(done, 'completed');
        assert.deepStrictEqual(log, ['a (first)', 'work', 'c', 'a (first)', 'work', 'c']);
    });

    test('a step after only unbackable ones is told it cannot go back', async () => {
        const log: string[] = [];
        await runWizard([
            scripted(log, 'auto', ['value'], { skipOnBack: true }),
            scripted(log, 'b', ['value'])
        ]);
        assert.deepStrictEqual(log, ['auto (first)', 'b (first)']);
    });

    test('back repeatedly walks all the way to the front', async () => {
        const log: string[] = [];
        const done = await runWizard([
            scripted(log, 'a', ['value', 'value']),
            scripted(log, 'b', ['value', 'back', 'value']),
            scripted(log, 'c', ['back', 'value'])
        ]);
        assert.strictEqual(done, 'completed');
        assert.deepStrictEqual(log, ['a (first)', 'b', 'c', 'b', 'a (first)', 'b', 'c']);
    });
});
