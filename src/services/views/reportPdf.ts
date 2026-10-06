/**
 * A report's PDF, fetched straight from the database's Odoo server with the
 * render tab's admin session - not through the frame proxy, which only the
 * webview may use. VS Code webviews show no PDF, so the file is opened with
 * the system's viewer instead.
 */
import * as http from 'node:http';

const MAX_PDF_BYTES = 200 * 1024 * 1024;

/** Odoo answered something other than 200: a redirect to /web/login means it dropped the session. */
export class PdfRefusedError extends Error {
    constructor(readonly status: number | undefined, readonly location: string | undefined) {
        super(`Odoo answered ${status}${location ? ` (to ${location})` : ''}.`);
    }

    get sessionDropped(): boolean {
        try {
            return !!this.location && new URL(this.location, 'http://odoo').pathname === '/web/login';
        } catch {
            return false;
        }
    }
}

export function reportPdfPath(reportName: string, resId: number): string {
    return `/report/pdf/${encodeURIComponent(reportName)}/${resId}`;
}

/** A file name with nothing but word characters, dots and dashes from the database and report. */
export function pdfFileName(dbName: string, reportName: string, resId: number): string {
    return `odt-report-${[dbName, reportName, String(resId)].map(part => part.replace(/[^\w.-]+/g, '_')).join('-')}.pdf`;
}

export function fetchReportPdf(port: number, path: string, sid: string, timeoutMs = 120_000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const request = http.get({ host: '127.0.0.1', port, path, headers: { cookie: `session_id=${sid}` }, timeout: timeoutMs }, response => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_PDF_BYTES) {
                    request.destroy(new Error('The PDF is larger than 200 MB.'));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                if (response.statusCode !== 200) {
                    reject(new PdfRefusedError(response.statusCode, response.headers.location));
                    return;
                }
                const body = Buffer.concat(chunks);
                if (body.subarray(0, 5).toString('latin1') !== '%PDF-') {
                    reject(new Error('Odoo did not send a PDF. Is wkhtmltopdf installed where that server runs?'));
                    return;
                }
                resolve(body);
            });
            response.on('error', reject);
        });
        request.on('timeout', () => request.destroy(new Error('Odoo took too long to make the PDF.')));
        request.on('error', reject);
    });
}
