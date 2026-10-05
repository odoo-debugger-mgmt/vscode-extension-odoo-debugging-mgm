# Spike: two Odoo web clients side by side in a VS Code tab (2026-10-05)

**Question:** can the View Doctor show the original and the upgraded database's Odoo web client next to each other inside VS Code, the way odoo-manager shows two iframes in one page? Can the extension control both frames (reload after a save, same record)?

**Answer: yes.** This was a throwaway probe extension on Odoo 17.0 and 19.0, both on loopback ports with `contacts`, run in a real VS Code 1.140 window under Xvfb. Everything below was observed. The probe code is at the end, as a starting point; it is not production code.

## What was tested and seen

| Check | Result |
|---|---|
| Both web clients load inside one webview tab, authenticated as admin, with no login page | ✅ |
| The same record on both sides (17: `/web#id=3&model=res.partner&view_type=form`; 19: `/odoo/res.partner/3`) | ✅ |
| Every proxied request succeeds: assets, `call_kw`, `get_views`, `web_read`, mail, service worker, `/bus/websocket_worker_bundle` | ✅ (0 responses ≥ 400) |
| Odoo's websocket (bus) through the proxy | ✅ `101 SWITCHING PROTOCOLS` on 17 and 19 |
| The extension writes to both DBs, then reloads both frames by posting a message to the webview | ✅ Both showed the new name about 100 ms later |
| The frames are interactive: typing into fields on both sides | ✅ (save/discard icons appear) |
| Session rotation (`Set-Cookie: session_id` with a new value) | Not triggered on 17 or 19 in normal use. The proxy follows it anyway. |
| A cookie set by the proxy (`SameSite=None; Secure` on `http://127.0.0.1`) comes back from inside the webview iframe | ✅ On every later request, including the document request after a reload |

## How it works

### The proxy

The proxy runs in the extension host, one per database, bound to `127.0.0.1` on its own port. Per request it does the following:

- **Injects the session.** It sets `Cookie: session_id=<sid>`, replacing any session cookie the browser sent. The browser never needs Odoo's own cookie, so the cross-site cookie rules of a `vscode-webview://` page don't matter. (That is the part odoo-manager's `*.frame.localhost` trick exists for; it cannot work from a webview origin.)
- **Passes `Host` through unchanged.** Odoo then builds its own URLs on the proxy's origin, so the probe needed no URL rewriting. `Location` rewriting is still worth keeping for absolute redirects built from `web.base.url`, as odoo-manager does.
- **Strips framing headers.** It removes `X-Frame-Options` (Odoo sends `DENY` on `/web` and `/odoo`) and `frame-ancestors` from `Content-Security-Policy`.
- **Hides Odoo's session cookie.** It drops `Set-Cookie: session_id` from responses, keeping the new value if Odoo rotates it.
- **Forwards websocket upgrades.** It does so with a raw `net` pipe, adding the same cookie injection.

### The session

The session is minted by the database's own `odoo-bin shell`, exactly like odoo-manager's `connect_as` (`odoo_manager/docker_manager.py:3007`). It works because the shell and the server share Odoo's session store, which is file-based in the data dir.

```python
from odoo.http import root
user = env['res.users'].browse(uid)            # an active base.group_system user
session = root.session_store.new()
session.db = env.cr.dbname
session.uid = user.id
session.login = user.login
session.session_token = user._compute_session_token(session.sid)
session.context = dict(user.context_get() or {})
root.session_store.save(session)               # -> session.sid
```

This worked on both 17.0 and 19.0 (`get_session_info` returned `uid: 2, is_admin: true`). 15 and 16 have not been tried; the APIs exist there per odoo-manager, but verify.

### The webview

- **The page.** Two iframes, and a CSP `frame-src` limited to the two proxy origins.
- **Reloading.** The extension reloads the frames by posting a message. The page sets `iframe.src = iframe.src`.
- **Detecting loads.** `load` events on the iframes tell the extension when a frame has (re)loaded.

## The one real problem: anyone on the machine gets admin

Without a lock-down, the proxy gives admin to every request that reaches its port:
- `curl` with no cookie got `is_admin: true`;
- so did a browser-style cross-site request (`Origin: http://evil.example`, `Sec-Fetch-Site: cross-site`).

Any web page open in the user's normal browser could therefore drive the dev database as admin through it. odoo-manager has the same exposure.

**The fix, which the spike's last check showed to be feasible:** gate the proxy with a cookie only the webview ever receives.

1. **Open through a gate.** The webview's first iframe URL is `/__odt/open?t=<one-time token>&next=<path>`.
2. **Set the gate cookie.** The proxy checks the token, invalidates it, and answers `302 next` with `Set-Cookie: odt_gate=<random secret>; Path=/; HttpOnly; Secure; SameSite=None`.
3. **Refuse everything else.** Any request (HTTP or websocket upgrade) without `odt_gate=<secret>` gets `403`, with no session injected.

The user's normal browser never receives that cookie; it lives in VS Code's own cookie jar. Nothing else can learn the secret, because it is generated in the extension host and never written anywhere.

Observed request headers, for whoever writes the gate:
- **Frame document request:** `Sec-Fetch-Site: cross-site`, `Sec-Fetch-Dest: empty`, no `Origin`, no `Referer`.
- **Subrequests:** `same-origin`, with `Origin`/`Referer` set to the proxy origin.

So headers alone can't tell the webview from another browser: use the cookie.

## Not covered by the spike

- **Remote sessions.** Remote-SSH, WSL and Codespaces need `vscode.env.asExternalUri` for the proxy URLs. The proxy runs on the remote side, next to Odoo.
- **Specific views.** The spike opened a model's default form, not a specific view. For a specific view use an `ir.actions.act_window` with `view_id`:
  - 17.2+: `/odoo/action-<id>/<res_id>`;
  - before 17.2: `/web#action=<id>&id=<res_id>&view_type=form`.
- **Reports and file downloads** through the proxy.
- **Odoo 15 and 16.**
- **Windows.**

## Probe proxy (throwaway reference)

This is the proxy half of the probe, as run. It **has no gate**, which is the security problem above.

```js
function startProxy(name, listenPort, targetPort, sidFile) {
    let sid = fs.readFileSync(sidFile, 'utf8').trim();
    const withSession = (cookieHeader) => {
        const others = (cookieHeader || '').split(';').map(s => s.trim()).filter(c => c && !c.startsWith('session_id='));
        return [...others, `session_id=${sid}`].join('; ');
    };
    const server = http.createServer((req, res) => {
        const headers = { ...req.headers, cookie: withSession(req.headers.cookie) };
        const upstream = http.request({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers }, up => {
            const out = { ...up.headers };
            delete out['x-frame-options'];
            if (out['content-security-policy']) {
                out['content-security-policy'] = String(out['content-security-policy']).replace(/frame-ancestors[^;]*;?/g, '');
            }
            if (out['set-cookie']) {
                out['set-cookie'] = out['set-cookie'].filter(c => {
                    const m = /^session_id=([^;]*)/.exec(c);
                    if (m) { if (m[1] && m[1] !== sid) { sid = m[1]; } return false; }
                    return true;
                });
            }
            res.writeHead(up.statusCode, out);
            up.pipe(res);
        });
        upstream.on('error', e => { res.writeHead(502); res.end(String(e)); });
        req.pipe(upstream);
    });
    server.on('upgrade', (req, socket, head) => {
        const up = net.connect(targetPort, '127.0.0.1', () => {
            const headers = { ...req.headers, cookie: withSession(req.headers.cookie) };
            let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
            for (const [k, v] of Object.entries(headers)) { raw += `${k}: ${v}\r\n`; }
            up.write(raw + '\r\n');
            if (head && head.length) { up.write(head); }
            up.pipe(socket); socket.pipe(up);
        });
        up.on('error', () => socket.destroy());
        socket.on('error', () => undefined);
    });
    server.listen(listenPort, '127.0.0.1');
    return server;
}
```

The webview page was two flex columns, each an `<iframe>`, with `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:<p1> http://127.0.0.1:<p2>; style-src 'unsafe-inline'; script-src 'unsafe-inline';">`. A production page should use a nonce instead of `'unsafe-inline'`. It listened for a `reload` message (`f.src = f.src`) and posted each frame's `load` events back.
