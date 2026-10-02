/**
 * The "Disabled views" list of upgrade-util's post-upgrade report, which it
 * posts to Discuss: the only record of which views an upgrade turned off - a
 * view that is inactive now may have been inactive all along. Port of
 * odoo-manager's migration_report.py, without an HTML parser: the report is
 * generated markup, and only headings and anchors matter.
 */

const SECTION_TITLE = 'Disabled views';
const VERSION_RE = /upgraded to Odoo\s+(\S+)/;
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
const HEADING_RE = /^h[1-6]$/;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

export interface DisabledReport {
    odooVersion?: string;
    viewIds: number[];
}

export function decodeEntities(text: string): string {
    return text
        .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)))
        .replace(/&quot;/g, '"')
        .replace(/&(?:#39|apos);/g, '\'')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
}

/**
 * The record id an upgrade-util anchor points at. It switched shapes at
 * saas~17.2:
 *   /web?debug=1#view_type=form&model=ir.ui.view&action=29&id=1818   id in the hash
 *   /odoo/action-29/1830?debug=1                                     id is the last path segment
 */
export function viewIdFromHref(href: string | null | undefined): number | undefined {
    if (!href) {
        return undefined;
    }
    const hashAt = href.indexOf('#');
    const fragment = hashAt >= 0 ? href.slice(hashAt + 1) : '';
    const beforeHash = hashAt >= 0 ? href.slice(0, hashAt) : href;
    const queryAt = beforeHash.indexOf('?');
    const query = queryAt >= 0 ? beforeHash.slice(queryAt + 1) : '';
    const pathPart = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;

    for (const part of [fragment, query]) {
        const id = new URLSearchParams(part).get('id');
        if (id && /^\d+$/.test(id)) {
            return Number(id);
        }
    }
    const last = pathPart.replace(/\/+$/, '').split('/').pop() ?? '';
    return /^\d+$/.test(last) ? Number(last) : undefined;
}

/**
 * The view ids under the report's "Disabled views" heading, in order, each
 * once. Anchors elsewhere in the message (server actions, "Overridden views")
 * are not views the upgrade disabled. Any heading ends the section.
 */
export function parseDisabledViews(body: string | null | undefined): DisabledReport {
    const result: DisabledReport = { viewIds: [] };
    if (!body || !body.trim()) {
        return result;
    }

    const seen = new Set<number>();
    let heading: { tag: string; textStart: number } | undefined;
    let inSection = false;

    for (const match of body.matchAll(TAG_RE)) {
        const [whole, closing, rawTag, attributes] = match;
        const tag = rawTag.toLowerCase();
        const at = match.index ?? 0;

        if (HEADING_RE.test(tag)) {
            if (!closing) {
                inSection = false;
                heading = { tag, textStart: at + whole.length };
            } else if (heading && heading.tag === tag) {
                const text = decodeEntities(body.slice(heading.textStart, at).replace(/<[^>]*>/g, ''))
                    .replace(/\s+/g, ' ')
                    .trim();
                if (tag === 'h2' && result.odooVersion === undefined) {
                    const version = VERSION_RE.exec(text);
                    if (version) {
                        result.odooVersion = version[1];
                    }
                }
                inSection = text === SECTION_TITLE;
                heading = undefined;
            }
            continue;
        }

        if (inSection && !closing && tag === 'a') {
            const href = HREF_RE.exec(attributes);
            const id = viewIdFromHref(decodeEntities(href?.[1] ?? href?.[2] ?? href?.[3] ?? ''));
            if (id !== undefined && !seen.has(id)) {
                seen.add(id);
                result.viewIds.push(id);
            }
        }
    }
    return result;
}

/** Every listed view, with the versions whose upgrade disabled it, in report order. */
export function mergeReports(reports: DisabledReport[]): Map<number, string[]> {
    const merged = new Map<number, string[]>();
    for (const report of reports) {
        for (const id of report.viewIds) {
            const versions = merged.get(id) ?? [];
            if (report.odooVersion && !versions.includes(report.odooVersion)) {
                versions.push(report.odooVersion);
            }
            merged.set(id, versions);
        }
    }
    return merged;
}
