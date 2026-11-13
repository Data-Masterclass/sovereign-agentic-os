/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Reconcile Trino's `rules.json` ConfigMap from OS domain membership
 * USER STORY: As a platform owner I want adding a user to a domain to make that domain's Iceberg
 *             schema writable for them, and removing them to take it away — without a Helm upgrade
 *             and without the OS holding a second, divergent copy of the rule.
 * ARCHITECTURE:
 *   - The chart renders a BOOTSTRAP `trino-access-rules` ConfigMap (impersonation by id pattern,
 *     nothing ownable) so a fresh install is safe before the OS has said anything. This module
 *     overwrites the SAME key with the enumerated rules, and Trino re-reads the file on its
 *     `security.refresh-period` — no pod restart, no roll.
 *   - PATCH only when the rendered bytes changed, so boot and a membership change are both cheap and
 *     the ConfigMap's resourceVersion does not churn.
 *   - Fail-soft: no cluster, no RBAC, a 404 ConfigMap — all return a typed outcome and log. The
 *     rules file is a NARROWING layer chained after OPA, so a stale file is never an opening.
 *   - Writes no secret: `buildTrinoRules` emits identifiers and regexes only.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { k8s, type K8sResult } from '@core/infra/k8s';
import { buildTrinoRules, renderTrinoRules, type RulesInput } from '@core/infra/trino-rules';

/** The ConfigMap the chart renders and Trino mounts at `/etc/trino/rules.json`. */
export const RULES_CONFIGMAP = 'trino-access-rules';
export const RULES_KEY = 'rules.json';

export type ReconcileOutcome =
  | { ok: true; changed: boolean; detail: string }
  | { ok: false; changed: false; detail: string };

export type RulesK8s = (method: string, path: string, body?: unknown) => Promise<K8sResult>;

function cmPath(ns: string): string {
  return `/api/v1/namespaces/${ns}/configmaps/${RULES_CONFIGMAP}`;
}

/**
 * Write the rules for `input` into the ConfigMap. Returns what happened; never throws.
 */
export async function reconcileTrinoAccessRules(
  input: RulesInput,
  opts: { namespace?: string; k8s?: RulesK8s } = {},
): Promise<ReconcileOutcome> {
  const ns = opts.namespace ?? config.platformNamespace;
  const call = opts.k8s ?? k8s;
  const desired = renderTrinoRules(buildTrinoRules(input));

  const get = await call('GET', cmPath(ns));
  if (get.status === 0) return { ok: false, changed: false, detail: 'no Kubernetes API reachable (not running in a cluster)' };
  if (get.status === 404) return { ok: false, changed: false, detail: `ConfigMap ${RULES_CONFIGMAP} does not exist — enable trino.accessControl in the chart` };
  if (get.status === 403) return { ok: false, changed: false, detail: `forbidden: the os-ui ServiceAccount may not read ${RULES_CONFIGMAP}` };
  if (get.status < 200 || get.status >= 300) return { ok: false, changed: false, detail: `GET ${RULES_CONFIGMAP} → ${get.status}` };

  const data = (get.body.data ?? {}) as Record<string, string>;
  if (data[RULES_KEY] === desired) return { ok: true, changed: false, detail: 'rules already current' };

  const patch = await call('PATCH', cmPath(ns), { data: { [RULES_KEY]: desired } });
  if (patch.status < 200 || patch.status >= 300) return { ok: false, changed: false, detail: `PATCH ${RULES_CONFIGMAP} → ${patch.status}` };
  return {
    ok: true,
    changed: true,
    detail: `${input.domains.length} domain(s), ${input.personalLanes.length} personal lane(s); Trino re-reads within security.refresh-period`,
  };
}
