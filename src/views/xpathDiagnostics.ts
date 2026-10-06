/**
 * An XPath check (xpathReport.ts) placed on the arch's text: which characters
 * each locator's diagnostic covers, its severity and message, and the quick
 * fixes that swap a locator for a shorter one that finds the same node.
 *
 * A locator is found by its element's index among the arch's elements, not by
 * line: lxml reports the line where a start tag *ends*, and a minified arch
 * has every locator on one line. The text is scanned for start tags with
 * comments, CDATA, processing instructions and the DOCTYPE blanked out, which
 * is also what lxml leaves out of the count.
 */
import * as vscode from 'vscode';
import type { LocatorStatus, XpathLocator, XpathReport } from '../services/views/xpathReport';

/** Offsets into the text; end exclusive. */
export interface TextSpan {
    start: number;
    end: number;
}

export interface ArchAttribute {
    name: string;
    /** The value between the quotes. */
    valueStart: number;
    valueEnd: number;
    quote: '"' | "'";
}

export interface ArchElement {
    tag: string;
    nameStart: number;
    nameEnd: number;
    attributes: ArchAttribute[];
}

export interface XpathFix {
    title: string;
    span: TextSpan;
    /** Already escaped for the attribute's quote. */
    text: string;
}

export type FindingSeverity = 'error' | 'warning' | 'hint';

export interface XpathFinding {
    status: LocatorStatus;
    severity: FindingSeverity;
    message: string;
    span: TextSpan;
    /** Shortest first; only for <xpath expr> locators that match. */
    fixes: XpathFix[];
}

const NON_ELEMENTS = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^>[]|\[[\s\S]*?\])*>/gi;
// Any name lxml accepts, not only ASCII: a skipped element would shift every later index.
const START_TAG = /<([^\s/>!?][^\s/>]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/g;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** The text with everything that is not markup of elements replaced by spaces, offset for offset (line breaks kept). */
export function blankNonElements(text: string): string {
    return text.replace(NON_ELEMENTS, match => match.replace(/[^\r\n]/g, ' '));
}

/** The arch's start tags, in document order. */
export function scanElements(text: string): ArchElement[] {
    const elements: ArchElement[] = [];
    for (const tag of blankNonElements(text).matchAll(START_TAG)) {
        const nameStart = (tag.index ?? 0) + 1;
        const nameEnd = nameStart + tag[1].length;
        const attributes: ArchAttribute[] = [];
        for (const attribute of tag[2].matchAll(ATTRIBUTE)) {
            const value = attribute[2] ?? attribute[3] ?? '';
            // The closing quote; the attribute text starts right after the tag name.
            const valueEnd = nameEnd + (attribute.index ?? 0) + attribute[0].length - 1;
            attributes.push({ name: attribute[1], valueStart: valueEnd - value.length, valueEnd, quote: attribute[2] !== undefined ? '"' : "'" });
        }
        elements.push({ tag: tag[1], nameStart, nameEnd, attributes });
    }
    return elements;
}

function lineStarts(text: string): number[] {
    const starts = [0];
    for (const lineBreak of text.matchAll(/\r\n|\r|\n/g)) {
        starts.push((lineBreak.index ?? 0) + lineBreak[0].length);
    }
    return starts;
}

/** A 0-based line and character, counting line breaks the way VS Code does. */
export function positionAt(text: string, offset: number): { line: number; character: number } {
    const starts = lineStarts(text);
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1] <= offset) {
        line++;
    }
    return { line, character: offset - starts[line] };
}

/** A 1-based line's content without its indentation and line break. */
function lineSpan(text: string, line: number): TextSpan {
    const starts = lineStarts(text);
    const index = Math.min(Math.max(line - 1, 0), starts.length - 1);
    const start = starts[index];
    const content = text.slice(start, index + 1 < starts.length ? starts[index + 1] : text.length).replace(/[\r\n]+$/, '');
    const indent = content.length - content.trimStart().length;
    return { start: start + indent, end: start + content.length };
}

/** `value` as the content of an attribute delimited by `quote`. */
export function quoteForAttribute(value: string, quote: '"' | "'"): string {
    const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return quote === '"' ? escaped.replace(/"/g, '&quot;') : escaped.replace(/'/g, '&apos;');
}

function place(locator: XpathLocator, elements: ArchElement[], text: string): { span: TextSpan; expr?: ArchAttribute } {
    const element = locator.element === null ? undefined : elements[locator.element];
    const expected = locator.kind === 'xpath' ? 'xpath' : /^\/\/([^[/]+)/.exec(locator.expr)?.[1];
    if (element && element.tag === expected) {
        const expr = locator.kind === 'xpath' ? element.attributes.find(attribute => attribute.name === 'expr') : undefined;
        if (expr) {
            return { span: { start: expr.valueStart, end: expr.valueEnd }, expr };
        }
        return { span: { start: element.nameStart, end: element.nameEnd } };
    }
    return { span: lineSpan(text, locator.line ?? 1) };
}

/** What to show for each locator worth showing: dead, ambiguous, invalid, or ok with a shorter equivalent. */
export function xpathFindings(report: XpathReport, text: string): XpathFinding[] {
    if (report.error) {
        return [];
    }
    const elements = scanElements(text);
    const findings: XpathFinding[] = [];
    for (const locator of report.locators) {
        const where = place(locator, elements, text);
        const expr = where.expr;
        const fixes: XpathFix[] = expr && (locator.status === 'ok' || locator.status === 'ambiguous')
            ? locator.shorter.map(shorter => ({ title: `Use ${shorter}`, span: where.span, text: quoteForAttribute(shorter, expr.quote) }))
            : [];
        const finding = (severity: FindingSeverity, message: string): XpathFinding =>
            ({ status: locator.status, severity, message, span: where.span, fixes });
        switch (locator.status) {
            case 'dead':
                findings.push(finding('warning', `${locator.expr} matches nothing: this patch does nothing.`));
                break;
            case 'ambiguous':
                findings.push(finding('warning', `${locator.expr} matches ${locator.matches ?? 'several'} nodes: Odoo patches the first.`));
                break;
            case 'invalid':
                findings.push(finding('error', `${locator.expr} is not a valid XPath${locator.detail ? `: ${locator.detail}` : '.'}`));
                break;
            case 'ok':
                // Faint on purpose: Studio's long paths work, they only read badly.
                if (fixes.length > 0) {
                    findings.push(finding('hint', `A shorter locator finds the same node: ${locator.shorter[0]}`));
                }
                break;
        }
    }
    return findings;
}

export const XPATH_SOURCE = 'Odoo XPath';

const SEVERITIES: Record<FindingSeverity, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    hint: vscode.DiagnosticSeverity.Hint
};

function toRange(span: TextSpan, text: string): vscode.Range {
    const start = positionAt(text, span.start);
    const end = positionAt(text, span.end);
    return new vscode.Range(start.line, start.character, end.line, end.character);
}

function toDiagnostic(finding: XpathFinding, text: string): vscode.Diagnostic {
    const diagnostic = new vscode.Diagnostic(toRange(finding.span, text), finding.message, SEVERITIES[finding.severity]);
    diagnostic.source = XPATH_SOURCE;
    diagnostic.code = finding.status;
    return diagnostic;
}

/**
 * The XPath check's results on open arches, in their own collection so they
 * never mix with Odoo's reason a view stays off, and the quick fixes for them.
 * A fix is offered only while the document still holds the text that was
 * checked: the offsets mean nothing once it changed.
 */
export class XpathDiagnostics implements vscode.CodeActionProvider, vscode.Disposable {
    static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];
    readonly collection: vscode.DiagnosticCollection;
    private readonly checked = new Map<string, { text: string; findings: XpathFinding[] }>();

    constructor(collection: vscode.DiagnosticCollection = vscode.languages.createDiagnosticCollection('odoo-view-xpaths')) {
        this.collection = collection;
    }

    /** Shows a check of `text`, the arch at `uri` as it was checked. */
    show(uri: vscode.Uri, text: string, report: XpathReport): void {
        const findings = xpathFindings(report, text);
        this.checked.set(uri.toString(), { text, findings });
        this.collection.set(uri, findings.map(finding => toDiagnostic(finding, text)));
    }

    clear(uri: vscode.Uri): void {
        this.checked.delete(uri.toString());
        this.collection.delete(uri);
    }

    provideCodeActions(document: Pick<vscode.TextDocument, 'uri' | 'getText'>, range: vscode.Range): vscode.CodeAction[] {
        const checked = this.checked.get(document.uri.toString());
        if (!checked || document.getText() !== checked.text) {
            return [];
        }
        const actions: vscode.CodeAction[] = [];
        for (const finding of checked.findings) {
            const where = toRange(finding.span, checked.text);
            if (finding.fixes.length === 0 || !where.intersection(range)) {
                continue;
            }
            const diagnostic = toDiagnostic(finding, checked.text);
            finding.fixes.forEach((fix, index) => {
                const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
                action.edit = new vscode.WorkspaceEdit();
                action.edit.replace(document.uri, toRange(fix.span, checked.text), fix.text);
                action.diagnostics = [diagnostic];
                action.isPreferred = index === 0;
                actions.push(action);
            });
        }
        return actions;
    }

    dispose(): void {
        this.checked.clear();
        this.collection.dispose();
    }
}
