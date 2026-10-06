import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ViewRenderPanel, escapeHtml, renderPanelHtml, type PdfHooks } from '../views/viewRenderPanel';
import type { FrameHost, RenderBackend, RenderState } from '../services/views/renderSession';
import { PdfRefusedError } from '../services/views/reportPdf';

const state: RenderState = {
    sides: [
        { key: 'shop-17', title: 'Original · shop-17', detail: 'Odoo 17.0 · res.partner · record 7', url: 'http://127.0.0.1:40001/__odt/open?t=a&next=%2Fweb' },
        { key: 'shop-18', title: 'Upgraded · <img src=x onerror=alert(1)>', message: 'No Odoo server is answering on port 8018.', offerStart: true }
    ],
    notice: 'No record exists in both databases; showing a new one.',
    record: { label: 'Record 7', canPrevious: false, canNext: true, canNew: true, showNew: true }
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
        const fresh = renderPanelHtml({ ...state, record: { label: 'New record', canPrevious: true, canNext: false, canNew: false, showNew: true } }, { nonce: 'n', cspSource: 'x' });
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

    // A report tab on shop-18 whose PDF goes through the hooks: nothing here opens an app.
    const reportBackend: RenderBackend = {
        newSession: async () => 'sid',
        makeAction: async () => assert.fail('a report makes no action'),
        reportTarget: async () => ({ reportName: 'account.report_invoice', name: 'Invoices', model: 'account.move', domain: [], series: '18.0', reportType: 'qweb-pdf' }),
        recentIds: async () => [8]
    };
    const reportHost: FrameHost = {
        portFor: async () => 8018,
        isPortOpen: async () => true,
        proxyFor: async (_db, port, mint) => ({ port: port + 1000, session: mint, gatePath: next => `/__odt/open?t=x&next=${encodeURIComponent(next)}` }),
        externalOrigin: async origin => origin
    };
    const reportRequest = {
        title: 'Invoices', targets: [{ dbName: 'shop-18', viewId: 5, title: 'shop-18', kind: 'report' as const }], startCommand: 'x', startLabel: 'Start'
    };
    const clickPdf = (panel: ViewRenderPanel) =>
        (panel as unknown as { onMessage(message: unknown): Promise<void> }).onMessage({ type: 'action', action: 'pdf', key: 'shop-18' });
    const pdfFolders = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('odt-report-')).sort();

    test('a PDF that cannot be fetched says why and writes nothing; a click while one is fetched is ignored', async () => {
        const errors: string[] = [];
        const failures: Error[] = [new Error('boom'), new PdfRefusedError(303, 'http://127.0.0.1:8018/web/login?redirect=%2Freport')];
        let calls = 0;
        let started!: () => void;
        const fetching = new Promise<void>(resolve => { started = resolve; });
        let fail!: () => void;
        const hooks: PdfHooks = {
            fetch: async (port, pdfPath, sid) => {
                calls++;
                assert.deepStrictEqual([port, pdfPath, sid], [8018, '/report/pdf/account.report_invoice/8', 'sid']);
                started();
                const failure = failures.shift()!;
                await new Promise<void>(resolve => { fail = resolve; });
                throw failure;
            },
            open: async () => assert.fail('nothing to open'),
            showError: message => { errors.push(message); },
            showInfo: message => assert.fail(`unexpected: ${message}`)
        };
        const before = pdfFolders();
        const panel = new ViewRenderPanel(reportBackend, reportHost, undefined, hooks);
        try {
            await panel.show(reportRequest);
            const first = clickPdf(panel);
            await fetching;
            await clickPdf(panel);
            assert.strictEqual(calls, 1, 'the second click fetched too');
            fail();
            await first;
            assert.deepStrictEqual(errors, ['Could not get the PDF: boom']);

            const second = clickPdf(panel);
            while (calls < 2) {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            fail();
            await second;
            assert.deepStrictEqual(errors.slice(1), ['Odoo no longer accepts the render\'s session; press Reload and try again.']);
            assert.deepStrictEqual(pdfFolders(), before, 'a failed fetch made a folder');
        } finally {
            panel.dispose();
        }
    });

    test('a PDF goes to the tab\'s private folder, says where it is when no app opens it, and leaves with the tab', async () => {
        const infos: string[] = [];
        const opened: string[] = [];
        const hooks: PdfHooks = {
            fetch: async () => Buffer.from('%PDF-1.4 fake', 'latin1'),
            open: async file => { opened.push(file); return false; },
            showError: message => assert.fail(`unexpected: ${message}`),
            showInfo: message => { infos.push(message); }
        };
        const panel = new ViewRenderPanel(reportBackend, reportHost, undefined, hooks);
        let folder = '';
        try {
            await panel.show(reportRequest);
            await clickPdf(panel);
            assert.strictEqual(opened.length, 1);
            const file = opened[0];
            folder = path.dirname(file);
            assert.strictEqual(path.dirname(folder), os.tmpdir());
            assert.match(path.basename(folder), /^odt-report-/);
            assert.strictEqual(path.basename(file), 'odt-report-shop-18-account.report_invoice-8.pdf');
            if (process.platform !== 'win32') {
                assert.strictEqual(fs.statSync(folder).mode & 0o777, 0o700);
            }
            assert.strictEqual(fs.readFileSync(file, 'latin1'), '%PDF-1.4 fake');
            assert.deepStrictEqual(infos, [`No app opened the PDF; it is at ${file}.`]);
            await clickPdf(panel);
            assert.strictEqual(path.dirname(opened[1]), folder, 'the tab keeps one folder');
        } finally {
            panel.dispose();
        }
        for (let tries = 0; tries < 100 && fs.existsSync(folder); tries++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(!fs.existsSync(folder), 'closing the tab left its PDF folder');
    });

    test('a PDF that arrives after its tab closed is not opened or kept, and does not block the reopened tab', async () => {
        const opened: string[] = [];
        const held: Array<() => void> = [];
        const hooks: PdfHooks = {
            fetch: async () => {
                await new Promise<void>(resolve => { held.push(resolve); });
                return Buffer.from('%PDF-1.4 fake', 'latin1');
            },
            open: async file => { opened.push(file); return true; },
            showError: message => assert.fail(`unexpected: ${message}`),
            showInfo: message => assert.fail(`unexpected: ${message}`)
        };
        const waitHeld = async (count: number) => {
            for (let tries = 0; tries < 200 && held.length < count; tries++) {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            assert.strictEqual(held.length, count, 'the fetch did not start');
        };
        const before = pdfFolders();
        const panel = new ViewRenderPanel(reportBackend, reportHost, undefined, hooks);
        try {
            await panel.show(reportRequest);
            const stale = clickPdf(panel);
            await waitHeld(1);
            panel.dispose();

            await panel.show(reportRequest);
            const fresh = clickPdf(panel);
            await waitHeld(2);
            held[0]();
            await stale;
            assert.deepStrictEqual(opened, [], 'the closed tab\'s PDF opened');
            held[1]();
            await fresh;
            assert.strictEqual(opened.length, 1, 'the reopened tab could not get its PDF');
        } finally {
            panel.dispose();
        }
        let left = pdfFolders();
        for (let tries = 0; tries < 100 && left.length > before.length; tries++) {
            await new Promise(resolve => setTimeout(resolve, 10));
            left = pdfFolders();
        }
        assert.deepStrictEqual(left, before, 'a PDF folder was left behind');
    });
});
