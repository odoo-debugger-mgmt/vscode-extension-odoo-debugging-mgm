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

interface Lexed {
    lines: string[];
    /** Does line i begin inside a triple-quoted string? */
    inString: boolean[];
    /** Bracket depth at the start of line i (and after the last line). */
    depth: number[];
}

/** One pass over the text: strings, comments and brackets, so signatures and continuation lines are known. */
function lex(text: string): Lexed {
    const lines = text.split('\n');
    const inString: boolean[] = [];
    const depth: number[] = [];
    let open: string | undefined;
    let level = 0;
    for (const raw of lines) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        inString.push(open !== undefined);
        depth.push(level);
        let i = 0;
        let continued = false;
        while (i < line.length) {
            const c = line[i];
            if (open) {
                if (c === '\\' && open.length === 1) {
                    continued = i === line.length - 1;
                    i += 2;
                } else if (line.startsWith(open, i)) {
                    i += open.length;
                    open = undefined;
                } else {
                    i++;
                }
            } else if (c === '#') {
                break;
            } else if (c === '"' || c === "'") {
                open = line.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
                i += open.length;
            } else {
                if (c === '(' || c === '[' || c === '{') {
                    level++;
                } else if ((c === ')' || c === ']' || c === '}') && level > 0) {
                    level--;
                }
                i++;
            }
        }
        if (open && open.length === 1 && !continued) {
            open = undefined;
        }
    }
    depth.push(level);
    return { lines, inString, depth };
}

/** The line where the brackets opened on or after line `i` are balanced again. */
function signatureEnd(lx: Lexed, i: number): number {
    let k = i;
    while (k < lx.lines.length - 1 && lx.depth[k + 1] > 0) {
        k++;
    }
    return k;
}

export function scanPythonSymbols(text: string): PySymbol[] {
    const lx = lex(text);
    const { lines, inString, depth } = lx;
    const symbols: PySymbol[] = [];
    const stack: PySymbol[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = inString[i] || depth[i] > 0 ? null : OPENER.exec(lines[i]);
        if (!m) {
            continue;
        }
        const indent = m[1].length;
        const sigEnd = signatureEnd(lx, i);
        let end = sigEnd + 1;
        for (let j = sigEnd + 1; j < lines.length; j++) {
            if (inString[j] || depth[j] > 0) {
                end = j + 1;
                continue;
            }
            const trimmed = lines[j].trim();
            if (!trimmed || trimmed.startsWith('#')) {
                continue; // like Python, comments never end a body, and never extend it
            }
            if (indentOf(lines[j]) <= indent) {
                break;
            }
            end = signatureEnd(lx, j) + 1;
        }
        let start = i;
        for (let p = i - 1; p >= 0; p--) {
            if (inString[p] || depth[p] > 0) {
                continue; // inside a multi-line decorator
            }
            const t = lines[p].trim();
            if (t.startsWith('@') && indentOf(lines[p]) === indent) {
                start = p;
            } else if (!t || t.startsWith('#')) {
                continue; // blank and comment lines may sit between a decorator and its def
            } else {
                break;
            }
        }
        while (stack.length && stack[stack.length - 1].end <= i) {
            stack.pop();
        }
        const qualified = [...stack.map(x => x.name), m[3]].join('.');
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

/** The model a class declares: `_name`, and `_inherit` as a string or a list; class-level assignments only. */
export function modelKeyOf(classText: string): { name?: string; inherit?: string[] } {
    const lx = lex(classText);
    const { lines, inString, depth } = lx;
    const key: { name?: string; inherit?: string[] } = {};
    const first = signatureEnd(lx, 0);
    let bodyIndent = -1;
    for (let j = first + 1; j < lines.length; j++) {
        if (!inString[j] && depth[j] === 0 && lines[j].trim() && !lines[j].trim().startsWith('#')) {
            bodyIndent = indentOf(lines[j]);
            break;
        }
    }
    if (bodyIndent < 0) {
        return key;
    }
    for (let j = first + 1; j < lines.length; j++) {
        if (inString[j] || depth[j] > 0 || indentOf(lines[j]) !== bodyIndent) {
            continue;
        }
        const stmt = lines.slice(j, signatureEnd(lx, j) + 1).join('\n');
        const name = /^\s*_name\s*=\s*['"]([^'"]+)['"]/.exec(stmt);
        if (name) {
            key.name = name[1];
        }
        const inherit = /^\s*_inherit\s*=\s*(\[[^\]]*\]|\([^)]*\)|['"][^'"]+['"])/.exec(stmt);
        if (inherit) {
            key.inherit = [...inherit[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);
        }
    }
    return key;
}

/**
 * The class of the same model (see `key`) that defines `method` directly. A class whose `_name` is the
 * model wins over one that only inherits it.
 */
export function findMethodInSources(
    sources: Array<{ file: string; text: string }>,
    key: { name?: string; inherit?: string[] },
    method: string
): { file: string; symbol: PySymbol } | undefined {
    const target = key.name ?? key.inherit?.[0];
    if (!target) {
        return undefined;
    }
    const scanned = sources.map(({ file, text }) => {
        const symbols = scanPythonSymbols(text);
        return { file, text, symbols, classes: symbols.filter(s => s.kind === 'class') };
    });
    const inherits = (k: { name?: string; inherit?: string[] }) =>
        key.name ? !k.name && !!k.inherit?.includes(key.name) : !!k.inherit?.includes(target) && (!k.name || k.name === target);
    for (const exact of [true, false]) {
        for (const { file, text, symbols, classes } of scanned) {
            for (const cls of classes) {
                const k = modelKeyOf(symbolText(text, cls));
                if (!(exact ? k.name === target : inherits(k))) {
                    continue;
                }
                const symbol = symbols.find(s => s.kind === 'function' && s.qualified === `${cls.qualified}.${method}`);
                if (symbol) {
                    return { file, symbol };
                }
            }
        }
    }
    return undefined;
}
