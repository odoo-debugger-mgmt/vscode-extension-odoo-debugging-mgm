/**
 * The render tab: one or two Odoo web clients side by side, each in a frame
 * behind its database's gated proxy. The page is rebuilt whenever what it
 * shows changes; a save reloads the frames of its database by message, so
 * the other side keeps whatever the user was doing in it.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { OdooFrameProxy } from '../services/views/odooFrameProxy';
import { RenderSession, type FrameHost, type RenderBackend, type RenderState, type RenderTarget } from '../services/views/renderSession';
import { isPortOpen, resolvePortForDatabase, waitForPort } from '../services/server';
import { errorMessage, logger } from '../services/logger';
import { showError, showWarning } from '../services/notifications';

export interface RenderRequest {
    title: string;
    /** The original side first. */
    targets: RenderTarget[];
    /** What a side with no server offers to run. */
    startCommand: string;
    /** The label of the button that runs it. */
    startLabel: string;
    notice?: string;
}

export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

const STYLE = `
body { margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.toolbar .notice { color: var(--vscode-descriptionForeground); }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 10px; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
.sides { flex: 1; display: flex; min-height: 0; }
.side { flex: 1; display: flex; flex-direction: column; min-width: 0; border-right: 1px solid var(--vscode-panel-border); }
.side:last-child { border-right: none; }
.side header { padding: 4px 8px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.side header .detail { color: var(--vscode-descriptionForeground); }
.side .message { color: var(--vscode-errorForeground); }
iframe { flex: 1; width: 100%; border: none; background: #fff; }
.empty { flex: 1; display: flex; align-items: center; justify-content: center; padding: 16px; color: var(--vscode-descriptionForeground); text-align: center; }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
for (const button of document.querySelectorAll('button[data-action]')) {
    button.addEventListener('click', () => vscode.postMessage({ type: 'action', action: button.dataset.action }));
}
window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.type !== 'reload') {
        return;
    }
    for (const frame of document.querySelectorAll('iframe[data-key]')) {
        if (!message.keys || message.keys.includes(frame.dataset.key)) {
            frame.src = frame.dataset.src;
        }
    }
});
`;

function button(action: string, label: string, enabled = true): string {
    return `<button data-action="${action}"${enabled ? '' : ' disabled'}>${escapeHtml(label)}</button>`;
}

export function renderPanelHtml(state: RenderState, options: { nonce: string; cspSource: string; startLabel?: string }): string {
    const origins = [...new Set(state.sides.flatMap(side => side.url ? [new URL(side.url).origin] : []))];
    const csp = [
        "default-src 'none'",
        ...(origins.length > 0 ? [`frame-src ${origins.join(' ')}`] : []),
        `style-src ${options.cspSource} 'nonce-${options.nonce}'`,
        `script-src 'nonce-${options.nonce}'`
    ].join('; ') + ';';
    const record = state.record;
    const toolbar = [
        button('reload', 'Reload'),
        ...(record ? [
            button('previous', 'Previous record', record.canPrevious),
            `<span>${escapeHtml(record.label)}</span>`,
            button('next', 'Next record', record.canNext),
            button('new', 'New record', record.canNew)
        ] : []),
        ...(state.notice ? [`<span class="notice">${escapeHtml(state.notice)}</span>`] : [])
    ].join('\n');
    const sides = state.sides.map(side => {
        const header = [
            `<strong>${escapeHtml(side.title)}</strong>`,
            ...(side.detail ? [`<span class="detail">${escapeHtml(side.detail)}</span>`] : []),
            ...(side.url && side.message ? [`<span class="message">${escapeHtml(side.message)}</span>`] : []),
            ...(side.offerStart ? [button('start', options.startLabel ?? 'Start Server')] : [])
        ].join(' ');
        const body = side.url
            ? `<iframe data-key="${escapeHtml(side.key)}" data-src="${escapeHtml(side.url)}" src="${escapeHtml(side.url)}"></iframe>`
            : `<div class="empty">${escapeHtml(side.message ?? 'Nothing to show.')}</div>`;
        return `<section class="side"><header>${header}</header>${body}</section>`;
    }).join('\n');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${options.nonce}">${STYLE}</style>
</head>
<body>
<div class="toolbar">${toolbar}</div>
<div class="sides">${sides}</div>
<script nonce="${options.nonce}">${SCRIPT}</script>
</body>
</html>`;
}

export class ViewRenderPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private session: RenderSession | undefined;
    private request: RenderRequest | undefined;
    private readonly proxies = new Map<string, Promise<OdooFrameProxy>>();
    private readonly host: FrameHost;
    /** Bumped by every show() and every close, so a slower earlier one can tell it is stale. */
    private generation = 0;
    private updates = 0;
    private starting = false;

    constructor(private readonly backend: RenderBackend, host?: FrameHost) {
        this.host = host ?? {
            portFor: async (dbName, versionId) => (await resolvePortForDatabase(dbName, versionId)).port,
            isPortOpen,
            proxyFor: (dbName, port, mint) => this.proxyFor(dbName, port, mint),
            externalOrigin: async origin => {
                const uri = await vscode.env.asExternalUri(vscode.Uri.parse(origin));
                return `${uri.scheme}://${uri.authority}`;
            }
        };
    }

    get isOpen(): boolean {
        return !!this.panel;
    }

    get title(): string | undefined {
        return this.request?.title;
    }

    async show(request: RenderRequest): Promise<void> {
        const generation = ++this.generation;
        const session = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Preparing the render of ${request.title}…` },
            () => RenderSession.prepare(request.targets, this.backend, this.host)
        );
        if (generation !== this.generation) {
            return;
        }
        this.session = session;
        this.request = request;
        const panel = this.ensurePanel();
        panel.title = `Render: ${request.title}`;
        await this.update();
        if (generation !== this.generation) {
            return;
        }
        panel.reveal(undefined, false);
    }

    /** A save in this database: its frames load the new arch. */
    reloadDatabase(dbName: string): void {
        if (this.panel && this.session?.shows(dbName)) {
            void this.panel.webview.postMessage({ type: 'reload', keys: [dbName] });
        }
    }

    /**
     * The toolbar's Reload: the page is rebuilt, which reloads every frame
     * and asks again which servers answer, so a side whose server stopped
     * says so and offers to start it, and one that came back shows again.
     */
    async reload(): Promise<void> {
        await this.update();
    }

    dispose(): void {
        const panel = this.panel;
        this.generation++;
        this.panel = undefined;
        this.session = undefined;
        this.request = undefined;
        panel?.dispose();
        void this.closeProxies();
    }

    private ensurePanel(): vscode.WebviewPanel {
        if (this.panel) {
            return this.panel;
        }
        const panel = vscode.window.createWebviewPanel('odooViewRender', 'Render', vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: []
        });
        panel.onDidDispose(() => {
            this.generation++;
            this.panel = undefined;
            this.session = undefined;
            this.request = undefined;
            void this.closeProxies();
        });
        panel.webview.onDidReceiveMessage(message => void this.onMessage(message));
        this.panel = panel;
        return panel;
    }

    private async update(): Promise<void> {
        const panel = this.panel;
        const session = this.session;
        if (!panel || !session) {
            return;
        }
        const update = ++this.updates;
        const state = await session.state();
        if (update !== this.updates || this.panel !== panel || this.session !== session) {
            return;
        }
        const notice = [this.request?.notice, state.notice].filter(Boolean).join(' ');
        panel.webview.html = renderPanelHtml({ ...state, notice: notice || undefined }, {
            nonce: randomBytes(16).toString('base64'),
            cspSource: panel.webview.cspSource,
            startLabel: this.request?.startLabel
        });
    }

    private async onMessage(message: unknown): Promise<void> {
        const action = (message as { type?: string; action?: string } | undefined)?.type === 'action'
            ? (message as { action?: string }).action
            : undefined;
        const session = this.session;
        if (!session || !action) {
            return;
        }
        try {
            switch (action) {
                case 'reload':
                    await this.reload();
                    return;
                case 'previous':
                    if (session.previous()) {
                        await this.update();
                    }
                    return;
                case 'next':
                    if (session.next()) {
                        await this.update();
                    }
                    return;
                case 'new':
                    if (session.newRecord()) {
                        await this.update();
                    }
                    return;
                case 'start':
                    await this.startServers(session);
                    return;
            }
        } catch (error) {
            logger.warn('The render tab could not handle an action:', error);
            void showError(`The render could not ${action}: ${errorMessage(error)}`);
        }
    }

    private async startServers(session: RenderSession): Promise<void> {
        if (!this.request || this.starting) {
            return;
        }
        this.starting = true;
        try {
            await vscode.commands.executeCommand(this.request.startCommand);
            const ports = session.ports();
            const answered = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Waiting for the Odoo servers…', cancellable: true },
                (_progress, token) => new Promise<boolean[]>(resolve => {
                    token.onCancellationRequested(() => resolve(ports.map(() => true)));
                    void Promise.all(ports.map(port => waitForPort(port, 120_000))).then(resolve);
                })
            );
            const silent = ports.filter((_port, index) => !answered[index]);
            if (silent.length > 0) {
                void showWarning(`No Odoo server is answering on port ${silent.join(', ')} yet.`);
            }
            if (this.session === session) {
                await this.update();
            }
        } finally {
            this.starting = false;
        }
    }

    private proxyFor(dbName: string, port: number, mint: () => Promise<string>): Promise<OdooFrameProxy> {
        const key = `${dbName}:${port}`;
        let proxy = this.proxies.get(key);
        if (!proxy) {
            const created = new OdooFrameProxy({ targetPort: port, mintSession: mint });
            proxy = created.listen().then(() => created);
            const pending = proxy;
            proxy.catch(() => {
                if (this.proxies.get(key) === pending) {
                    this.proxies.delete(key);
                }
            });
            this.proxies.set(key, proxy);
        }
        return proxy;
    }

    private async closeProxies(): Promise<void> {
        const proxies = [...this.proxies.values()];
        this.proxies.clear();
        await Promise.all(proxies.map(async proxy => (await proxy.catch(() => undefined))?.close()));
    }
}
