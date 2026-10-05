import * as assert from 'assert';
import { ViewRenderPanel, escapeHtml, renderPanelHtml } from '../views/viewRenderPanel';
import type { FrameHost, RenderBackend, RenderState } from '../services/views/renderSession';

const state: RenderState = {
    sides: [
        { key: 'shop-17', title: 'Original · shop-17', detail: 'Odoo 17.0 · res.partner · record 7', url: 'http://127.0.0.1:40001/__odt/open?t=a&next=%2Fweb' },
        { key: 'shop-18', title: 'Upgraded · <img src=x onerror=alert(1)>', message: 'No Odoo server is answering on port 8018.', offerStart: true }
    ],
    notice: 'No record exists in both databases; showing a new one.',
    record: { label: 'Record 7', canPrevious: false, canNext: true, canNew: true }
};

suite('Render tab', () => {
    test('frames only the proxy origins, and runs only its own nonced script', () => {
        const html = renderPanelHtml(state, { nonce: 'n0nce', cspSource: 'vscode-resource:' });
        const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? '';
        assert.ok(csp.includes("default-src 'none'"), csp);
        assert.ok(csp.includes('frame-src http://127.0.0.1:40001;'), csp);
        assert.ok(csp.includes("script-src 'nonce-n0nce'"), csp);
        assert.ok(!html.includes('unsafe-inline'));
        assert.strictEqual((html.match(/<script /g) ?? []).length, 1);
        assert.ok(html.includes('<script nonce="n0nce">'));
    });

    test('escapes names', () => {
        const html = renderPanelHtml(state, { nonce: 'n', cspSource: 'x' });
        assert.ok(!html.includes('<img src=x'), 'markup from a name reached the page');
        assert.ok(html.includes('Upgraded · &lt;img src=x onerror=alert(1)&gt;'));
        assert.strictEqual(escapeHtml(`"a" & 'b'`), '&quot;a&quot; &amp; &#39;b&#39;');
    });

    test('a side without a frame says why and offers to start its server', () => {
        const html = renderPanelHtml(state, { nonce: 'n', cspSource: 'x' });
        assert.strictEqual((html.match(/<iframe /g) ?? []).length, 1);
        assert.ok(html.includes('data-src="http://127.0.0.1:40001/__odt/open?t=a&amp;next=%2Fweb"'));
        assert.ok(html.includes('No Odoo server is answering on port 8018.'));
        assert.ok(html.includes('data-action="start"'));
        assert.ok(html.includes('No record exists in both databases; showing a new one.'));
    });

    test('the record buttons follow what can be shown', () => {
        const html = renderPanelHtml(state, { nonce: 'n', cspSource: 'x' });
        assert.ok(/<button data-action="previous" disabled>/.test(html));
        assert.ok(/<button data-action="next">/.test(html));
        assert.ok(/<button data-action="new">/.test(html));
        const list = renderPanelHtml({ sides: state.sides }, { nonce: 'n', cspSource: 'x' });
        assert.ok(!list.includes('data-action="next"'), 'no record buttons for a list');
        assert.ok(list.includes('data-action="reload"'));
    });

    test('opens one tab, reuses it, and closes it', async () => {
        const backend: RenderBackend = {
            newSession: async () => 'sid',
            makeAction: async () => ({ actionId: 3, model: 'res.partner', viewType: 'list', rootId: 1, series: '18.0' }),
            recentIds: async () => []
        };
        const host: FrameHost = {
            portFor: async () => 8018,
            isPortOpen: async () => false,
            proxyFor: async () => ({ port: 40002, session: async () => 'sid', gatePath: next => next }),
            externalOrigin: async origin => origin
        };
        const panel = new ViewRenderPanel(backend, host);
        const request = { title: 'partner.custom', targets: [{ dbName: 'shop-18', viewId: 4, title: 'shop-18' }], startCommand: 'odoo.startServer' };
        await panel.show(request);
        assert.strictEqual(panel.isOpen, true);
        await panel.show(request);
        panel.reloadDatabase('shop-18');
        panel.dispose();
        assert.strictEqual(panel.isOpen, false);
    });
});
