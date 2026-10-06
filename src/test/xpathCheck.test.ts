/**
 * The XPath checker's Python tests (src/test/python/test_xpath_check.py),
 * one mocha test each. Uses ODT_VIEW_TEST_PYTHON when set, else python3;
 * skipped when that Python has no lxml (Odoo's venvs all do).
 */
import * as assert from 'assert';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPTS = path.join(REPO, 'resources', 'scripts');
const TESTS = path.join(REPO, 'src', 'test', 'python', 'test_xpath_check.py');
const PYTHON = process.env.ODT_VIEW_TEST_PYTHON || 'python3';

const CASES = [
    'test_a_long_unique_path_offers_shorter_equivalents',
    'test_direct_locator_dead',
    'test_direct_locator_nested_under_data_wrapper',
    'test_direct_locator_no_identifying_attribute_is_skipped',
    'test_direct_locator_ok',
    'test_elements_count_in_document_order_without_comments',
    'test_group_general_dead_against_raw_parent_text',
    'test_group_general_ok_against_a_composed_parent',
    'test_locators_carry_the_line_their_start_tag_ends_on_and_their_element',
    'test_malformed_child_arch_returns_error',
    'test_malformed_parent_arch_returns_error',
    'test_mixed_xpath_and_direct_locators_both_checked',
    'test_xpath_ambiguous',
    'test_xpath_dead',
    'test_xpath_invalid',
    'test_xpath_ok'
];

suite('XPath checker (Python)', function () {
    this.timeout(60000);
    let results: Record<string, string | null> | undefined;

    suiteSetup(function () {
        const probe = spawnSync(PYTHON, ['-c', 'import lxml'], { encoding: 'utf-8' });
        if (probe.status !== 0) {
            this.skip();
        }
        const run = spawnSync(PYTHON, ['-B', TESTS, SCRIPTS], { encoding: 'utf-8' });
        assert.strictEqual(run.status, 0, run.stderr);
        results = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}');
    });

    test('runs exactly the expected cases', () => {
        assert.deepStrictEqual(Object.keys(results ?? {}).sort(), [...CASES].sort());
    });

    for (const name of CASES) {
        test(name, () => {
            assert.ok(results && name in results, `${name} did not run`);
            assert.strictEqual(results[name], null, results[name] ?? undefined);
        });
    }
});
