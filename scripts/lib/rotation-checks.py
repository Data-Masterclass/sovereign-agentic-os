#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""rotation-checks.py — small read-only checks of scripts/ops/rotate-secrets.sh verify, on kubectl JSON.

  rotation-checks.py env-sources <deployment.json> <container>
      prints one `secret <name>` / `configmap <name>` line per envFrom source of the container, in
      order — the objects env-state needs to see.
  rotation-checks.py env-state <deployment.json> <container> <VAR> [<secret|configmap.json> …]
      prints `absent`, `empty` or `set` for VAR as the container sees it, resolved the way Kubernetes
      does: the envFrom sources in order (a later source overrides an earlier one; `prefix` applies),
      then the `env` list, which overrides envFrom, where the LAST entry with that name wins. An env
      entry without a `value` key is empty (length 0); a valueFrom is `set`. The JSON of each envFrom
      source is passed after VAR (a missing optional source is an empty file). Never prints a value.
  rotation-checks.py secrets-read <workload.json>
      prints, one per line, every Secret the pod template reads: env valueFrom.secretKeyRef, envFrom
      secretRef, and volumes (secret, projected secret sources), over all containers and init
      containers. A Deployment, StatefulSet, DaemonSet, Job or CronJob.
  rotation-checks.py readers <list.json> <rotated secret> [<rotated secret> …]
      the list is `kubectl get deploy,statefulset,daemonset,cronjob -o json`; prints `<Kind> <name>
      <secret,…>` for every workload whose pod template reads one of the rotated Secrets — the
      readers are discovered, never listed by hand, so a new one cannot be missed.
  rotation-checks.py item <list.json> <Kind> <name>
      prints that one object of the list as JSON.
  rotation-checks.py changed-at <secret.json> [<secret.json>…]
      prints the latest time any of the Secrets was changed (ISO, UTC): the newest managedFields
      entry time, which the API server sets when a manager adds, changes or removes a field and
      leaves alone when an apply changes nothing — so a later deploy that did not touch the
      Secret does not move it. Falls back to creationTimestamp. A missing (empty) file is an error.
"""
import base64
import json
import sys


def load(path):
    with open(path) as f:
        text = f.read().strip()
    return json.loads(text) if text else None


def container(dep, name):
    spec = dep["spec"]["template"]["spec"]
    cs = spec.get("containers") or []
    return next((c for c in cs if c.get("name") == name), cs[0])


def env_sources(dep_path, name):
    for src in container(load(dep_path), name).get("envFrom") or []:
        if "secretRef" in src:
            print(f"secret {src['secretRef']['name']}")
        elif "configMapRef" in src:
            print(f"configmap {src['configMapRef']['name']}")


def source_value(obj, key):
    """The value of `key` in a Secret/ConfigMap JSON (None when absent)."""
    if obj is None:
        return None
    if obj.get("kind") == "Secret":
        data = obj.get("data") or {}
        if key in data:
            return base64.b64decode(data[key]).decode("utf-8", "replace")
        return (obj.get("stringData") or {}).get(key)
    return (obj.get("data") or {}).get(key)


def env_state(dep_path, name, var, source_paths):
    c = container(load(dep_path), name)
    sources = c.get("envFrom") or []
    objs = [load(p) for p in source_paths]
    state = "absent"
    for src, obj in zip(sources, objs + [None] * (len(sources) - len(objs))):
        prefix = src.get("prefix") or ""
        if not var.startswith(prefix):
            continue
        value = source_value(obj, var[len(prefix):])
        if value is not None:  # a later source overrides an earlier one
            state = "set" if value != "" else "empty"
    for e in c.get("env") or []:  # env overrides envFrom; the last entry with the name wins
        if e.get("name") == var:
            state = "set" if "valueFrom" in e or (e.get("value") or "") != "" else "empty"
    return state


def pod_spec(obj):
    """The pod spec of a Deployment, StatefulSet, DaemonSet, Job or CronJob."""
    spec = obj.get("spec") or {}
    if obj.get("kind") == "CronJob":
        spec = (spec.get("jobTemplate") or {}).get("spec") or {}
    return (spec.get("template") or {}).get("spec") or {}


def secrets_of(obj):
    spec = pod_spec(obj)
    names = []
    for c in (spec.get("containers") or []) + (spec.get("initContainers") or []):
        for e in c.get("env") or []:
            ref = (e.get("valueFrom") or {}).get("secretKeyRef")
            if ref:
                names.append(ref["name"])
        for src in c.get("envFrom") or []:
            if "secretRef" in src:
                names.append(src["secretRef"]["name"])
    for v in spec.get("volumes") or []:
        if "secret" in v:
            names.append(v["secret"]["secretName"])
        for s in (v.get("projected") or {}).get("sources") or []:
            if "secret" in s:
                names.append(s["secret"]["name"])
    return sorted(set(names))


def secrets_read(path):
    return secrets_of(load(path))


def readers(list_path, rotated):
    """Every workload in a `kubectl get deploy,sts,ds,cronjob -o json` list that reads a rotated Secret."""
    out = []
    for obj in (load(list_path) or {}).get("items") or []:
        hit = [n for n in secrets_of(obj) if n in rotated]
        if hit:
            out.append(f"{obj['kind']} {obj['metadata']['name']} {','.join(hit)}")
    return sorted(out)


def item(list_path, kind, name):
    for obj in (load(list_path) or {}).get("items") or []:
        if obj.get("kind") == kind and obj["metadata"]["name"] == name:
            return json.dumps(obj)
    raise SystemExit(f"{kind}/{name} not in the list")


def changed_at(paths):
    times = []
    for p in paths:
        obj = load(p)
        if obj is None:
            raise SystemExit(f"{p}: no such Secret")
        md = obj["metadata"]
        times += [m["time"] for m in md.get("managedFields") or [] if m.get("time")]
        times.append(md["creationTimestamp"])
    return max(times)  # RFC 3339 'Z' timestamps compare correctly as text


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "env-sources":
        env_sources(*args[:2])
    elif cmd == "env-state":
        print(env_state(args[0], args[1], args[2], args[3:]))
    elif cmd == "secrets-read":
        print("\n".join(secrets_read(args[0])))
    elif cmd == "readers":
        print("\n".join(readers(args[0], set(args[1:]))))
    elif cmd == "item":
        print(item(*args[:3]))
    elif cmd == "changed-at":
        print(changed_at(args))
    else:
        sys.exit(f"unknown command {cmd}")
