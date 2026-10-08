/**
 * Find `<record>`, `<template>` and `<menuitem>` elements (with an id) in
 * Odoo data files, by character offset.
 */

export interface XmlElement {
    tag: 'record' | 'template' | 'menuitem';
    id: string;
    /** Character offsets; `end` is exclusive. */
    start: number;
    end: number;
}

/** Comments and CDATA replaced by spaces (newlines kept), so offsets stay valid. */
function blankOut(text: string): string {
    return text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, m => m.replace(/[^\n]/g, ' '));
}

function allElements(text: string): XmlElement[] {
    const clean = blankOut(text);
    const out: XmlElement[] = [];
    const open = /<(record|template|menuitem)\b([^>]*?)(\/?)>/g;
    let m: RegExpExecArray | null;
    while ((m = open.exec(clean))) {
        const id = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(m[2]);
        const tag = m[1] as XmlElement['tag'];
        const idValue = id?.[1] ?? id?.[2];
        if (!idValue) {
            continue;
        }
        let end = m.index + m[0].length;
        if (!m[3]) {
            const tags = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'g');
            tags.lastIndex = end;
            let depth = 1;
            let t: RegExpExecArray | null;
            end = clean.length;
            while ((t = tags.exec(clean))) {
                if (t[1]) {
                    depth--;
                } else if (!t[2]) {
                    depth++;
                }
                if (depth === 0) {
                    end = t.index + t[0].length;
                    break;
                }
            }
        }
        out.push({ tag, id: idValue, start: m.index, end });
    }
    return out;
}

/** The innermost element containing `offset`. */
export function xmlElementAt(text: string, offset: number): XmlElement | undefined {
    let best: XmlElement | undefined;
    for (const el of allElements(text)) {
        if (el.start <= offset && offset < el.end && (!best || el.start >= best.start)) {
            best = el;
        }
    }
    return best;
}

/** The element with this id, a bare id and `module.id` being the same when the module is `module`. */
export function findXmlElementById(text: string, id: string, module: string): XmlElement | undefined {
    const prefix = `${module}.`;
    const norm = (x: string) => (x.startsWith(prefix) ? x.slice(prefix.length) : x);
    const wanted = norm(id);
    return allElements(text).find(el => norm(el.id) === wanted);
}
