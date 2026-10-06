/**
 * One render: for each database shown, the action that opens the view, the
 * proxy its frame goes through and the records it has; then, for the record
 * being shown, what each frame loads. Both sides always show the same record
 * - the newest both databases have - or both a new one, so the two renders
 * compare. The one exception: a report whose model differs between the two
 * databases, where an id names unrelated records; each side then shows its
 * own newest record.
 */
import { errorMessage } from '../logger';
import type { RenderAction, ReportTarget } from './viewService';
import { NO_COMMON_RECORD, commonIds, framePath, reportPath } from './renderPlan';
import { pdfFileName, reportPdfPath } from './reportPdf';

export const RECENT_LIMIT = 200;

/** The report types that /report/pdf renders; qweb-text makes plain text. */
const PDF_REPORT_TYPES = new Set(['qweb-pdf', 'qweb-html']);

export interface RenderTarget {
    dbName: string;
    versionId?: string;
    viewId: number;
    /** The frame header's first part, e.g. "Original · shop-17". */
    title: string;
    /** A report renders its template on a record; a view opens in the web client. Default 'view'. */
    kind?: 'view' | 'report';
}

export interface RenderBackend {
    newSession(dbName: string): Promise<string>;
    makeAction(dbName: string, viewId: number): Promise<RenderAction>;
    reportTarget(dbName: string, viewId: number): Promise<ReportTarget | null>;
    recentIds(dbName: string, model: string, limit?: number, domain?: unknown[]): Promise<number[]>;
}

export interface FrameProxyHandle {
    readonly port: number;
    session(): Promise<string>;
    gatePath(next: string): string;
}

export interface FrameHost {
    portFor(dbName: string, versionId?: string): Promise<number>;
    isPortOpen(port: number): Promise<boolean>;
    /** The database's proxy to this port, listening, started on first use. */
    proxyFor(dbName: string, port: number, mint: () => Promise<string>): Promise<FrameProxyHandle>;
    /** The origin the webview reaches a local origin at (port forwarding in remote windows). */
    externalOrigin(localOrigin: string): Promise<string>;
}

export interface RenderSideState {
    key: string;
    title: string;
    detail?: string;
    url?: string;
    message?: string;
    offerStart?: boolean;
    /** A report side showing a record, of a report that makes a PDF: it can give its PDF. */
    pdf?: boolean;
}

export interface PdfSource {
    dbName: string;
    /** The Odoo server's own port; the PDF does not go through the proxy. */
    port: number;
    path: string;
    fileName: string;
    /** The admin session the side's frame uses. */
    session(): Promise<string>;
}

export interface RenderRecordState {
    label: string;
    canPrevious: boolean;
    canNext: boolean;
    canNew: boolean;
    /** Only a form can show a new record, so only a form's bar has the button. */
    showNew?: boolean;
}

export interface RenderState {
    sides: RenderSideState[];
    notice?: string;
    /** Present for form views and reports only. */
    record?: RenderRecordState;
}

interface PreparedSide {
    target: RenderTarget;
    port?: number;
    action?: RenderAction;
    report?: ReportTarget;
    proxy?: FrameProxyHandle;
    origin?: string;
    ids: number[];
    error?: string;
}

async function prepareSide(target: RenderTarget, backend: RenderBackend, host: FrameHost): Promise<PreparedSide> {
    try {
        const connect = async () => {
            const port = await host.portFor(target.dbName, target.versionId);
            const proxy = await host.proxyFor(target.dbName, port, () => backend.newSession(target.dbName));
            return { port, proxy };
        };
        if (target.kind === 'report') {
            const report = await backend.reportTarget(target.dbName, target.viewId);
            if (!report) {
                return { target, ids: [], error: `${target.dbName} has no report for this template.` };
            }
            const { port, proxy } = await connect();
            const [, origin, ids] = await Promise.all([
                proxy.session(),
                host.externalOrigin(`http://127.0.0.1:${proxy.port}`),
                backend.recentIds(target.dbName, report.model, RECENT_LIMIT, report.domain)
            ]);
            return { target, port, report, proxy, origin, ids };
        }
        const action = await backend.makeAction(target.dbName, target.viewId);
        const { port, proxy } = await connect();
        const [, origin, ids] = await Promise.all([
            proxy.session(),
            host.externalOrigin(`http://127.0.0.1:${proxy.port}`),
            action.viewType === 'form' ? backend.recentIds(target.dbName, action.model, RECENT_LIMIT) : Promise.resolve([])
        ]);
        return { target, port, action, proxy, origin, ids };
    } catch (error) {
        return { target, ids: [], error: errorMessage(error) };
    }
}

type RenderMode = 'form' | 'report' | 'other';

export class RenderSession {
    /** Position in `records`; -1 is a new record. */
    private index: number;

    private constructor(
        private readonly sides: PreparedSide[],
        private readonly host: FrameHost,
        private readonly records: number[],
        private readonly mode: RenderMode,
        private readonly notice: string | undefined,
        /** Shown in place of a report's frames when there is no record to render it with. */
        private readonly noRecord: string | undefined,
        /** Report sides on different models: each shows its own newest record, with no stepping. */
        private readonly ownRecords = false
    ) {
        this.index = records.length > 0 ? 0 : -1;
    }

    static async prepare(targets: RenderTarget[], backend: RenderBackend, host: FrameHost): Promise<RenderSession> {
        const sides = await Promise.all(targets.map(target => prepareSide(target, backend, host)));
        const ready = sides.filter(side => side.action || side.report);
        const mode: RenderMode = ready.length === 0 ? 'other'
            : ready.every(side => side.report) ? 'report'
            : ready.every(side => side.action?.viewType === 'form') ? 'form' : 'other';
        let records: number[] = [];
        let notice: string | undefined;
        let noRecord: string | undefined;
        // The same id on two models names unrelated records: do not pair them.
        const ownRecords = mode === 'report' && new Set(ready.map(side => side.report?.model)).size > 1;
        if (ownRecords) {
            const models = ready.map(side => `${side.report?.model} in ${side.target.dbName}`).join(', ');
            notice = `The report renders a different model in each database (${models}); each side shows its own newest record.`;
        } else if (mode !== 'other') {
            records = ready.map(side => side.ids).reduce((a, b) => commonIds(a, b));
        }
        if (mode === 'form' && records.length === 0) {
            notice = ready.length > 1 ? NO_COMMON_RECORD : `${ready[0].action?.model} has no record yet; showing a new one.`;
        }
        if (mode === 'report' && !ownRecords && records.length === 0) {
            const model = ready[0].report?.model;
            noRecord = ready.length > 1
                ? `No ${model} record exists in both databases to render this report with.`
                : `No ${model} record to render this report with.`;
        }
        return new RenderSession(sides, host, records, mode, notice, noRecord, ownRecords);
    }

    async state(options: { debug?: boolean } = {}): Promise<RenderState> {
        const resId = this.index >= 0 ? this.records[this.index] : undefined;
        const debug = options.debug ?? true;
        const sides = await Promise.all(this.sides.map(side => this.sideState(side, this.recordOf(side), debug)));
        let record: RenderRecordState | undefined;
        if (this.mode === 'form') {
            record = {
                label: resId ? `Record ${resId}` : 'New record',
                canPrevious: this.index > 0 || (this.index === -1 && this.records.length > 0),
                canNext: this.index >= 0 && this.index < this.records.length - 1,
                canNew: this.index !== -1,
                showNew: true
            };
        } else if (this.mode === 'report' && resId !== undefined) {
            record = { label: `Record ${resId}`, canPrevious: this.index > 0, canNext: this.index < this.records.length - 1, canNew: false };
        }
        return { sides, notice: this.notice, record };
    }

    /** The newer shared record, or back from a new record to the newest. */
    previous(): boolean {
        if (this.index > 0 || (this.index === -1 && this.records.length > 0)) {
            this.index = this.index === -1 ? 0 : this.index - 1;
            return true;
        }
        return false;
    }

    /** The older shared record. */
    next(): boolean {
        if (this.index >= 0 && this.index < this.records.length - 1) {
            this.index++;
            return true;
        }
        return false;
    }

    newRecord(): boolean {
        if (this.mode !== 'form' || this.index === -1) {
            return false;
        }
        this.index = -1;
        return true;
    }

    shows(dbName: string): boolean {
        return this.sides.some(side => side.target.dbName === dbName);
    }

    /** What the PDF of the record a report side shows needs; undefined for any other side. */
    pdfSource(key: string): PdfSource | undefined {
        const side = this.sides.find(entry => entry.target.dbName === key);
        const resId = side ? this.recordOf(side) : undefined;
        if (!side?.report || !PDF_REPORT_TYPES.has(side.report.reportType) || !side.proxy || side.port === undefined || resId === undefined) {
            return undefined;
        }
        const { report, proxy } = side;
        return {
            dbName: side.target.dbName,
            port: side.port,
            path: reportPdfPath(report.reportName, resId),
            fileName: pdfFileName(side.target.dbName, report.reportName, resId),
            session: () => proxy.session()
        };
    }

    /** The record a side shows: the shared one, or its own newest when the report's models differ. */
    private recordOf(side: PreparedSide): number | undefined {
        if (this.ownRecords) {
            return side.ids[0];
        }
        return this.index >= 0 ? this.records[this.index] : undefined;
    }

    /** The server ports the sides point at, for waiting on a start. */
    ports(): number[] {
        return this.sides.flatMap(side => side.port === undefined ? [] : [side.port]);
    }

    private async sideState(side: PreparedSide, resId: number | undefined, debug: boolean): Promise<RenderSideState> {
        const base = { key: side.target.dbName, title: side.target.title };
        if (side.report) {
            const { report, proxy, port, origin } = side;
            if (!proxy || port === undefined || !origin) {
                return { ...base, message: side.error ?? 'This side cannot render.' };
            }
            const detail = `Odoo ${report.series} · ${report.name}${resId ? ` · record ${resId}` : ''}`;
            if (resId === undefined) {
                return { ...base, detail, message: this.noRecord ?? `No ${report.model} record to render this report with.` };
            }
            if (!await this.host.isPortOpen(port)) {
                return { ...base, detail, message: `No Odoo server is answering on port ${port}.`, offerStart: true };
            }
            const url = `${origin}${proxy.gatePath(reportPath(report.reportName, resId, debug))}`;
            return { ...base, detail, url, ...(PDF_REPORT_TYPES.has(report.reportType) ? { pdf: true } : {}) };
        }
        const { action, proxy, port, origin } = side;
        if (side.error || !action || !proxy || port === undefined || !origin) {
            return { ...base, message: side.error ?? 'This side cannot render.' };
        }
        const what = action.viewType === 'form' ? (resId ? `record ${resId}` : 'new record') : action.viewType;
        const detail = `Odoo ${action.series} · ${action.model} · ${what}`;
        if (!await this.host.isPortOpen(port)) {
            return { ...base, detail, message: `No Odoo server is answering on port ${port}.`, offerStart: true };
        }
        const path = framePath({ series: action.series, actionId: action.actionId, model: action.model, viewType: action.viewType, resId, debug });
        return { ...base, detail, url: `${origin}${proxy.gatePath(path)}` };
    }
}
