/**
 * A small indentation scanner for Python classes and functions, so a symbol
 * can be cut out of a file without a language server.
 */

export interface PySymbol {
    kind: 'class' | 'function';
    name: string;
    /** Names of the enclosing symbols and this one, joined by dots. */
    qualified: string;
    /** 0-based first line, decorators included. */
    start: number;
    /** 0-based line after the last non-blank body line. */
    end: number;
}

const OPENER = /^(\s*)(class|def|async\s+def)\s+(\w+)/;

function indentOf(line: string): number {
    return line.length - line.trimStart().length;
}

/** For each line: does it begin inside a triple-quoted string? */
function stringStarts(lines: string[]): boolean[] {
    const out: boolean[] = [];
    let open: string | undefined;
    for (const line of lines) {
        out.push(open !== undefined);
        const re = /"""|'''/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line))) {
            if (open === undefined) {
                open = m[0];
            } else if (open === m[0]) {
                open = undefined;
            }
        }
    }
    return out;
}

export function scanPythonSymbols(text: string): PySymbol[] {
    const lines = text.split('\n');
    const inString = stringStarts(lines);
    const symbols: PySymbol[] = [];
    const stack: PySymbol[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = inString[i] ? null : OPENER.exec(lines[i]);
        if (!m) {
            continue;
        }
        const indent = m[1].length;
        let end = i + 1;
        for (let j = i + 1; j < lines.length; j++) {
            if (inString[j] || !lines[j].trim()) {
                continue;
            }
            if (indentOf(lines[j]) <= indent) {
                break;
            }
            end = j + 1;
        }
        let start = i;
        while (start > 0 && lines[start - 1].trim().startsWith('@') && indentOf(lines[start - 1]) === indent) {
            start--;
        }
        while (stack.length && stack[stack.length - 1].end <= i) {
            stack.pop();
        }
        const qualified = [...stack.map(s => s.name), m[3]].join('.');
        const symbol: PySymbol = { kind: m[2] === 'class' ? 'class' : 'function', name: m[3], qualified, start, end };
        symbols.push(symbol);
        stack.push(symbol);
    }
    return symbols;
}

/** The innermost symbol whose lines contain `line`. */
export function enclosingSymbol(symbols: PySymbol[], line: number): PySymbol | undefined {
    let best: PySymbol | undefined;
    for (const s of symbols) {
        if (s.start <= line && line < s.end && (!best || s.start >= best.start)) {
            best = s;
        }
    }
    return best;
}

export function symbolText(text: string, s: PySymbol): string {
    return text.split('\n').slice(s.start, s.end).join('\n');
}

/** The model a class declares: `_name`, and `_inherit` as a string or a list. */
export function modelKeyOf(classText: string): { name?: string; inherit?: string[] } {
    const key: { name?: string; inherit?: string[] } = {};
    const name = /^\s*_name\s*=\s*['"]([^'"]+)['"]/m.exec(classText);
    if (name) {
        key.name = name[1];
    }
    const inherit = /^\s*_inherit\s*=\s*(\[[^\]]*\]|\([^)]*\)|['"][^'"]+['"])/m.exec(classText);
    if (inherit) {
        key.inherit = [...inherit[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);
    }
    return key;
}

/** The class of the same model (see `key`) that defines `method`, in the first source that has one. */
export function findMethodInSources(
    sources: Array<{ file: string; text: string }>,
    key: { name?: string; inherit?: string[] },
    method: string
): { file: string; symbol: PySymbol } | undefined {
    const target = key.name ?? key.inherit?.[0];
    if (!target) {
        return undefined;
    }
    for (const { file, text } of sources) {
        const symbols = scanPythonSymbols(text);
        for (const cls of symbols.filter(s => s.kind === 'class')) {
            const k = modelKeyOf(symbolText(text, cls));
            const matches = key.name
                ? k.name === key.name || (!k.name && !!k.inherit?.includes(key.name))
                : !!k.inherit?.includes(target) || k.name === target;
            if (!matches) {
                continue;
            }
            const symbol = symbols.find(s => s.kind === 'function' && s.qualified === `${cls.qualified}.${method}`);
            if (symbol) {
                return { file, symbol };
            }
        }
    }
    return undefined;
}
