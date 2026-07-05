<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Runbook — helm upgrade (the safe path)

Applies to every `helm upgrade` of the umbrella chart on a stateful cluster
(the live STACKIT deploy). Full chart-change deploys go through this path;
**image-only os-ui updates do not** — use
[deploy-os-ui.md](deploy-os-ui.md) for those.

## 0. The standing rule — backup first, always

```bash
deploy/pre-upgrade-backup.sh     # fresh pg dump + ad-hoc Velero backup, waits for both
```

If it fails, **fix the backup before touching the platform** (see
`docs/backups.md`). No exceptions — this is Tier 2 of the backup system.

## 1. Upgrade

```bash
export KUBECONFIG="$PWD/deploy/kubeconfig.yaml"
helm upgrade agentic-os charts/sovereign-agentic-os -n agentic-os \
  -f values.selfcontained.yaml -f values.stackit-selfhosted.yaml -f values.private.yaml \
  --timeout 45m        # the Superset init hook alone can take ~20 min
```

## 2. Known gotcha — the ClickHouse SSA conflict

Helm 4 applies **server-side**. If anything was ever changed out-of-band
(`kubectl set|patch|edit`) on a chart-managed object, that edit registered a
foreign field-manager, and the next upgrade dies with:

```
conflict occurred while applying object ... clickhouse
(.spec.template.spec.containers[clickhouse].resources.limits.memory)
```

Recovery (one-time, zero-risk when the live value already equals the chart
value — it is then a metadata-only ownership transfer, no restart):

```bash
helm upgrade agentic-os charts/sovereign-agentic-os -n agentic-os \
  -f values.selfcontained.yaml -f values.stackit-selfhosted.yaml -f values.private.yaml \
  --force-conflicts --timeout 45m
```

**The standing rule that keeps it from coming back:** chart-managed resources
(ClickHouse memory is the documented case — see the comment at
`clickhouse.resources` in `values.yaml`) change **only via the chart**, never
with an out-of-band `kubectl` edit.

## 3. Verify

```bash
helm history agentic-os -n agentic-os | tail -2     # status: deployed
kubectl -n agentic-os get pods | grep -v Running | grep -v Completed
```

Then spot-check the front door (`/`, Governance queue, one dataset query) and
confirm the nightly backup jobs are still scheduled
(`kubectl -n agentic-os get cronjob pg-dump`).
