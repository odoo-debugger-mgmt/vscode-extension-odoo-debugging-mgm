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
});
