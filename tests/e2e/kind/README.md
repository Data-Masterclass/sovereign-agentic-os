# Acceptance harness on kind

The programme gate of the Sovereign Agentic OS master plan: the journeys **AT-a … AT-e** plus the
eject test **AT-f**, each with its negative twins. They exist **before** the work they prove and
run red until it lands (MASTER-PLAN WP-02; turned green by WP-48).

The rule for every assertion: **it reads the component's own record of the hop** (Dagster GraphQL,
Trino `system.runtime.queries`, the OpenSearch security audit log, Langfuse observations, OPA
decision logs, git, Kubernetes, Docling's access log), never an OS row on its own. The OS is only
*driven*, through its MCP endpoint as a real Keycloak user (`lib/os-driver.mjs`). The only faked
hop is the model: a scripted OpenAI-compatible stub that counts requests (`model-stub/`).

## Run it

```sh
tests/e2e/kind/up.sh      # kind "wp02" + Calico + our images + SeaweedFS + the chart
tests/e2e/kind/run.sh     # self-test, then journeys; report in tests/e2e/kind/report/
tests/e2e/kind/down.sh    # delete the cluster
```

Needs docker, kind, kubectl, helm, python3 (PyYAML) and Node ≥ 22. Useful variables:
`E2E_CLUSTER` (default `wp02`), `E2E_VALUES` (an extra values file, for example one that turns
components off on a small laptop), `E2E_ALLOW_PARTIAL=1` (carry on when a workload is not Ready),
`E2E_BUILD_ONLY="mockModel dagster"`, `E2E_SKIP_BUILD=1`, `E2E_STOP_AFTER_INFRA=1`,
`E2E_IGNORE_XFAIL=1` (drop every expected-fail marker, as WP-48 runs it).

CI: `.github/workflows/e2e-kind.yml`, on demand and nightly, never on pull requests. Before anything
is installed it runs the capacity gate (`scripts/check-capacity.mjs`) against the runner's budget.
On the standard `ubuntu-latest` runner (4 vCPU / 16 GB) the requests fit but the memory limits do not,
so the gate fails there by design. The recommended runner is an 8-core larger runner, selected with
the repository variables `E2E_RUNNER` and `E2E_CAPACITY_BUDGET=tests/e2e/kind/capacity.e2e-8core.yaml`.
It costs $0.022/min (about $2 a run) and needs a paid GitHub plan.

The official all-red baseline is the first nightly run on `main` with the full chart installed. A
local run on a small laptop only proves the harness itself.

## Layout

| Path | What |
|---|---|
| `cluster.yaml`, `versions.env` | kind with the default CNI off; pins for kind, Calico, SeaweedFS |
| `values.e2e-limits.yaml`, `capacity.e2e*.yaml` | memory limits sized for CI; the runner budgets the capacity gate checks |
| `values.e2e.yaml` | the harness profile on top of `values.local.yaml`: no offline mock, SeaweedFS, the stub behind LiteLLM's production model list, the agent worker as its own Deployment |
| `manifests/seaweedfs.yaml` | SeaweedFS S3 + the chart's buckets |
| `model-stub/` | scripted, request-counting OpenAI-compatible upstream |
| `lib/records/*.mjs` | one reader per component record |
| `lib/journey.mjs` | assertions, negative twins (each red twin must name the one reason that proves its hop: `redReasonMust`), the expected-fail marker, the report |
| `lib/checks/` | journey judgements as pure functions, tested without a cluster |
| `journeys/journey-{a..f}-*.e2e.mjs` | AT-a … AT-f |
| `journeys/app-builder-journey.sh` | the App Builder journey (own kind cluster, not this harness's chart install; CI: `app-builder-e2e.yml`) |
| `selftest/` | the harness proving itself (Calico enforces policy, S3, stub, reachability) and the framework's own tests |

## Status words in the report

- **red**: marked expected-fail and red. This is the intended state until the WP named in "Closed by" lands.
- **unexpected-green**: marked expected-fail but green. The run fails until the marker is removed.
- **failed**: not marked and red, which means the harness itself or a regression. The self-test must never show this.
- A twin is meaningful only when its positive check is green first. A twin that stays green with its hop disabled fails the run, because the test cannot see that hop.

The OS calls in the driver use the MCP tool argument names as of this commit. The WP that changes a
tool updates the journey in the same PR.
