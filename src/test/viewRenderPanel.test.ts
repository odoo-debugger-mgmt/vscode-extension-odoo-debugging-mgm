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
        assert.ok(html.includes('>Start Server</button>'));
        const single = renderPanelHtml({ sides: [state.sides[1]] }, { nonce: 'n', cspSource: 'x', startLabel: 'Start Both Servers' });
        assert.ok(single.includes('>Start Both Servers</button>'));
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

    test('a report\'s record bar has no New record button; a form\'s keeps it, even on a new record', () => {
        const report = renderPanelHtml({ ...state, record: { label: 'Record 7', canPrevious: false, canNext: true, canNew: false } }, { nonce: 'n', cspSource: 'x' });
        assert.ok(/<button data-action="previous" disabled>/.test(report));
        assert.ok(report.includes('<span>Record 7</span>'));
        assert.ok(/<button data-action="next">/.test(report));
        assert.ok(!report.includes('data-action="new"'), 'a report can never show a new record');
        const fresh = renderPanelHtml({ ...state, record: { label: 'New record', canPrevious: true, canNext: false, canNew: false } }, { nonce: 'n', cspSource: 'x' });
        assert.ok(/<button data-action="new" disabled>/.test(fresh));
    });

    test('the Debug box shows the setting, and PDF shows only on a report side', () => {
        const report = { ...state, sides: [{ ...state.sides[0], pdf: true }, state.sides[1]] };
        const on = renderPanelHtml(report, { nonce: 'n', cspSource: 'x', debug: true });
        assert.ok(/<input type="checkbox" data-toggle="debug" checked>/.test(on), on);
        assert.strictEqual((on.match(/data-action="pdf"/g) ?? []).length, 1);
        assert.ok(on.includes('data-action="pdf" data-key="shop-17"'));
        const off = renderPanelHtml(state, { nonce: 'n', cspSource: 'x', debug: false });
        assert.ok(/<input type="checkbox" data-toggle="debug">/.test(off), off);
        assert.ok(!off.includes('data-action="pdf"'));
    });

    test('turning Debug off is remembered and reloads the frames without debug', async () => {
        let debug = true;
        const backend: RenderBackend = {
            newSession: async () => 'sid',
            makeAction: async () => ({ actionId: 3, model: 'res.partner', viewType: 'list', rootId: 1, series: '18.0' }),
            reportTarget: async () => null,
            recentIds: async () => []
        };
        const host: FrameHost = {
            portFor: async () => 8018,
            isPortOpen: async () => true,
            proxyFor: async (_db, port, mint) => ({ port: port + 1000, session: mint, gatePath: next => `/__odt/open?t=x&next=${encodeURIComponent(next)}` }),
            externalOrigin: async origin => origin
        };
        const panel = new ViewRenderPanel(backend, host, { debug: () => debug, setDebug: value => { debug = value; } });
        try {
            await panel.show({ title: 'Partners', targets: [{ dbName: 'shop-18', viewId: 1, title: 'shop-18' }], startCommand: 'x', startLabel: 'Start' });
            await (panel as unknown as { onMessage(message: unknown): Promise<void> }).onMessage({ type: 'action', action: 'debug', value: false });
            assert.strictEqual(debug, false);
            const html = (panel as unknown as { panel: { webview: { html: string } } }).panel.webview.html;
            assert.ok(html.includes('debug%3D0'), 'the frame URL did not turn debug off');
            assert.ok(/<input type="checkbox" data-toggle="debug">/.test(html));
        } finally {
            panel.dispose();
        }
    });

    test('opens one tab, reuses it, and closes it', async () => {
        const backend: RenderBackend = {
            newSession: async () => 'sid',
            makeAction: async () => ({ actionId: 3, model: 'res.partner', viewType: 'list', rootId: 1, series: '18.0' }),
            reportTarget: async () => null,
            recentIds: async () => []
        };
        const host: FrameHost = {
            portFor: async () => 8018,
            isPortOpen: async () => false,
            proxyFor: async () => ({ port: 40002, session: async () => 'sid', gatePath: next => next }),
            externalOrigin: async origin => origin
        };
        const panel = new ViewRenderPanel(backend, host);
        const request = { title: 'partner.custom', targets: [{ dbName: 'shop-18', viewId: 4, title: 'shop-18' }], startCommand: 'odoo.startServer', startLabel: 'Start Server' };
        await panel.show(request);
        assert.strictEqual(panel.isOpen, true);
        await panel.show(request);
        panel.reloadDatabase('shop-18');
        panel.dispose();
        assert.strictEqual(panel.isOpen, false);
    });

    function gated(delays: Map<number, Promise<void>>): { backend: RenderBackend; host: FrameHost } {
        return {
            backend: {
                newSession: async () => 'sid',
                makeAction: async (_db, viewId) => {
                    await delays.get(viewId);
                    return { actionId: 3, model: 'res.partner', viewType: 'list', rootId: 1, series: '18.0' };
                },
                reportTarget: async () => null,
                recentIds: async () => []
            },
            host: {
                portFor: async () => 8018,
                isPortOpen: async () => false,
                proxyFor: async () => ({ port: 40002, session: async () => 'sid', gatePath: next => next }),
                externalOrigin: async origin => origin
            }
        };
    }
    const requestFor = (viewId: number, title: string) => ({
        title, targets: [{ dbName: 'shop-18', viewId, title }], startCommand: 'odoo.startServer', startLabel: 'Start Server'
    });

    test('the render asked for last wins, even when an earlier one prepares slower', async () => {
        let release!: () => void;
        const slow = new Promise<void>(resolve => { release = resolve; });
        const { backend, host } = gated(new Map([[1, slow]]));
        const panel = new ViewRenderPanel(backend, host);
        const first = panel.show(requestFor(1, 'first'));
        await panel.show(requestFor(2, 'second'));
        release();
        await first;
        assert.strictEqual(panel.title, 'second');
        panel.dispose();
    });

    test('Reload asks again which servers answer, so a stopped one shows its message and Start', async () => {
        const { backend, host } = gated(new Map());
        let asked = 0;
        host.isPortOpen = async () => { asked++; return asked === 1; };
        const panel = new ViewRenderPanel(backend, host);
        await panel.show(requestFor(1, 'first'));
        assert.strictEqual(asked, 1);
        await panel.reload();
        assert.strictEqual(asked, 2, 'Reload only reloaded the frames, so a stopped server still showed a proxy error');
        panel.dispose();
        await panel.reload();
        assert.strictEqual(asked, 2, 'a closed tab asks nothing');
    });

    test('a tab closed while a render prepares stays closed', async () => {
        let release!: () => void;
        const slow = new Promise<void>(resolve => { release = resolve; });
        const { backend, host } = gated(new Map([[2, slow]]));
        const panel = new ViewRenderPanel(backend, host);
        await panel.show(requestFor(1, 'first'));
        assert.strictEqual(panel.isOpen, true);
        const pending = panel.show(requestFor(2, 'second'));
        panel.dispose();
        release();
        await pending;
        assert.strictEqual(panel.isOpen, false);
    });
});
