import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
    parseMinPythonFromSetupPy,
    parseMinPythonFromReleasePy,
    parseSeriesFromReleasePy,
    parsePreferredPythonFromRequirements,
    readOdooPythonWindow
} from '../services/odooRequirements';

const REQUIREMENTS_17 = `# The officially supported versions of the following packages are their
# python3-* equivalent distributed in Ubuntu 22.04 and Debian 11
Babel==2.9.1 ; python_version < '3.11'
`;

const REQUIREMENTS_19 = `# The officially supported versions of the following packages are their
# python3-* equivalent distributed in Ubuntu 24.04 and Debian 12
asn1crypto==1.4.0 ; python_version < '3.11'
`;

async function writeCheckout(files: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'odoo-req-test-'));
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(dir, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf-8');
    }
    return dir;
}

suite('Odoo requirements derivation', () => {
    test('reads the literal python_requires from setup.py', () => {
        assert.deepStrictEqual(
            parseMinPythonFromSetupPy(`    python_requires='>=3.10',`),
            [3, 10]
        );
    });

    test('ignores the computed python_requires form', () => {
        assert.strictEqual(
            parseMinPythonFromSetupPy(`    python_requires='>=' + ".".join(map(str, MIN_PY_VERSION)),`),
            undefined
        );
    });

    test('reads MIN_PY_VERSION from release.py', () => {
        assert.deepStrictEqual(parseMinPythonFromReleasePy('MIN_PY_VERSION = (3, 10)\n'), [3, 10]);
    });

    test('reads the series from release.py version_info', () => {
        assert.strictEqual(
            parseSeriesFromReleasePy(`version_info = (19, 0, 0, FINAL, 0, '')\n`),
            '19.0'
        );
    });

    test('derives preferred python from the requirements header', () => {
        assert.deepStrictEqual(parsePreferredPythonFromRequirements(REQUIREMENTS_17), [3, 10]);
        assert.deepStrictEqual(parsePreferredPythonFromRequirements(REQUIREMENTS_19), [3, 12]);
    });

    test('ignores distribution names that appear after the header', () => {
        const content = `# unrelated header\npkg==1.0\n# Ubuntu 24.04 mentioned in a later comment\n`;
        assert.strictEqual(parsePreferredPythonFromRequirements(content), undefined);
    });

    test('returns no preferred python for an unrecognized header', () => {
        assert.strictEqual(
            parsePreferredPythonFromRequirements('# built for Fedora 40\npkg==1.0\n'),
            undefined
        );
    });

    test('prefers setup.py over release.py and reports the source', async () => {
        const dir = await writeCheckout({
            'setup.py': `    python_requires='>=3.10',`,
            'odoo/release.py': 'MIN_PY_VERSION = (3, 8)\n',
            'requirements.txt': REQUIREMENTS_17
        });
        const window = await readOdooPythonWindow(dir);
        assert.deepStrictEqual(window.minPython, [3, 10]);
        assert.deepStrictEqual(window.preferredPython, [3, 10]);
        assert.strictEqual(window.source, 'setup.py');
    });

    test('falls back to release.py when setup.py has the computed form', async () => {
        const dir = await writeCheckout({
            'setup.py': `    python_requires='>=' + ".".join(map(str, MIN_PY_VERSION)),`,
            'odoo/release.py': `MIN_PY_VERSION = (3, 10)\nversion_info = (19, 0, 0, FINAL, 0, '')\n`,
            'requirements.txt': REQUIREMENTS_19
        });
        const window = await readOdooPythonWindow(dir);
        assert.deepStrictEqual(window.minPython, [3, 10]);
        assert.deepStrictEqual(window.preferredPython, [3, 12]);
        assert.strictEqual(window.series, '19.0');
        assert.strictEqual(window.source, 'release.py');
    });

    test('falls back to 3.10 when nothing is parseable', async () => {
        const dir = await writeCheckout({ 'README.md': 'not an odoo checkout' });
        const window = await readOdooPythonWindow(dir);
        assert.deepStrictEqual(window.minPython, [3, 10]);
        assert.strictEqual(window.preferredPython, undefined);
        assert.strictEqual(window.source, 'fallback');
    });
});
