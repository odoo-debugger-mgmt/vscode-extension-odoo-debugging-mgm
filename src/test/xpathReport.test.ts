import * as assert from 'assert';
import { brokenLocators, checkResultText, parseXpathReport } from '../services/views/xpathReport';

const locator = (status: string, extra: Record<string, unknown> = {}) => ({
    kind: 'xpath', expr: '//a', position: 'after', length: 3, line: 2, element: 1, status, matches: status === 'dead' ? 0 : 1, shorter: [], ...extra
});

suite('XPath report', () => {
    test('parses the checker\'s result and counts it again', () => {
        const report = parseXpathReport({
            locators: [locator('ok', { shorter: ['//x'] }), locator('dead'), locator('ambiguous', { matches: 3 }), locator('invalid', { matches: null, detail: 'Invalid expression' })],
            summary: { ok: 99 }, healthy: true
        });
        assert.deepStrictEqual(report.summary, { ok: 1, dead: 1, ambiguous: 1, invalid: 1 });
        assert.strictEqual(report.healthy, false);
        assert.deepStrictEqual(report.locators[0], { kind: 'xpath', expr: '//a', position: 'after', status: 'ok', matches: 1, line: 2, element: 1, shorter: ['//x'] });
        assert.strictEqual(report.locators[3].detail, 'Invalid expression');
        assert.strictEqual(report.locators[3].matches, null);
    });

    test('an error result has no locators', () => {
        assert.deepStrictEqual(parseXpathReport({ error: 'child arch is not valid XML: x' }),
            { locators: [], summary: { ok: 0, dead: 0, ambiguous: 0, invalid: 0 }, healthy: false, error: 'child arch is not valid XML: x' });
    });

    test('odd shapes do not throw', () => {
        assert.deepStrictEqual(parseXpathReport(null).locators, []);
        const odd = parseXpathReport({ locators: [{ status: 'weird', kind: 'other', line: 'x', element: -1 }] }).locators[0];
        assert.deepStrictEqual([odd.status, odd.kind, odd.line, odd.element, odd.expr], ['invalid', 'direct', null, null, '']);
    });

    test('what a save says about broken locators', () => {
        assert.strictEqual(brokenLocators(parseXpathReport({ locators: [locator('ok'), locator('ambiguous')] })), undefined);
        assert.strictEqual(brokenLocators(parseXpathReport({ locators: [locator('dead')] })), '1 locator matches nothing');
        assert.strictEqual(brokenLocators(parseXpathReport({ locators: [locator('dead'), locator('dead'), locator('invalid')] })),
            '2 locators match nothing and 1 locator is not valid XPath');
    });

    test('what Check XPaths says', () => {
        assert.deepStrictEqual(checkResultText(parseXpathReport({ locators: [locator('ok'), locator('ok')] })), { level: 'info', text: 'All 2 locators match.' });
        assert.deepStrictEqual(checkResultText(parseXpathReport({ locators: [locator('ok')] })), { level: 'info', text: 'The locator matches.' });
        assert.deepStrictEqual(checkResultText(parseXpathReport({ locators: [] })), { level: 'info', text: 'This view has no locators to check.' });
        assert.deepStrictEqual(checkResultText(parseXpathReport({ locators: [locator('ok'), locator('dead'), locator('ambiguous'), locator('ambiguous')] })),
            { level: 'warning', text: 'Of 4 locators, 1 matches nothing, 2 match several nodes.' });
        assert.deepStrictEqual(checkResultText(parseXpathReport({ locators: [locator('dead')] })), { level: 'warning', text: 'The locator matches nothing.' });
        assert.deepStrictEqual(checkResultText(parseXpathReport({ locators: [locator('ambiguous', { matches: 2 })] })),
            { level: 'warning', text: 'The locator matches several nodes.' });
        assert.deepStrictEqual(checkResultText(parseXpathReport({ locators: [locator('invalid', { matches: null })] })),
            { level: 'warning', text: 'The locator is not valid XPath.' });
        assert.deepStrictEqual(checkResultText(parseXpathReport({ error: 'child arch is not valid XML: y' })),
            { level: 'warning', text: 'Could not check the locators: child arch is not valid XML: y' });
    });
});
