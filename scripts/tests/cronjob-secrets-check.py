# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Every CronJob's Secret references must name a Secret the chart itself creates.

Reads a `helm template` render on stdin, plus optional extra CronJob manifests (JSON, one per
file) given as arguments — the CronJob os-ui creates at run time for an agent schedule. A Secret
"the chart creates" is a rendered `Secret`, or the target of a rendered `ExternalSecret` (the ESO
profiles deliver the shared Secrets that way). A reference marked `optional: true` is skipped.
`--owner-provided NAME` accepts a Secret the chart documents as created by the operator before
the feature is enabled (values.yaml says so next to the setting); every use is printed as such.

Prints one `ok`/`FAIL` line per CronJob reference and exits 1 on any FAIL, 2 when no CronJob was
seen (a render that silently lost its CronJobs must not pass).
"""
import json
import sys

import yaml


def secret_refs(pod_spec):
    """(container, env/envFrom label, secret name) for every non-optional Secret reference."""
    out = []
    for c in (pod_spec.get("initContainers") or []) + (pod_spec.get("containers") or []):
        for e in c.get("env") or []:
            ref = ((e.get("valueFrom") or {}).get("secretKeyRef")) or None
            if ref and not ref.get("optional"):
                out.append((c.get("name"), f"env {e.get('name')} -> {ref.get('name')}/{ref.get('key')}", ref.get("name")))
        for ef in c.get("envFrom") or []:
            ref = ef.get("secretRef")
            if ref and not ref.get("optional"):
                out.append((c.get("name"), f"envFrom -> {ref.get('name')}", ref.get("name")))
    for v in pod_spec.get("volumes") or []:
        s = v.get("secret")
        if s and not s.get("optional"):
            out.append(("volume", f"volume {v.get('name')} -> {s.get('secretName')}", s.get("secretName")))
    return out


def main():
    docs = [d for d in yaml.safe_load_all(sys.stdin) if isinstance(d, dict)]
    args, owner_provided = sys.argv[1:], set()
    while "--owner-provided" in args:
        i = args.index("--owner-provided")
        owner_provided.add(args[i + 1])
        del args[i : i + 2]
    for path in args:
        with open(path, encoding="utf-8") as f:
            docs.append(json.load(f))
    created = set()
    for d in docs:
        if d.get("kind") == "Secret":
            created.add(d["metadata"]["name"])
        elif d.get("kind") == "ExternalSecret":
            target = ((d.get("spec") or {}).get("target") or {}).get("name")
            created.add(target or d["metadata"]["name"])
    cronjobs = [d for d in docs if d.get("kind") == "CronJob"]
    if not cronjobs:
        print("FAIL no CronJob in the render")
        return 2
    failed = 0
    for cj in cronjobs:
        spec = cj["spec"]["jobTemplate"]["spec"]["template"]["spec"]
        refs = secret_refs(spec)
        if not refs:
            print(f"ok   cronjob {cj['metadata']['name']}: no Secret reference")
        for container, what, name in refs:
            if name in created:
                print(f"ok   cronjob {cj['metadata']['name']} [{container}] {what}")
            elif name in owner_provided:
                print(f"ok   cronjob {cj['metadata']['name']} [{container}] {what} (owner-provided, documented)")
            else:
                failed += 1
                print(f"FAIL cronjob {cj['metadata']['name']} [{container}] {what}: the chart creates no Secret '{name}'")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
