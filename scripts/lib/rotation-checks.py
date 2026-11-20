#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""rotation-checks.py — small read-only checks of scripts/ops/rotate-secrets.sh verify, on kubectl JSON.

  rotation-checks.py env-state <deployment.json> <container name> <VAR>
      prints `absent`, `empty` or `set` for an env entry of the Deployment's pod template. An entry
      without a `value` key (as the subchart renders `envVars.X: ""`/null) and an entry with an
      empty value are both `empty`: the container sees a variable of length 0. Never prints the value.
  rotation-checks.py changed-at <secret.json> [<secret.json>…]
      prints the latest time any of the Secrets was changed (ISO, UTC): the newest managedFields
      entry time, which the API server sets when a manager adds, changes or removes a field and
      leaves alone when an apply changes nothing — so a later deploy that did not touch the
      Secret does not move it. Falls back to creationTimestamp. A missing (empty) file is an error.
"""
import json
import sys


def env_state(dep_path, container, var):
    dep = json.load(open(dep_path))
    containers = dep["spec"]["template"]["spec"]["containers"]
    c = next((x for x in containers if x.get("name") == container), containers[0])
    for e in c.get("env") or []:
        if e.get("name") == var:
            if "valueFrom" in e:
                return "set"
            return "set" if (e.get("value") or "") != "" else "empty"
    return "absent"


def changed_at(paths):
    times = []
    for p in paths:
        text = open(p).read().strip()
        if not text:
            raise SystemExit(f"{p}: no such Secret")
        md = json.loads(text)["metadata"]
        times += [m["time"] for m in md.get("managedFields") or [] if m.get("time")]
        times.append(md["creationTimestamp"])
    return max(times)  # RFC 3339 'Z' timestamps compare correctly as text


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "env-state":
        print(env_state(*sys.argv[2:5]))
    elif cmd == "changed-at":
        print(changed_at(sys.argv[2:]))
    else:
        sys.exit(f"unknown command {cmd}")
