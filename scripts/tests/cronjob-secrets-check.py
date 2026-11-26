# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""Every CronJob's Secret references must name a Secret the chart itself creates — and a key in it.

Reads a `helm template` render on stdin, plus optional extra CronJob manifests (JSON, one per
file) given as arguments — the CronJob os-ui creates at run time for an agent schedule. A Secret
"the chart creates" is a rendered `Secret`, or the target of a rendered `ExternalSecret` (the ESO
profiles deliver the shared Secrets that way). A reference marked `optional: true` is skipped.
`--owner-provided NAME` accepts a Secret the chart documents as created by the operator before
the feature is enabled (values.yaml says so next to the setting); every use is printed as such.

Keys: where the chart renders the Secret's content, a `secretKeyRef.key` must be one of its keys
(`data` / `stringData` of a Secret; `spec.data[].secretKey` and `spec.target.template.data` of an
ExternalSecret). An ExternalSecret with `dataFrom` has keys only the store knows, so its key is
not checked; neither is an owner-provided Secret's.

Prints one `ok`/`FAIL` line per CronJob reference and exits 1 on any FAIL, 2 when no CronJob was
seen (a render that silently lost its CronJobs must not pass).
"""
import json
import sys

import yaml


def secret_refs(pod_spec):
    """(container, label, secret name, key or None) for every non-optional Secret reference."""
    out = []
    for c in (pod_spec.get("initContainers") or []) + (pod_spec.get("containers") or []):
        for e in c.get("env") or []:
            ref = ((e.get("valueFrom") or {}).get("secretKeyRef")) or None
            if ref and not ref.get("optional"):
                out.append((c.get("name"), f"env {e.get('name')} -> {ref.get('name')}/{ref.get('key')}", ref.get("name"), ref.get("key")))
        for ef in c.get("envFrom") or []:
            ref = ef.get("secretRef")
            if ref and not ref.get("optional"):
                out.append((c.get("name"), f"envFrom -> {ref.get('name')}", ref.get("name"), None))
    for v in pod_spec.get("volumes") or []:
        s = v.get("secret")
        if s and not s.get("optional"):
            for item in s.get("items") or [{"key": None}]:
                out.append(("volume", f"volume {v.get('name')} -> {s.get('secretName')}/{item.get('key')}", s.get("secretName"), item.get("key")))
    return out


def created_secrets(docs):
    """name -> set of keys, or None when the keys are not knowable from the render."""
    created = {}
    for d in docs:
        if d.get("kind") == "Secret":
            keys = set((d.get("data") or {}).keys()) | set((d.get("stringData") or {}).keys())
            created[d["metadata"]["name"]] = keys
        elif d.get("kind") == "ExternalSecret":
            spec = d.get("spec") or {}
            target = (spec.get("target") or {}).get("name") or d["metadata"]["name"]
            if spec.get("dataFrom"):
                created[target] = None
            else:
                keys = {x.get("secretKey") for x in spec.get("data") or [] if x.get("secretKey")}
                keys |= set((((spec.get("target") or {}).get("template") or {}).get("data") or {}).keys())
                created[target] = keys
    return created


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
    created = created_secrets(docs)
    cronjobs = [d for d in docs if d.get("kind") == "CronJob"]
    if not cronjobs:
        print("FAIL no CronJob in the render")
        return 2
    failed = 0
    for cj in cronjobs:
        cname = cj["metadata"]["name"]
        refs = secret_refs(cj["spec"]["jobTemplate"]["spec"]["template"]["spec"])
        if not refs:
            print(f"ok   cronjob {cname}: no Secret reference")
        for container, what, name, key in refs:
            if name in created:
                keys = created[name]
                if key is not None and keys is not None and key not in keys:
                    failed += 1
                    print(f"FAIL cronjob {cname} [{container}] {what}: Secret '{name}' has no key '{key}' (keys: {', '.join(sorted(keys)) or 'none'})")
                else:
                    print(f"ok   cronjob {cname} [{container}] {what}{'' if keys is not None else ' (keys from the store)'}")
            elif name in owner_provided:
                print(f"ok   cronjob {cname} [{container}] {what} (owner-provided, documented)")
            else:
                failed += 1
                print(f"FAIL cronjob {cname} [{container}] {what}: the chart creates no Secret '{name}'")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
