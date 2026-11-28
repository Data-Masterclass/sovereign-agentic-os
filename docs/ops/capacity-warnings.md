<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Capacity warnings: Monitoring → Platform → Capacity

On 2026-11-27 a class of about twelve people could hardly run agents. The cause was measured: the
os-ui-worker ran **one** agent run at a time, so queued runs waited 522 s to 2,095 s
(`run_jobs.created_at` → first `run_events.at`) while the node sat at 8 % CPU and 43 % memory and the
model gateway never went above 8 concurrent calls, with no 429 or 5xx. Nobody was warned, and the
obvious wrong answer ("buy a bigger server") would not have helped.

The Capacity card (admin only) and `get_monitoring_overview` → `capacity` (admin only) now say so, with
the fix. Code: `os-ui/tabs/monitoring/lib/capacity-core.ts` (pure rules and folds, tested),
`os-ui/tabs/monitoring/lib/adapters/capacity.ts` (reads, shared for 30 s), `adapters/run-queue.ts` (run-store SQL).

**os-ui holds no cluster-wide pod grant.** Pod requests, node allocatable and OOM kills come from
kube-state-metrics (Apache-2.0, `components/kube-state-metrics/UPSTREAM.md`), which VictoriaMetrics scrapes;
os-ui only runs PromQL. kube-state-metrics has its own ServiceAccount with `list, watch` on pods and nodes,
`--resources=pods,nodes`, a strict `--metric-allowlist` (`observability.kubeStateMetrics.metrics`), a restricted
security context and an ingress policy that admits VictoriaMetrics alone. `scripts/check-kube-state-metrics-chart.mjs`
asserts all of it on the rendered chart, including that no ClusterRole bound to os-ui grants anything on pods.

## Signals: what is measured, and from where

| Signal | Source | If it does not answer |
|---|---|---|
| Node CPU / memory **requests** vs allocatable | kube-state-metrics via VictoriaMetrics: `kube_node_status_allocatable`, `kube_pod_container_resource_requests`, `kube_pod_init_container_resource_requests` + `kube_pod_init_container_info{restart_policy="Always"}`, minus Succeeded/Failed pods (`kube_pod_status_phase`). Kubernetes' rule: max(app + sidecars, largest regular init + sidecars) — native sidecars are summed; container order is not in the metrics, so all sidecars count during every init container (an upper bound). Pod overhead is not exported and not added | kube-state-metrics off → "not measured"; on but no series (not scraped) → "not measured" with that reason; VictoriaMetrics down → "unavailable" |
| OOM kills, last 24 h | `kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}`, `_last_terminated_timestamp`, `_restarts_total`; app name from `kube_pod_labels` (allowlisted label `app.kubernetes.io/name`). A container that is still terminated (never restarted) is not in the *last*-terminated series | as above |
| Node memory use (now, and its minimum over 1 h); CPU cores (now, 1 h average) | VictoriaMetrics, kubelet_stats via the Collector (`CAPACITY_PROMQL`) | "unavailable"; usage shows "—", never 0 |
| Agent-run queue: queued, running, oldest wait, p95 wait-to-start and p95 run duration over the last hour | the run store (`run_jobs` + `run_events`, `agent_runs` database) | "unavailable" |
| Model gateway 429 / timeouts | **not measured** — os-ui reads LiteLLM for spend and keys only; nothing it reads counts rate-limited or timed-out calls per hour | always "not measured" |

The headline is `partial` when some signals did not answer and `unknown` when none did — never
"healthy" on missing data.

## Thresholds (defaults; per install under `osUI.capacity.thresholds`)

| Key | Default | Meaning |
|---|---|---|
| `memRequestsWarn` / `memRequestsCrit` | 0.75 / 0.85 | node memory requests ÷ allocatable |
| `cpuRequestsWarn` / `cpuRequestsCrit` | 0.80 / 0.90 | node CPU requests ÷ allocatable |
| `memUsageWarn` | 0.80 | node memory use; "stays high" = its 1 h minimum is above this |
| OOM kill | any in 24 h → warning; `restartCount ≥ 2` → critical | per container |
| `queueWaitWarnSec` / `queueWaitCritSec` | 60 / 300 | oldest queued run; when the queue is empty, the last hour's p95 wait-to-start |
| `runP95WarnSec` | 600 | p95 duration of runs finished in the last hour (first pass, done/failed) |
| `modelErrorRateWarn` | 0.02 | 429 + timeouts ÷ calls in 1 h (no source yet) |

An invalid override (a ratio outside (0, 1], a non-number, a warn above its critical) keeps the default
and is listed on the card. Env names: `OS_CAPACITY_*` (`THRESHOLD_ENV` in capacity-core.ts).

## The verdict rules

- **Bigger flavour / second node only** when node **requests** cross the critical threshold, or memory
  use stays above `memUsageWarn` for an hour. The text names the next flavour (`m3i.8 → m3i.16`) and,
  for a single-node pool, the SKE cluster autoscaler (node pool maximum > 1). How: `docs/ops/second-node.md`.
- Requests between warn and critical: "plan", explicitly no purchase today.
- **Runs waiting with room on the node → raise concurrency** (`osUI.worker.concurrency` or
  `osUI.worker.replicas`; with `AGENTS_WORKER=inline`, turn the worker on first). If the node is ALSO
  critical, the text says capacity first.
- An OOM kill → raise that container's limit (the chart values key is named for platform components) —
  never a node upgrade.
- p95 run duration → look at the runs (model latency, steps); concurrency shortens queues, not runs.

## What is not built (owner decisions)

- **Alert rules / paging.** The chart has no vmalert or Alertmanager; the thresholds are evaluated when
  the card or the MCP overview is read (results shared for 30 s). Continuous alerting needs vmalert
  (Apache-2.0, the VictoriaMetrics project) plus a notifier — a new component, so an owner decision. The
  node-request and OOM rules are already metrics now (kube-state-metrics); the run queue is read from
  Postgres and would need an exporter first.
- **VPA in recommendation-only mode.** kubernetes/autoscaler's Vertical Pod Autoscaler is Apache-2.0;
  only the recommender would run (`updateMode: "Off"`), it needs metrics-server (SKE ships it) and
  installs CRDs and cluster RBAC. Not installed here. If wanted (cluster admin, dev first):
  `git clone --depth 1 --branch vertical-pod-autoscaler-<pinned release> https://github.com/kubernetes/autoscaler && kubectl apply -f autoscaler/vertical-pod-autoscaler/deploy/vpa-v1-crd-gen.yaml -f autoscaler/vertical-pod-autoscaler/deploy/vpa-rbac.yaml -f autoscaler/vertical-pod-autoscaler/deploy/recommender-deployment.yaml`,
  then one `VerticalPodAutoscaler` per Deployment with `updatePolicy.updateMode: "Off"` and read
  `status.recommendation`.
- **Model gateway 429/timeouts.** Needs a source: LiteLLM's own Prometheus metrics scraped into
  VictoriaMetrics, or a LiteLLM API that counts failures per hour.

## Dev

Observability is off on dev (`observability.enabled: false`), so the card there reads node requests, usage and
OOM kills as "not measured" and shows the run queue. To try the whole card on dev: apply
`scripts/dev/manifests/kube-state-metrics-rbac.yaml` with the admin kubeconfig (the CI account cannot create
cluster RBAC; `values.dev.yaml` sets `observability.kubeStateMetrics.createClusterRole: false`), then switch
observability on for dev — a capacity decision for the dev node (`charts/sovereign-agentic-os/capacity.dev.yaml`).
