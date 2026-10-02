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

/**
 * The lines of Odoo's message, without the "View error context:" block it
 * may end with.
 */
function messageLines(message: string): string[] {
    const text = readableArchError(message);
    const context = text.search(/^\s*View error context:/m);
    return (context >= 0 ? text.slice(0, context) : text)
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '');
}

/**
 * The line of Odoo's message that says what is wrong, for a one-line notice.
 * Odoo leads with a heading ("Error while parsing or validating view:"), and
 * a validation error quotes five lines of the combined arch first:
 *
 *   Error while validating view near:
 *
 *   <form string="Partners" __validate__="1">
 *   ...  (arch lines, text nodes among them)
 *
 *   Field "x_custom" does not exist in model "res.partner"
 *
 * so the reason is the last line that is neither a heading nor markup.
 */
export function archErrorSummary(message: string): string {
    const lines = messageLines(message);
    const reasons = lines.filter(line => !line.endsWith(':') && !line.startsWith('<'));
    return reasons[reasons.length - 1] ?? lines.find(line => !line.endsWith(':')) ?? lines[0] ?? '';
}

function quoted(text: string): string[] {
    return [...text.matchAll(/"([^"]{3,})"/g)].map(match => match[1]);
}

export function locateArchError(arch: string, rawMessage: string): ArchErrorLocation {
    const message = readableArchError(rawMessage);
    const lines = arch.split('\n');
    const whole = (line: number): ArchErrorLocation => ({ line, start: 0, end: lines[line]?.length ?? 0 });

    const syntaxLine = /line (\d+), column \d+/.exec(message);
    if (syntaxLine) {
        return whole(Math.max(0, Math.min(Number(syntaxLine[1]) - 1, lines.length - 1)));
    }

    // The reason's quotes first: the arch lines Odoo quotes around it name
    // fields too ("name"), and would win if searched in message order.
    const needles = [...new Set([...quoted(archErrorSummary(message)), ...quoted(message)])];
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
