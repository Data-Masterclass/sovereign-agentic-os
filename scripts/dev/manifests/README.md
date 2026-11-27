# scripts/dev/manifests — operator-owned objects on the dev cluster

What the dev CI account (`sovereign-os-ci`, a namespaced deploy role) may NOT create, so a cluster
admin applies it with the **admin** kubeconfig. Helm never renders these objects and never owns them.
The context is `$DEV_KUBE_CONTEXT` (default `dmagosdev`, see `scripts/dev/lib.sh`).

| File | What | Applied by |
|---|---|---|
| `namespaces.yaml` | the namespaces + their Pod Security labels | `bootstrap-secrets.sh`, `ci-kubeconfig.sh` |
| `ci-rbac.yaml` | the CI account and its namespaced deploy role | `ci-kubeconfig.sh` |
| `node-sysctl.yaml` | `vm.max_map_count` DaemonSet in kube-system (OpenSearch) | `platform.sh` |
| `scanner-roles.yaml` | os-ui's (and the worker's) Role/RoleBinding in the software scanner's namespace `agentic-os-scans` (generated, drift-checked by `check-dev-app-builder-roles.mjs`) | by hand, after `namespaces.yaml` (`docs/components/software-scanner.md` "Dev") |
| `os-ui-nodes-rbac.yaml` | os-ui may `get,list` nodes (Platform → Cluster node list) | `ci-kubeconfig.sh`, or once by hand (below) |
| `os-ui-capacity-rbac.yaml` | os-ui may `list` pods cluster-wide (Monitoring → Platform → Capacity) | `ci-kubeconfig.sh`, or once by hand (below) |

## os-ui node list (one-time apply)

`values.dev.yaml` turns the node list on (`osUI.nodesReader.enabled: true`) but tells the chart not
to create the ClusterRole (`osUI.nodesReader.createClusterRole: false`). The grant — exactly the
chart's: `get, list` on `nodes`, bound to ServiceAccount `os-ui` in `agentic-os` — is
`os-ui-nodes-rbac.yaml`, under its own `sovereign-os-os-ui-nodes` names so it never collides with the
chart's `<release>-os-ui-nodes`. Apply it once, from the repo root, with the admin kubeconfig:

```bash
kubectl --context "${DEV_KUBE_CONTEXT:-dmagosdev}" apply -f scripts/dev/manifests/os-ui-nodes-rbac.yaml
# proof, from the API server itself (expect: yes / no):
kubectl --context "${DEV_KUBE_CONTEXT:-dmagosdev}" auth can-i list nodes --as system:serviceaccount:agentic-os:os-ui
kubectl --context "${DEV_KUBE_CONTEXT:-dmagosdev}" auth can-i watch nodes --as system:serviceaccount:agentic-os:os-ui
```

No restart is needed: os-ui reads `GET /api/v1/nodes` on every Platform page load. Until the grant
exists, Platform → Overview & health shows a red `Nodes not readable (forbidden)` — the honest state.
Remove: `kubectl --context "${DEV_KUBE_CONTEXT:-dmagosdev}" delete -f scripts/dev/manifests/os-ui-nodes-rbac.yaml`.

## os-ui capacity card (one-time apply)

`values.dev.yaml` turns the capacity reader on (`osUI.capacityReader.enabled: true`) without the chart's
ClusterRole (`createClusterRole: false`). The grant — `list` on `pods` in all namespaces, bound to
ServiceAccount `os-ui` in `agentic-os` — is `os-ui-capacity-rbac.yaml`:

```bash
kubectl --context "${DEV_KUBE_CONTEXT:-dmagosdev}" apply -f scripts/dev/manifests/os-ui-capacity-rbac.yaml
# proof (expect: yes / no):
kubectl --context "${DEV_KUBE_CONTEXT:-dmagosdev}" auth can-i list pods -A --as system:serviceaccount:agentic-os:os-ui
kubectl --context "${DEV_KUBE_CONTEXT:-dmagosdev}" auth can-i create pods/exec -n kube-system --as system:serviceaccount:agentic-os:os-ui
```

No restart is needed. Until the grant exists, Monitoring → Platform → Capacity shows
`Node requests unavailable (… forbidden …)` and `OOM kills unavailable` — the honest state.
