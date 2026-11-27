# ingress-nginx

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0
- **Source:** https://github.com/kubernetes/ingress-nginx
- **Pinned as:** Helm chart `ingress-nginx` **4.15.1** from https://kubernetes.github.io/ingress-nginx
  (chart sha256 `3eff0bd18151d6e6b1c441463410571443dda1ac78292cb189346628de784f0c`), appVersion
  **1.15.1**: controller image `registry.k8s.io/ingress-nginx/controller:v1.15.1@sha256:594ceea76b01c592858f803f9ff4d2cb40542cae2060410b2c95f75907d659e1`
  (the digest the chart itself pins). Released 2026-03-19. The pin lives in
  `scripts/dev/platform-versions.env`; the values in `scripts/dev/ingress-nginx-values.yaml`.
- **Production:** upgraded with the same file plus the production overlay
  `scripts/dev/ingress-nginx-values.prod.yaml` (controller memory limit 512Mi instead of dev's
  256Mi, after the 2026-11-25 OOMKill; budgeted in `charts/sovereign-agentic-os/capacity.yaml`):
  `helm upgrade --install ingress-nginx ingress-nginx --repo https://kubernetes.github.io/ingress-nginx
  --version "$INGRESS_NGINX_CHART_VERSION" -n ingress-nginx -f scripts/dev/ingress-nginx-values.yaml
  -f scripts/dev/ingress-nginx-values.prod.yaml` (plus the production LoadBalancer address
  annotation, as `scripts/dev/platform.sh` sets it for dev).
- **Docs:** https://kubernetes.github.io/ingress-nginx/ ·
  values https://github.com/kubernetes/ingress-nginx/blob/helm-chart-4.15.1/charts/ingress-nginx/values.yaml ·
  ConfigMap keys https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/configmap/ ·
  annotation risk levels https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations-risk/

**Why the OS uses it:** the cluster's ingress controller, installed beside the chart (not a
subchart): every OS Ingress (`ingress.className: nginx`) and every app Ingress the software runner
writes goes through it.

**Why this version:** previously 4.11.3 / v1.11.3. 4.15.1 is the newest release of the newest
line and includes the 2025 fixes to annotation validation and to the admission webhook (fixed
upstream from v1.11.5 / v1.12.1). Upstream has announced the project's retirement, and v1.15.1 is
the final line. Moving to a maintained controller (Gateway API) is a separate decision.

**Defaults we state explicitly** (`scripts/dev/ingress-nginx-values.yaml`), so a future chart default
cannot widen them:

| Setting | Value | Why |
|---|---|---|
| `controller.allowSnippetAnnotations` | `false` | no `*-snippet` annotation is ever rendered (also the upstream default since v1.9) |
| `annotations-risk-level` | `High` | admits every annotation the OS's own Ingresses use (`auth-url`, `auth-response-headers`, `auth-type/secret/realm`, `proxy-*`, `force-ssl-redirect`, `whitelist-source-range`) and refuses `Critical` ones (upstream default since v1.12) |
| `strict-validate-path-type` | `true` | path values are checked against their `pathType` (upstream default since v1.12); every OS path is `/` or `/git` with `Prefix` |

App Ingresses are further limited to the annotations in `softwareRunner.ingressPolicy`
(chart `templates/base/os-ui/apps-ingress-admission.yaml`, a ValidatingAdmissionPolicy).

**Proof:** `scripts/tests/app-ingress-admission.kind.sh` installs exactly this chart (sha256
checked) with these values on kind, asserts the controller image and the three settings, and
passes the chart's rendered platform Ingresses (STACKIT profile) through the controller's own
admission webhook (server-side dry run).
