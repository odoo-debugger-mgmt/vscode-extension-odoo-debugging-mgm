import * as assert from 'assert';
import { parseXpathReport, type XpathReport } from '../services/views/xpathReport';
import { positionAt, quoteForAttribute, scanElements, xpathFindings } from '../views/xpathDiagnostics';

function report(locators: Array<Record<string, unknown>>): XpathReport {
    return parseXpathReport({ locators: locators.map(entry => ({ kind: 'xpath', position: 'after', matches: 1, shorter: [], line: 1, ...entry })) });
}

const slice = (text: string, span: { start: number; end: number }) => text.slice(span.start, span.end);

suite('XPath diagnostics: placing a check on the text', () => {
    test('a minified arch: each locator lands on its own expr', () => {
        const text = '<data><xpath expr="//a" position="after"/><xpath expr="//b" position="after"/></data>';
        const findings = xpathFindings(report([
            { expr: '//a', status: 'dead', matches: 0, element: 1 },
            { expr: '//b', status: 'ambiguous', matches: 2, element: 2 }
        ]), text);
        assert.deepStrictEqual(findings.map(finding => slice(text, finding.span)), ['//a', '//b']);
    });

    test('comments, CDATA, a declaration and processing instructions are not elements', () => {
        const text = '<?xml version="1.0"?>\r\n<data>\r\n  <!-- <xpath expr="//zzz"/> -->\r\n  <![CDATA[<xpath expr="//yyy"/>]]>\r\n  <?pi x?>\r\n  <xpath expr="//a"/>\r\n</data>';
        const [finding] = xpathFindings(report([{ expr: '//a', status: 'dead', matches: 0, element: 1, line: 6 }]), text);
        assert.strictEqual(slice(text, finding.span), '//a');
        assert.deepStrictEqual(positionAt(text, finding.span.start), { line: 5, character: 15 });
        assert.deepStrictEqual(scanElements(text).map(element => element.tag), ['data', 'xpath']);
    });

    test('a start tag over several lines, with > inside a value', () => {
        const text = '<data>\n  <xpath\n     expr="//a[@x > 1]"\n     position="after">\n  </xpath>\n</data>';
        const [finding] = xpathFindings(report([{ expr: '//a[@x > 1]', status: 'dead', matches: 0, element: 1, line: 4 }]), text);
        assert.strictEqual(slice(text, finding.span), '//a[@x > 1]');
    });

    test('a direct locator points at its tag name', () => {
        const text = '<data><field name="b" position="before"/></data>';
        const [finding] = xpathFindings(report([{ kind: 'direct', expr: "//field[@name='b']", status: 'dead', matches: 0, element: 1 }]), text);
        assert.strictEqual(slice(text, finding.span), 'field');
        assert.deepStrictEqual(finding.fixes, []);
    });

    test('an element index that names another tag falls back to the line, trimmed', () => {
        const text = '<data>\n    <group name="g"/>\n</data>';
        const [finding] = xpathFindings(report([{ expr: '//g', status: 'dead', matches: 0, element: 1, line: 2 }]), text);
        assert.strictEqual(slice(text, finding.span), '<group name="g"/>');
    });

    test('severities, messages and fixes per status', () => {
        const text = '<data><xpath expr="//a"/><xpath expr="//b"/><xpath expr="//c["/><xpath expr="/form/sheet/field"/><xpath expr="//e"/></data>';
        const findings = xpathFindings(report([
            { expr: '//a', status: 'dead', matches: 0, element: 1 },
            { expr: '//b', status: 'ambiguous', matches: 3, element: 2, shorter: ["//b[@name='x']"] },
            { expr: '//c[', status: 'invalid', matches: null, element: 3, detail: 'Invalid expression' },
            { expr: '/form/sheet/field', status: 'ok', matches: 1, element: 4, shorter: ["//field[@name='x']", "//sheet/field"] },
            { expr: '//e', status: 'ok', matches: 1, element: 5 }
        ]), text);
        assert.deepStrictEqual(findings.map(finding => [finding.status, finding.severity, finding.message]), [
            ['dead', 'warning', '//a matches nothing: this patch does nothing.'],
            ['ambiguous', 'warning', '//b matches 3 nodes: Odoo patches the first.'],
            ['invalid', 'error', '//c[ is not a valid XPath: Invalid expression'],
            ['ok', 'hint', "A shorter locator finds the same node: //field[@name='x']"]
        ]);
        assert.deepStrictEqual(findings[1].fixes.map(fix => [fix.title, fix.text, slice(text, fix.span)]), [["Use //b[@name='x']", "//b[@name='x']", '//b']]);
        assert.deepStrictEqual(findings[3].fixes.map(fix => fix.title), ["Use //field[@name='x']", 'Use //sheet/field']);
        assert.deepStrictEqual(findings[0].fixes, []);
    });

    test('a fix is escaped for the quote the attribute uses', () => {
        const text = `<data><xpath expr='//field[@name="x"]/..' position="after"/></data>`;
        const [finding] = xpathFindings(report([{ expr: '//field[@name="x"]/..', status: 'ambiguous', matches: 2, element: 1, shorter: ["//group[@name='g']"] }]), text);
        assert.strictEqual(finding.fixes[0].text, '//group[@name=&apos;g&apos;]');
        assert.strictEqual(quoteForAttribute(`//a[@b="c" and @d='e'] & <`, '"'), `//a[@b=&quot;c&quot; and @d='e'] &amp; &lt;`);
    });

    test('nothing to place when the arch was not XML', () => {
        assert.deepStrictEqual(xpathFindings(parseXpathReport({ error: 'child arch is not valid XML: x' }), '<data'), []);
    });

    test('positions count \\r\\n, \\r and \\n as one line break each, like VS Code', () => {
        const text = 'a\r\nb\rc\nd';
        assert.deepStrictEqual(positionAt(text, text.indexOf('d')), { line: 3, character: 0 });
        assert.deepStrictEqual(positionAt(text, text.indexOf('c')), { line: 2, character: 0 });
        assert.deepStrictEqual(positionAt(text, 1), { line: 0, character: 1 });
    });
});
