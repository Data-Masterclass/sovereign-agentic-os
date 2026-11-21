#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# A Dagster run pod gets the user-code container's env and container context
# (`includeConfigInLaunchedRuns`), and authored dbt can read any env variable with `env_var()`.
# So that env must hold no credential. The repo-sync SIDECAR keeps its bearer: a sidecar's env is
# not the run container's, and the run pod's copy exits at once (POD_NAME).
# Checked on every profile that renders Dagster (the STACKIT profile disables it today).
# Not covered here: DAGSTER_PG_PASSWORD, which the Dagster subchart itself gives every run worker
# because the run writes its events to the instance database.
set -euo pipefail
cd "$(dirname "$0")/../.."
fail=0
for prof in "" "-f values.stackit-managed.yaml"; do
  out=$(helm template agentic-os charts/sovereign-agentic-os $prof 2>/dev/null | python3 -c '
import json, re, sys, yaml
SECRETISH = re.compile(r"TOKEN|SECRET|PASSWORD|BEARER|API_KEY", re.I)
SUBCHART_OWN = {"DAGSTER_PG_PASSWORD"}  # the Dagster subchart'"'"'s instance-database login (see the header)
bad, notes = [], []
for d in yaml.safe_load_all(sys.stdin):
    if not d or d.get("kind") != "Deployment" or "user-deployments" not in d["metadata"]["name"]:
        continue
    pod = d["spec"]["template"]["spec"]
    uc = next(c for c in pod["containers"] if c["name"] != "repo-sync")
    env = uc.get("env", [])
    for e in env:
        if e["name"] == "DAGSTER_CLI_API_GRPC_CONTAINER_CONTEXT":
            ctx = json.loads(e["value"])["k8s"]
            for x in ctx.get("env", []):
                if "valueFrom" in x or SECRETISH.search(x["name"]):
                    bad.append("container context env " + x["name"])
            for x in (ctx.get("env_secrets") or []):
                bad.append("container context env_secrets " + x)
        elif e["name"] in SUBCHART_OWN:
            continue
        elif "valueFrom" in e and "secretKeyRef" in e["valueFrom"]:
            bad.append("user-code env " + e["name"])
        elif SECRETISH.search(e["name"]):
            bad.append("user-code env " + e["name"])
    names = {e["name"] for e in env}
    if "OS_INDEX_FILE" not in names:
        bad.append("user-code env has no OS_INDEX_FILE (the principals sensor would read nothing)")
    side = [c for c in pod["containers"] if c["name"] == "repo-sync"]
    if not side or not any(e["name"] == "AGENT_RUNTIME_TOKEN" for e in side[0].get("env", [])):
        bad.append("the repo-sync sidecar lost its bearer (it fetches the OS index)")
    notes.append(d["metadata"]["name"])
print("\n".join(["checked " + n for n in notes] + ["BAD " + b for b in bad]))
')
  echo "$out"
  echo "$out" | grep -q '^checked ' || { echo "skip: this profile renders no Dagster code location ($prof)"; continue; }
  if echo "$out" | grep -q '^BAD '; then echo "FAIL ($prof)"; fail=1; fi
done
[ $fail = 0 ] && echo "dagster-run-pod-env: ok" || exit 1
