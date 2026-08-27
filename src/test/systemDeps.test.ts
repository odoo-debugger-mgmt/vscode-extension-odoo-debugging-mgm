import * as assert from 'assert';
import { installHintFor, summarizeMissing, SystemDepReport } from '../services/systemDeps';

function report(id: string, present: boolean): SystemDepReport {
    return { id, label: id, present, impact: `${id} impact` };
}

suite('System dependency doctor', () => {
    test('gives a platform-specific install hint', () => {
        assert.ok(installHintFor('wkhtmltopdf', 'apt')?.includes('apt'));
        assert.ok(installHintFor('wkhtmltopdf', 'brew')?.includes('brew'));
        assert.ok(installHintFor('wkhtmltopdf', 'dnf')?.includes('dnf'));
    });

    test('returns no hint for an unknown platform or unknown dependency', () => {
        assert.strictEqual(installHintFor('wkhtmltopdf', 'unknown'), undefined);
        assert.strictEqual(installHintFor('nonexistent-tool', 'apt'), undefined);
    });

    test('summarizes only the missing dependencies', () => {
        const summary = summarizeMissing([
            report('wkhtmltopdf', false),
            report('psql', true),
            report('rtlcss', false)
        ]);
        assert.ok(summary);
        assert.ok(summary.includes('wkhtmltopdf'));
        assert.ok(summary.includes('rtlcss'));
        assert.ok(!summary.includes('psql'));
    });

    test('returns undefined when nothing is missing', () => {
        assert.strictEqual(summarizeMissing([report('psql', true)]), undefined);
    });
});
