import * as assert from 'assert';
import { makeLineForwarder } from '../services/process';

suite('Process output lines', () => {
    const feed = (chunks: string[]): string[] => {
        const lines: string[] = [];
        const forward = makeLineForwarder(line => lines.push(line));
        chunks.forEach(forward);
        return lines;
    };

    test('a progress redraw with a bare carriage return is a line of its own', () => {
        assert.deepStrictEqual(feed(['Counting: 1%\rCounting: 2%\rCounting: done.\n']), ['Counting: 1%', 'Counting: 2%', 'Counting: done.']);
    });

    test('CRLF split across two chunks gives no empty line', () => {
        assert.deepStrictEqual(feed(['a\r', '\nb\n']), ['a', 'b']);
    });

    test('plain newlines and a partial last line', () => {
        assert.deepStrictEqual(feed(['one\ntw', 'o\nthree']), ['one', 'two']);
    });
});
