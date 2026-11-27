# App Builder build platform (workstream C1)

How app images are built, pushed and kept, and what an operator must provide before builds may run. Spec:
`docs/superpowers/specs/2026-11-26-app-builder-design.md` §6.1–6.2, §13. Everything here is behind
`softwareRunner.environments.enabled` (default off: nothing renders).

## Preconditions the chart enforces (it refuses to render otherwise)

| Setting | Why |
|---|---|
| `softwareRunner.environments.build.image` = `<repo>@sha256:<digest>` **listed in `charts/sovereign-agentic-os/files/builder-digests.txt`** | Only digests produced by the gated `builder-v*` tag build (licence gate on the built bytes) may run; the list changes only by reviewed PR. Today it is **empty**. Since 2026-11-27 the gate accepts the five MPL-2.0 Go modules BuildKit/runc link, under the narrow owner exception (`THIRD-PARTY-LICENSES.md`, "Narrow MPL-2.0 exception: the App Builder image"); any other MPL module still fails. Next step: push a `builder-v<x>` tag → the workflow builds, gates and prints the digest line → a reviewed PR adds it here. |
| `softwareRunner.environments.build.isolation` = `dedicated-nodes` or `sandbox-runtime` | Untrusted build code (the app's Dockerfile `RUN`s) gets an unprivileged user namespace, i.e. kernel attack surface with node-root impact. It must never share a node kernel with os-ui, Postgres or any platform pod. There is no dev-only exception. |
| `osUI.software.registry.allowedSourceRanges` (non-empty, never `0.0.0.0/0`) for `ingress-restricted` **and** `internal-lb` | Node pulls only; the registry is never reachable from the internet. |
| `ingress.className: nginx` for `ingress-restricted` | The allowlist is the ingress-nginx annotation `whitelist-source-range`; another controller would ignore it. |
| `osUI.software.registry.internalLoadBalancer.annotations` for `internal-lb` | The provider's internal-LB annotation; without it the Service would be public. |
| `networkPolicies.apiserver.cidrs` (or a resolvable `kubernetes` EndpointSlice) | zot-users may reach the API server only. |

## Build isolation

- **`dedicated-nodes`**: a node pool only for build pods. Taint and label every node of it:
  ```bash
  kubectl --kubeconfig <cluster> taint nodes <node> soa.dev/build=true:NoSchedule
  kubectl --kubeconfig <cluster> label nodes <node> soa.dev/pool=build
  ```
  (values `build.dedicatedNodes.nodeSelector` / `.tolerations`; defaults match the commands). The build pod gets the
  nodeSelector and toleration; the admission policy `app-checks-build-pod` refuses a build pod without them. The pool
  needs kernel ≥ 6.3 and containerd ≥ 2.0 (user namespaces with idmapped mounts) and the build seccomp mode
  (`runtime-default`, or `localhost` with security-profiles-operator, `scripts/spo/install.sh`).
- **`sandbox-runtime`**: a RuntimeClass with its own kernel boundary (gVisor, Kata) that supports user namespaces
  (`build.sandboxRuntime.runtimeClassName`); enforced by the same admission policy.

**Dev:** the dedicated pool is the SKE node pool `builds` in `deploy/envs/dev/main.tf` (label `soa.dev/pool=builds`, taint
`soa.dev/build=true:NoSchedule`, 0..1 nodes), selected in `values.dev.yaml`. See the next section.

## Dedicated build pool with scale-to-zero

### How it works

1. The build pool is a node group that is **tainted** (`soa.dev/build=true:NoSchedule`) and **labelled**
   (`soa.dev/pool=builds` on dev), with **minimum 0**. Taint and label are declared on the node group itself, never set
   with `kubectl` afterwards: when the group has no node, the cluster autoscaler simulates one from the group's template,
   and only taints and labels in that template count.
2. A build starts. The `build-image` pod has the nodeSelector and the toleration, so the scheduler has nowhere to put it
   and it stays `Pending` (Unschedulable).
3. The cluster autoscaler sees the Pending pod, finds that a new node of the build group would fit it, and scales that
   group from 0 to 1. The node boots, joins, its DaemonSets start, and the pod is bound to it.
4. The build finishes. Its pods complete, and the node is "unneeded". After the autoscaler's scale-down delays, the node
   is drained and deleted, and the group is back at 0.

Three things make step 3 happen, and each one, if missing, leaves the build Pending forever with no node:

- **Priority at or above the autoscaler's expendable cutoff.** The cluster autoscaler ignores Pending pods whose priority
  is below `--expendable-pods-priority-cutoff` (upstream default -10; SKE/Gardener hard-set -10). The run pods' class
  `soa-build-low` is -200, so the build-image pod on the dedicated pool runs at its own class `soa-build-pool` (-10,
  `preemptionPolicy: Never`; `build.dedicatedNodes.priorityClass`). Only build pods tolerate the pool's taint, so this
  priority ranks against nothing there; gates, push and scans stay at `soa-build-low` on the platform nodes. The chart
  refuses a value below -10, and `scripts/check-software-apps-envs-chart.mjs` checks both classes.
- **Tekton's Affinity Assistant off** (`coschedule: disabled`, set by `scripts/tekton/install.sh`). With the default,
  every pod of a PipelineRun that shares the PVC workspace is pinned by pod affinity to the assistant's node, a platform
  node, which contradicts the build pod's nodeSelector. Off, the ReadWriteOnce workspace volume moves between nodes, so
  every task that mounts it (fetch, gates, scan, build-image, push-image) runs strictly one after another (`scan` runs
  after `gates`, not beside it): two of them at once on different nodes would wait on a Multi-Attach. **The build pool
  must be in the same zone as the platform nodes** (block volumes are zonal).
- **Nothing else may tolerate the taint**, DaemonSets aside. Otherwise a platform pod could land next to untrusted build
  code, or keep the node busy so it never scales down. The chart check renders the whole chart and fails on any
  toleration of `soa.dev/build` (or of every taint) other than the build-image pod's.

**DaemonSets on a build node.** Node agents still run there, as they must: SKE's CNI (Cilium) and kube-proxy where
present, the CSI node plugin, SKE's node-local agents (node-problem-detector and similar, which tolerate every taint), and
**security-profiles-operator's `spod`** when the build pod uses the `localhost` seccomp profile. `spod` writes the profile
to the node, so it must tolerate the taint; `scripts/spo/install.sh` sets `spec.scheduling.tolerations` on the SPOD
(SPO's own defaults repeated, plus `soa.dev/build`). On a node fresh from zero, a build container that starts before
`spod` has written the profile fails and the kubelet retries it until the file exists. The chart's own DaemonSets do not
tolerate the taint: the OpenTelemetry Collector (off on dev) collects no logs from build nodes, and build logs are read
from the Tekton TaskRun while the pod exists; `sovereign-os-node-sysctl` (OpenSearch's `vm.max_map_count`) is not
needed there. SKE's system components (CoreDNS, metrics-server) stay off because the pool sets
`allow_system_components = false`; that also keeps the node removable.

### Latency

Measured numbers belong here after the first build on dev; until then, these are the documented bounds and the parts:

- Detection: the autoscaler scans every 10 s (SKE default `--scan-interval=10s`).
- Provisioning: create a VM, boot Flatcar, join, start DaemonSets, pull the builder image. SKE documents no per-node time
  (cluster creation: "about 5-10 minutes"); expect a few minutes. The autoscaler gives up on a node that is not ready
  after `--max-node-provision-time=20m`.
- Scale-down: a node is removed after it has been unneeded for 30 min (`--scale-down-unneeded-time=30m`), and not within
  1 h after any scale-up (`--scale-down-delay-after-add=1h`). So one build keeps the node for about 1.5 h; builds in that
  window reuse it with no wait. SKE's autoscaler flags are its fixed defaults (the stackit Terraform provider exposes
  none of them).

Source: <https://docs.stackit.cloud/products/runtime/kubernetes-engine/faq/> (cluster autoscaler defaults).

### Cost

With 0 nodes the pool costs nothing: a node pool is not a billed item, only its servers and their disks are, and
neither exists. The SKE cluster fee is charged per cluster whether or not this pool exists. While a node exists (dev,
`g2i.2` = 2 vCPU / 8 GB, STACKIT price list 1.0.45 of 2026-11-03, net list prices, eu01):

| Item | EUR / hour | EUR / month if it never scaled down |
|---|---|---|
| Server `g2i.2` | 0.10229 | 73.65 |
| Boot disk, 50 GB Premium-Performance 1 (0.0101667 per disk + 0.0000907638 per GB) | 0.01471 | 10.59 |
| **Total while up** | **≈ 0.117** | **≈ 84.24** |

STACKIT invoices "per billing unit or part thereof" and lists servers per hour, so one build (node up about 1.5 h) costs
about 2 billed hours, **≈ EUR 0.23**; a day with builds spread over 8 hours, about EUR 1. Why `g2i.2`: SKE accepts no
flavour below 2 vCPU; `c2i.2` (2 vCPU / 4 GB, EUR 0.043/h) is cheaper, but after kubelet reservations and DaemonSets it
leaves less memory than the build's 3 Gi limit (`next build` peaks there), so a build could be OOM-killed. The build pod
requests about 0.5 CPU / 1.1 Gi (buildkitd 500m / 1 Gi, the step 10m / 32 Mi, Tekton's init containers from the
LimitRange) with limits 2.5 CPU / 3.25 Gi, which fits `g2i.2`'s allocatable with room for the DaemonSets.

Sources: price list <https://stackit.com/en/asset/download/37788/file/STACKIT_price_list.pdf?version=33> (linked from
<https://stackit.com/en/prices/cloud>); flavours
<https://docs.stackit.cloud/products/compute-engine/server/basics/machine-types/>; SKE node pools ("only machine types
which have a minimum of 2 CPU cores") <https://docs.stackit.cloud/products/runtime/kubernetes-engine/getting-started/node-pools/>.

### Why this works on SKE (research, 2026-11-27)

- SKE's cluster autoscaler is Gardener's fork of the upstream one, and Gardener deploys it for every pool with
  `minimum < maximum` (<https://gardener.cloud/docs/gardener/autoscaling/shoot_autoscaling/>; SKE FAQ above).
- Minimum 0 is valid: Gardener only refuses a negative minimum, and requires at least one pool with system components
  allowed and `maximum > 0` (`workers` here) (`ValidateWorker` / `ValidateSystemComponentWorkers` in
  <https://github.com/gardener/gardener/blob/master/pkg/api/core/validation/shoot.go>). The stackit provider requires at
  least one pool with `allow_system_components = true`
  (<https://github.com/stackitcloud/terraform-provider-stackit/blob/v0.123.0/stackit/internal/services/ske/cluster/resource.go>).
- Scale-from-zero: the worker resource carries each pool's CPU/memory "used by Cluster Autoscaler to generate nodeTemplate
  during scaling the nodeGroup from zero" (<https://gardener.cloud/docs/gardener/extensions/resources/worker/>), and the
  autoscaler takes the template's labels and taints from the pool's MachineDeployment (`GetMachineDeploymentNodeTemplate`
  in <https://github.com/gardener/autoscaler/blob/machine-controller-manager-provider/cluster-autoscaler/cloudprovider/mcm/mcm_manager.go>).
  Hence taints and labels on the pool (Terraform `node_pools[].taints` / `.labels`), never on the node.
- Gardener hard-sets `--expendable-pods-priority-cutoff=-10`
  (<https://github.com/gardener/gardener/blob/master/pkg/component/autoscaling/clusterautoscaler/cluster_autoscaler.go>);
  upstream semantics: <https://github.com/kubernetes/autoscaler/blob/master/cluster-autoscaler/FAQ.md>.
- `max_surge` / `max_unavailable` "must be at least the amount of zones" when set; the pool has one zone, surge 1,
  unavailable 0 (<https://registry.terraform.io/providers/stackitcloud/stackit/latest/docs/resources/ske_cluster>).
- Kernel and runtime: SKE's Flatcar `4459.2.x` and later ship containerd 2.x (supported since 2026-02-11; current
  `4757.2.2-containerd2.2.10`) (<https://docs.stackit.cloud/products/runtime/kubernetes-engine/release-notes/>), which
  user namespaces need with a kernel >= 6.3. Verify on the first build node (`kubectl get node -o wide`).
- SKE also offers `kata = true` per pool (Kata Containers, private preview), a candidate for `sandbox-runtime` later.

### Install anywhere (other clusters)

Any autoscaling node group with a taint works; the chart needs nothing provider-specific. The checklist:

- a node group with minimum 0 (or a fixed small size if your autoscaler cannot scale from zero), the taint
  `soa.dev/build=true:NoSchedule` and a label, both **declared on the group** so they exist in the scale-from-zero
  template; in the same zone as the platform nodes; kernel >= 6.3 and containerd >= 2.0;
- `softwareRunner.environments.build.isolation: dedicated-nodes` with that label as `dedicatedNodes.nodeSelector`;
- the build-image pod's class at or above your autoscaler's expendable cutoff (`dedicatedNodes.priorityClass.value`,
  default -10, matching the upstream default);
- Tekton's Affinity Assistant off (`scripts/tekton/install.sh` does it);
- `spod` tolerating the taint when using the `localhost` seccomp profile (`scripts/spo/install.sh` does it).

Examples (sketches, check your provider's docs):

- **Cluster Autoscaler on AWS (EKS managed node group, min 0):** set the taint and label on the node group, and for scale
  from zero also tag the Auto Scaling group with
  `k8s.io/cluster-autoscaler/node-template/taint/soa.dev/build: "true:NoSchedule"` and
  `k8s.io/cluster-autoscaler/node-template/label/soa.dev/pool: builds`
  (<https://github.com/kubernetes/autoscaler/blob/master/cluster-autoscaler/cloudprovider/aws/README.md>).
- **Gardener shoots elsewhere / other Gardener-based offerings:** a worker pool with `minimum: 0`, `taints` and `labels`,
  `systemComponents.allow: false`, exactly as the dev pool here.
- **Karpenter:** a NodePool whose template carries the taint and label, so only build pods match it, with consolidation
  to remove the empty node:
  ```yaml
  apiVersion: karpenter.sh/v1
  kind: NodePool
  metadata: { name: builds }
  spec:
    template:
      metadata: { labels: { soa.dev/pool: builds } }
      spec:
        taints: [{ key: soa.dev/build, value: "true", effect: NoSchedule }]
        requirements: [{ key: karpenter.sh/capacity-type, operator: In, values: [on-demand] }]
        nodeClassRef: { group: karpenter.k8s.aws, kind: EC2NodeClass, name: default }
    limits: { cpu: "4" }
    disruption: { consolidationPolicy: WhenEmptyOrUnderutilized, consolidateAfter: 5m }
  ```
  (<https://karpenter.sh/docs/concepts/nodepools/>).

### Dev: apply and verify (owner)

Only the owner applies, with the dev key and the dev state (`docs/ops/dev-environment.md` "Create"), and **only with
`-target`** (the root also describes the ingress IP, the bucket and credentials). The change is an in-place update of
`stackit_ske_cluster.dev` that adds the pool `builds`.

```bash
D=deploy/envs/dev
tofu -chdir=$D init -backend-config=path=<path to dev.tfstate in your secrets folder>
tofu -chdir=$D plan -target=stackit_ske_cluster.dev -var node_machine_type=m2i.4 -out=builds.tfplan
#   review: "Plan: 0 to add, 1 to change, 0 to destroy"; ~ stackit_ske_cluster.dev updated in-place;
#   node_pools gains "builds" (g2i.2, minimum 0, maximum 1, taint soa.dev/build, label soa.dev/pool=builds,
#   allow_system_components false). Expected and harmless: a warning that the node_pools list changes, and the
#   workers' max_surge / max_unavailable shown as "(known after apply)". STOP only if "workers" changes its
#   machine_type, os, zones, volume, labels, taints, minimum or maximum: pass the values it really runs with
#   (-var ...) and plan again. Optional: -var build_pool_os_version_min=<workers' os_version_used>.
tofu -chdir=$D apply builds.tfplan
```

`-var node_machine_type=m2i.4` is there because dev runs `m2i.4` today; leave it out if `terraform.tfvars` already says
so, and never let the plan change the `workers` machine type (that replaces the platform node).

Verify (`KUBECONFIG=~/.kube/dmagosdev.yaml`):

```bash
kubectl get nodes -L soa.dev/pool          # still ONE node (workers); no build node while no build runs
# later, during the first build:
kubectl get pods -n agentic-build -w        # the build-image pod: Pending, then Running
kubectl get nodes -L soa.dev/pool -o wide   # a second node, soa.dev/pool=builds; OS-IMAGE, KERNEL and
                                            # CONTAINER-RUNTIME match the workers node (containerd >= 2.0)
kubectl describe node -l soa.dev/pool=builds | grep Taints   # soa.dev/build=true:NoSchedule
kubectl get pods -A -o wide --field-selector spec.nodeName=<build node>   # build pods + DaemonSets only
# about 1.5 h after the last build: back to one node
```

Before the first build with `seccomp: localhost`, re-run `scripts/spo/install.sh` (spod tolerates the taint) and
`scripts/tekton/install.sh` (Affinity Assistant off) on dev.

## The build pod (Task `buildkit-build`)

- `hostUsers: false`; the API server refuses the pod otherwise (admission policy `app-checks-build-pod`: a cluster
  without user-namespace support drops the field before admission, so the pod is denied rather than run as the node's
  root). The builder's entrypoint `require-userns` checks `/proc/self/{uid,gid}_map` again and exits before buildkitd
  starts if the pod is in the node's initial user namespace or uid 0 maps to the node's uid 0.
- seccomp `runtime-default` blocks rootless BuildKit on containerd (no nested user namespace without CAP_SYS_ADMIN).
  The approved fallback `localhost` = moby's default profile plus: `mount umount2 pivot_root sethostname setdomainname`;
  `clone`/`unshare`/`setns` only with `CLONE_NEWNET` clear (no new network namespace: the build uses the pod network);
  `clone3` and the new mount API (`fsopen fsconfig fsmount fspick move_mount open_tree mount_setattr`) answer an errno
  so callers fall back; sockets limited to AF_UNIX/AF_INET/AF_INET6 and AF_NETLINK with NETLINK_ROUTE only; nested
  seccomp filters refused (EINVAL). Rendered from the pinned upstream by `scripts/spo/render-seccomp-profile.mjs`.
- No privileged, no added capability, no AppArmor field, no Secret, no ServiceAccount token, PriorityClass
  `soa-build-low` (never preempts). Egress: egress proxy (npm) and Zot only.

## Push and registry

- `crane-push` is the only pod with a domain's push Secret (`zot-push-<domainKey>`, bound to `apps/<domainKey>` by the
  listener's CEL filter and again by zot-users). It first refuses a layout with a symlink, special file or a path
  outside the OCI layout.
- Zot: ClusterIP; node pulls through the TLS Ingress (`ingress-restricted`, ingress-nginx only) or an internal LB with
  `loadBalancerSourceRanges`. **X-Forwarded-For:** ingress-nginx must judge the real client address: keep the
  controller's `use-forwarded-headers: false` (default) or limit `proxy-real-ip-cidr` to your load balancer; a
  controller that trusts forwarded headers from anyone lets a client pick the address the allowlist sees.
- Identities (htpasswd + access control rendered by `zot-users`):
  - `push-<domainKey>`: create/update under `apps/<domainKey>/**`, but never a `keep-*` or `release-*` tag (Zot policy
    condition): those are the platform's retention tags;
  - `pull`: read `apps/**`; its credential is the Secret `zot-pull`, which os-ui may read to check a digest exists;
  - `keeper`: read/create/delete tags, retention only; its credential is the Secret `zot-keeper`, readable only by the
    zot-users ServiceAccount (a chart check fails if any Role bound to os-ui or os-ui-worker can read it).
  A malformed or duplicate push Secret is skipped and reported, never fatal for the other domains.

## Retention (what is never collected)

- `release-*` tags: the digest of every release record (dev and prod) is tagged `release-<env>-<id>` by the release
  flow (C2) with a platform identity, never a domain push user (they are refused those tags); kept forever.
- `keep-<digest hex>` tags: on every run zot-users tags each digest a pod in `apps-dev`/`apps-prod` runs, and deletes
  the tag once nothing runs it.
- Everything else: the newest `retention.keepNewest` (10) per repository, then GC of untagged manifests.

## Uninstall the seccomp fallback

`bash scripts/spo/install.sh --kubeconfig <cluster> --uninstall` refuses while any pod uses the profile; then removes the
SeccompProfile, the SPOD and the operator with its CRDs, each with a timeout.
