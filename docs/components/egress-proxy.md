# Egress proxy

**What it is:** The single outbound chokepoint (tinyproxy) — an **allowlist-only** forward
proxy. Requests to non-allowlisted domains are blocked; everything is logged. The governed
`web_fetch` tool routes through it; agents have no other path out. On STACKIT this pairs with
Cilium FQDN egress + DLP.

## Configure the allowlist
`egressProxy.allowlist` in values (domains; subdomains included). Default: `example.com`,
`github.com`. After changing, `helm upgrade` (pods roll automatically).

## Test
```bash
kubectl -n agentic-os run e --rm -i --restart=Never --image=curlimages/curl:8.11.1 -- sh -c \
 'curl -s -o /dev/null -w "%{http_code}\n" -x http://egress-proxy:3128 https://api.github.com'   # 200
```

## FAQ
**Q: Why tinyproxy not Squid?** Squid's arm64 edge build ran away on memory on kind; tinyproxy
is tiny and reliable. Squid/Envoy remain valid on STACKIT.
**Q: Are the NetworkPolicies enforcing this locally?** kind's kindnet doesn't enforce
NetworkPolicies; the app-layer chain (OPA + proxy + web_fetch) does. Cilium enforces on STACKIT.
