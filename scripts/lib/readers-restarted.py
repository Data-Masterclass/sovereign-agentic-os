#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""readers-restarted.py — does a Deployment now serve ONLY from pods started after a given time?

  readers-restarted.py <deployment.json> <replicasets.json> <pods.json> <since: ISO time — when the Secrets it reads last changed>

The JSON files are `kubectl get deploy <d> -o json` (EMPTY when the Deployment does not exist;
a StatefulSet or DaemonSet is accepted too, see `pods_verdict`),
`kubectl get rs -l <selector> -o json` and `kubectl get pods -l <selector> -o json`.

PASS (exit 0) only when ALL hold:
  * the Deployment exists and its controller has seen the latest spec: observedGeneration == generation;
  * the rollout is complete: updatedReplicas == readyReplicas == availableReplicas == replicas
    (status) == spec.replicas;
  * the current ReplicaSet exists (owned by the Deployment, revision == the Deployment's revision);
  * no pod of ANY OTHER ReplicaSet of this Deployment is still Running or Terminating — an old pod
    still serves the old value;
  * every pod of the current ReplicaSet that is not finished is Ready, and started after <since>.
SKIP (exit 2) only when spec.replicas == 0. Everything else FAILS (exit 1), a missing Deployment
included. Pods not owned by a ReplicaSet of this Deployment (a one-off Job pod with the same labels)
are not readers and are ignored; the output says how many. Prints one line.
"""
import json
import sys
from datetime import datetime

REV = "deployment.kubernetes.io/revision"


def ts(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def owned_by(obj, kind, uids):
    return any(o.get("kind") == kind and o.get("uid") in uids for o in obj["metadata"].get("ownerReferences") or [])


def ready(pod):
    return any(c.get("type") == "Ready" and c.get("status") == "True" for c in (pod.get("status") or {}).get("conditions") or [])


def verdict(dep, rss, pods, deployed):
    if not dep:
        return 1, "the Deployment does not exist (misnamed reader, or it was removed)"
    md, spec, st = dep["metadata"], dep.get("spec") or {}, dep.get("status") or {}
    name = md["name"]
    if dep.get("kind") in ("StatefulSet", "DaemonSet"):
        return pods_verdict(dep, pods, deployed)
    want = spec.get("replicas", 1)
    if want == 0:
        return 2, f"{name}: scaled to 0 replicas"
    if st.get("observedGeneration") != md.get("generation"):
        return 1, f"{name}: the controller has not observed the latest spec (observedGeneration {st.get('observedGeneration')} != generation {md.get('generation')})"
    counts = {k: st.get(k, 0) for k in ("replicas", "updatedReplicas", "readyReplicas", "availableReplicas")}
    if set(counts.values()) != {want}:
        return 1, f"{name}: rollout not complete ({', '.join(f'{k}={v}' for k, v in counts.items())}, spec.replicas={want})"
    mine = [rs for rs in rss if owned_by(rs, "Deployment", {md["uid"]})]
    revision = (md.get("annotations") or {}).get(REV)
    current = {rs["metadata"]["uid"] for rs in mine if (rs["metadata"].get("annotations") or {}).get(REV) == revision}
    if not current:
        return 1, f"{name}: no current ReplicaSet (revision {revision})"
    others = {rs["metadata"]["uid"] for rs in mine} - current

    def live(p):  # still running, or on its way out (Terminating): it may still serve
        return (p.get("status") or {}).get("phase") not in ("Succeeded", "Failed")

    old = [p["metadata"]["name"] for p in pods if owned_by(p, "ReplicaSet", others) and live(p)]
    if old:
        return 1, f"{name}: pod(s) of an earlier ReplicaSet still running or terminating: {', '.join(old)}"
    cur = [p for p in pods if owned_by(p, "ReplicaSet", current) and live(p)]
    ignored = len(pods) - len(cur) - len([p for p in pods if owned_by(p, "ReplicaSet", others)])
    note = f" ({ignored} other pod(s) with the same labels ignored: not of this Deployment)" if ignored else ""
    if not cur:
        return 1, f"{name}: no pod of the current ReplicaSet{note}"
    not_ready = [p["metadata"]["name"] for p in cur if not ready(p)]
    if not_ready:
        return 1, f"{name}: pod(s) of the current ReplicaSet not Ready: {', '.join(not_ready)}"
    since = ts(deployed)
    stale = [p["metadata"]["name"] for p in cur if not (p.get("status") or {}).get("startTime") or ts(p["status"]["startTime"]) <= since]
    if stale:
        return 1, f"{name}: pod(s) started before the Secrets it reads changed: {', '.join(stale)}"
    return 0, f"{name}: rollout complete, all {len(cur)} pod(s) Ready and started after the Secrets it reads changed{note}"


def pods_verdict(obj, pods, since_iso):
    """StatefulSet / DaemonSet: the rollout is complete and every live pod the workload owns is Ready
    and started after <since> (a pod started after the Secret changed has read the new value)."""
    md, spec, st = obj["metadata"], obj.get("spec") or {}, obj.get("status") or {}
    name = f"{obj['kind']}/{md['name']}"
    if st.get("observedGeneration") != md.get("generation"):
        return 1, f"{name}: the controller has not observed the latest spec"
    if obj["kind"] == "StatefulSet":
        want = spec.get("replicas", 1)
        if want == 0:
            return 2, f"{name}: scaled to 0 replicas"
        counts = {"replicas": st.get("replicas", 0), "readyReplicas": st.get("readyReplicas", 0),
                  "updatedReplicas": st.get("updatedReplicas", 0)}
        if set(counts.values()) != {want} or st.get("currentRevision") != st.get("updateRevision"):
            return 1, f"{name}: rollout not complete ({', '.join(f'{k}={v}' for k, v in counts.items())}, spec.replicas={want})"
    else:
        want = st.get("desiredNumberScheduled", 0)
        if want == 0:
            return 2, f"{name}: scheduled on no node"
        counts = {k: st.get(k, 0) for k in ("currentNumberScheduled", "updatedNumberScheduled", "numberReady", "numberAvailable")}
        if set(counts.values()) != {want}:
            return 1, f"{name}: rollout not complete ({', '.join(f'{k}={v}' for k, v in counts.items())}, desired={want})"
    mine = [p for p in pods if owned_by(p, obj["kind"], {md["uid"]}) and (p.get("status") or {}).get("phase") not in ("Succeeded", "Failed")]
    if not mine:
        return 1, f"{name}: no pod"
    not_ready = [p["metadata"]["name"] for p in mine if not ready(p) or p["metadata"].get("deletionTimestamp")]
    if not_ready:
        return 1, f"{name}: pod(s) not Ready or terminating: {', '.join(not_ready)}"
    since = ts(since_iso)
    stale = [p["metadata"]["name"] for p in mine if not (p.get("status") or {}).get("startTime") or ts(p["status"]["startTime"]) <= since]
    if stale:
        return 1, f"{name}: pod(s) started before the Secrets it reads changed: {', '.join(stale)}"
    return 0, f"{name}: all {len(mine)} pod(s) Ready and started after the Secrets it reads changed"


def load(path):
    with open(path) as f:
        text = f.read().strip()
    return json.loads(text) if text else None


def main(dep_path, rs_path, pods_path, deployed):
    dep = load(dep_path)
    rss = (load(rs_path) or {}).get("items", [])
    pods = (load(pods_path) or {}).get("items", [])
    rc, line = verdict(dep, rss, pods, deployed)
    print(line)
    return rc


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:5]))
