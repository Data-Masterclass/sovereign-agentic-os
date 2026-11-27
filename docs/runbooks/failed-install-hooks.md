<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) -->

# A Helm hook failed: inspect it, re-run it, recover a partial install

The chart does part of its setup in Helm **hooks** — Jobs Helm runs after the main objects are applied:

| Hook Job | When | Weight | What it does |
|---|---|---|---|
| `pg-extra-databases-reconcile`, `seaweedfs-bucket-init` | post-install, post-upgrade | 5 | databases/roles, buckets |
| `os-governance-bootstrap`, `os-governance-migrate` | post-install, post-upgrade (governance store on) | 6, 7 | governance roles, DB, migrations |
| `register-opensearch-*`, `opensearch-orphan-cleanup`, `opa-reassert-principals` | post-install, post-upgrade | 1–3 | snapshot repos, OPA principals |
| `polaris-catalog-init` | post-install, post-upgrade | 10 | the `lakehouse` Iceberg catalog |
| `polaris-purge` | post-install, post-upgrade | 11 | the delete-window principal (on/off) |
| `dbt-build` | **post-install only** | 15 | demo dbt project |
| `northpeak-marts-init` | **post-install only** | 20 | the Northpeak gold mart (ensures the catalog itself first) |

Two Helm rules decide what a failure leaves behind:

1. **Helm stops the hook chain at the first failed hook** and marks the release `failed`. Hooks with a higher
   weight never run.
2. **Helm never re-runs `post-install` hooks.** The next `helm upgrade` runs the `post-upgrade` ones only, so a
   post-install-only hook (`dbt-build`, `northpeak-marts-init`) that failed or never ran stays missing until it
   is run by hand.

## 1. Inspect the failure

Every chart hook Job is deleted by Helm **only when it succeeds** (`helm.sh/hook-delete-policy:
before-hook-creation,hook-succeeded`, no `ttlSecondsAfterFinished`), so a failed one — and its pods and logs —
stays until the next run of that hook replaces it:

```sh
NS=agentic-os
helm -n $NS status agentic-os                 # STATUS: failed + the error
kubectl -n $NS get jobs                       # the failed hook Job is still there
kubectl -n $NS describe job northpeak-marts-init
kubectl -n $NS logs job/northpeak-marts-init --all-containers --prefix
```

Fix the cause first (the log says what): an OOM-killed dependency, a missing Secret, a component that is not
Ready yet (`kubectl -n $NS get pods`).

## 2. Re-run the hooks

**post-upgrade hooks** (everything except `dbt-build` and `northpeak-marts-init`): run the same `helm upgrade`
again, with the same chart and values. It re-runs every post-upgrade hook in weight order (each is idempotent)
and moves the release out of `failed`. `scripts/deploy.sh` does exactly that for production/dev.

**post-install-only hooks**: Helm keeps the rendered hook manifests of the release (`helm get hooks`). Re-create
the Job from there — it is the exact manifest Helm ran, with the release's values:

```sh
NS=agentic-os; JOB=northpeak-marts-init      # or dbt-build
kubectl -n $NS delete job $JOB --ignore-not-found
helm -n $NS get hooks agentic-os \
  | awk -v j="$JOB" '/^---/{if (doc ~ ("\n  name: " j "\n") && doc ~ /\nkind: Job\n/) print doc; doc=""; next} {doc = doc "\n" $0} END{if (doc ~ ("\n  name: " j "\n") && doc ~ /\nkind: Job\n/) print doc}' \
  | kubectl -n $NS create -f -
kubectl -n $NS wait --for=condition=complete job/$JOB --timeout=20m
kubectl -n $NS logs job/$JOB --all-containers --prefix
```

The Job carries the hook annotations; created with `kubectl` they are inert (only Helm acts on them), so delete
it yourself once it succeeded: `kubectl -n $NS delete job $JOB`.

## 3. A partial install

A first install that failed in a hook has every main object applied (the hooks run last), so in most cases
fixing the cause and running §2 is enough. If the release is `failed` and you want a clean slate instead:
`helm -n agentic-os uninstall agentic-os`, then delete the PVCs only if the data may go, then install again.
Do not `helm rollback` a failed **first** install: there is no earlier revision to return to.

## Polaris specifically ("Unable to find warehouse lakehouse")

The `lakehouse` catalog lives in Polaris' metastore. With `polaris.persistenceType: relational-jdbc` (the
default since the pilot fixes) it survives Polaris restarts; with `in-memory` every restart — an OOM kill
included — loses it. `polaris-catalog-init` (re-run by any `helm upgrade`) and the first initContainer of
`northpeak-marts-init` (`ensure-catalog`) both create it when it is missing, through Polaris' management API
(`POST /api/management/v1/catalogs`). An OOM-killed Polaris: check `polaris.resources` and
`polaris.jvm.maxRamPercentage` (`docs/components/polaris.md`).
