import * as assert from 'assert';
import * as http from 'node:http';
import * as net from 'node:net';
import { OdooFrameProxy, filterHandshakeHead, forwardedCookie, rewriteLocation, withoutFrameAncestors } from '../services/views/odooFrameProxy';

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, path: string, options: { cookie?: string; method?: string } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.cookie ? { cookie: options.cookie } : {} }, res => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

/** The gate cookie a proxy hands out, as a Cookie header value. */
async function openGate(proxy: OdooFrameProxy, next = '/odoo'): Promise<string> {
    const reply = await request(proxy.port, proxy.gatePath(next));
    assert.strictEqual(reply.status, 302);
    return String(reply.headers['set-cookie']?.[0]).split(';')[0];
}

/** A raw upgrade request; resolves with what came back up to the end of the head, or when the socket closes. */
function upgradeRaw(port: number, headers: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
            socket.write(`GET /websocket HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${headers.map(line => `${line}\r\n`).join('')}\r\n`);
        });
        let received = '';
        socket.setEncoding('utf-8');
        socket.setTimeout(2000, () => { socket.destroy(); reject(new Error(`no answer: ${received}`)); });
        const done = () => { socket.destroy(); resolve(received); };
        socket.on('data', chunk => { received += chunk; if (received.includes('\r\n\r\n')) { done(); } });
        socket.on('close', done);
        socket.on('error', reject);
    });
}

suite('Odoo frame proxy', () => {
    let upstream: http.Server;
    let upstreamPort: number;
    let seen: http.IncomingHttpHeaders[];
    let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void;
    let proxies: OdooFrameProxy[];
    let mints: number;
    let upgradeHead: string;

    const makeProxy = async (sids: string[] = ['sid-1', 'sid-2', 'sid-3'], options: { refreshIntervalMs?: number; targetPort?: number; tokenTtlMs?: number; mint?: () => Promise<string> } = {}) => {
        const proxy = new OdooFrameProxy({
            targetPort: options.targetPort ?? upstreamPort,
            mintSession: options.mint ?? (async () => sids[Math.min(mints++, sids.length - 1)]),
            refreshIntervalMs: options.refreshIntervalMs,
            tokenTtlMs: options.tokenTtlMs
        });
        proxies.push(proxy);
        await proxy.listen();
        return proxy;
    };

    setup(async () => {
        seen = [];
        mints = 0;
        upgradeHead = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n';
        proxies = [];
        respond = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('odoo'); };
        upstream = http.createServer((req, res) => { seen.push(req.headers); respond(req, res); });
        upstream.on('upgrade', (req, socket) => {
            seen.push(req.headers);
            socket.write(upgradeHead);
            socket.pipe(socket);
        });
        await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
        upstreamPort = (upstream.address() as net.AddressInfo).port;
    });

    teardown(async () => {
        await Promise.all(proxies.map(proxy => proxy.close()));
        upstream.closeAllConnections?.();
        await new Promise<void>(resolve => upstream.close(() => resolve()));
    });

    test('refuses everything without the gate cookie, and injects nothing', async () => {
        const proxy = await makeProxy();
        const reply = await request(proxy.port, '/web', { cookie: 'session_id=stolen' });
        assert.strictEqual(reply.status, 403);
        assert.strictEqual(seen.length, 0);
        assert.strictEqual(mints, 0);
    });

    test('the gate opens once, then again only with its cookie', async () => {
        const proxy = await makeProxy();
        const gate = proxy.gatePath('/odoo/action-5/7?debug=1');
        const first = await request(proxy.port, gate);
        assert.strictEqual(first.status, 302);
        assert.strictEqual(first.headers.location, '/odoo/action-5/7?debug=1');
        const cookie = String(first.headers['set-cookie']?.[0]);
        assert.match(cookie, new RegExp(`^odt_gate_${proxy.port}=[0-9a-f]{64}; Path=/; HttpOnly; Secure; SameSite=None$`));
        // Replayed by anything else: the token is spent.
        assert.strictEqual((await request(proxy.port, gate)).status, 403);
        // A frame reloading its src carries the cookie, and lands on the page again.
        assert.strictEqual((await request(proxy.port, gate, { cookie: cookie.split(';')[0] })).status, 302);
        assert.strictEqual(seen.length, 0, 'the gate itself never reaches Odoo');
    });

    test('a gate that leads off this origin is refused', async () => {
        const proxy = await makeProxy();
        for (const next of ['//evil.example/', 'https://evil.example/', '/\\evil.example', 'odoo']) {
            assert.strictEqual((await request(proxy.port, proxy.gatePath(next))).status, 403, next);
        }
    });

    test('a gate cookie for another proxy opens nothing', async () => {
        const first = await makeProxy();
        const second = await makeProxy();
        const firstCookie = await openGate(first);
        assert.strictEqual((await request(second.port, '/odoo', { cookie: firstCookie })).status, 403);
        const secondCookie = await openGate(second);
        // Both cookies reach both proxies (cookies ignore ports): each still opens only its own.
        assert.strictEqual((await request(first.port, '/odoo', { cookie: `${firstCookie}; ${secondCookie}` })).status, 200);
        assert.strictEqual((await request(second.port, '/odoo', { cookie: `${firstCookie}; ${secondCookie}` })).status, 200);
    });

    test('injects the session in place of the browser\'s own, keeps other cookies, hides the gate from Odoo', async () => {
        const proxy = await makeProxy();
        const gate = await openGate(proxy);
        const reply = await request(proxy.port, '/odoo', { cookie: `session_id=browser; cids=1; ${gate}` });
        assert.strictEqual(reply.status, 200);
        assert.strictEqual(seen[0].cookie, 'cids=1; session_id=sid-1');
        assert.strictEqual(seen[0].host, `127.0.0.1:${proxy.port}`, 'Host passes through, so Odoo builds URLs on the proxy');
    });

    test('strips the framing headers and Odoo\'s session cookie, following a rotation', async () => {
        respond = (_req, res) => {
            res.writeHead(200, {
                'x-frame-options': 'DENY',
                'content-security-policy': "frame-ancestors 'self'; default-src 'self'",
                'set-cookie': ['session_id=rotated; Path=/; HttpOnly', 'tz=UTC; Path=/']
            });
            res.end('odoo');
        };
        const proxy = await makeProxy();
        const gate = await openGate(proxy);
        const reply = await request(proxy.port, '/odoo', { cookie: gate });
        assert.strictEqual(reply.headers['x-frame-options'], undefined);
        assert.strictEqual(reply.headers['content-security-policy'], "default-src 'self'");
        assert.deepStrictEqual(reply.headers['set-cookie'], ['tz=UTC; Path=/']);
        await request(proxy.port, '/odoo', { cookie: gate });
        assert.strictEqual(seen[1].cookie, 'session_id=rotated');
    });

    test('a redirect to the backend\'s own address becomes a path', async () => {
        respond = (_req, res) => { res.writeHead(303, { location: `http://localhost:${upstreamPort}/odoo/discuss?x=1` }); res.end(); };
        const proxy = await makeProxy();
        const reply = await request(proxy.port, '/web', { cookie: await openGate(proxy) });
        assert.strictEqual(reply.headers.location, '/odoo/discuss?x=1');
        assert.strictEqual(rewriteLocation('http://example.com/odoo', upstreamPort), 'http://example.com/odoo');
        assert.strictEqual(rewriteLocation(`http://127.0.0.1:${upstreamPort}`, upstreamPort), '/');
        assert.strictEqual(rewriteLocation(`http://127.0.0.1:${upstreamPort + 1}/x`, upstreamPort), `http://127.0.0.1:${upstreamPort + 1}/x`);
    });

    test('a refused session is minted again once, then passes through', async () => {
        let accepted = 'sid-2';
        respond = (req, res) => {
            if (String(req.headers.cookie).includes(`session_id=${accepted}`)) {
                res.writeHead(200);
                res.end('in');
            } else {
                res.writeHead(303, { location: '/web/login?redirect=%2Fodoo' });
                res.end();
            }
        };
        const proxy = await makeProxy();
        const gate = await openGate(proxy);
        const retry = await request(proxy.port, '/odoo?debug=1', { cookie: gate });
        assert.deepStrictEqual([retry.status, retry.headers.location], [302, '/odoo?debug=1']);
        assert.strictEqual((await request(proxy.port, '/odoo?debug=1', { cookie: gate })).body, 'in');
        assert.strictEqual(mints, 2);

        // A server that refuses every session: one more mint, then Odoo's answer as is.
        accepted = 'never';
        assert.strictEqual((await request(proxy.port, '/odoo', { cookie: gate })).status, 303);
        assert.strictEqual(mints, 2, 'no second refresh within the interval');
    });

    test('a refused POST is not retried', async () => {
        respond = (_req, res) => { res.writeHead(401); res.end(); };
        const proxy = await makeProxy();
        const gate = await openGate(proxy);
        assert.strictEqual((await request(proxy.port, '/web/dataset/call_kw', { cookie: gate, method: 'POST' })).status, 401);
        assert.strictEqual(mints, 1);
    });

    test('pipes a websocket upgrade with the session, and refuses one without the gate', async () => {
        const proxy = await makeProxy();
        const gate = await openGate(proxy);
        const talk = (cookie: string) => new Promise<string>((resolve, reject) => {
            const socket = net.connect(proxy.port, '127.0.0.1', () => {
                socket.write(`GET /websocket HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${cookie ? `Cookie: ${cookie}\r\n` : ''}\r\n`);
            });
            let received = '';
            socket.setEncoding('utf-8');
            socket.on('data', chunk => {
                received += chunk;
                if (received.includes('\r\n\r\n') && received.startsWith('HTTP/1.1 101') && !received.includes('ping')) {
                    socket.write('ping');
                }
                if (received.includes('ping') || received.startsWith('HTTP/1.1 403')) {
                    socket.destroy();
                    resolve(received);
                }
            });
            socket.on('error', reject);
        });
        const piped = await talk(gate);
        assert.ok(piped.startsWith('HTTP/1.1 101') && piped.endsWith('ping'), piped);
        assert.strictEqual(seen[0].cookie, 'session_id=sid-1');
        assert.ok((await talk('')).startsWith('HTTP/1.1 403'));
        assert.strictEqual(seen.length, 1);
    });

    test('says so when no server answers, or when no session can be minted', async () => {
        const closed = await new Promise<number>(resolve => {
            const probe = net.createServer().listen(0, '127.0.0.1', () => {
                const { port } = probe.address() as net.AddressInfo;
                probe.close(() => resolve(port));
            });
        });
        const dead = await makeProxy(undefined, { targetPort: closed });
        const reply = await request(dead.port, '/odoo', { cookie: await openGate(dead) });
        assert.strictEqual(reply.status, 502);
        assert.ok(reply.body.includes(String(closed)), reply.body);

        const failing = new OdooFrameProxy({ targetPort: upstreamPort, mintSession: async () => { throw new Error('no admin'); } });
        proxies.push(failing);
        await failing.listen();
        await assert.rejects(failing.session(), /no admin/);
        const refused = await request(failing.port, '/odoo', { cookie: await openGate(failing) });
        assert.strictEqual(refused.status, 502);
        assert.ok(refused.body.includes('no admin'));
    });

    test('an odd request target gets an answer, never an unhandled rejection', async () => {
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown) => rejections.push(reason);
        process.on('unhandledRejection', onRejection);
        try {
            const proxy = await makeProxy();
            const answer = await new Promise<string>((resolve, reject) => {
                const socket = net.connect(proxy.port, '127.0.0.1', () => socket.write('GET // HTTP/1.1\r\nHost: x\r\n\r\n'));
                let received = '';
                socket.setEncoding('utf-8');
                socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('no answer')); });
                socket.on('data', chunk => { received += chunk; if (received.includes('\r\n\r\n')) { socket.destroy(); resolve(received); } });
                socket.on('error', reject);
            });
            assert.match(answer, /^HTTP\/1\.1 (400|403)/);
            await new Promise(resolve => setTimeout(resolve, 50));
            assert.deepStrictEqual(rejections, []);
            assert.strictEqual(seen.length, 0);
        } finally {
            process.off('unhandledRejection', onRejection);
        }
    });

    test('a foreign Origin is refused on upgrades and writes, even with the gate, but not on navigations', async () => {
        const proxy = await makeProxy();
        const gate = await openGate(proxy);
        assert.ok((await upgradeRaw(proxy.port, [`Cookie: ${gate}`, 'Origin: http://evil.example'])).startsWith('HTTP/1.1 403'));
        assert.ok((await upgradeRaw(proxy.port, [`Cookie: ${gate}`, 'Origin: null'])).startsWith('HTTP/1.1 403'));
        assert.strictEqual(seen.length, 0);
        assert.ok((await upgradeRaw(proxy.port, [`Cookie: ${gate}`, `Origin: http://127.0.0.1:${proxy.port}`])).startsWith('HTTP/1.1 101'));
        const post = (origin: string, method: string) => new Promise<number>((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port: proxy.port, path: '/web/dataset/call_kw', method, headers: { cookie: gate, origin } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
            req.on('error', reject);
            req.end();
        });
        const before = seen.length;
        assert.strictEqual(await post('http://evil.example', 'POST'), 403);
        assert.strictEqual(seen.length, before);
        assert.strictEqual(await post(`http://127.0.0.1:${proxy.port}`, 'POST'), 200);
        assert.strictEqual(await post('http://evil.example', 'GET'), 200);
    });

    test('the websocket handshake does not hand Odoo\'s session cookie to the frame', async () => {
        upgradeHead = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSet-Cookie: SESSION_ID=rotated-ws; Path=/\r\nSet-Cookie: tz=UTC; Path=/\r\nConnection: Upgrade\r\n\r\n';
        const proxy = await makeProxy();
        const gate = await openGate(proxy);
        const head = await upgradeRaw(proxy.port, [`Cookie: ${gate}`]);
        assert.ok(head.startsWith('HTTP/1.1 101'), head);
        assert.ok(!/session_id/i.test(head), head);
        assert.ok(head.includes('Set-Cookie: tz=UTC'), head);
        await request(proxy.port, '/odoo', { cookie: gate });
        assert.strictEqual(seen[seen.length - 1].cookie, 'session_id=rotated-ws');
        assert.strictEqual(
            filterHandshakeHead('HTTP/1.1 101 X\r\nset-cookie: session_id=a; Path=/\r\nUpgrade: websocket\r\n\r\n').head,
            'HTTP/1.1 101 X\r\nUpgrade: websocket\r\n\r\n');
    });

    test('a client that left while the session was minted opens nothing upstream', async () => {
        let release!: (sid: string) => void;
        const proxy = await makeProxy(undefined, { mint: () => new Promise<string>(resolve => { release = resolve; }) });
        const gate = await openGate(proxy);
        const socket = net.connect(proxy.port, '127.0.0.1');
        await new Promise<void>(resolve => socket.on('connect', resolve));
        socket.on('error', () => undefined);
        socket.write(`GET /websocket HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: ${gate}\r\n\r\n`);
        await new Promise(resolve => setTimeout(resolve, 100));
        socket.destroy();
        await new Promise(resolve => setTimeout(resolve, 50));
        await proxy.close();
        release('late');
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.strictEqual(seen.length, 0);
    });

    test('a gate target with control characters is refused', async () => {
        const proxy = await makeProxy();
        assert.strictEqual((await request(proxy.port, proxy.gatePath('/\t/evil.example'))).status, 403);
        assert.strictEqual((await request(proxy.port, proxy.gatePath('/a\u0001b'))).status, 403);
    });

    test('the gate passes if any of its duplicate cookies matches', async () => {
        const proxy = await makeProxy();
        const gate = await openGate(proxy);
        const name = gate.split('=')[0];
        assert.strictEqual((await request(proxy.port, '/odoo', { cookie: `${name}=junk; ${gate}` })).status, 200);
        assert.strictEqual((await request(proxy.port, '/odoo', { cookie: `${name}=junk` })).status, 403);
    });

    test('a gate token expires', async () => {
        const proxy = await makeProxy(undefined, { tokenTtlMs: 30 });
        const stale = proxy.gatePath('/odoo');
        const fresh = proxy.gatePath('/odoo');
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.strictEqual((await request(proxy.port, stale)).status, 403);
        assert.strictEqual((await request(proxy.port, fresh)).status, 403);
        assert.strictEqual((await request(proxy.port, proxy.gatePath('/odoo'))).status, 302);
    });

    test('header helpers', () => {
        assert.strictEqual(withoutFrameAncestors("frame-ancestors 'self'"), undefined);
        assert.strictEqual(withoutFrameAncestors("default-src 'self'; frame-ancestors 'none'; img-src *"), "default-src 'self'; img-src *");
        assert.strictEqual(forwardedCookie(undefined, 's'), 'session_id=s');
        assert.strictEqual(forwardedCookie('Session_ID=x; odt_gate_123=y; frontend_lang=fr_FR', 's'), 'frontend_lang=fr_FR; session_id=s');
    });
});
