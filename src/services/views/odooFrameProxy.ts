/**
 * A reverse proxy to one database's Odoo server, for the render tab's frames.
 *
 * A webview's origin is never the same site as the server, so Odoo's own
 * session cookie cannot work there: the proxy injects an admin session the
 * database's shell minted instead, strips the headers that forbid framing,
 * and hides Odoo's session cookie from the frame. Host passes through, so
 * Odoo builds its URLs on the proxy's origin.
 *
 * That makes the proxy admin for anyone who reaches its port, so it is
 * gated: the frame's first URL carries a one-time token, answered with a
 * cookie only VS Code's webview ever holds, and every request or websocket
 * without that cookie is refused before anything is forwarded. A websocket or
 * a write that names a foreign Origin is refused too, cookie or not. The cookie is
 * named after the proxy's port, because cookies ignore ports and the two
 * sides' proxies share 127.0.0.1.
 */
import * as http from 'node:http';
import * as net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const GATE_PATH = '/__odt/open';

export interface FrameProxyOptions {
    /** The port of the Odoo server that serves the database. */
    targetPort: number;
    /** An admin session id on the database; called again when Odoo stops accepting the current one. */
    mintSession(): Promise<string>;
    /** At most one new session per this interval after a refusal. Default 30 s. */
    refreshIntervalMs?: number;
    /** How long a gate URL stays valid without the cookie. Default 2 min. */
    tokenTtlMs?: number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 30_000;
const DEFAULT_TOKEN_TTL_MS = 120_000;
const MAX_HANDSHAKE_HEAD = 64 * 1024;
const LOOPBACK_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?(?=[/?#]|$)/i;

/** A redirect to the backend's own loopback origin, as a path; anything else as is. */
export function rewriteLocation(location: string, targetPort: number): string {
    const match = LOOPBACK_ORIGIN.exec(location);
    if (!match || Number(match[1] ?? 80) !== targetPort) {
        return location;
    }
    const rest = location.slice(match[0].length);
    return rest.startsWith('/') ? rest : `/${rest}`;
}

/** The policy without frame-ancestors; undefined when nothing else is left. */
export function withoutFrameAncestors(csp: string): string | undefined {
    const kept = csp.split(';').map(part => part.trim()).filter(part => part && !/^frame-ancestors\b/i.test(part));
    return kept.length > 0 ? kept.join('; ') : undefined;
}

/** The browser's cookies minus its own session and every gate, plus the injected session. */
export function forwardedCookie(header: string | undefined, sid: string): string {
    const kept = (header ?? '').split(';').map(part => part.trim())
        .filter(part => part && !/^session_id=/i.test(part) && !/^odt_gate_\d+=/i.test(part));
    return [...kept, `session_id=${sid}`].join('; ');
}

function cookieValues(header: string | undefined, name: string): string[] {
    const values: string[] = [];
    for (const part of (header ?? '').split(';')) {
        const [key, ...value] = part.trim().split('=');
        if (key === name) {
            values.push(value.join('='));
        }
    }
    return values;
}

/** The response head without Odoo's session cookie lines; the session it set, if any. */
export function filterHandshakeHead(head: string): { head: string; sid?: string } {
    let sid: string | undefined;
    const lines = head.split('\r\n').filter(line => {
        const match = /^set-cookie:\s*session_id=([^;]*)/i.exec(line);
        if (match && match[1]) {
            sid = match[1];
        }
        return !match;
    });
    return { head: lines.join('\r\n'), sid };
}

/** A request from a page that is not this proxy's own origin. */
function foreignOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) {
        return false;
    }
    try {
        return new URL(origin).host !== req.headers.host;
    } catch {
        return true;
    }
}

function sameSecret(candidate: string | undefined, secret: string): boolean {
    if (candidate === undefined) {
        return false;
    }
    const given = Buffer.from(candidate, 'utf-8');
    const expected = Buffer.from(secret, 'utf-8');
    return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A path on this origin: not protocol-relative, not a backslash trick, not absolute. */
function isLocalPath(next: string): boolean {
    if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\') || /[\u0000-\u001f\u007f]/.test(next)) {
        return false;
    }
    try {
        return new URL(next, 'http://proxy').origin === 'http://proxy';
    } catch {
        return false;
    }
}

function plain(res: http.ServerResponse, status: number, text: string): void {
    if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    }
    res.end(text);
}

const REFUSED = 'This address only opens from the View Doctor in VS Code.';

export class OdooFrameProxy {
    private readonly server: http.Server;
    private readonly secret = randomBytes(32).toString('hex');
    private readonly tokens = new Map<string, number>();
    private readonly sockets = new Set<net.Socket>();
    private sid: string | undefined;
    private minting: Promise<string> | undefined;
    private lastRefresh = Number.NEGATIVE_INFINITY;
    private listening: Promise<number> | undefined;
    private boundPort = 0;
    private closed = false;

    constructor(private readonly options: FrameProxyOptions) {
        this.server = http.createServer((req, res) => {
            this.handle(req, res).catch(() => res.destroy());
        });
        this.server.on('connection', socket => this.track(socket));
        this.server.on('upgrade', (req, socket, head) => {
            this.upgrade(req, socket as net.Socket, head).catch(() => socket.destroy());
        });
    }

    get targetPort(): number {
        return this.options.targetPort;
    }

    get port(): number {
        return this.boundPort;
    }

    private get gateCookie(): string {
        return `odt_gate_${this.boundPort}`;
    }

    listen(): Promise<number> {
        this.listening ??= new Promise<number>((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => {
                this.server.off('error', reject);
                this.server.on('error', () => undefined);
                this.boundPort = (this.server.address() as net.AddressInfo).port;
                resolve(this.boundPort);
            });
        });
        return this.listening;
    }

    /** The session to inject, minted on first use; call it early to surface a failure. */
    session(): Promise<string> {
        if (this.sid) {
            return Promise.resolve(this.sid);
        }
        this.minting ??= this.options.mintSession()
            .then(sid => {
                this.sid = sid;
                return sid;
            })
            .finally(() => {
                this.minting = undefined;
            });
        return this.minting;
    }

    /** A frame's first URL path: the token works once, and sends the frame on to `next`. */
    gatePath(next: string): string {
        const token = randomBytes(24).toString('hex');
        const now = Date.now();
        for (const [spent, expiry] of this.tokens) {
            if (expiry <= now) {
                this.tokens.delete(spent);
            }
        }
        this.tokens.set(token, now + (this.options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS));
        return `${GATE_PATH}?t=${token}&next=${encodeURIComponent(next)}`;
    }

    /** Stops listening and ends every open connection, websockets included. */
    close(): Promise<void> {
        this.closed = true;
        for (const socket of this.sockets) {
            socket.destroy();
        }
        return new Promise<void>(resolve => this.server.close(() => resolve()));
    }

    private track(socket: net.Socket): void {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
    }

    private gated(cookie: string | undefined): boolean {
        return cookieValues(cookie, this.gateCookie).some(value => sameSecret(value, this.secret));
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        let url: URL;
        try {
            url = new URL(req.url ?? '/', 'http://proxy');
        } catch {
            req.resume();
            plain(res, 400, 'Bad request.');
            return;
        }
        const gated = this.gated(req.headers.cookie);
        if (url.pathname === GATE_PATH) {
            req.resume();
            this.open(url, gated, res);
            return;
        }
        if (!gated) {
            req.resume();
            plain(res, 403, REFUSED);
            return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD' && foreignOrigin(req)) {
            req.resume();
            plain(res, 403, REFUSED);
            return;
        }
        let sid: string;
        try {
            sid = await this.session();
        } catch (error) {
            req.resume();
            plain(res, 502, `Could not open an Odoo session: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        if (this.closed || res.destroyed) {
            req.resume();
            return;
        }
        const upstream = http.request({
            host: '127.0.0.1',
            port: this.options.targetPort,
            method: req.method,
            path: req.url,
            headers: { ...req.headers, cookie: forwardedCookie(req.headers.cookie, sid) }
        }, up => {
            if (this.refusedSession(req, up)) {
                up.resume();
                this.retry(req, res, sid).catch(() => res.destroy());
                return;
            }
            res.writeHead(up.statusCode ?? 502, this.responseHeaders(up.headers));
            up.pipe(res);
        });
        upstream.on('error', error => {
            if (res.headersSent) {
                res.destroy();
            } else {
                plain(res, 502, `No Odoo server answers on port ${this.options.targetPort}: ${error.message}`);
            }
        });
        res.on('close', () => {
            if (!res.writableFinished) {
                upstream.destroy();
            }
        });
        req.pipe(upstream);
    }

    private open(url: URL, gated: boolean, res: http.ServerResponse): void {
        const token = url.searchParams.get('t') ?? '';
        const next = url.searchParams.get('next') ?? '/';
        // A spent token still opens for the frame that holds the cookie: that is a reload.
        const expiry = this.tokens.get(token);
        this.tokens.delete(token);
        const allowed = (expiry !== undefined && expiry > Date.now()) || gated;
        if (!allowed || !isLocalPath(next)) {
            plain(res, 403, REFUSED);
            return;
        }
        // Every (re)load of a frame passes here. From 19.0 the web client keeps
        // get_views in IndexedDB and shows that copy first, so a reload after
        // a save would show the arch from before it. Clearing the frame's
        // storage (not its cookies) makes it ask Odoo again.
        res.writeHead(302, {
            location: next,
            'set-cookie': `${this.gateCookie}=${this.secret}; Path=/; HttpOnly; Secure; SameSite=None`,
            'clear-site-data': '"storage"',
            'cache-control': 'no-store'
        });
        res.end();
    }

    /** Odoo turned the session away on a page load: worth one new session, now and then. */
    private refusedSession(req: http.IncomingMessage, up: http.IncomingMessage): boolean {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return false;
        }
        if (Date.now() - this.lastRefresh < (this.options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS)) {
            return false;
        }
        const status = up.statusCode ?? 0;
        if (status === 401) {
            return true;
        }
        const location = up.headers.location;
        if (status < 300 || status >= 400 || !location) {
            return false;
        }
        try {
            return new URL(location, 'http://proxy').pathname === '/web/login';
        } catch {
            return false;
        }
    }

    private async retry(req: http.IncomingMessage, res: http.ServerResponse, refused: string): Promise<void> {
        this.lastRefresh = Date.now();
        if (this.sid === refused) {
            this.sid = undefined;
        }
        try {
            await this.session();
        } catch (error) {
            plain(res, 502, `Could not open an Odoo session: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        if (res.destroyed) {
            return;
        }
        try {
            res.writeHead(302, { location: req.url ?? '/', 'cache-control': 'no-store' });
        } catch {
            res.destroy();
            return;
        }
        res.end();
    }

    private responseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
        const out: http.OutgoingHttpHeaders = { ...headers };
        delete out['x-frame-options'];
        const csp = headers['content-security-policy'];
        if (csp !== undefined) {
            const kept = withoutFrameAncestors(String(csp));
            if (kept) {
                out['content-security-policy'] = kept;
            } else {
                delete out['content-security-policy'];
            }
        }
        const cookies = headers['set-cookie'];
        if (cookies) {
            const kept = cookies.filter(cookie => {
                const match = /^\s*session_id=([^;]*)/i.exec(cookie);
                if (!match) {
                    return true;
                }
                // Odoo rotated the session: keep injecting the one it now expects.
                if (match[1]) {
                    this.sid = match[1];
                }
                return false;
            });
            if (kept.length > 0) {
                out['set-cookie'] = kept;
            } else {
                delete out['set-cookie'];
            }
        }
        if (typeof headers.location === 'string') {
            out.location = rewriteLocation(headers.location, this.options.targetPort);
        }
        return out;
    }

    private async upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
        socket.on('error', () => undefined);
        if (!this.gated(req.headers.cookie) || foreignOrigin(req)) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            return;
        }
        let sid: string;
        try {
            sid = await this.session();
        } catch {
            socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            return;
        }
        if (this.closed || socket.destroyed) {
            socket.destroy();
            return;
        }
        const upstream = net.connect(this.options.targetPort, '127.0.0.1', () => {
            const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                if (req.rawHeaders[i].toLowerCase() !== 'cookie') {
                    lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
                }
            }
            lines.push(`Cookie: ${forwardedCookie(req.headers.cookie, sid)}`);
            upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
            if (head.length > 0) {
                upstream.write(head);
            }
            socket.pipe(upstream);
            this.relayHandshake(upstream, socket);
        });
        this.track(upstream);
        upstream.on('error', () => socket.destroy());
        socket.on('close', () => upstream.destroy());
    }

    /** Odoo's answer to the frame, minus its session cookie, then the rest as is. */
    private relayHandshake(upstream: net.Socket, socket: net.Socket): void {
        let buffered = Buffer.alloc(0);
        const onData = (chunk: Buffer): void => {
            buffered = Buffer.concat([buffered, chunk]);
            const end = buffered.indexOf('\r\n\r\n');
            if (end < 0) {
                if (buffered.length > MAX_HANDSHAKE_HEAD) {
                    socket.destroy();
                }
                return;
            }
            upstream.off('data', onData);
            const { head, sid } = filterHandshakeHead(buffered.subarray(0, end + 4).toString('latin1'));
            if (sid) {
                this.sid = sid;
            }
            socket.write(Buffer.from(head, 'latin1'));
            if (buffered.length > end + 4) {
                socket.write(buffered.subarray(end + 4));
            }
            upstream.pipe(socket);
        };
        upstream.on('data', onData);
    }
}
