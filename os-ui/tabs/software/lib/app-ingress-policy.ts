/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The annotation allow-list for app Ingresses.
 * USER STORY: As an operator I want every Ingress the OS writes for a user's app to carry only
 *             the annotations the platform itself chose, so an app can never configure the
 *             shared ingress controller.
 * ARCHITECTURE:
 *   - The runner (runner.ts) checks its own Ingress here BEFORE the API call and refuses to apply
 *     one that fails (first door).
 *   - The chart enforces the same list in the API server for every writer in the runner
 *     namespace: a ValidatingAdmissionPolicy (templates/base/os-ui/apps-ingress-admission.yaml,
 *     values `softwareRunner.ingressPolicy`). `scripts/check-app-ingress-policy.mjs` (OS gate)
 *     fails when the chart's default list and this one differ.
 *   - Annotation keys: https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/
 */

/** Every annotation key an app Ingress may carry. The runner sets only the TLS issuer. */
export const APP_INGRESS_ANNOTATION_ALLOWLIST: readonly string[] = Object.freeze(['cert-manager.io/cluster-issuer']);

/** The reasons an app Ingress is refused (empty = allowed). */
export function appIngressViolations(manifest: Record<string, unknown>, ingressClass: string): string[] {
  const problems: string[] = [];
  const meta = (manifest.metadata ?? {}) as { annotations?: Record<string, unknown> };
  for (const key of Object.keys(meta.annotations ?? {})) {
    if (!APP_INGRESS_ANNOTATION_ALLOWLIST.includes(key)) problems.push(`annotation '${key}' is not on the app Ingress allow-list`);
  }
  const cls = ((manifest.spec ?? {}) as { ingressClassName?: unknown }).ingressClassName;
  if (!ingressClass) problems.push('no ingress class is configured (softwareRunner.ingressClass / ingress.className)');
  else if (cls !== ingressClass) problems.push(`ingressClassName must be '${ingressClass}' (got ${cls === undefined ? 'none' : `'${String(cls)}'`})`);
  return problems;
}
