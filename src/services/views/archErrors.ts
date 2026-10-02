/**
 * Where in an arch Odoo's error points, for a diagnostic. Odoo names the
 * failing locator or field in quotes, or (for XML syntax) a line; an error
 * that names neither lands on the first line.
 */
import { decodeEntities } from './disabledReport';

export interface ArchErrorLocation {
    line: number;
    start: number;
    end: number;
}

/**
 * Odoo's message as plain text. It HTML-escapes the attributes of a locator
 * it cannot find - `@name=&#39;partner_id&#39;` - on every version from 15
 * to 19, so the raw text neither reads well nor matches the arch.
 */
export function readableArchError(message: string): string {
    return decodeEntities(message);
}

export function locateArchError(arch: string, rawMessage: string): ArchErrorLocation {
    const message = readableArchError(rawMessage);
    const lines = arch.split('\n');
    const whole = (line: number): ArchErrorLocation => ({ line, start: 0, end: lines[line]?.length ?? 0 });

    const syntaxLine = /line (\d+), column \d+/.exec(message);
    if (syntaxLine) {
        return whole(Math.max(0, Math.min(Number(syntaxLine[1]) - 1, lines.length - 1)));
    }

    const needles = [...message.matchAll(/"([^"]{3,})"/g)].map(match => match[1]);
    for (const needle of needles) {
        for (let line = 0; line < lines.length; line++) {
            const start = lines[line].indexOf(needle);
            if (start >= 0) {
                return { line, start, end: start + needle.length };
            }
        }
    }
    return whole(0);
}
