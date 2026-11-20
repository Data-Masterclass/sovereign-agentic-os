# App deploy (WP-54) — upstream pins

An app's build and deploy code is native: a `Dockerfile`, plain Kubernetes manifests under
`apps/<slug>/k8s/`, and a GitHub-Actions-format image workflow. The OS applies the committed
manifests through the Kubernetes API and builds no images.

| What | Version | Licence | Docs |
|---|---|---|---|
| Kubernetes API: create/replace, server-side dry run (`dryRun=All`) | apps/v1, v1, networking.k8s.io/v1 | Apache-2.0 | https://kubernetes.io/docs/reference/using-api/api-concepts/#dry-run |
| Pod Security Admission, level `restricted` | `enforce-version: latest` | Apache-2.0 | https://kubernetes.io/docs/concepts/security/pod-security-standards/#restricted |
| `kubectl apply -n <ns> -f k8s/` (the eject command) | kubectl matching the cluster | Apache-2.0 | https://kubernetes.io/docs/reference/kubectl/generated/kubectl_apply/ |
| actions/checkout | v4.2.2 `11bd71901bbe5b1630ceea73d27597364c9af683` | MIT | https://github.com/actions/checkout |
| docker/setup-buildx-action | v4.4.1 `f87e5991a6d7451dcb8d9637bfbc97413f497069` | Apache-2.0 | https://github.com/docker/setup-buildx-action |
| docker/login-action | v4.8.0 `8aa5831fb8d48d8f76594c7ddde61ae58019f550` | Apache-2.0 | https://github.com/docker/login-action |
| docker/build-push-action | v7.4.0 `c3c9e263c25d99ce0380d002d59b67737d91b0dc` | Apache-2.0 | https://github.com/docker/build-push-action |
| CNCF Distribution registry (eject test only, stands in for the platform registry) | `registry:3.0.0` | Apache-2.0 | https://distribution.github.io/distribution/ |
| kind local-registry pattern (eject test only) | kind v0.32.0 | Apache-2.0 | https://kind.sigs.k8s.io/docs/user/local-registry/ |

The action pins are the same as `.github/workflows/build-images.yml`.
