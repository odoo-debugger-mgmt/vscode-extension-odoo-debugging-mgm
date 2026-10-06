import * as assert from 'assert';
import { NO_COMMON_RECORD } from '../services/views/renderPlan';
import { RenderSession, type FrameHost, type RenderBackend, type RenderTarget } from '../services/views/renderSession';
import type { RenderAction, ReportTarget } from '../services/views/viewService';

const original: RenderTarget = { dbName: 'shop-17', versionId: 'v17', viewId: 40, title: 'Original · shop-17' };
const upgraded: RenderTarget = { dbName: 'shop-18', versionId: 'v18', viewId: 40, title: 'Upgraded · shop-18' };

function backend(
    ids: Record<string, number[]>,
    actions: Record<string, Partial<RenderAction> | Error> = {},
    reports: Record<string, ReportTarget | null> = {}
): RenderBackend & { recentCalls: string[]; domains: unknown[][] } {
    const recentCalls: string[] = [];
    const domains: unknown[][] = [];
    return {
        recentCalls,
        domains,
        newSession: async dbName => `sid-${dbName}`,
        makeAction: async dbName => {
            const action = actions[dbName];
            if (action instanceof Error) {
                throw action;
            }
            return { actionId: dbName === 'shop-17' ? 11 : 21, model: 'res.partner', viewType: 'form', rootId: 7, series: dbName === 'shop-17' ? '17.0' : '18.0', ...action };
        },
        reportTarget: async dbName => dbName in reports ? reports[dbName] : null,
        recentIds: async (dbName, _model, _limit, domain = []) => {
            recentCalls.push(dbName);
            domains.push(domain);
            return ids[dbName] ?? [];
        }
    };
}

function host(closedPorts: number[] = []): FrameHost {
    const ports: Record<string, number> = { 'shop-17': 8017, 'shop-18': 8018 };
    return {
        portFor: async dbName => ports[dbName],
        isPortOpen: async port => !closedPorts.includes(port),
        proxyFor: async (_dbName, port, mint) => ({
            port: port + 1000,
            session: mint,
            gatePath: next => `/__odt/open?t=x&next=${encodeURIComponent(next)}`
        }),
        externalOrigin: async origin => origin.replace('127.0.0.1', 'forwarded.example')
    };
}

const nextOf = (url: string | undefined) => decodeURIComponent(/next=([^&]*)/.exec(url ?? '')?.[1] ?? '');

suite('Render session', () => {
    test('both sides open the newest record they share, and step through the shared ones', async () => {
        const session = await RenderSession.prepare([original, upgraded], backend({ 'shop-17': [9, 7, 5], 'shop-18': [8, 7, 5] }), host());
        let state = await session.state();
        assert.deepStrictEqual(state.sides.map(side => nextOf(side.url)), [
            '/web?debug=1#action=11&model=res.partner&view_type=form&id=7',
            '/odoo/action-21/7?debug=1'
        ]);
        assert.ok(state.sides[1].url?.startsWith('http://forwarded.example:9018/__odt/open'), state.sides[1].url);
        assert.deepStrictEqual(state.record, { label: 'Record 7', canPrevious: false, canNext: true, canNew: true });
        assert.strictEqual(state.notice, undefined);
        assert.strictEqual(state.sides[0].detail, 'Odoo 17.0 · res.partner · record 7');

        assert.strictEqual(session.next(), true);
        state = await session.state();
        assert.ok(state.sides.every(side => nextOf(side.url).includes('5')));
        assert.strictEqual(session.next(), false, 'no older shared record');
        assert.strictEqual(session.newRecord(), true);
        state = await session.state();
        assert.deepStrictEqual(state.sides.map(side => nextOf(side.url)), [
            '/web?debug=1#action=11&model=res.partner&view_type=form',
            '/odoo/action-21?debug=1'
        ]);
        assert.strictEqual(state.record?.label, 'New record');
        assert.strictEqual(session.previous(), true, 'back to the newest shared record');
        assert.strictEqual(state.record?.canPrevious, true);
    });

    test('with no record in both, both sides open a new one and say so', async () => {
        const session = await RenderSession.prepare([original, upgraded], backend({ 'shop-17': [9], 'shop-18': [8] }), host());
        const state = await session.state();
        assert.strictEqual(state.notice, NO_COMMON_RECORD);
        assert.deepStrictEqual(state.sides.map(side => nextOf(side.url)), [
            '/web?debug=1#action=11&model=res.partner&view_type=form',
            '/odoo/action-21?debug=1'
        ]);
        assert.deepStrictEqual(state.record, { label: 'New record', canPrevious: false, canNext: false, canNew: false });
    });

    test('one side alone uses its newest record, or a new one', async () => {
        let state = await (await RenderSession.prepare([upgraded], backend({ 'shop-18': [8, 3] }), host())).state();
        assert.strictEqual(nextOf(state.sides[0].url), '/odoo/action-21/8?debug=1');
        assert.strictEqual(state.notice, undefined);
        state = await (await RenderSession.prepare([upgraded], backend({}), host())).state();
        assert.strictEqual(nextOf(state.sides[0].url), '/odoo/action-21?debug=1');
        assert.strictEqual(state.notice, 'res.partner has no record yet; showing a new one.');
    });

    test('a list opens as is, without looking for records', async () => {
        const fake = backend({ 'shop-18': [8] }, { 'shop-18': { viewType: 'list' } });
        const state = await (await RenderSession.prepare([upgraded], fake, host())).state();
        assert.strictEqual(nextOf(state.sides[0].url), '/odoo/action-21?debug=1');
        assert.strictEqual(state.record, undefined);
        assert.deepStrictEqual(fake.recentCalls, []);
    });

    test('a side with no server says so and offers to start it; the other still renders', async () => {
        const session = await RenderSession.prepare([original, upgraded], backend({ 'shop-17': [7], 'shop-18': [7] }), host([8017]));
        const state = await session.state();
        assert.strictEqual(state.sides[0].url, undefined);
        assert.strictEqual(state.sides[0].offerStart, true);
        assert.strictEqual(state.sides[0].message, 'No Odoo server is answering on port 8017.');
        assert.strictEqual(nextOf(state.sides[1].url), '/odoo/action-21/7?debug=1');
        assert.deepStrictEqual(session.ports(), [8017, 8018]);
        assert.strictEqual(session.shows('shop-17'), true);
        assert.strictEqual(session.shows('shop-19'), false);
    });

    test('a side that cannot render shows why; the other uses its own records', async () => {
        const fake = backend({ 'shop-17': [9], 'shop-18': [8] }, { 'shop-17': new Error('Model res.partner is not installed in this database.') });
        const state = await (await RenderSession.prepare([original, upgraded], fake, host())).state();
        assert.strictEqual(state.sides[0].message, 'Model res.partner is not installed in this database.');
        assert.strictEqual(state.sides[0].url, undefined);
        assert.strictEqual(nextOf(state.sides[1].url), '/odoo/action-21/8?debug=1');
        assert.strictEqual(state.notice, undefined);
    });

    const invoice = (series: string): ReportTarget => ({ reportName: 'account.report_invoice', name: 'Invoices', model: 'account.move', domain: [['move_type', '!=', 'entry']], series });
    const reportOf = (target: RenderTarget): RenderTarget => ({ ...target, kind: 'report' });

    test('a report shows the same invoice on both sides, as HTML, and steps without a new record', async () => {
        const fake = backend({ 'shop-17': [9, 7, 5], 'shop-18': [8, 7, 5] }, {}, { 'shop-17': invoice('17.0'), 'shop-18': invoice('18.0') });
        const session = await RenderSession.prepare([reportOf(original), reportOf(upgraded)], fake, host());
        const state = await session.state();
        assert.deepStrictEqual(state.sides.map(side => nextOf(side.url)), ['/report/html/account.report_invoice/7?debug=1', '/report/html/account.report_invoice/7?debug=1']);
        assert.deepStrictEqual(state.record, { label: 'Record 7', canPrevious: false, canNext: true, canNew: false });
        assert.strictEqual(state.sides[0].detail, 'Odoo 17.0 · Invoices · record 7');
        assert.deepStrictEqual(fake.domains, [[['move_type', '!=', 'entry']], [['move_type', '!=', 'entry']]]);
        assert.strictEqual(session.newRecord(), false);
    });

    test('a report with no shared record says so in place of the frames', async () => {
        const fake = backend({ 'shop-17': [9], 'shop-18': [8] }, {}, { 'shop-17': invoice('17.0'), 'shop-18': invoice('18.0') });
        const state = await (await RenderSession.prepare([reportOf(original), reportOf(upgraded)], fake, host())).state();
        assert.ok(state.sides.every(side => !side.url && side.message === 'No account.move record exists in both databases to render this report with.'), JSON.stringify(state.sides));
        assert.strictEqual(state.record, undefined);
        const single = await (await RenderSession.prepare([reportOf(upgraded)], backend({}, {}, { 'shop-18': invoice('18.0') }), host())).state();
        assert.strictEqual(single.sides[0].message, 'No account.move record to render this report with.');
    });

    test('a side whose database has no such report says so; the other still renders', async () => {
        const fake = backend({ 'shop-18': [8] }, {}, { 'shop-17': null, 'shop-18': invoice('18.0') });
        const state = await (await RenderSession.prepare([reportOf(original), reportOf(upgraded)], fake, host())).state();
        assert.strictEqual(state.sides[0].message, 'shop-17 has no report for this template.');
        assert.strictEqual(nextOf(state.sides[1].url), '/report/html/account.report_invoice/8?debug=1');
    });

    test('a report steps to the next shared record and back', async () => {
        const fake = backend({ 'shop-17': [9, 7, 5], 'shop-18': [8, 7, 5] }, {}, { 'shop-17': invoice('17.0'), 'shop-18': invoice('18.0') });
        const session = await RenderSession.prepare([reportOf(original), reportOf(upgraded)], fake, host());
        const urls = async () => (await session.state()).sides.map(side => nextOf(side.url));
        const at = (id: number) => [`/report/html/account.report_invoice/${id}?debug=1`, `/report/html/account.report_invoice/${id}?debug=1`];
        assert.deepStrictEqual(await urls(), at(7));
        assert.strictEqual(session.next(), true);
        assert.deepStrictEqual(await urls(), at(5));
        assert.deepStrictEqual((await session.state()).record, { label: 'Record 5', canPrevious: true, canNext: false, canNew: false });
        assert.strictEqual(session.next(), false, 'no older shared record');
        assert.strictEqual(session.previous(), true);
        assert.deepStrictEqual(await urls(), at(7));
        assert.deepStrictEqual((await session.state()).record, { label: 'Record 7', canPrevious: false, canNext: true, canNew: false });
        assert.strictEqual(session.previous(), false, 'no new record before the newest');
    });

    test('the debug flag reaches every frame, and a report side offers its PDF', async () => {
        const views = await RenderSession.prepare([original, upgraded], backend({ 'shop-17': [7], 'shop-18': [7] }), host());
        assert.ok((await views.state({ debug: false })).sides.every(side => nextOf(side.url).includes('debug=0')));
        assert.ok((await views.state()).sides.every(side => !side.pdf));
        assert.strictEqual(views.pdfSource('shop-18'), undefined);

        const reports = await RenderSession.prepare([reportOf(upgraded)], backend({ 'shop-18': [8, 5] }, {}, { 'shop-18': invoice('18.0') }), host());
        const state = await reports.state({ debug: false });
        assert.strictEqual(nextOf(state.sides[0].url), '/report/html/account.report_invoice/8?debug=0');
        assert.strictEqual(state.sides[0].pdf, true);
        const source = reports.pdfSource('shop-18');
        assert.deepStrictEqual([source?.dbName, source?.port, source?.path, source?.fileName],
            ['shop-18', 8018, '/report/pdf/account.report_invoice/8', 'odt-report-shop-18-account.report_invoice-8.pdf']);
        assert.strictEqual(await source?.session(), 'sid-shop-18');
        reports.next();
        assert.strictEqual(reports.pdfSource('shop-18')?.path, '/report/pdf/account.report_invoice/5', 'follows the record shown');
        assert.strictEqual(reports.pdfSource('nope'), undefined);
    });
});
