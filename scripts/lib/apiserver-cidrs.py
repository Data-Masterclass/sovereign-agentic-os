#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""apiserver-cidrs.py — the API server address the release's pods really connect to.

  python3 scripts/lib/apiserver-cidrs.py --context <ctx> --namespace <ns>

WHY. `allow-apiserver-egress` admits the `kubernetes` EndpointSlice addresses (or
`networkPolicies.apiserver.cidrs`). On Gardener clusters (STACKIT SKE) the gardener-resource-manager
webhook `kubernetes-service-host.resources.gardener.cloud` sets KUBERNETES_SERVICE_HOST in every pod
to the API server's DOMAIN, so in-cluster clients (Dagster's run launcher, client-go, client-node)
connect to the address that domain resolves to, not to the endpoint. That address was not admitted:
the Dagster daemon timed out creating every run Job (dev, 21 Nov 2026).

WHAT. Reads the pods of <ns> (`kubectl get pods -o json`, read-only), collects every explicit
KUBERNETES_SERVICE_HOST in a container's env (the webhook's injection), resolves each name to its
IPv4 addresses, and prints a values overlay:

  networkPolicies:
    apiserver:
      extraCidrs: ["188.0.2.10/32"]

Exit 0: overlay printed. Exit 1: no pod carries an injected KUBERNETES_SERVICE_HOST (not Gardener,
or no pod yet): nothing printed, nothing to add. Exit 2: a host is injected but does not resolve —
the caller must stop, because run launches would fail. Exit 3: the pods could not be read — the
caller must stop too (never guess "not Gardener" from an error).
"""
import argparse
import ipaddress
import json
import socket
import subprocess
import sys


def injected_hosts(pods):
    hosts = set()
    for p in pods.get("items", []):
        spec = p.get("spec", {})
        for c in spec.get("containers", []) + spec.get("initContainers", []):
            for e in c.get("env", []) or []:
                if e.get("name") == "KUBERNETES_SERVICE_HOST" and e.get("value"):
                    hosts.add(e["value"].strip())
    return sorted(hosts)


def resolve(host):
    try:
        return [str(ipaddress.IPv4Address(host))]
    except ValueError:
        pass
    infos = socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)
    return sorted({i[4][0] for i in infos})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--context", required=True)
    ap.add_argument("--namespace", required=True)
    a = ap.parse_args()
    r = subprocess.run(["kubectl", "--context", a.context, "-n", a.namespace, "get", "pods", "-o", "json"],
                       capture_output=True, text=True)
    try:
        pods = json.loads(r.stdout) if r.returncode == 0 else None
    except ValueError:
        pods = None
    if pods is None:
        print(f"APISERVER_PODS_UNREADABLE — kubectl get pods in {a.namespace} failed: {r.stderr.strip()[:300]}", file=sys.stderr)
        return 3
    hosts = injected_hosts(pods)
    if not hosts:
        return 1
    cidrs = []
    for h in hosts:
        try:
            ips = resolve(h)
        except OSError as e:
            print(f"APISERVER_HOST_UNRESOLVED — the pods' KUBERNETES_SERVICE_HOST {h} does not resolve ({e})", file=sys.stderr)
            return 2
        if not ips:
            print(f"APISERVER_HOST_UNRESOLVED — {h} has no IPv4 address", file=sys.stderr)
            return 2
        cidrs += [f"{ip}/32" for ip in ips]
        print(f"apiserver-cidrs: the pods' KUBERNETES_SERVICE_HOST {h} -> {', '.join(ips)}", file=sys.stderr)
    print("networkPolicies:\n  apiserver:\n    extraCidrs: " + json.dumps(sorted(set(cidrs))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
