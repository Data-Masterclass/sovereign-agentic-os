# BuildKit (+ runc, rootlesskit, shadow newuidmap/newgidmap)

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`. Built from pinned
source into our builder image `images/base/builder` (App Builder workstream C1, spec 6.1).

- **Licences:** BuildKit Apache-2.0 · runc Apache-2.0 · rootlesskit Apache-2.0 · shadow (newuidmap/newgidmap only)
  BSD-3-Clause · musl (static libc of the C binaries) MIT.
- **Sources and pins** (tag AND commit, checked by the Dockerfile):
  - https://github.com/moby/buildkit `v0.35.1` = `412cc86ad3c4252b82e929f9b1b1ad167376ded8` (buildkitd, buildctl)
  - https://github.com/opencontainers/runc `v1.5.3` = `46365c62967c76a765a5e347f48f0c7b3b571fe9` (built WITHOUT the
    `seccomp` tag: that tag links libseccomp, LGPL-2.1)
  - https://github.com/rootless-containers/rootlesskit `v3.3.0` = `888c3189e9cdf34dcdb19011e1c7c34eb94b5393`
  - https://github.com/shadow-maint/shadow `4.20.4` release tarball, sha256
    `639d03cd7821b4086deba50485a1b8041acbb0d1d3c33c20ebd4708e0eeb9bc7`
  - build-time only: `golang:1.27-alpine3.24`, `tonistiigi/xx:1.10.0` (MIT, cross-compilation), digests in the Dockerfile.
- **Not used, by design:** the upstream `moby/buildkit:*-rootless` image (bundles slirp4netns GPL-2.0 and
  fuse-overlayfs GPL-3.0+), crun (GPL-2.0+), libseccomp (LGPL-2.1).
- **Docs used:** https://github.com/moby/buildkit/blob/v0.35.1/docs/rootless.md,
  https://github.com/moby/buildkit/tree/v0.35.1/examples/kubernetes, https://kubernetes.io/docs/concepts/workloads/pods/user-namespaces/,
  https://github.com/kubernetes-sigs/security-profiles-operator (the seccomp fallback).

## How the OS runs it, and what the proof found (2026-11-27)

`tests/software-factory/buildkit-proof.sh` builds the `nextjs-web@2` template on kind (k8s 1.36.1, kernel 6.8,
containerd 2.3.1) and on the dev SKE cluster (k8s 1.35.9, Flatcar 4757.2.2, kernel 6.12.113, containerd 2.2.10):

- Pod `hostUsers: false`, Pod Security `baseline` namespace, no privileged, no added capability, no AppArmor field,
  no Secret, no ServiceAccount token. buildkitd runs under rootlesskit as uid 0 **of the pod's user namespace**
  (`--net=host` = the pod network, native snapshotter, `--oci-worker-no-process-sandbox`); buildctl writes an OCI image
  layout; a separate restricted pod `crane push`es it with the domain's push credential.
- **seccomp RuntimeDefault blocks it** on both clusters: containerd's default profile allows `clone`/`unshare` with
  `CLONE_NEWUSER` and `mount` only with CAP_SYS_ADMIN, so rootlesskit cannot create the nested user namespace
  (`[rootlesskit:parent] error: failed to start the child: fork/exec /proc/self/exe: operation not permitted`).
- **The approved fallback works** on both: a Localhost profile = moby's default profile + `clone unshare setns mount
  umount2 pivot_root sethostname setdomainname`, with nested seccomp filters answered EINVAL
  (`charts/sovereign-agentic-os/files/seccomp/buildkit-rootless.json`, rendered reproducibly by
  `scripts/spo/render-seccomp-profile.mjs`; distributed by security-profiles-operator, `scripts/spo/install.sh`).
  Hardened after the security review (profile as committed now, re-proof pending): no `CLONE_NEWNET`, new mount API
  answers ENOSYS, sockets limited to UNIX/INET/INET6/NETLINK_ROUTE; build pods only on dedicated nodes or a sandbox
  runtime (`docs/components/app-builder-build.md`).
- Learnings (each cost a failed run):
  - kubelet REFUSES a pod with `appArmorProfile: RuntimeDefault` on a node without AppArmor (kind nodes, Flatcar):
    leave the field unset, which is the runtime default where AppArmor exists.
  - `allowPrivilegeEscalation: false` (no_new_privs) on the buildkitd container strips the capabilities rootlesskit's
    child gains at its re-exec inside the new user namespace (`Capabilities: {Effective:0}` and a hang). Baseline allows
    it; the image holds no setuid/setcap binary.
  - A native sidecar's `startupProbe` gates the main container; a `readinessProbe` does not.
  - runc without libseccomp refuses BuildKit's per-step seccomp profile ("config provided but seccomp not supported");
    the Localhost profile makes `prctl(PR_SET_SECCOMP)` answer EINVAL, so BuildKit generates none and every step runs
    under the pod's own (inherited) filter.
  - kind: user-namespaced pods fail to mount sysfs while kind's DMI files are bind-mounted over the node's `/sys`
    (`mount_too_revealing`); `tests/software-factory/tekton-up.sh` unmounts them. Ubuntu hosts (colima, GitHub
    runners) also need `kernel.apparmor_restrict_unprivileged_userns=0`.
  - Go under qemu crashes building runc: the C binaries are CROSS-compiled with xx instead.
- **Licence finding, decided 2026-11-27 (narrow MPL-2.0 exception, granted by the owner):** the builder image's SBOM
  (`scripts/check-builder-sbom.mjs`) finds MPL-2.0 Go modules statically linked into buildkitd/buildctl/runc. They are
  core dependencies of upstream BuildKit and runc; no build tag removes them. The owner excepted exactly these,
  unmodified, in this image only, inside the upstream binaries only (`licenses/exceptions.images.json`, scope `builder`;
  policy in `THIRD-PARTY-LICENSES.md`, "Narrow MPL-2.0 exception: the App Builder image"):

  | Module | Version (pinned tags' `go.mod`/`go.sum`/`vendor/modules.txt`) | Licence | Source |
  |---|---|---|---|
  | `github.com/hashicorp/go-immutable-radix/v2` | v2.1.0 (buildkit v0.35.1) | MPL-2.0 | https://github.com/hashicorp/go-immutable-radix/tree/v2.1.0 |
  | `github.com/hashicorp/go-retryablehttp` | v0.7.8 (buildkit v0.35.1, indirect) | MPL-2.0 | https://github.com/hashicorp/go-retryablehttp/tree/v0.7.8 |
  | `github.com/hashicorp/go-cleanhttp` | v0.5.2 (buildkit v0.35.1) | MPL-2.0 | https://github.com/hashicorp/go-cleanhttp/tree/v0.5.2 |
  | `github.com/hashicorp/golang-lru/v2` | v2.0.7 (buildkit v0.35.1) | MPL-2.0 AND BSD-3-Clause | https://github.com/hashicorp/golang-lru/tree/v2.0.7 |
  | `github.com/cyphar/filepath-securejoin` (incl. `pathrs-lite`) | v0.7.0 (buildkit v0.35.1 and runc v1.5.3) | BSD-3-Clause AND MPL-2.0 | https://github.com/cyphar/filepath-securejoin/tree/v0.7.0 |

  rootlesskit v3.3.0 and go-containerregistry v0.22.1 require none of them. The Dockerfile copies each module's own
  licence files verbatim from the compiled `vendor/` tree to `/licenses/go/<module>@<version>/`, plus `/licenses/NOTICE`
  and `/licenses/MPL-2.0.txt`, and fails if `vendor/modules.txt` names another version. Exact sources and hashes:
  `licenses/source-offer.md`.
- **On a BuildKit or runc bump:** re-check these versions and look for any NEW MPL module (which still fails); update
  `MPL_MODULES` in the Dockerfile, the scope-`builder` entries, `images/base/builder/licenses/NOTICE`,
  `licenses/notices/builder-image.md`, `licenses/source-offer.md` and `LICENCE_FILES` in the gate, and get the owner's
  re-review. Never patch these files: a modified file would have to be published under MPL-2.0.
- **Not excepted:** runc v1.5.3 and buildkit also list `cyphar.com/go-pathrs` (the libpathrs binding, used only with the
  `libpathrs` build tag, which we do not set). If an SBOM ever shows it linked, the gate fails and it needs its own
  owner decision.
