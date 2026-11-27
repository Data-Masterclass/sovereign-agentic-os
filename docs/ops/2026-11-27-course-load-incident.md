<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Course load incident, 27 Nov 2026: findings and plan

For the owner and the operator. During the training course on 2026-11-27, participants had
"major problems running agents". This page records what was measured on prod, the root causes
ranked by impact, and the plan (built in PRs, or left as decisions) so the next course runs
cleanly. All times are UTC. Every number comes from a read-only source on the prod cluster
(`dmagenticos`, namespace `agentic-os`): the `agent_runs` and `litellm` databases (read-only
transactions), pod logs, the ingress access log, `kubectl top` and the kubelet's cAdvisor
counters. VictoriaMetrics history could not be read (the API-server service proxy is blocked
by NetworkPolicy), so there are no 7-day percentiles here.

## Summary

- **The server was not too small.** On the course day the node peaked far below its limits: 8 % CPU
  and 43 % memory in use. The model gateway never had more than 8 calls in flight and returned no
  429 or 5xx.
- **The main cause was how we run agents.** The `os-ui-worker` ran **one agent run at a time**.
  During the main exercise (13:07 to 13:41), 22 runs were filed and executed one after another. Runs
  waited in the queue for **up to 35 minutes** before their first step (13:19 to 14:13).
- **The second cause was output budgets that were too small for reasoning models.** The worker
  cannot read the gateway catalog, because it has no admin key (that is by design). So it used
  built-in output caps of 8 000 tokens (`sovereign-strong`) and 4 000 tokens (`sovereign-worker`).
  **8 of the day's 10 failed runs** stopped with "the model spent its whole output budget on
  reasoning".
- **Verdict on the server:** keep the m3i.8 for now. With the worker running 6 runs in parallel
  (PR below), it covers a class like this one (about 10 to 15 active participants). For about 25,
  raise `osUI.worker.concurrency` to 12; no new hardware is needed for that. Upgrade or add a node
  only when the thresholds in [Capacity: when to upgrade](#capacity-when-to-upgrade) are crossed.

## What was measured

### Runs (table `run_jobs`, 27 Nov)

The day had 69 runs: 56 `done`, 10 `failed` and 3 `parked` (approvals, as designed). The course
peak was 13:00 to 13:45:

| 15 min from | runs started | done | failed | distinct users | p50 total s | p90 total s |
|---|---|---|---|---|---|---|
| 12:45 | 2 | 1 | 0 (1 parked) | 2 | 156 | 263 |
| 13:00 | 2 | 1 | 1 | 1 | 391 | 473 |
| 13:15 | 15 | 14 | 1 | 8 | 1 103 | 2 119 |
| 13:30 | 7 | 7 | 0 | 6 | 1 993 | 2 041 |

"Total" means from filing the run to settling it. **Queue wait** is the time from `created_at` to
the run's first `run_events` row. The waits rose in steps as each run queued behind the one before:

```
created   user          wait to first step   total
13:18:05  participant   88 s                 233 s
13:19:13  participant   522 s                630 s
13:20:32  participant   639 s                721 s
13:22:23  participant   1 009 s              1 165 s
13:23:12  participant   1 515 s              1 942 s
13:24:30  participant   2 036 s              2 128 s
13:28:19  participant   2 095 s              2 240 s
13:41:02  participant   1 891 s              1 922 s
```

Execution time alone (total minus wait) was 57 to 427 s, about 180 s on average. So the runs
themselves were reasonably fast; the queue in front of them was the problem.

**Failure reasons, ranked (10 failed runs):**

| # | reason | runs | roles |
|---|---|---|---|
| 1 | "the model spent its whole output budget on reasoning (≈4 000 / ≈8 000 tokens)" | 8 | strong 6, worker 2 |
| 2 | "the model wrote a tool call as text instead of calling it (qwen/hermes `<tool_call>`)" | 2 | `sovereign-worker` = `minimax-m3.1-flash` behind an `openai/` (OpenAI-compatible) route |

### Model gateway (table `LiteLLM_SpendLogs`, 27 Nov)

- 1 544 chat calls on the day; 736 between 12:30 and 14:30. All succeeded: there were no 429 or
  5xx responses, and none of the log lines matched rate limit, timeout or overload.
- The most calls in flight at once, per 15 minutes, reached **8** at 13:30 (6 at 13:00, 7 at 13:15).
- Per-call latency: on average 4 to 19 s; p95 up to 56 s for `sovereign-strong`
  (`deepseek-v4.1-flash`) and up to 30 s for `sovereign-worker` (`minimax-m3.1-flash`).
- **Calls that ended exactly at the cap:** 108 of 848 `sovereign-strong` calls hit 8 000 tokens
  (13 %), and 56 of 696 `sovereign-worker` calls hit 4 000 (8 %).
- The worker logged `[models] could not read the model limits from LiteLLM (/model/info: HTTP 401)`
  on every run (161 times). The reads use the master key, which is admin-only and deliberately
  absent from the worker (`scripts/check-worker-env.mjs`). So the worker always used the built-in
  defaults. Separately, the catalog has **no `max_output_tokens` for `lyceum-deepseek-v4.1-flash`**
  (the model behind `sovereign-strong`). Even os-ui would fall back to 8 000 for it.

### Ingress (access log, client IP is always the load balancer 10.0.0.35)

- Peak hour 13:00, about 11 000 requests; 182 `run/stream` requests.
- `run/stream` p50 and p90 were both 240 s. That is the designed hand-off (`TAIL_BUDGET_MS`): the
  stream gives the client a cursor and the client re-attaches. It is not a failure. But a user
  whose run sat in the queue watched a panel that kept re-attaching with nothing happening, for up
  to 35 minutes.
- 65 HTTP 499 responses (the client gave up), with a median of 47 s: 41 on
  `/api/agents/systems/:id/run/stream`, 15 on `/api/mcp`, 7 on `…/assistant`, 3 on `…/run`.
- **No rate limiting bit.** The day had only 2 HTTP 429 responses (on `/recover` and `/about`), and
  none on any run, assistant or MCP path. The login limit is keyed per (IP, username), so the shared
  load-balancer IP does not lock a class out of signing in. The 503 bursts at 08 and 14 were bot
  scans (`/.env` and similar), not users.

### Pods and node (now, plus cAdvisor counters since each container started)

- Node: `kubectl top` shows 670 m CPU (8 %) and 22.8 GiB memory (43 %). `kubectl describe node`
  shows requests of 6 012 m CPU (76 %) and 16.5 GiB memory (31 %), and limits of 449 % CPU and 81 %
  memory.
- **CPU throttling:** os-ui was throttled in 11.3 % of its CPU periods (limit 500 m). The Dagster
  `repo-sync` container was throttled in 42 % (limit 500 m; it is not user-facing). Everything else
  was under 4 %.
- **Close to the memory limit:** opensearch at 1 410 of 1 536 MiB (92 %); litellm with a peak of
  1 336 of 1 536 MiB (87 %); minio with a peak of 1 543 of 1 536 MiB (page cache).
- **Requests below real use:** os-ui requested 128 Mi but used 464 MiB; trino requested 2 Gi but
  used 3.2 GiB.
- os-ui-worker: 394 MiB idle and 499 MiB at its peak, when it ran one run at a time.
- One restart on the day: **Valkey OOMKilled at 09:56** (limit 256 Mi, no `maxmemory`). That is
  fixed on main by PR #403 (512 Mi limit plus a 400 MB `maxmemory` cap), which ships in 0.9.38.
- Postgres: `max_connections` is 100, with about 40 in use.

## Root causes, ranked

1. **Serial run execution in the worker** (impact: every participant; up to 35 min waits). The code
   says it plainly: `engine/worker-loop.ts` had "ONE claim at a time", and the chart had
   `osUI.worker.replicas: 1`. The node, the gateway and the model provider all had headroom.
2. **The output budget was too small for reasoning models** (impact: 8 of 10 failures). There were
   two layers. The worker cannot read the catalog (HTTP 401, by design). And the catalog lacks
   `max_output_tokens` for the strong model. Both fall back to the built-in 8 000 / 4 000 caps. The
   existing retry (`core/runtime/reasoning-budget.ts`) then retries at `reasoning_effort: low` with
   the **same** cap, because the first call already used the "normal" reserve; the models kept
   thinking past it.
3. **No queue feedback in the UI** (impact: people gave up; 499s). A queued run looked like a
   running one, so users re-ran, reloaded or left.
4. **os-ui CPU limit of 500 m** (impact: slower chats, MCP and tails under load). It was throttled
   in 11 % of its CPU periods while the node was 92 % idle.
5. **minimax writes Hermes-style `<tool_call>` text** (impact: 2 runs). The engine detects this,
   re-prompts once, and then fails with a clear message. The upstream-correct fix is on the
   serving side (vLLM `--tool-call-parser` for the model, or a LiteLLM provider route that parses
   it), not text-parsing in our engine.
6. **The Valkey OOM** at 09:56 (fixed in #403) and the components close to their memory limits
   (opensearch, litellm). These did not cause today's failures, but they are the next crash.

These were **not** causes: node size, provider rate limits or throughput, per-IP rate limits,
Postgres connections.

## Plan

### (a) Immediate fixes for the next course

| # | what | why | effort | where | status |
|---|---|---|---|---|---|
| a1 | Worker runs N runs in parallel: `osUI.worker.concurrency` (prod 6, dev 4), one lease identity per slot, chores only on slot 0, `agent_runs` pool 10 + 2 per extra slot; worker 768Mi/2Gi | root cause 1 | S | `os-ui/tabs/agents/lib/engine/worker-loop.ts`, `build/run-jobs-server.ts`, `core/kernel/config.ts`, `core/adapters/postgres/pool.ts`, chart `osUI.worker` | **PR "course-ready limits"** |
| a2 | Built-in output reserve 16 384 for `sovereign-strong` and `sovereign-worker` (was 8 000 / 4 000) | root cause 2 | XS | `os-ui/core/models/context-windows.ts` | **same PR** |
| a3 | os-ui CPU limit 500 m → 2 | root cause 4 | XS | `charts/sovereign-agentic-os/values.yaml` `osUI.resources` | **same PR** |
| a4 | Add `max_output_tokens` (and `max_input_tokens`) to the gateway models by hand, dev first, then prod, checked with the parity script: at least `lyceum-deepseek-v4.1-flash`, with the provider's documented maximum | catalog gap behind root cause 2 | XS (ops) | LiteLLM UI/API per env (models are hand-made, `deploy/gateway-parity.yaml`) | **owner/ops step** |
| a5 | Let the worker read `/model/info` without the master key: LiteLLM answers `/model/info` for a virtual key with the models that key may use. The role mapping (`/router/settings`) would still come from os-ui (for example, os-ui writes the resolved limits to the mirror the worker already reads) | so a remapped role's limits reach the worker | M | `core/models/model-limits-live.ts`, `core/infra/litellm-admin.ts` | follow-up PR |
| a6 | `<tool_call>` text from minimax: ask the provider to enable its tool-call parser, or map `sovereign-worker` to a model that returns native tool calls; we do not text-parse tool calls in our engine | root cause 5 | owner decision | gateway config | **decision** |
| a7 | Run the load test (e) on dev before each course | prove it | S | `scripts/load/` | follow-up PR |

### (b) Load handling

- **Fair queueing per user.** Today the claim takes the oldest run (`ORDER BY created_at`). With N
  slots, one user who fires off 10 runs can still fill every slot. Proposal: a per-user cap on
  `running` (for example 2), enforced in the claim SQL (`… AND requested_by NOT IN (SELECT
  requested_by FROM run_jobs WHERE status='running' GROUP BY 1 HAVING count(*) >= $cap)`), with
  `SKIP LOCKED` kept. Effort M; `engine/jobs-postgres.ts` plus a test against the pg fixture.
- **Backpressure and clear UI messages.** The stream should send a `queued` event with the run's
  position and the oldest wait (one indexed `count(*)` on `run_jobs_queued_idx`), and the Run panel
  should show "Waiting for a free slot: 3 runs ahead of yours" instead of a spinner. When the queue
  is deeper than a threshold, `POST …/run` should still file the run but answer with the expected
  wait. Effort M; `app/api/agents/systems/[id]/run/stream/route.ts`, the Run panel, i18n in 7
  locales.
- **HPA.** os-ui and the worker are single-replica by design today. The approvals hydration and
  the os-repos RWO volume are per process (see the worker template header), so an HPA on them is
  **not** safe yet. Scale the worker vertically through `concurrency` first. LiteLLM is stateless
  (its state is in Postgres), so it could get an HPA, but at a peak of 8 calls in flight it does not
  need one. Revisit when its CPU passes 70 %.

### (c) Dynamic rightsizing

- **How limits change:** always by a chart values PR, gated by `scripts/check-capacity.mjs` for
  prod, dev and dev-m2i4. Never by a live `kubectl edit`; prod and dev must stay in sync.
- **PR "memory rebalancing" (#408):** raises the limits that were close to OOM (opensearch with its
  heap, litellm), raises requests that were below real use (os-ui 128 Mi → 512 Mi), lowers
  over-reserved limits (clickhouse 6 Gi → 5 Gi, query-tool 768 Mi → 512 Mi), and adds or keeps
  memory caps on stateful components where upstream offers one (as Valkey did in #403). With #408
  plus the course-ready-limits PR, the prod memory-limits gate sits at 83.0 % and CPU requests at
  63 %.
- **Recommendations without automation:** the Kubernetes Vertical Pod Autoscaler (Apache-2.0) in
  `updateMode: "Off"` gives per-container recommendations from real usage and changes nothing. Its
  recommender is one small pod. If installed, the monthly ritual is: read the recommendations, then
  open a values PR. This is an owner decision because it adds a component (CRDs, cluster scope).
  Goldilocks (Apache-2.0) is a UI on top of VPA and is not needed.

### (d) Capacity monitoring and the upgrade signal

PR "warn and suggest" adds an admin-only capacity card in Monitoring, plus thresholds, built only
from signals that exist. Where a source is missing, the card says "not measured" rather than
showing it as healthy.

| signal | warn | critical | recommendation |
|---|---|---|---|
| node memory requests | ≥ 75 % | ≥ 85 % | rebalance requests; then a bigger flavour or a second node |
| node CPU requests | ≥ 80 % | ≥ 90 % | lower over-reserved requests; then a bigger flavour or a second node |
| node memory in use | ≥ 80 % | — | find the grower; raise its cap or move it |
| OOMKill (24 h) | any | repeated, same container | raise that container's limit (values key named) |
| oldest queued run waiting | ≥ 60 s | ≥ 300 s | raise `osUI.worker.concurrency` (with an idle node this is never "buy a server") |
| p95 run duration (1 h) | ≥ 10 min | — | check model latency and the output caps |
| model 429 / timeouts (1 h) | > 2 % of calls | — | provider limit: raise the key's rpm/tpm or add a fallback model |

### Capacity: when to upgrade

The node is **not** the bottleneck today. Numbers on a single m3i.8 (7 910 m CPU and 52.6 GiB
allocatable):

- Usage on the course day: 8 % CPU and 43 % memory. Requests: 76 % CPU (63 % after #408) and 31 %
  memory. Memory limits are gated at 85 % and sit at 83 % after both PRs.
- The worker at 6 slots costs about +0.5 GiB. At 12 slots it costs about +1.1 GiB (≈ 395 MiB plus
  ≈ 100 MiB per running run), which still fits inside 2 Gi.
- Capacity for a class: the measured burst was 12 runs in 6 minutes, with runs of about 3 minutes
  each. That is about 6 in flight. **6 slots cover a class of about 10 to 15 active participants;
  12 slots cover about 25.** The gateway had 8 calls in flight without a 429, so the provider limit
  for 12 parallel runs is unknown. The dev load test (e) must show it before a 25-person course.
- **Upgrade (m3i.8 → the next larger flavour) or add a second node** when CPU or memory requests
  stay above 85 % after rebalancing, or memory in use stays above 75 % at peak, or a new always-on
  component does not fit under the gate. A second node with the SKE cluster autoscaler (node pool
  `maximum > 1`) is also the answer for **availability**. One node is a single point of failure
  whatever its size; decide on that separately from capacity.

### (e) Load test before each course

- **Tool:** an in-repo Node script (`scripts/load/course-sim.mjs`: Node's built-in `fetch`, no new
  dependency, Apache-2.0 like the repo). Locust (MIT) is the alternative if we want a UI. k6 is AGPL
  and forbidden by the licence policy.
- **Scenario:** N synthetic dev users sign in (the dev environment uses synthetic data), each opens a
  seeded agent system and starts a run every 2 to 4 minutes for 20 minutes, and tails its stream
  as the UI does. The script reports queue wait (p50/p95/max), run duration, failures by reason,
  499/5xx, and the worker's and node's memory and CPU (`kubectl top`, read-only).
- **Two passes:** `DEV_MODEL=stub` first, to measure our own platform at no cost; then real models
  for a short pass, to measure the provider.
- **Pass criteria for a course of N:** p95 queue wait < 60 s, no failed runs other than
  model-content failures, no OOMKill, node requests within the gates. Dev runs 4 slots and prod 6,
  so scale dev results by 6/4.

## PRs

- **Course-ready limits:** worker concurrency, output reserves, os-ui CPU (a1 to a3).
- **#408 memory rebalancing:** (c).
- **Warn and suggest:** (d).
- **Follow-ups not built yet:** a5 (catalog limits in the worker), fair per-user queueing and queue
  position in the UI (b), the load-test script (e).
- **Owner decisions:** a4 (catalog values, by hand per env), a6 (tool-call format: provider or
  model choice), VPA in recommendation mode, a second node or autoscaler for availability, and the
  real client IP (PROXY protocol on the STACKIT load balancer plus ingress-nginx
  `use-proxy-protocol`). That last one changes the edge for every request and is not needed for
  rate limiting today, because no run, chat or MCP path is limited per IP.
