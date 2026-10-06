/**
 * What the View Doctor's XPath check (resources/scripts/xpath_check.py, run
 * by the worker's check_xpaths) says about an inheriting view's locators:
 * one entry per <xpath expr> or direct locator, matched against the parent's
 * combined arch. Odoo's own composition silently drops a locator that matches
 * nothing, so "saved, and the view is on" does not prove a fix works; this does.
 */

export type LocatorStatus = 'ok' | 'dead' | 'ambiguous' | 'invalid';

export interface XpathLocator {
    kind: 'xpath' | 'direct';
    expr: string;
    position: string;
    status: LocatorStatus;
    /** How many nodes it matches; null when it is not valid XPath. */
    matches: number | null;
    /** lxml's sourceline: the 1-based line its start tag ends on. */
    line: number | null;
    /** Its element's index among the arch's elements, in document order (root 0). */
    element: number | null;
    /** Shorter locators that find the same node, shortest first. */
    shorter: string[];
    detail?: string;
}

export interface XpathSummary {
    ok: number;
    dead: number;
    ambiguous: number;
    invalid: number;
}

export interface XpathReport {
    locators: XpathLocator[];
    summary: XpathSummary;
    /** No dead and no invalid locator. */
    healthy: boolean;
    /** The arch could not be read as XML; nothing was checked. */
    error?: string;
}

const STATUSES: readonly LocatorStatus[] = ['ok', 'dead', 'ambiguous', 'invalid'];

function count(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseLocator(raw: unknown): XpathLocator {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const status = STATUSES.includes(entry.status as LocatorStatus) ? entry.status as LocatorStatus : 'invalid';
    const line = count(entry.line);
    return {
        kind: entry.kind === 'xpath' ? 'xpath' : 'direct',
        expr: typeof entry.expr === 'string' ? entry.expr : '',
        position: typeof entry.position === 'string' ? entry.position : 'inside',
        status,
        matches: count(entry.matches),
        line: line && line > 0 ? line : null,
        element: count(entry.element),
        shorter: Array.isArray(entry.shorter) ? entry.shorter.filter((value): value is string => typeof value === 'string') : [],
        ...(typeof entry.detail === 'string' ? { detail: entry.detail } : {})
    };
}

/** The checker's result; the counts are made again from the locators, so they always agree. */
export function parseXpathReport(raw: unknown): XpathReport {
    const value = (raw ?? {}) as Record<string, unknown>;
    const summary: XpathSummary = { ok: 0, dead: 0, ambiguous: 0, invalid: 0 };
    if (typeof value.error === 'string') {
        return { locators: [], summary, healthy: false, error: value.error };
    }
    const locators = Array.isArray(value.locators) ? value.locators.map(parseLocator) : [];
    for (const locator of locators) {
        summary[locator.status]++;
    }
    return { locators, summary, healthy: summary.dead === 0 && summary.invalid === 0 };
}

/** The locators that make a fix not work, as a clause ("2 locators match nothing"); undefined when there are none. */
export function brokenLocators(report: XpathReport): string | undefined {
    const { dead, invalid } = report.summary;
    const parts: string[] = [];
    if (dead > 0) {
        parts.push(`${dead} ${dead === 1 ? 'locator matches' : 'locators match'} nothing`);
    }
    if (invalid > 0) {
        parts.push(`${invalid} ${invalid === 1 ? 'locator is' : 'locators are'} not valid XPath`);
    }
    return parts.length > 0 ? parts.join(' and ') : undefined;
}

/** Check XPaths' one-line answer. */
export function checkResultText(report: XpathReport): { level: 'info' | 'warning'; text: string } {
    if (report.error) {
        return { level: 'warning', text: `Could not check the locators: ${report.error}` };
    }
    const total = report.locators.length;
    if (total === 0) {
        return { level: 'info', text: 'This view has no locators to check.' };
    }
    const { dead, ambiguous, invalid } = report.summary;
    if (dead === 0 && ambiguous === 0 && invalid === 0) {
        return { level: 'info', text: total === 1 ? 'The locator matches.' : `All ${total} locators match.` };
    }
    if (total === 1) {
        const text = dead > 0 ? 'The locator matches nothing.'
            : ambiguous > 0 ? 'The locator matches several nodes.'
                : 'The locator is not valid XPath.';
        return { level: 'warning', text };
    }
    const parts: string[] = [];
    if (dead > 0) {
        parts.push(`${dead} ${dead === 1 ? 'matches' : 'match'} nothing`);
    }
    if (ambiguous > 0) {
        parts.push(`${ambiguous} ${ambiguous === 1 ? 'matches' : 'match'} several nodes`);
    }
    if (invalid > 0) {
        parts.push(`${invalid} ${invalid === 1 ? 'is' : 'are'} not valid XPath`);
    }
    return { level: 'warning', text: `Of ${total} locators, ${parts.join(', ')}.` };
}
