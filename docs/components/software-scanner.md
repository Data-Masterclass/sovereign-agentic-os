<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Software security scanner (Trivy) and its namespace

The software security scanner runs Trivy (Apache-2.0) once per deploy request over the app's committed
tree: dependency vulnerabilities from its manifests and lockfiles, plus committed secrets. os-ui starts one
Kubernetes Job per scan (`os-ui/tabs/software/lib/scan-trivy.ts`) and reads the result from the pod log. A
failed, timed-out or unreachable scan stays `unavailable` with its reason; it is never reported as a pass.

- Chart: `charts/sovereign-agentic-os/templates/base/os-ui/software-scanner.yaml`
- Values: `osUI.software.scanner` in `charts/sovereign-agentic-os/values.yaml`
- Env (os-ui and os-ui-worker): `SOFTWARE_SCANNER_ENABLED`, `_IMAGE`, `_NAMESPACE`, `_DB_MODE`, `_DB_REPOSITORY`,
  `_TIMEOUT_MS` (`templates/base/os-ui/_os-ui-env.tpl`)

## Where the scan runs

The scan runs in its **own namespace**, never in the release namespace:

| Value | Default | Meaning |
|---|---|---|
| `osUI.software.scanner.namespace` | `""` = `<release namespace>-scans` (`agentic-os-scans`) | the scanner namespace; the release namespace, the apps runner namespace, the App Builder env namespaces, the build namespace, the connection-credential namespace and `kube-system`/`kube-public`/`kube-node-lease`/`default` **fail the render** |
| `osUI.software.scanner.quota` | 3 pods, 6 Jobs, 6 Secrets, 500m/1Gi requests, 3/3Gi limits | the namespace's ResourceQuota |
| `osUI.software.scanner.createNamespace` | `true` | `false` = the operator creates the namespace (with the labels below) |
| `osUI.software.scanner.createOsUiRoles` | `true` | `false` = the operator applies os-ui's Role and RoleBinding there |
| `osUI.software.scanner.image.digest` | the Trivy 0.58.2 digest | **required**; the admission policy admits this image only |

os-ui resolves the same namespace (`scannerNamespace` in `scan-trivy.ts`: the env value, else
`<platform namespace>-scans`) and refuses the platform namespace and the same reserved list
(`reservedScanNamespaces`), before any Kubernetes call.

### Why

The scanner needs `create` on Jobs and `get` on `pods/log`. Until this change those rights were granted in the
release namespace. There, a Job that mounts any platform Secret (or reads it with `envFrom` /
`secretKeyRef`) and prints it would let os-ui, or anyone who can steer the Job spec, read every platform
Secret (`litellm-credentials`, `os-ui-session`, …) through the pod log.

### The four fences in the scanner namespace

1. **RBAC** (Role `os-ui-software-scanner`, bound to `os-ui` and `os-ui-worker`): Jobs create/get/list/watch/
   delete; pods and `pods/log` get/list/watch; Secrets **create and delete only** (the per-scan payload). No
   Secret get/list/watch/update, no pod create, no exec.
2. **Admission** (`<release>-software-scanner-shape`, a ValidatingAdmissionPolicy with a `Deny` binding, for
   every request in the namespace, whoever sends it). A Job or Pod is admitted only in the scanner's exact
   shape:
   - one container, no init or ephemeral containers;
   - the image `<repository>:<tag>@<digest>` from the values, nothing else;
   - volumes: `emptyDir`s and **one** Secret volume `payload` whose `secretName` is the Job's own name (so no
     other Secret, and no other scan's payload); no projected, hostPath, configMap or PVC volume;
   - no `envFrom`, no env `valueFrom` (so no `secretKeyRef`);
   - `automountServiceAccountToken: false`, the `default` ServiceAccount;
   - `runAsNonRoot`, seccomp `RuntimeDefault`, no privilege escalation, read-only root filesystem, not
     privileged, all capabilities dropped and none added;
   - no host network/PID/IPC, no container ports;
   - CPU and memory requests and limits; the payload mounted read-only; Job named `os-scan-*`, pods labelled
     `app.kubernetes.io/component=software-scanner`;
   - no fan-out: `parallelism` and `completions` at most 1, `backoffLimit` set and at most 1, no
     `priorityClassName`.

   Secrets are admitted only as `Opaque`, named `os-scan-*`, owned by a Job. This stops the write-only Secret
   grant from planting a ServiceAccount-token Secret, which the token controller would fill in.
3. **Network**: `software-scanner-default-deny` (ingress and egress, every pod), then
   `software-scanner-egress` for scan pods: DNS, plus TCP 443 to public address space when `dbMode: mirror`
   (the Trivy DB). With `dbMode: offline`, DNS only. "Public" is `soa.network.nonPublicCidrs`
   (`templates/base/network/_public-egress.tpl`), shared with the egress proxy and the direct-HTTPS
   workloads: 0.0.0.0/0 minus RFC1918, 100.64.0.0/10 (Gardener/SKE pods and Services, so ingress-nginx and every
   platform Service), 169.254.0.0/16 (metadata), 240.0.0.0/4 (the SKE API server endpoint) and
   `networkPolicies.apiserver.cidrs` + `extraCidrs`. Calico applies ipBlock to pod and endpoint addresses, so
   RFC1918 alone would not keep a scan pod off the API server on SKE.
   A ResourceQuota (`software-scanner`) caps concurrent scans; a scan over it cannot start and reports
   `unavailable` with its reason.
4. **Pod Security Admission**: `restricted` (enforce, audit, warn).

What stays in the release namespace: os-ui keeps CronJob rights for agent schedules (`os-ui` Role). With the
platform registry on, `os-ui-zot-users` still grants `jobs create` there for the zot-users reconcile (a Job
from the chart's own CronJob template); that grant is not part of this change.

## Tests

- `os-ui/tabs/software/lib/scan-trivy.test.ts`: `scannerNamespace` (default, explicit, platform refused; a
  refused scan makes no Kubernetes call; the Job goes to `<platform>-scans`).
- `os-ui/tabs/software/lib/scanner-chart.test.ts`: the template's Role, policy expressions, switches and env.
- `scripts/tests/scanner-namespace-chart.test.mjs` (CI `test-ui`): helm renders. The default, dev values and
  the refusals: release namespace as scanner namespace, no digest. Also: nothing grants os-ui Job create or
  `pods/log` in the release namespace.
- `scripts/tests/scanner-admission.kind.sh` (CI `test-opensearch`, "Chart guards (kind)"): on a real API
  server, os-ui's own Job and payload Secret (`os-ui/scripts/print-scan-job.ts`) are admitted. 22 variants
  are refused (another Secret, envFrom, secretKeyRef, projected token, automounted token, unpinned image,
  hostPath, host network, privileged, …). os-ui cannot get/list Secrets there. With the binding deleted, the
  Secret-mounting Job is admitted (twin).
- `scripts/tests/dev-pod-security.kind.sh`: the dev render is accepted as the dev CI account, which cannot
  create pods, Jobs, Secrets or Roles in the scanner namespace.

## Dev

On dev the CI account may not create namespaces, nor a Role that grants Secret writes. `values.dev.yaml` sets
`createNamespace: false` and `createOsUiRoles: false`. **Before the first dev deploy with this change**, with
the admin kubeconfig (`--context "${DEV_KUBE_CONTEXT:-dmagosdev}"`):

```bash
kubectl apply -f scripts/dev/manifests/namespaces.yaml     # adds agentic-os-scans (PSA restricted)
kubectl apply -f scripts/dev/manifests/scanner-roles.yaml  # os-ui's + the worker's Role/RoleBinding there
kubectl apply -f scripts/dev/manifests/ci-rbac.yaml        # CI: NetworkPolicies + ResourceQuota there + the policy by name
# proof (expect: yes, no, no):
kubectl auth can-i create jobs.batch -n agentic-os-scans --as system:serviceaccount:agentic-os:os-ui
kubectl auth can-i get secrets -n agentic-os-scans --as system:serviceaccount:agentic-os:os-ui
kubectl auth can-i create pods -n agentic-os-scans --as system:serviceaccount:sovereign-os-ci:sovereign-os-ci
```

`scanner-roles.yaml` is generated from the chart (`node scripts/check-dev-app-builder-roles.mjs --write`); CI
fails when it drifts. The deploy itself then removes `os-ui-software-scanner` from `agentic-os` (Helm owns it)
and renders the policy, the NetworkPolicies and the ResourceQuota in `agentic-os-scans`.

After the deploy, check: `kubectl -n agentic-os get role os-ui-software-scanner` → NotFound;
`kubectl get validatingadmissionpolicy agentic-os-software-scanner-shape`; request a deploy scan in the
Software tab and see a `live` scan (or an `unavailable` one with a reason, never a pass).

## Production

No operator step: the prod deploy account creates the namespace, the Role, the policy and the
NetworkPolicies (chart defaults). The move ships with the next release. On upgrade Helm deletes
`os-ui-software-scanner` from `agentic-os`. A scan that is running during the roll may come back `unavailable`;
the next request runs in `agentic-os-scans`. Leftover scan Jobs in `agentic-os` reap themselves
(`ttlSecondsAfterFinished: 600`) and take their payload Secrets with them (owner reference).

Rollback: rolling back the release restores the old Role in `agentic-os`. The scanner namespace is deleted with
it, since Helm created it.
