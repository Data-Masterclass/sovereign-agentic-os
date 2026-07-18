<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Admin Console — removed (superseded by Platform → Components)

> **This standalone service no longer ships.** As of os-ui 0.5.38 the separate `admin-console`
> workload has been removed from the chart. Everything it did is now a **native OS UI surface**.

Operating the stack — **live component status**, **on/off toggles** (scale a workload 0↔1),
each component's **address · login · summary · docs** — lives in the OS UI at **Platform →
Components** (`/components`).

**How it works now:** the OS UI reads the Kubernetes API **directly, server-side** (via a scoped
ServiceAccount) through `/api/platform/components`, `/api/platform/toggle`, and `/api/platform/doc`.
There is no cross-pod fetch to a separate console service, and the browser never holds the
Kubernetes token. This is the single operator front door.

```bash
kubectl -n agentic-os port-forward svc/os-ui 8080:3000   # http://localhost:8080 → Platform → Components
```

See [os-ui.md](./os-ui.md#platform--components--native-stack-operator) for details.
