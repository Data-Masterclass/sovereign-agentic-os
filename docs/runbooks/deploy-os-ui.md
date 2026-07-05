<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Runbook — deploy an os-ui update (image-only fast path)

For **app-code-only** changes (the `os-ui/` Next.js app), the platform is not
re-helmed. The os-ui image carries its own version line (`0.1.x`, independent
of the chart/app semver) and rolls with `kubectl set image`. Chart or values
changes go through [helm-upgrade.md](helm-upgrade.md) instead.

## 1. Build + push the image

```bash
cd os-ui
VER=0.1.33   # next os-ui image version
docker build -t ghcr.io/aborek/sovereign-os/os-ui:$VER .
docker push ghcr.io/aborek/sovereign-os/os-ui:$VER
```

## 2. Record the version in the values file (source of truth)

In `values.stackit-selfhosted.yaml` under `osUI.image`:
- bump `tag: "0.1.33"`, and
- add a one-line `# 0.1.33 = …` changelog comment above it (the running
  convention — see the 0.1.32 entry there).

Commit this. Keeping the chart tag in sync is what makes the fast path safe:
the next full `helm upgrade` then converges on the **same** image instead of
rolling the app back.

## 3. Roll the deployment

```bash
export KUBECONFIG="$PWD/deploy/kubeconfig.yaml"
kubectl -n agentic-os set image deploy/os-ui os-ui=ghcr.io/aborek/sovereign-os/os-ui:$VER
kubectl -n agentic-os rollout status deploy/os-ui --timeout=5m
```

## 4. Verify

- `kubectl -n agentic-os get deploy os-ui -o jsonpath='{.spec.template.spec.containers[0].image}'`
- Sign in, check the version-sensitive surface you shipped, and confirm
  artifacts survived the roll (the OpenSearch mirror hydrates the stores —
  any prior approvals/datasets should still be there).

## Notes

- **State**: an os-ui roll restarts the in-process stores; they re-hydrate
  from the OpenSearch mirror (`lib/os-mirror.ts`). Writes made in the seconds
  before the roll may be lost (write-to-mirror race) — roll in a quiet moment.
- **SSA scope**: `kubectl set image` on `deploy/os-ui` is the *sanctioned*
  out-of-band edit, tolerated because step 2 keeps the chart in agreement.
  Do **not** extend the habit to other chart-managed objects — that is exactly
  what caused the ClickHouse SSA conflict (see helm-upgrade.md §2).
