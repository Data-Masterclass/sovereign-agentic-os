# Redirect-only hostnames

A second hostname can point people at the OS without becoming a second OS address. Every request
to it gets a **308 Permanent Redirect** to the canonical OS URL, with the path and the query string
kept: `https://platform.sovereign-agentic.com/a/b?x=1` goes to
`https://agentic.datamasterclass.com/a/b?x=1` (production's `osUI.publicUrl`). The browser then talks only to the canonical
host, so sign-in cookies, links, the MCP URL and `osUI.publicUrl` do not change.

## How it works

`ingress.redirectHosts` (default empty) is a list of `{host, to}`. `to` is optional and defaults
to `osUI.publicUrl` — the same value os-ui receives as `OS_PUBLIC_URL` — so the target follows the
canonical URL and is never typed twice. Each entry renders one
ingress-nginx Ingress (`templates/base/ingress-redirects.yaml`) with:

- `nginx.ingress.kubernetes.io/permanent-redirect: <to>$request_uri` and
  `nginx.ingress.kubernetes.io/permanent-redirect-code: "308"` — the controller answers with
  nginx's `return 308 …`; `$request_uri` is nginx's variable for the original path and query;
- its own certificate: `cert-manager.io/cluster-issuer` (the release's `ingress.tlsIssuer`,
  `letsencrypt-prod`) and a `<host>-tls` Secret, solved over HTTP-01;
- a backend Service that does not exist (`redirect-only`): nothing is proxied, never to os-ui.

The render refuses a target (`to` or `osUI.publicUrl`) that is not a bare `https://<host>` origin, an
entry with neither, a host that is also served
under `ingress.hosts`, a duplicate host, and a list without `ingress.enabled`.

Upstream docs: ingress-nginx annotations "Permanent Redirect" and "Permanent Redirect Code"
(kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/), nginx `return`
(nginx.org/en/docs/http/ngx_http_rewrite_module.html#return), cert-manager ingress-shim
(cert-manager.io/docs/usage/ingress/).

**Controller constraint.** Production runs ingress-nginx v1.11.3 with annotation validation off
(the v1.11 default). With `--enable-annotation-validation` on, the URL validator rejects the `$`
of `$request_uri` and the redirect stops working. Re-run `tests/ingress/redirect.kind.sh` with the
new controller version before such an upgrade.

## Production: platform.sovereign-agentic.com

1. **DNS (owner, Route 53).** In the hosted zone `sovereign-agentic.com`, create the record
   `platform` — type **A** — value **the production ingress IP**, the external IP of the
   `ingress-nginx/ingress-nginx-controller` LoadBalancer Service:
   `kubectl --context dmagenticos -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}'`.
   Check: `dig +short platform.sovereign-agentic.com` returns that IP.
2. **Deploy (once).**
   `VALUES_OVERLAY=deploy/overlays/platform-redirect.stackit.yaml ./scripts/deploy.sh --from-registry <version>`
3. **Check.**
   - `kubectl --context dmagenticos -n agentic-os get certificate platform.sovereign-agentic.com-tls` is `Ready=True`;
   - `curl -sI 'https://platform.sovereign-agentic.com/a/b?x=1'` shows `HTTP/2 308` and
     `location: https://agentic.datamasterclass.com/a/b?x=1`;
   - `curl -sI https://agentic.datamasterclass.com/` and `https://os.agentic.datamasterclass.com/`
     are unchanged (no redirect).
4. **Rollback.** Deploy with an overlay that sets `ingress: { redirectHosts: [] }`; the redirect
   Ingress is removed. Delete the `platform` DNS record if the hostname is given up.

## Tests

- `node --test scripts/tests/ingress-redirects.test.mjs` — the render, the unchanged canonical
  objects, the empty default and the refusals.
- `tests/ingress/redirect.kind.sh` — the rendered Ingress on a real ingress-nginx v1.11.3 in kind
  answers 308 with path and query; the canonical host is not redirected.
