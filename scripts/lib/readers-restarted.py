#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""readers-restarted.py — did a Deployment's serving pods start after the last deploy?

  readers-restarted.py <deployment.json> <replicasets.json> <pods.json> <last_deployed ISO time>

The JSON files are `kubectl get deploy <d> -o json`, `kubectl get rs -o json` and
`kubectl get pods -l <selector> -o json`. Counts ONLY the pods that serve the Deployment now:

  * owned (ownerReferences) by the Deployment's CURRENT ReplicaSet — the ReplicaSet owned by the
    Deployment whose `deployment.kubernetes.io/revision` equals the Deployment's own revision;
  * in phase Running.

A completed Job pod that happens to carry the same labels (for example a one-off migration Job), a
pod of an old ReplicaSet that is terminating, or a Succeeded/Failed pod is NOT a reader and is
ignored. Prints one line and exits 0 when every such pod started after the deploy, 1 when one did
not, 2 when there is no current serving pod (caller reports a skip).
"""
import json
import sys
from datetime import datetime

REV = "deployment.kubernetes.io/revision"


def ts(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def main(dep_path, rs_path, pods_path, deployed):
    dep = json.load(open(dep_path))
    rss = json.load(open(rs_path)).get("items", [])
    pods = json.load(open(pods_path)).get("items", [])
    name, uid = dep["metadata"]["name"], dep["metadata"]["uid"]
    revision = (dep["metadata"].get("annotations") or {}).get(REV)
    current = [
        rs for rs in rss
        if any(o.get("kind") == "Deployment" and o.get("uid") == uid for o in rs["metadata"].get("ownerReferences") or [])
        and (rs["metadata"].get("annotations") or {}).get(REV) == revision
    ]
    if not current:
        print(f"{name}: no current ReplicaSet (revision {revision})")
        return 2
    rs_uids = {rs["metadata"]["uid"] for rs in current}
    serving = [
        p for p in pods
        if (p.get("status") or {}).get("phase") == "Running"
        and any(o.get("kind") == "ReplicaSet" and o.get("uid") in rs_uids for o in p["metadata"].get("ownerReferences") or [])
    ]
    ignored = len(pods) - len(serving)
    if not serving:
        print(f"{name}: no Running pod of the current ReplicaSet")
        return 2
    since = ts(deployed)
    old = [p["metadata"]["name"] for p in serving if ts(p["status"]["startTime"]) <= since]
    note = f" ({ignored} other pod(s) with the same labels ignored: not of the current ReplicaSet, or not Running)" if ignored else ""
    if old:
        print(f"{name}: {len(old)} serving pod(s) started before the last deploy: {', '.join(old)}{note}")
        return 1
    print(f"{name}: all {len(serving)} serving pod(s) of the current ReplicaSet started after the last deploy{note}")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:5]))
