<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG -->

# os-ui Secret access in the platform namespace (2026-11-27)

**Owner decision:** narrow what the `os-ui` ServiceAccount may do with Secrets in its own (release)
namespace when `osUI.externalConnectorsEnabled` is on. Production has the flag on.

## What changed

| | Before | After |
|---|---|---|
| os-ui Role, `secrets` rule (flag on) | `get`, `list`, `create`, `patch`, `update`, namespace-wide (one rule shared with `configmaps`) | `create`, `update` only, in a rule of its own |
| os-ui Role, `configmaps` rule (flag on) | the same shared rule | unchanged verbs (`get`, `list`, `create`, `patch`, `update`) |
| flag off | no Secret rule | no Secret rule (unchanged) |
| `trino-ext-<catalog>` write | `GET` the Secret, then `PUT` if it exists, else `POST` | `POST`; on `409 Conflict`, `PUT` |

With the flag on, os-ui can no longer read or list **any** Secret in the release namespace. The one
name it may still read there is `zot-pull` (the read-only registry pull identity, its own
`resourceNames` rule in `software-registry.yaml`, unchanged).

## Which Secrets the external-connector code touches

Every Kubernetes Secret API call made by the external-connector and runtime code, found by grep
(`/secrets` paths, `labelSelector`, `extSecretName`, `getSecretServerSide`) across `os-ui/core`,
`os-ui/tabs`, `os-ui/app` and `os-ui/worker`:

| Code | Namespace | Secret(s) | Calls | Covered by |
|---|---|---|---|---|
| `tabs/connections/lib/warehouse/k8s-registration.ts` (live warehouse catalog registration and teardown) | release | `trino-ext-<catalog>`, one per registered catalog | was `GET`/`PUT`/`POST`, `DELETE` on teardown; now `POST`/`PUT`, `DELETE` on teardown | **this rule** |
| `core/infra/secret-backend.ts`, `core/infra/key-state.ts` (connection credential store) | `<release>-conn-secrets` | `os-conn-secret-*`, keyring | get/list/create/update/delete | `os-ui-connection-secrets` Role (dedicated namespace, unchanged) |
| `core/adapters/zot/client.ts` | release / build | `zot-pull` (get by name), per-domain push Secret | get, create | `os-ui-zot-users`, `os-ui-zot-push-secrets` (unchanged) |
| `tabs/software/lib/scan-trivy.ts` | scanner namespace (`<release>-scans`, never the release namespace) | scan payload | create, delete | `os-ui-software-scanner`, fenced by the `<release>-software-scanner-shape` admission policy (`docs/components/software-scanner.md`) |
| `core/adapters/cnpg/client.ts`, `tabs/software/lib/domain-delete.ts` | `apps-*` / runner | app DB and TLS Secrets | per their Roles | unchanged |

No connector code lists Secrets or selects them by label. The external-connector code needs exactly
one family, `trino-ext-<catalog>`, which it **writes** but never needs to read back: it owns the whole
object.

## Why this option

- **`resourceNames` for a fixed list:** not possible. The name is derived from the catalog the user
  registers, so there is no static list, and `create` cannot be restricted by name in RBAC at all.
- **A dedicated namespace (the `conn-secrets` pattern):** would break the feature. Trino reads the
  credential through `secretKeyRef` in its Deployment, and a `secretKeyRef` resolves only in the
  pod's own namespace. Moving the Secrets would also need a migration of every existing
  `trino-ext-*` Secret plus a Trino roll in prod.
- **Write-only (chosen):** the code was changed to create-or-replace without a read, so the read
  verbs could go. It needs **no data migration**. Existing `trino-ext-*` Secrets stay where they
  are, under the same name, and the next registration of a catalog replaces its Secret in place
  (`409` → `PUT`). Nothing is deleted, moved or renamed. A Role change does not restart any pod.

## Known limits (not changed here)

- `create` / `update` on Secrets are still namespace-wide in the release namespace. RBAC cannot pin
  them to the `trino-ext-` prefix. A follow-up could add a ValidatingAdmissionPolicy that limits
  os-ui's Secret writes there to that prefix. (The software scanner no longer writes Secrets in the
  release namespace: since 2026-11-27 it runs only in its own namespace, `docs/components/software-scanner.md`.)
- Teardown (`removeLiveRegistration`) issues a `DELETE` on `trino-ext-<catalog>`. Neither the old
  Role nor the new one grants `delete`, so on a real cluster that step reports a partial removal
  and the Secret is left behind. This is unchanged and deliberately not widened here.

## Rollout: dev first, prod only after the owner has tested

1. Merge. CI runs `scripts/check-os-ui-secret-read-chart.mjs` (via `os-ui/scripts/gate.sh`), which
   renders the chart with the flag off and on, with the worker, software runner and App Builder,
   and fails if os-ui can `get`/`list`/`watch` any Secret in the release namespace other than
   `zot-pull` by name.
2. **Dev** (`main` auto-deploys to dev): turn on `osUI.externalConnectorsEnabled` there if it is
   off, then verify:
   ```bash
   NS=agentic-os   # the dev release namespace
   SA=system:serviceaccount:$NS:os-ui
   kubectl auth can-i get    secrets --as=$SA -n $NS                 # no
   kubectl auth can-i list   secrets --as=$SA -n $NS                 # no
   kubectl auth can-i create secrets --as=$SA -n $NS                 # yes
   kubectl auth can-i update secrets/trino-ext-example --as=$SA -n $NS   # yes
   kubectl auth can-i get    secrets/zot-pull --as=$SA -n $NS        # yes (unchanged)
   ```
   Then, as a user, register an external warehouse connection (or re-register an existing one).
   It must report "Registered catalog … live", and Trino must restart and list the catalog. A
   re-registration exercises the `409` → `PUT` path on an existing Secret.
3. **Prod:** only after the owner has tested on dev and says go, through the normal release
   (`./scripts/release.sh`). Nothing to migrate. To confirm afterwards, run the same `kubectl auth
   can-i` checks against the prod namespace.

**Rollback:** redeploy the previous chart version. The Role returns to its old verbs and the old
code path (`GET` first) works with it. No Secret was changed by the upgrade itself.
