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

**Owner follow-up (dev):** dev has one node, so builds cannot be enabled there until a dedicated build node pool exists
(one small tainted node, or a sandbox RuntimeClass). Size it for one build at a time (buildkitd 500m/1Gi request, up to 2 CPU / 3 Gi during
`next build`).

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
