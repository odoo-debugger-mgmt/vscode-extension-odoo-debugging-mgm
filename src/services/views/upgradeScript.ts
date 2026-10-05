/**
 * Upgrade scripts that put fixed views back during an upgrade. Port of
 * odoo-manager's upgrade_script.py (render_instance_script).
 *
 * Wholesale on purpose: a view's whole arch is written back as it is in the
 * database now, rather than the edits that got it there - a common idiom in
 * upgrade-specific, and what the editor showed is exactly what the script
 * writes. A view whose arch was never edited (unchangedReason) goes in
 * ACTIVATE instead and is only re-enabled.
 *
 * Invariants (odoo-manager CLAUDE.md:135-203):
 * - edit_view always gets skip_if_not_noupdate=False: by default it does
 *   nothing at all for a view whose ir_model_data is noupdate=False, which is
 *   every view a custom module ships.
 * - edit_view always gets active=True: its "auto" activates an xmlid target
 *   but leaves a view_id target alone, and re-enabling is the point.
 * - Re-enabling only is a plain UPDATE: edit_view would re-serialize the arch
 *   it is meant to leave alone.
 * - A view with no external id is addressed by its id, which only means
 *   something in the database it came from; the entry says so.
 *
 * The file the extension writes can be parsed back (parseScript), so a later
 * Add to Upgrade Script merges into it. Pure string work.
 */
import type { UnchangedReason } from './viewNotes';

export interface ScriptView {
    id: number;
    xmlid: string | null;
    model: string;
    type: string;
    name: string;
    /** The Odoo versions whose upgrade disabled it. */
    listedIn: string[];
    /** The database the view and its arch come from. */
    dbName: string;
    /** null: only re-enabled, the arch is left out (see `why`). */
    arch: string | null;
    why: UnchangedReason | null;
}

/** One element of ACTIVATE or VIEWS, as its exact text in the file. */
export interface ScriptEntry {
    /** The external id, or `id:<view id>` without one. */
    key: string;
    list: 'activate' | 'views';
    text: string;
}

export interface ScriptFile {
    /** Comment lines, no trailing newline. */
    header: string;
    activate: ScriptEntry[];
    views: ScriptEntry[];
}

export const DEFAULT_HEADER = [
    "# Views fixed with Odoo DevTools' View Doctor, written back during the upgrade.",
    '# Needs upgrade-util on the upgrade path (--upgrade-path=<upgrade-util>/src) for `from odoo.upgrade import util`.',
    "# An end- script runs after every module has loaded, so no module's data file overwrites these views.",
    '# Every view listed is made active. VIEWS also get their arch back; ACTIVATE are only re-enabled.'
].join('\n');

const LXML_IMPORT = 'from lxml import etree\n\n';
const UTIL_IMPORT = 'from odoo.upgrade import util\n\n';
const ACTIVATE_OPEN = 'ACTIVATE = [\n';
const VIEWS_OPEN = 'VIEWS = [\n';
const ARCH_OPEN = '        "arch": """\\\n';
const ARCH_CLOSE = '""",\n    },\n';

const ACTIVATE_SQL = 'cr.execute("UPDATE ir_ui_view SET active = true WHERE id = %s", [view_id])';

const ACTIVATE_STEP = [
    '    for target in ACTIVATE:',
    '        view_id = target if isinstance(target, int) else util.ref(cr, target)',
    '        if view_id:',
    `            ${ACTIVATE_SQL}`
].join('\n') + '\n';

const VIEWS_STEP = [
    '    for view in VIEWS:',
    '        xmlid = view.get("xmlid")',
    '        view_id = view.get("view_id")',
    '        with util.skippable_cm(), util.edit_view(cr, xmlid, view_id, skip_if_not_noupdate=False, active=True) as arch:',
    '            new_arch = etree.fromstring(view["arch"])',
    '            arch.tag = new_arch.tag',
    '            arch.text = new_arch.text',
    '            arch.attrib.clear()',
    '            arch.attrib.update(new_arch.attrib)',
    '            arch[:] = new_arch[:]'
].join('\n') + '\n';

const WHY: Record<UnchangedReason, string> = {
    noted: 'arch unchanged since it was noted',
    'not-edited': 'arch never edited in the database'
};

/**
 * `text` on one line, for a comment. View names come from the database and
 * Studio lets anyone type a newline into one, which would end the comment and
 * turn the rest into code. Python's own line ends are \n and \r; the other
 * separators are collapsed too, to be safe.
 */
export function oneLine(text: string, limit?: number): string {
    const line = String(text).split(/[\s\x1c-\x1f\x85]+/).filter(Boolean).join(' ');
    const chars = Array.from(line);
    return limit && chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : line;
}

/**
 * The body of a Python triple-quoted string. Left literal in the usual case
 * (a human reads and edits this XML); escaped only when a backslash or an
 * embedded """ would break the literal. The caller always puts a newline
 * before the closing quotes, so a trailing " is harmless.
 */
export function pyTripleQuoted(text: string): string {
    return text.includes('\\') || text.includes('"""')
        ? text.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')
        : text;
}

export function entryKey(view: { id: number; xmlid: string | null }): string {
    return view.xmlid ?? `id:${view.id}`;
}

function head(view: ScriptView): string {
    const label = [view.model, view.type].filter(Boolean).join(' ') || 'view';
    let line = `# ${oneLine(label)} — id ${view.id} in ${oneLine(view.dbName)}`;
    const steps = view.listedIn.map(step => oneLine(step));
    if (steps.length === 1) {
        line += ` (disabled by the ${steps[0]} upgrade)`;
    } else if (steps.length > 1) {
        line += ` (disabled by the ${steps.slice(0, -1).join(', ')} and ${steps[steps.length - 1]} upgrades)`;
    }
    return line;
}

function noXmlidNote(view: ScriptView): string {
    return `# NOTE: no xml_id, so this view is addressed by database id — valid in ${oneLine(view.dbName)} only.`;
}

function activateEntry(view: ScriptView): ScriptEntry {
    const lines = [head(view)];
    if (view.name) {
        lines.push(`# ${oneLine(view.name, 100)}`);
    }
    const why = `# ${view.why ? WHY[view.why] : 'arch unchanged'} — only re-enabled`;
    if (view.xmlid) {
        lines.push(why, `${JSON.stringify(view.xmlid)},`);
    } else {
        lines.push(noXmlidNote(view), why, `${view.id},`);
    }
    return { key: entryKey(view), list: 'activate', text: lines.map(line => `    ${line}\n`).join('') };
}

function viewsEntry(view: ScriptView): ScriptEntry {
    const arch = (view.arch ?? '').replace(/\r\n?/g, '\n').trim();
    if (!arch) {
        throw new Error(`view ${view.id} has no arch to write`);
    }
    const lines = [head(view)];
    if (view.name) {
        lines.push(`# ${oneLine(view.name, 100)}`);
    }
    if (view.xmlid) {
        lines.push(`"xmlid": ${JSON.stringify(view.xmlid)},`);
    } else {
        lines.splice(1, 0, noXmlidNote(view));
        lines.push(`"view_id": ${view.id},`);
    }
    const body = lines.map(line => `        ${line}\n`).join('');
    return { key: entryKey(view), list: 'views', text: `    {\n${body}${ARCH_OPEN}${pyTripleQuoted(arch)}\n${ARCH_CLOSE}` };
}

/** The view's entry: ACTIVATE when its arch is left out, VIEWS otherwise. */
export function scriptEntry(view: ScriptView): ScriptEntry {
    return view.arch === null ? activateEntry(view) : viewsEntry(view);
}

export function newScriptFile(): ScriptFile {
    return { header: DEFAULT_HEADER, activate: [], views: [] };
}

/** `file` with `entries` added; a view already listed is replaced where it stands, or moved to the other list. */
export function mergeEntries(file: ScriptFile, entries: ScriptEntry[]): ScriptFile {
    const activate = [...file.activate];
    const views = [...file.views];
    for (const entry of entries) {
        const [target, other] = entry.list === 'activate' ? [activate, views] : [views, activate];
        const elsewhere = other.findIndex(existing => existing.key === entry.key);
        if (elsewhere >= 0) {
            other.splice(elsewhere, 1);
        }
        const here = target.findIndex(existing => existing.key === entry.key);
        if (here >= 0) {
            target[here] = entry;
        } else {
            target.push(entry);
        }
    }
    return { header: file.header, activate, views };
}

/** The file's full text. Only what is needed: no lxml without VIEWS, no ACTIVATE list when nothing is only re-enabled. */
export function renderScript(file: ScriptFile): string {
    if (file.activate.length === 0 && file.views.length === 0) {
        throw new Error('no views to write');
    }
    const sections: string[] = [];
    const steps: string[] = [];
    if (file.activate.length > 0) {
        sections.push(`${ACTIVATE_OPEN}${file.activate.map(entry => entry.text).join('')}]\n`);
        steps.push(ACTIVATE_STEP);
    }
    if (file.views.length > 0) {
        sections.push(`${VIEWS_OPEN}${file.views.map(entry => entry.text).join('')}]\n`);
        steps.push(VIEWS_STEP);
    }
    const imports = file.views.length > 0 ? LXML_IMPORT : '';
    return `${imports}${UTIL_IMPORT}${file.header}\n\n${sections.join('\n')}\n\ndef migrate(cr, version):\n${steps.join('\n')}`;
}

export function newScript(views: ScriptView[]): string {
    return renderScript(mergeEntries(newScriptFile(), views.map(scriptEntry)));
}

/** The key of a literal as this file writes it: a JSON-style "string", or digits for an id. */
function keyOfLiteral(literal: string, allowId: boolean): string | undefined {
    if (/^\d+$/.test(literal)) {
        return allowId ? `id:${Number(literal)}` : undefined;
    }
    try {
        const value: unknown = JSON.parse(literal);
        return typeof value === 'string' && value ? value : undefined;
    } catch {
        return undefined;
    }
}

/** Where the """ closing an arch starts, honouring backslash escapes; -1 when it never closes. */
function closingQuotes(text: string, from: number): number {
    for (let i = from; i < text.length; i++) {
        if (text[i] === '\\') {
            i++;
        } else if (text.startsWith('"""', i)) {
            return i;
        }
    }
    return -1;
}

function parseActivate(text: string, start: number): { entries: ScriptEntry[]; end: number } | undefined {
    const entries: ScriptEntry[] = [];
    let at = start;
    let entryStart = start;
    for (;;) {
        const eol = text.indexOf('\n', at);
        if (eol < 0) {
            return undefined;
        }
        const line = text.slice(at, eol);
        if (line === ']') {
            return at === entryStart ? { entries, end: eol + 1 } : undefined;
        }
        if (!line.startsWith('    #')) {
            const value = /^ {4}("(?:[^"\\]|\\.)*"|\d+),$/.exec(line);
            const key = value ? keyOfLiteral(value[1], true) : undefined;
            if (!key) {
                return undefined;
            }
            entries.push({ key, list: 'activate', text: text.slice(entryStart, eol + 1) });
            entryStart = eol + 1;
        }
        at = eol + 1;
    }
}

function parseViews(text: string, start: number): { entries: ScriptEntry[]; end: number } | undefined {
    const entries: ScriptEntry[] = [];
    let at = start;
    for (;;) {
        if (text.startsWith(']\n', at)) {
            return { entries, end: at + 2 };
        }
        if (!text.startsWith('    {\n', at)) {
            return undefined;
        }
        const entryStart = at;
        at += '    {\n'.length;
        let key: string | undefined;
        while (!text.startsWith(ARCH_OPEN, at)) {
            const eol = text.indexOf('\n', at);
            if (eol < 0) {
                return undefined;
            }
            const line = text.slice(at, eol);
            const keyed = /^ {8}"(xmlid|view_id)": ("(?:[^"\\]|\\.)*"|\d+),$/.exec(line);
            if (keyed && key === undefined) {
                key = keyed[1] === 'view_id'
                    ? (/^\d+$/.test(keyed[2]) ? `id:${Number(keyed[2])}` : undefined)
                    : keyOfLiteral(keyed[2], false);
                if (!key) {
                    return undefined;
                }
            } else if (!line.startsWith('        #')) {
                return undefined;
            }
            at = eol + 1;
        }
        if (!key) {
            return undefined;
        }
        const close = closingQuotes(text, at + ARCH_OPEN.length);
        if (close < 0 || !text.startsWith(ARCH_CLOSE, close)) {
            return undefined;
        }
        at = close + ARCH_CLOSE.length;
        entries.push({ key, list: 'views', text: text.slice(entryStart, at) });
    }
}

/**
 * A script this extension wrote, read back so new entries can be merged in;
 * undefined for anything else. The test is exact: the file must re-render byte
 * for byte from what was read (CRLF read as LF). Entries are kept verbatim, so
 * a comment edited inside one survives; code added anywhere does not parse,
 * and the caller writes a new file rather than lose it.
 */
export function parseScript(source: string): ScriptFile | undefined {
    const text = source.replace(/\r\n/g, '\n');
    let at = text.startsWith(LXML_IMPORT) ? LXML_IMPORT.length : 0;
    if (!text.startsWith(UTIL_IMPORT, at)) {
        return undefined;
    }
    at += UTIL_IMPORT.length;
    const headerEnd = text.indexOf('\n\n', at);
    if (headerEnd < 0) {
        return undefined;
    }
    const header = text.slice(at, headerEnd);
    if (!header || !header.split('\n').every(line => line.startsWith('#'))) {
        return undefined;
    }
    at = headerEnd + 2;
    const file: ScriptFile = { header, activate: [], views: [] };
    if (text.startsWith(ACTIVATE_OPEN, at)) {
        const parsed = parseActivate(text, at + ACTIVATE_OPEN.length);
        if (!parsed) {
            return undefined;
        }
        file.activate = parsed.entries;
        at = parsed.end;
        if (text.startsWith(`\n${VIEWS_OPEN}`, at)) {
            at += 1;
        }
    }
    if (text.startsWith(VIEWS_OPEN, at)) {
        const parsed = parseViews(text, at + VIEWS_OPEN.length);
        if (!parsed) {
            return undefined;
        }
        file.views = parsed.entries;
    }
    if (file.activate.length === 0 && file.views.length === 0) {
        return undefined;
    }
    return renderScript(file) === text ? file : undefined;
}
