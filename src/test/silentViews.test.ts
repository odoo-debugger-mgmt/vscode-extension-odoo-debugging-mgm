/**
 * Views and background refreshes read the selection silently.
 *
 * `SettingsStore.getSelectedProject` raises "No project is selected." when
 * there is none, which is right for a command and wrong for a view: every new
 * window on a shared store starts with nothing selected, and was greeted with
 * an error before anyone had done anything. The test run found this twice, in
 * a different view each time, so every tree provider is checked here.
 */
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.resolve(__dirname, '..', '..', 'src');

/** Paths refreshes run through that are not a view's getChildren. */
const SILENT_FUNCTIONS = ['currentUpgradeConfig', 'initializeUpgradeContext', 'initializeTestingContext'];

function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return entry.name === 'test' ? [] : sourceFiles(full);
        }
        return entry.name.endsWith('.ts') ? [full] : [];
    });
}

/** The body of each function or method called `name`, by brace matching. */
function bodiesOf(source: string, name: string): string[] {
    const bodies: string[] = [];
    const pattern = new RegExp(`(?:function\\s+|async\\s+|^\\s+)${name}\\s*\\(`, 'gm');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
        const open = source.indexOf('{', source.indexOf(')', match.index));
        if (open < 0) {
            continue;
        }
        let depth = 0;
        let end = open;
        for (; end < source.length; end++) {
            if (source[end] === '{') {
                depth++;
            } else if (source[end] === '}' && --depth === 0) {
                break;
            }
        }
        bodies.push(source.slice(open, end + 1));
    }
    return bodies;
}

suite('Views read the selection silently', () => {
    const files = fs.existsSync(SRC) ? sourceFiles(SRC) : [];

    (files.length ? test : test.skip)('no getChildren, and no refresh path, raises "No project is selected."', () => {
        const offenders: string[] = [];
        for (const file of files) {
            const source = fs.readFileSync(file, 'utf8');
            for (const name of ['getChildren', ...SILENT_FUNCTIONS]) {
                if (bodiesOf(source, name).some(body => body.includes('getSelectedProject('))) {
                    offenders.push(`${path.relative(SRC, file)}: ${name}`);
                }
            }
        }
        assert.deepStrictEqual(offenders, [], 'use SettingsStore.peekSelectedProject() here');
    });
});
