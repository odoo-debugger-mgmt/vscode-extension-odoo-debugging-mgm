import * as assert from 'assert';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PdfRefusedError, fetchReportPdf, pdfFileName, reportPdfPath } from '../services/views/reportPdf';

async function fakeOdoo(answer: (request: http.IncomingMessage, response: http.ServerResponse) => void): Promise<{ port: number; close(): Promise<void> }> {
    const server = http.createServer(answer);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, close: () => new Promise(resolve => server.close(() => resolve())) };
}

suite('Report PDF', () => {
    test('paths and file names', () => {
        assert.strictEqual(reportPdfPath('account.report_invoice', 7), '/report/pdf/account.report_invoice/7');
        assert.strictEqual(pdfFileName('shop 18', 'account.report/invoice', 7), 'odt-report-shop_18-account.report_invoice-7.pdf');
    });

    test('fetches with the session cookie and accepts only a PDF', async () => {
        const cookies: string[] = [];
        const odoo = await fakeOdoo((request, response) => {
            cookies.push(String(request.headers.cookie));
            if (request.url === '/report/pdf/r/1') {
                response.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.4 fake');
            } else if (request.url === '/report/pdf/r/2') {
                response.writeHead(200, { 'content-type': 'text/html' }).end('<html>wkhtmltopdf missing</html>');
            } else {
                response.writeHead(303, { location: '/web/login' }).end();
            }
        });
        try {
            assert.strictEqual((await fetchReportPdf(odoo.port, '/report/pdf/r/1', 'abc')).toString('latin1'), '%PDF-1.4 fake');
            assert.deepStrictEqual(cookies, ['session_id=abc']);
            await assert.rejects(fetchReportPdf(odoo.port, '/report/pdf/r/2', 'abc'), /did not send a PDF/);
            await assert.rejects(fetchReportPdf(odoo.port, '/report/pdf/r/3', 'abc'), (error: unknown) =>
                error instanceof PdfRefusedError && /answered 303 \(to \/web\/login\)/.test(error.message) && error.sessionDropped);
            assert.strictEqual(new PdfRefusedError(500, undefined).sessionDropped, false);
            assert.strictEqual(new PdfRefusedError(303, 'http://127.0.0.1:8069/web/login?redirect=%2Freport').sessionDropped, true);
        } finally {
            await odoo.close();
        }
    });
});
