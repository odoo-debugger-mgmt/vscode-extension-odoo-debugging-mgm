import * as assert from 'assert';
import * as vscode from 'vscode';
import { createSaveHook, saveMessage, type SaveHookDeps } from '../views/viewSaveHook';
import { parseXpathReport, type XpathReport } from '../services/views/xpathReport';
import type { SaveResult } from '../services/views/viewService';

const dead = parseXpathReport({ locators: [{ kind: 'xpath', expr: '//a', status: 'dead', matches: 0, element: 1, line: 1 }, { kind: 'xpath', expr: '//b', status: 'dead', matches: 0, element: 2, line: 1 }] });
const fine = parseXpathReport({ locators: [{ kind: 'xpath', expr: '//a', status: 'ok', matches: 1, element: 1, line: 1 }] });
const on: SaveResult = { active: true, activated: true, activationError: null, inheriting: true };

function harness(overrides: Partial<SaveHookDeps> & { report?: XpathReport | Error } = {}) {
    const log: string[] = [];
    const activation = vscode.languages.createDiagnosticCollection('odoo-views-test');
    const deps: SaveHookDeps = {
        checkXpaths: async (_db, _id, arch) => {
            log.push(`check:${arch}`);
            if (overrides.report instanceof Error) {
                throw overrides.report;
            }
            return overrides.report ?? fine;
        },
        checkOnSave: () => true,
        xpaths: { show: (_uri, _text, report) => log.push(`show:${report.summary.dead}`) },
        activationDiagnostics: activation,
        reloadDatabase: db => log.push(`reload:${db}`),
        recordSave: async () => { log.push('record'); },
        refreshTree: () => log.push('refresh'),
        warn: text => log.push(`warn:${text}`),
        brief: text => log.push(`brief:${text}`),
        ...overrides
    };
    return { log, activation, hook: createSaveHook(deps) };
}

const uri = vscode.Uri.parse('odoo-view:/shop/12/acme.patch.xml');
const ref = { dbName: 'shop', viewId: 12 };

suite('After an arch save', () => {
    test('the message says when locators are broken', () => {
        assert.deepStrictEqual(saveMessage(on, dead), { warning: true, text: 'Saved, and the view is on — but 2 locators match nothing.' });
        assert.deepStrictEqual(saveMessage({ ...on, activated: false }, dead), { warning: true, text: 'Saved — but 2 locators match nothing.' });
        assert.deepStrictEqual(saveMessage(on, fine), { warning: false, text: 'Saved, and the view is on.' });
        assert.deepStrictEqual(saveMessage({ ...on, activated: false }), { warning: false, text: 'Saved.' });
        assert.match(saveMessage({ active: false, activated: false, activationError: 'Element x cannot be located', inheriting: true }, dead).text, /^Saved\. The view stays off: /);
    });

    test('an inheriting view is checked on the saved text, and the toast waits for it', async () => {
        const { log, hook, activation } = harness({ report: dead });
        await hook(ref, on, uri, '<data/>');
        assert.deepStrictEqual(log.filter(entry => !['record', 'refresh'].includes(entry)), [
            'reload:shop', 'check:<data/>', 'show:2', 'warn:Saved, and the view is on — but 2 locators match nothing.'
        ]);
        activation.dispose();
    });

    test('no check with the setting off, for a root view, or when the check fails', async () => {
        for (const [overrides, result] of [
            [{ checkOnSave: () => false }, on],
            [{}, { ...on, inheriting: false }],
            [{ report: new Error('shell gone') }, on]
        ] as Array<[Partial<SaveHookDeps> & { report?: Error }, SaveResult]>) {
            const { log, hook, activation } = harness(overrides);
            await hook(ref, result, uri, '<data/>');
            assert.ok(!log.some(entry => entry.startsWith('show:')), log.join());
            assert.ok(log.includes('brief:Saved, and the view is on.'), log.join());
            activation.dispose();
        }
    });

    test('Odoo\'s reason a view stays off still lands on its line', async () => {
        const { log, hook, activation } = harness();
        await hook(ref, { active: false, activated: false, activationError: 'Element \'<xpath expr="//nope">\' cannot be located in parent view', inheriting: true }, uri, '<data>\n<xpath expr="//nope"/>\n</data>');
        assert.strictEqual(activation.get(uri)?.length, 1);
        assert.ok(log.some(entry => entry.startsWith('warn:Saved. The view stays off')), log.join());
        activation.dispose();
    });
});
