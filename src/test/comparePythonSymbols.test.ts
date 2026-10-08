import * as assert from 'assert';
import { enclosingSymbol, findMethodInSources, modelKeyOf, scanPythonSymbols, symbolText } from '../services/compare/pythonSymbols';

const SRC = [
    'from odoo import models',            // 0
    '',                                    // 1
    'class SaleOrder(models.Model):',      // 2
    "    _inherit = 'sale.order'",         // 3
    '',                                    // 4
    "    @api.depends('order_line')",      // 5
    '    def _compute_amounts(self):',     // 6
    '        def helper(x):',              // 7
    '            return x',                // 8
    '        return helper(1)',            // 9
    '',                                    // 10
    '    total = 0',                       // 11
    '',                                    // 12
    'def top():',                          // 13
    '    pass',                            // 14
].join('\n');

suite('Compare: Python symbols', () => {
    test('classes, methods (with their decorators) and nested functions', () => {
        const symbols = scanPythonSymbols(SRC);
        const byQ = new Map(symbols.map(s => [s.qualified, s]));
        assert.deepStrictEqual([...byQ.keys()].sort(), ['SaleOrder', 'SaleOrder._compute_amounts', 'SaleOrder._compute_amounts.helper', 'top'].sort());
        const m = byQ.get('SaleOrder._compute_amounts')!;
        assert.strictEqual(m.start, 5, 'the decorator belongs to the method');
        assert.strictEqual(m.end, 10);
        assert.strictEqual(byQ.get('SaleOrder')!.end, 12);
    });

    test('the innermost symbol around a line', () => {
        const symbols = scanPythonSymbols(SRC);
        assert.strictEqual(enclosingSymbol(symbols, 8)?.qualified, 'SaleOrder._compute_amounts.helper');
        assert.strictEqual(enclosingSymbol(symbols, 5)?.qualified, 'SaleOrder._compute_amounts');
        assert.strictEqual(enclosingSymbol(symbols, 11)?.qualified, 'SaleOrder');
        assert.strictEqual(enclosingSymbol(symbols, 0), undefined);
    });

    test('symbol text is its lines', () => {
        const m = scanPythonSymbols(SRC).find(s => s.qualified === 'top')!;
        assert.strictEqual(symbolText(SRC, m), 'def top():\n    pass');
    });

    test('_name and _inherit', () => {
        assert.deepStrictEqual(modelKeyOf("class A:\n    _name = 'a.b'\n    _inherit = ['mail.thread', 'x']"), { name: 'a.b', inherit: ['mail.thread', 'x'] });
        assert.deepStrictEqual(modelKeyOf('class A:\n    _inherit = "sale.order"'), { inherit: ['sale.order'] });
    });

    test('a method moved to another file of the module is found by model', () => {
        const other = "class SaleOrderLine(models.Model):\n    _inherit = 'sale.order'\n\n    def _compute_amounts(self):\n        pass\n";
        const hit = findMethodInSources([{ file: 'a.py', text: 'class X:\n    pass\n' }, { file: 'b.py', text: other }], { inherit: ['sale.order'] }, '_compute_amounts');
        assert.strictEqual(hit?.file, 'b.py');
        assert.strictEqual(hit?.symbol.name, '_compute_amounts');
        assert.strictEqual(findMethodInSources([{ file: 'b.py', text: other }], { inherit: ['sale.order'] }, 'nope'), undefined);
    });

    const bounds = (src: string) => scanPythonSymbols(src).map(x => [x.qualified, x.start, x.end]);

    test('a docstring-only body, and a method returning a triple-quoted string, keep their lines', () => {
        assert.deepStrictEqual(bounds('class A:\n    """Doc\n    more\n"""\nx = 1\n'), [['A', 0, 4]]);
        assert.deepStrictEqual(bounds('class A:\n    def f(self):\n        return """\nSELECT 1\n"""\n\n    def g(self):\n        pass\n'),
            [['A', 0, 8], ['A.f', 1, 5], ['A.g', 6, 8]]);
    });

    test('a multi-line signature with `):` at the def indent does not end the body', () => {
        assert.deepStrictEqual(bounds('class A:\n    def f(\n        self,\n        x,\n    ):\n        return 1\n\n    def g(self):\n        pass\n'),
            [['A', 0, 9], ['A.f', 1, 6], ['A.g', 7, 9]]);
        assert.deepStrictEqual(bounds('class X(\n    models.Model\n):\n    _name = "x"\n\ny = 1\n'), [['X', 0, 4]]);
    });

    test('a multi-line decorator belongs to the method', () => {
        const src = 'class A:\n    @api.depends(\n        "a",\n        "b",\n    )\n    @api.model\n    def f(self):\n        pass\n';
        assert.deepStrictEqual(bounds(src), [['A', 0, 8], ['A.f', 1, 8]]);
        assert.deepStrictEqual(bounds('x = foo(\n    1,\n)\ndef f():\n    pass\n'), [['f', 3, 5]]);
    });

    test('triple quotes in a comment do not open a string', () => {
        assert.deepStrictEqual(bounds('class A:\n    def f(self):\n        # a """ quote\n        return 1\n\n    def g(self):\n        pass\n'),
            [['A', 0, 7], ['A.f', 1, 4], ['A.g', 5, 7]]);
    });

    test('modelKeyOf reads class-level assignments only', () => {
        assert.deepStrictEqual(modelKeyOf("class A:\n    _inherit = 'a'\n\n    def f(self):\n        _name = 'local'\n\n    class B:\n        _name = 'nested'\n"), { inherit: ['a'] });
        assert.deepStrictEqual(modelKeyOf("class A:\n    _inherit = [\n        'a',\n        'b',\n    ]\n"), { inherit: ['a', 'b'] });
    });

    test('an exact _name wins over an _inherit-only match; a class with another _name does not match by _inherit', () => {
        const inh = { file: 'a.py', text: "class A:\n    _inherit = 'x.y'\n    def m(self):\n        pass\n" };
        const own = { file: 'b.py', text: "class B:\n    _name = 'x.y'\n    def m(self):\n        pass\n" };
        assert.strictEqual(findMethodInSources([inh, own], { name: 'x.y' }, 'm')?.file, 'b.py');
        const other = { file: 'c.py', text: "class C:\n    _name = 'foo'\n    _inherit = ['mail.thread']\n    def m(self):\n        pass\n" };
        assert.strictEqual(findMethodInSources([other], { inherit: ['mail.thread'] }, 'm'), undefined);
    });

    test('a nested function is not a method of the model', () => {
        const src = { file: 'a.py', text: "class A:\n    _inherit = 'x'\n    def f(self):\n        def helper():\n            pass\n" };
        assert.strictEqual(findMethodInSources([src], { inherit: ['x'] }, 'helper'), undefined);
    });
});
