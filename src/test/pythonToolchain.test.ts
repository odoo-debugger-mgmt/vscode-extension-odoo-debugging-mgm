import * as assert from 'assert';
import * as path from 'node:path';
import {
    parsePythonVersion,
    rankInterpreters,
    isAbovePreferred,
    venvPythonPath,
    InterpreterInfo
} from '../services/pythonToolchain';
import { OdooPythonWindow } from '../services/odooRequirements';

const WINDOW_17: OdooPythonWindow = {
    minPython: [3, 10],
    preferredPython: [3, 10],
    source: 'setup.py'
};

const WINDOW_NO_PREFERENCE: OdooPythonWindow = {
    minPython: [3, 10],
    source: 'fallback'
};

function interpreter(version: [number, number]): InterpreterInfo {
    return { path: `/usr/bin/python${version[0]}.${version[1]}`, version };
}

suite('Python toolchain', () => {
    test('parses the version from python --version output', () => {
        assert.deepStrictEqual(parsePythonVersion('Python 3.12.3\n'), [3, 12]);
        assert.deepStrictEqual(parsePythonVersion('Python 3.9.18'), [3, 9]);
        assert.strictEqual(parsePythonVersion('not python'), undefined);
    });

    test('ranks an exact preferred match first', () => {
        const ranked = rankInterpreters(
            [interpreter([3, 12]), interpreter([3, 10]), interpreter([3, 11])],
            WINDOW_17
        );
        assert.deepStrictEqual(ranked[0].version, [3, 10]);
    });

    test('prefers the newest at or below preferred over anything above it', () => {
        const ranked = rankInterpreters(
            [interpreter([3, 14]), interpreter([3, 10])],
            { minPython: [3, 8], preferredPython: [3, 12], source: 'setup.py' }
        );
        assert.deepStrictEqual(ranked[0].version, [3, 10]);
        assert.deepStrictEqual(ranked[1].version, [3, 14]);
    });

    test('excludes interpreters below the floor', () => {
        const ranked = rankInterpreters([interpreter([3, 8]), interpreter([3, 9])], WINDOW_17);
        assert.deepStrictEqual(ranked, []);
    });

    test('takes the newest at or above the floor when there is no preference', () => {
        const ranked = rankInterpreters(
            [interpreter([3, 10]), interpreter([3, 14]), interpreter([3, 12])],
            WINDOW_NO_PREFERENCE
        );
        assert.deepStrictEqual(ranked[0].version, [3, 14]);
    });

    test('flags an interpreter above the preferred version', () => {
        assert.strictEqual(isAbovePreferred(interpreter([3, 14]), WINDOW_17), true);
        assert.strictEqual(isAbovePreferred(interpreter([3, 10]), WINDOW_17), false);
        assert.strictEqual(isAbovePreferred(interpreter([3, 14]), WINDOW_NO_PREFERENCE), false);
    });

    test('builds the platform-correct venv interpreter path', () => {
        const expected = process.platform === 'win32'
            ? path.join('/venv', 'Scripts', 'python.exe')
            : path.join('/venv', 'bin', 'python');
        assert.strictEqual(venvPythonPath('/venv'), expected);
    });
});
