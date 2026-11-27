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

## The binary path (AppArmor)
The image runs the unmodified Alpine tinyproxy binary from `/opt/egress-proxy/egress-proxy`, not
`/usr/bin/tinyproxy`. Ubuntu hosts can carry a `tinyproxy` AppArmor profile that attaches by that
path, and under kind it then confined the proxy inside the cluster too ("Could not open config
file"). See [troubleshooting](../ops/troubleshooting.md#egress-proxy-could-not-open-config-file).

## FAQ
**Q: Why tinyproxy not Squid?** Squid's arm64 edge build ran away on memory on kind; tinyproxy
is tiny and reliable. Squid/Envoy remain valid on STACKIT.
**Q: Are the NetworkPolicies enforcing this locally?** On kind >= v0.24, yes: kindnet enforces
NetworkPolicies. Older kind does not; there the app-layer chain (OPA + proxy + web_fetch) still does.
Cilium enforces on STACKIT.
