# Running on a server / behind a reverse proxy

Use this page when the OS runs on a server and users reach it through a reverse proxy of your own
(nginx, Traefik, HAProxy, a load balancer) instead of the chart's Ingress, or directly on
`http://<server>:8080` for a quick test. Every statement here points at the code that does it.

## TL;DR

1. Terminate **HTTPS** in front of os-ui. The session cookie is `Secure`, so a browser does not keep
   it over plain HTTP on any host except `localhost`.
2. Set **`osUI.publicUrl`** to the exact origin users type, e.g. `https://os.example.com`. It works
   without the chart's Ingress.
3. Every other name users open (a second DNS name, an internal name) goes into
   **`osUI.publicUrlAliases`**.
4. The proxy must pass **`Host`**, **`X-Forwarded-Proto`** and **`X-Forwarded-For`**, must not
   buffer responses (**`proxy_buffering off`**), and needs long **read timeouts**. See the nginx
   example below.

```yaml
# values for your install (helm upgrade … -f this-file.yaml)
osUI:
  publicUrl: https://os.example.com
  publicUrlAliases: []          # e.g. [https://os.internal.example.net]
  insecureSessionCookie: false  # NOT FOR PRODUCTION, see below
```

## The chart values

| Value | Env in os-ui | What it does |
|---|---|---|
| `osUI.publicUrl` | `OS_PUBLIC_URL` | The OS's own origin. It is the origin the same-origin check and CORS trust, the base of emailed links, OAuth callbacks and the remote MCP endpoint, and the target of the canonical redirect for OAuth starts. Empty = the os-ui Ingress host when the Ingress is on, otherwise unset (local dev: the request's own origin is used). |
| `osUI.publicUrlAliases` | `OS_PUBLIC_URL_ALIASES` | Further origins the UI is served on. A list, or one comma-separated string. Each entry must be an origin (`scheme://host[:port]`, no path), otherwise the render fails, because os-ui would silently drop it (`parseOriginList`). Merged with the Ingress's second host when the Ingress is on. |
| `osUI.insecureSessionCookie` | `OS_SESSION_COOKIE_INSECURE=true` | **Not for production.** Drops `Secure` (and the `__Host-` prefix) from the session cookie so a browser keeps it over plain HTTP. Rendered only when `true`; `helm install`/`upgrade` then prints a NOT-FOR-PRODUCTION note. |

Template: `charts/sovereign-agentic-os/templates/base/os-ui/_os-ui-env.tpl`. Render test:
`scripts/check-public-url-chart.mjs`.

## Cookies

The session cookie is set by `POST /api/auth/login` (`os-ui/app/api/auth/login/route.ts`), with
options from `sessionCookieOptions` in `os-ui/core/kernel/session.ts`:

| Attribute | Value | Consequence for the proxy |
|---|---|---|
| Name | `__Host-soa_session` (with `insecureSessionCookie`: `soa_session_insecure`) | The `__Host-` prefix makes the browser require `Secure`, `Path=/` and no `Domain`. |
| `Secure` | on in production (`NODE_ENV=production`, set in `images/base/os-ui/Dockerfile`) unless `OS_SESSION_COOKIE_INSECURE=true` | Plain HTTP on a non-localhost host: the browser drops the cookie and every page sends you back to `/signin`. |
| `HttpOnly` | on | Page scripts cannot read it. |
| `SameSite` | `Lax` | Sent on top-level navigations from other sites, not on cross-site sub-requests. |
| `Domain` | none (host-only) | Sent to the exact host that set it. Another name (an alias) has its own session. |
| `Path` | `/` | Serve the OS at the **root** of its host. A sub-path (`https://example.com/os/`) is not supported: the UI calls absolute paths such as `/api/auth/login`. |
| `Max-Age` | 12 h | |

Do not rewrite the cookie in the proxy (no `proxy_cookie_domain`, no `proxy_cookie_path`, no
stripping of `Set-Cookie`).

### Sign-in over plain HTTP no longer fails silently

When a sign-in succeeds but the browser will not keep the cookie, os-ui now says so:

- **Server:** the login route logs **one** line per cause and origin (at most every 10 minutes, and at most 20 lines per 10 minutes
  in total; origins are clipped to 200 characters),
  for example
  `[auth] WARN sign-in from http://10.0.0.5:8080 succeeded, but the browser will drop the session cookie: … Fix: serve the OS over HTTPS … or for a non-production test install only set osUI.insecureSessionCookie=true …`.
  A second variant fires when the browser's `Origin` is neither `publicUrl` nor an alias.
  Code: `os-ui/core/kernel/session-transport.ts`.
- **Sign-in page:** after a successful login it asks `/api/auth/me`. If that still has no user, it
  shows why (plain HTTP, wrong address, or "the browser did not keep the cookie"; only on a 200 with an
  explicit `user: null`, never for a server error or a deactivated account) and what fixes it,
  instead of reloading (`os-ui/app/(entry)/signin/page.tsx`, `os-ui/core/auth/signin-session.ts`).

The browser's scheme is taken from the `Origin` header first, then from `X-Forwarded-Proto`, then
from the request URL. `localhost`, `*.localhost`, `127.0.0.0/8` and `::1` are not flagged (Chrome
and Firefox keep `Secure` cookies there; Safari does not, see the comment on `secureByDefault` in
`os-ui/core/kernel/session.ts`).

### Quick test without TLS (not for production)

```yaml
osUI:
  publicUrl: http://10.0.0.5:8080      # the address you type
  insecureSessionCookie: true          # session travels unencrypted
```

Anyone on the network path can read and replay the session. Use it only on a trusted network for
a throw-away install, then switch to HTTPS.

## Origin check

`os-ui/core/kernel/same-origin.ts` (run by `os-ui/middleware.ts` before every `/api/` route): a
request that carries the session cookie must prove it comes from an OS origin before any write
(POST/PUT/PATCH/DELETE), before admin reads, and before a few state-changing GETs:

1. `Sec-Fetch-Site: same-origin` → allowed (modern browsers send this on the OS's own requests).
2. Otherwise `Origin`, else `Referer`, must **exactly** equal `publicUrl` or an alias (scheme, host
   and port).
3. Neither header → refused.

The allowed set comes from configuration only. `Host` and `X-Forwarded-Host` never widen it, so a
proxy cannot fix a missing alias by rewriting headers: put every name users open into
`publicUrl`/`publicUrlAliases`. Requests with a bearer token (MCP, API clients) are not checked.
CORS (`os-ui/core/kernel/cors.ts`) answers credentialed requests for `publicUrl` only.

## Headers the proxy must send

| Header | Set it to | Who reads it |
|---|---|---|
| `Host` | the host the user typed (nginx: `$host`; use `$http_host` if `publicUrl` has a non-default port) | The OAuth "Connect" start (`os-ui/core/auth/redirect.ts`, `canonicalStartUrl`) compares it with `publicUrl`'s host and redirects to `publicUrl` when they differ. A proxy that sends its upstream name instead makes that redirect loop. The tool-console proxy forwards it as `X-Forwarded-Host`. |
| `X-Forwarded-Proto` | `https` (nginx: `$scheme`) | The sign-in diagnosis above (when there is no `Origin`), and the tool-console proxy (`os-ui/core/infra/tool-proxy.ts`), which passes it to the consoles so their absolute URLs are right. |
| `X-Forwarded-For` | the client address, **overwritten** (nginx: `$remote_addr`) | The sign-in rate limit (`os-ui/core/kernel/ratelimit.ts`, `clientIp`) uses the **first** entry. Appending (`$proxy_add_x_forwarded_for`) keeps whatever the client sent first, so a client could choose its own rate-limit bucket. |

`X-Forwarded-Host` is not read by os-ui. `X-Real-IP` is used only when `X-Forwarded-For` is absent.

## Streams (SSE), WebSockets and timeouts

- The OS UI streams over **Server-Sent Events** (`text/event-stream`): agent runs
  (`/api/agents/systems/<id>/run`, `…/run/stream`), app chat (`/api/apps/<id>/chat`), the software
  team view, and the MCP endpoint's GET stream. Turn **buffering off** for them, or events arrive in
  bursts at the end. Only the MCP stream sends `X-Accel-Buffering: no` itself, so set
  `proxy_buffering off` in the proxy.
- An agent-run stream can be **silent for up to 240 s** between events (the tail budget in
  `app/api/agents/systems/[id]/run/route.ts`; no heartbeat), and runs last longer than that.
  nginx's default `proxy_read_timeout` of 60 s cuts them. Use `3600s`, as the chart's Ingress does
  (`ingress.annotations` in `values.yaml`). The MCP stream sends a keep-alive comment every 25 s.
- The OS UI itself uses **no WebSockets** (the tool consoles that need them say so and are not
  proxied, see `docs/ops/tool-consoles.md`). Upgrade headers are not needed; they do no harm.
- **Uploads:** the Files tab accepts up to 200 MB per file (`UPLOAD_MAX_BYTES`), so set
  `client_max_body_size 200m` (the chart's Ingress uses `proxy-body-size: 200m`). Long uploads also
  need the long send/read timeouts. If you enable the git-http push route, its limit is
  `osUI.dataProjectGit.gitHttp.maxPushSize` (default `512m`).

## Example: nginx in front of a kind install

The kind profile publishes os-ui on host port 8080 (`kind-config.yaml`: hostPort 8080 → NodePort
30080). kind binds that port on all interfaces by default; restrict it to `127.0.0.1` (kind's
`listenAddress`) or firewall it so users can only come through nginx.

```nginx
# /etc/nginx/sites-available/sovereign-os
server {
    listen 80;
    server_name os.example.com;
    return 308 https://$host$request_uri;
}

server {
    listen 443 ssl http2;                  # nginx >= 1.25.1 also accepts `http2 on;`
    server_name os.example.com;

    ssl_certificate     /etc/ssl/certs/os.example.com.fullchain.pem;
    ssl_certificate_key /etc/ssl/private/os.example.com.key;

    client_max_body_size 200m;            # Files tab upload cap

    location / {
        proxy_pass http://127.0.0.1:8080;  # kind hostPort -> os-ui NodePort
        proxy_http_version 1.1;
        proxy_set_header Connection "";

        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $remote_addr;   # overwrite, do not append

        # Server-Sent Events: agent runs, app chat, MCP
        proxy_buffering         off;
        proxy_cache             off;
        proxy_request_buffering off;       # stream uploads instead of spooling them to disk first
        proxy_read_timeout      3600s;
        proxy_send_timeout      3600s;
    }
}
```

and in the chart values:

```yaml
osUI:
  publicUrl: https://os.example.com
```

## Checks after the change

```bash
# 1. os-ui got the values
kubectl -n agentic-os get deploy os-ui -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{"\n"}{end}' \
  | grep -E 'OS_PUBLIC_URL|OS_SESSION_COOKIE_INSECURE'
# 2. the cookie arrives through the proxy with Secure, HttpOnly, SameSite=Lax
curl -si https://os.example.com/api/auth/login -H 'content-type: application/json' \
  -H 'origin: https://os.example.com' -d '{"username":"<user>","password":"<pw>"}' | grep -i '^set-cookie'
# 3. no sign-in warning in the log
kubectl -n agentic-os logs deploy/os-ui | grep '\[auth\] WARN'
```
