# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Checks for external-secrets-chart.test.sh over a rendered manifest on stdin.
Prints OK, or the first reason a check fails. Reads key NAMES and types only, never a value."""
import sys, yaml

check, chart, arg = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else "")
docs = [d for d in yaml.safe_load_all(sys.stdin.read()) if isinstance(d, dict) and d.get("kind")]
cat = yaml.safe_load(open(f"{chart}/files/external-secrets/catalog.yaml"))["secrets"]
names = [n for n in arg.split(",") if n] if arg and ":" not in arg and "/" not in arg else []
secrets = {d["metadata"]["name"]: d for d in docs if d["kind"] == "Secret"}
ess = [d for d in docs if d["kind"] == "ExternalSecret"]
stores = [d for d in docs if d["kind"] == "ClusterSecretStore"]
KEEP = "helm.sh/resource-policy"

def keys(d): return set((d.get("stringData") or {}).keys()) | set((d.get("data") or {}).keys())
def ann(d): return (d.get("metadata") or {}).get("annotations") or {}
def fail(msg): print(msg); sys.exit(0)

if check == "no-eso":
    if ess or stores: fail(f"ESO objects rendered: {[d['metadata']['name'] for d in ess + stores]}")
elif check == "no-handover":
    # Only Secrets that already carried `keep` on main may carry it.
    # os-ui-agent-key-encryption: keep by design (the stored model keys are sealed under it), like os-ui-session.
    already = {"os-ui-graph", "os-ui-session", "os-ui-smtp", "docling-api-key", "service-bearer-token", "os-ui-agent-key-encryption"}
    extra = [n for n, d in secrets.items() if KEEP in ann(d) and n not in already]
    if extra: fail(f"annotation added to {extra}")
elif check == "catalog-covers":
    for n, d in secrets.items():
        e = cat.get(n)
        if not e: fail(f"{n} is rendered by the chart but is not in the catalog")
        if e["source"] != "chart": fail(f"{n}: catalog source {e['source']}, but the chart renders it")
        if (d.get("type") or "Opaque") != e["type"]: fail(f"{n}: type {d.get('type')} vs catalog {e['type']}")
        missing = keys(d) - set(e["keys"])
        if missing: fail(f"{n}: the chart writes keys the catalog lacks: {sorted(missing)}")
    if len(secrets) < 20: fail(f"only {len(secrets)} Secrets rendered — the optional templates did not render")
elif check == "handover-keep":
    for n in names:
        if n not in secrets: continue  # rendered only with other values (asserted by catalog-covers)
        if ann(secrets[n]).get(KEEP) != "keep": fail(f"{n} lacks {KEEP}: keep")
    if not any(n in secrets for n in names): fail("no handover Secret rendered")
elif check == "not-rendered":
    both = [n for n in names if n in secrets]
    if both: fail(f"the chart still renders managed Secrets: {both}")
elif check == "externalsecrets":
    by = {d["metadata"]["name"]: d for d in ess}
    if len(ess) != len(by): fail("duplicate ExternalSecret names")
    if set(by) != set(names): fail(f"ExternalSecrets {sorted(by)} vs managed {sorted(names)}")
    for n in names:
        s = by[n]["spec"]; e = cat[n]; t = s["target"]
        if s["secretStoreRef"] != {"name": "stackit-secrets-manager", "kind": "ClusterSecretStore"}: fail(f"{n}: store {s['secretStoreRef']}")
        if t["name"] != n: fail(f"{n}: target name {t['name']}")
        if t.get("creationPolicy") != "Orphan": fail(f"{n}: creationPolicy {t.get('creationPolicy')}")
        if (t.get("template") or {}).get("type") != e["type"]: fail(f"{n}: type {(t.get('template') or {}).get('type')} vs {e['type']}")
        tdata = (t.get("template") or {}).get("data") or {}
        if sorted(tdata) != sorted(e["keys"]): fail(f"{n}: template keys {sorted(tdata)} vs {e['keys']}")
        for k, tv in tdata.items():
            if tv != '{{ $v := index . "%s" }}{{ if empty (trim $v) }}{{ index (list "empty value refused") 1 }}{{ end }}{{ $v }}' % k: fail(f"{n}/{k}: no empty-value refusal in the template")
        if (t.get("template") or {}).get("engineVersion") != "v2": fail(f"{n}: template engine")
        got = [x["secretKey"] for x in s["data"]]
        if sorted(got) != sorted(e["keys"]) or len(got) != len(set(got)): fail(f"{n}: keys {got} vs {e['keys']}")
        rk = {x["remoteRef"]["key"] for x in s["data"]}
        if rk != {f"agentic-os/{n}"}: fail(f"{n}: remote keys {rk}")
        if by[n]["apiVersion"] != "external-secrets.io/v1": fail(f"{n}: {by[n]['apiVersion']}")
elif check == "store":
    if len(stores) != 1: fail(f"{len(stores)} ClusterSecretStores")
    st = stores[0]; v = st["spec"]["provider"]["vault"]
    want = {"server": "https://prod.sm.eu01.stackit.cloud", "path": "00000000-0000-0000-0000-000000000000", "version": "v2"}
    for k, w in want.items():
        if v.get(k) != w: fail(f"vault.{k} = {v.get(k)}")
    up = v["auth"]["userPass"]
    if up != {"path": "userpass", "username": "eso-reader", "secretRef": {"name": "stackit-secrets-manager-eso", "namespace": "external-secrets", "key": "password"}}: fail(f"userPass {up}")
    if st["spec"].get("conditions") != [{"namespaces": ["agentic-os"]}]: fail(f"conditions {st['spec'].get('conditions')}")
    if st["apiVersion"] != "external-secrets.io/v1": fail(st["apiVersion"])
elif check == "remote-key":
    rk = {x["remoteRef"]["key"] for d in ess for x in d["spec"]["data"]}
    if rk != {arg}: fail(f"remote keys {rk}")
elif check == "remote-property":
    n, kv = arg.split(":", 1); k, p = kv.split("=", 1)
    d = next((x for x in ess if x["metadata"]["name"] == n), None)
    if not d: fail(f"no ExternalSecret {n}")
    got = {x["secretKey"]: x["remoteRef"]["property"] for x in d["spec"]["data"]}
    if got.get(k) != p: fail(f"{n}: {k} reads property {got.get(k)}")
elif check == "api-v1":
    if len(ess) < 2: fail(f"only {len(ess)} ExternalSecrets rendered")
    bad = [(d["metadata"]["name"], d["apiVersion"]) for d in ess if d["apiVersion"] != "external-secrets.io/v1"]
    if bad: fail(f"not served by ESO 2.15: {bad}")
else:
    fail(f"unknown check {check}")
print("OK")
