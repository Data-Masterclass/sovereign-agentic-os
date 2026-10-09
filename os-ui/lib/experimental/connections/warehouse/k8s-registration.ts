/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * External-warehouse connector — ONE-CLICK LIVE REGISTRATION (the k8s seam).
 *
 * `catalogRegistration(source)` (registration.ts) renders the exact Trino catalog
 * `.properties` + the secret env plumbing an operator would paste into
 * `values.trino.externalCatalogs` and `helm upgrade`. That GitOps path is honest but
 * NOT usable from the UI. This module makes the same registration LIVE without a
 * values edit, using the os-ui pod's in-cluster ServiceAccount, in three idempotent
 * steps against the SAME objects the chart renders:
 *
 *   (a) MERGE the `<catalog>.properties` key into the live `trino-catalog` ConfigMap
 *       (the read-only mount the Trino pod loads its catalogs from).
 *   (b) MATERIALIZE the connection's vaulted secret(s) into a `trino-ext-<catalog>`
 *       k8s Secret — one data key per `secretMaterial.envVars` entry — and PATCH the
 *       Trino Deployment's container env so each ${ENV:VAR} resolves via secretKeyRef.
 *       Keyless platforms (Glue = IRSA, BigQuery = Workload Identity) declare NO env
 *       vars, so NO Secret is created and NO env is added — provably.
 *   (c) TRIGGER a rollout by patching a pod-template annotation. The Trino Deployment
 *       is `strategy: Recreate` with a read-only rootfs, so the new pod re-reads the
 *       freshly-merged ConfigMap mount + picks up the new env on restart.
 *
 * The k8s client is INJECTED (same shape as lib/software/runner.ts) so the whole flow
 * unit-tests against a fake with no cluster. Failures are surfaced honestly — a step
 * that the API server rejects returns `ok:false` with the real status, never a silent
 * partial success. No secret VALUE is ever returned or logged (only the key names).
 */

import type { CatalogRegistration } from './registration.ts';
import { k8s as liveK8s } from '@/lib/infra/k8s.ts';

/** The injectable in-cluster client (a subset of lib/infra/k8s.ts's `k8s`). */
export type RegK8s = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: Record<string, unknown> }>;

/** The materialized secret values for this catalog: env-var name → secret VALUE. */
export type SecretValues = Record<string, string>;

export type RegisterK8sOutcome = {
  ok: boolean;
  /** True only when a real cluster confirmed every applied step. */
  live: boolean;
  catalog: string;
  /** Which steps ran + their result (for an honest, auditable report). */
  steps: {
    configMap: { applied: boolean; status: number };
    secret: { applied: boolean; status: number; keys: string[] };
    rollout: { applied: boolean; status: number };
  };
  detail: string;
};

/** The `trino-catalog` ConfigMap name the chart renders (lakehouse/trino.yaml). */
const CATALOG_CM = 'trino-catalog';
/** The Trino Deployment name the chart renders. */
const TRINO_DEPLOYMENT = 'trino';
/** The Trino container name inside that Deployment. */
const TRINO_CONTAINER = 'trino';

function cmPath(ns: string): string {
  return `/api/v1/namespaces/${ns}/configmaps/${CATALOG_CM}`;
}
function secretPath(ns: string, name: string): string {
  return `/api/v1/namespaces/${ns}/secrets/${name}`;
}
function deploymentPath(ns: string): string {
  return `/apis/apps/v1/namespaces/${ns}/deployments/${TRINO_DEPLOYMENT}`;
}

/** Serialize a props map to the `.properties` text the chart mounts (sorted keys). */
export function propsToProperties(props: Record<string, string>): string {
  return Object.keys(props)
    .sort()
    .map((k) => `${k}=${props[k]}`)
    .join('\n') + '\n';
}

/** A DNS-1123 Secret name for a catalog's materialized env secret. */
export function extSecretName(catalog: string): string {
  return `trino-ext-${catalog.replace(/_/g, '-')}`;
}

function okStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * (a) Merge the catalog's `.properties` into the live `trino-catalog` ConfigMap.
 * A strategic/merge PATCH of `data` adds or REPLACES the single `<catalog>.properties`
 * key (re-registering the same catalog updates it) without disturbing `iceberg.properties`
 * or any other external catalog already present. Returns the API status.
 */
async function mergeCatalogConfigMap(
  k8s: RegK8s,
  ns: string,
  catalog: string,
  properties: string,
): Promise<{ applied: boolean; status: number }> {
  const key = `${catalog}.properties`;
  const res = await k8s('PATCH', cmPath(ns), { data: { [key]: properties } });
  return { applied: okStatus(res.status), status: res.status };
}

/**
 * (b) Materialize the env-backed secret(s). Creates (or replaces) a `trino-ext-<catalog>`
 * Secret whose data keys are the provider's `secretMaterial.envVars`, then patches the
 * Trino Deployment container env so each ${ENV:VAR} resolves via secretKeyRef. When the
 * provider declares NO env vars (Glue IRSA / BigQuery Workload Identity) this is a NO-OP:
 * no Secret is created and no env is added — the keyless contract is preserved.
 */
async function materializeSecret(
  k8s: RegK8s,
  ns: string,
  catalog: string,
  envVars: string[],
  values: SecretValues,
): Promise<{ applied: boolean; status: number; keys: string[] }> {
  if (envVars.length === 0) {
    // Keyless platform — nothing to mount. Provably no Secret, no env patch.
    return { applied: true, status: 0, keys: [] };
  }
  const name = extSecretName(catalog);
  // stringData carries plaintext values the API server base64-encodes; each env var is
  // one key. A missing value is an honest failure BEFORE we touch the cluster.
  const stringData: Record<string, string> = {};
  for (const v of envVars) {
    const val = values[v];
    if (val === undefined || val === '') {
      return { applied: false, status: 0, keys: [] };
    }
    stringData[v] = val;
  }
  const secretManifest = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace: ns },
    type: 'Opaque',
    stringData,
  };
  // Idempotent create-or-replace: PUT replaces an existing Secret; a 404 means it does
  // not exist yet, so POST it. (The read-modify path a PATCH would need is avoided —
  // we always own the whole `trino-ext-<catalog>` Secret.)
  const existing = await k8s('GET', secretPath(ns, name));
  let sres: { status: number };
  if (existing.status === 200) {
    sres = await k8s('PUT', secretPath(ns, name), secretManifest);
  } else {
    sres = await k8s('POST', `/api/v1/namespaces/${ns}/secrets`, secretManifest);
  }
  if (!okStatus(sres.status)) {
    return { applied: false, status: sres.status, keys: envVars };
  }
  // Patch the Trino Deployment container env: add a secretKeyRef entry per env var.
  // A strategic-merge patch on the named container's `env` list merges by `name`, so
  // re-registering the same catalog updates the refs rather than duplicating them.
  const env = envVars.map((v) => ({
    name: v,
    valueFrom: { secretKeyRef: { name, key: v } },
  }));
  const patch = {
    spec: {
      template: {
        spec: {
          containers: [{ name: TRINO_CONTAINER, env }],
        },
      },
    },
  };
  const dres = await k8s('PATCH', deploymentPath(ns), patch);
  return { applied: okStatus(dres.status), status: dres.status, keys: envVars };
}

/**
 * (c) Trigger a Trino rollout by stamping a pod-template annotation. `strategy: Recreate`
 * + read-only rootfs means the pod must restart to re-read the ConfigMap mount; touching
 * the pod-template annotation is the standard, side-effect-free way to force that.
 */
async function triggerRollout(
  k8s: RegK8s,
  ns: string,
  catalog: string,
): Promise<{ applied: boolean; status: number }> {
  const patch = {
    spec: {
      template: {
        metadata: {
          annotations: {
            'soa.dev/catalog-registered': `${catalog}-${Date.now()}`,
          },
        },
      },
    },
  };
  const res = await k8s('PATCH', deploymentPath(ns), patch);
  return { applied: okStatus(res.status), status: res.status };
}

/**
 * Apply the full live registration for one external catalog. Ordered so a failure stops
 * BEFORE the rollout (never restart Trino into a half-registered state): ConfigMap →
 * Secret+env → rollout. Each step's result is reported; the first hard failure short-
 * circuits with an honest detail. `values` supplies the vaulted secret VALUES keyed by
 * env-var name (empty for keyless platforms).
 */
export async function applyLiveRegistration(
  reg: CatalogRegistration,
  values: SecretValues,
  opts: { namespace: string; k8s?: RegK8s },
): Promise<RegisterK8sOutcome> {
  const k8s = opts.k8s ?? (liveK8s as RegK8s);
  const ns = opts.namespace;
  const catalog = reg.name;
  const properties = propsToProperties(reg.props);

  const configMap = await mergeCatalogConfigMap(k8s, ns, catalog, properties);
  if (!configMap.applied) {
    return {
      ok: false,
      live: configMap.status !== 0,
      catalog,
      steps: {
        configMap,
        secret: { applied: false, status: 0, keys: [] },
        rollout: { applied: false, status: 0 },
      },
      detail:
        configMap.status === 0
          ? `Could not reach the Kubernetes API to merge the '${catalog}' catalog (not in a cluster, or the os-ui ServiceAccount lacks configmaps write).`
          : `Kubernetes rejected the ConfigMap merge for '${catalog}' (HTTP ${configMap.status}).`,
    };
  }

  const secret = await materializeSecret(k8s, ns, catalog, reg.envVars, values);
  if (!secret.applied) {
    return {
      ok: false,
      live: secret.status !== 0,
      catalog,
      steps: { configMap, secret, rollout: { applied: false, status: 0 } },
      detail:
        secret.status === 0
          ? `The catalog props merged, but the secret material for '${catalog}' is missing or unreadable — nothing was rolled out.`
          : `The catalog props merged, but Kubernetes rejected the secret/env wiring for '${catalog}' (HTTP ${secret.status}) — no rollout triggered.`,
    };
  }

  const rollout = await triggerRollout(k8s, ns, catalog);
  const ok = configMap.applied && secret.applied && rollout.applied;
  return {
    ok,
    live: rollout.status !== 0,
    catalog,
    steps: { configMap, secret, rollout },
    detail: ok
      ? `Registered catalog '${catalog}' live: merged its .properties into ${CATALOG_CM}${
          secret.keys.length ? `, wired ${secret.keys.length} secret env var(s)` : ' (keyless — no secret)'
        }, and rolled the Trino Deployment. It becomes queryable once the pod restarts.`
      : `Catalog '${catalog}' props + secret applied, but the Trino rollout patch failed (HTTP ${rollout.status}) — restart Trino manually to load it.`,
  };
}

export type RemoveK8sOutcome = {
  ok: boolean;
  /** True only when a real cluster answered (status !== 0). */
  live: boolean;
  catalog: string;
  steps: {
    configMap: { removed: boolean; status: number };
    secret: { removed: boolean; status: number };
    rollout: { applied: boolean; status: number };
  };
  detail: string;
};

/** A 404 is a SUCCESSFUL removal (the object is already gone) — idempotent teardown. */
function removedOk(status: number): boolean {
  return okStatus(status) || status === 404;
}

/**
 * REMOVE a catalog's LIVE registration — the exact inverse of {@link applyLiveRegistration},
 * for connection teardown (C1). A deleted warehouse connection whose catalog is still merged
 * into `trino-catalog` (and whose `trino-ext-<catalog>` Secret still holds a LIVE credential
 * COPY) is NOT deleted — Trino would keep federating it, and the delete report would falsely
 * claim the credential purged. Three idempotent steps against the SAME objects the chart
 * renders (a 404 counts as success — already gone):
 *
 *   (a) DROP the `<catalog>.properties` key from the `trino-catalog` ConfigMap (a JSON
 *       merge-patch with the key set to null removes exactly that catalog; other catalogs
 *       untouched).
 *   (b) DELETE the `trino-ext-<catalog>` k8s Secret (the materialized credential copy). The
 *       Deployment env still names the removed VAR via secretKeyRef, but with the Secret gone
 *       that ref resolves to nothing — the catalog is already dropped, so it is never read.
 *   (c) TRIGGER a Trino rollout so the pod re-reads the ConfigMap without the dropped catalog.
 *
 * Ordered ConfigMap → Secret → rollout so we never roll Trino into a state where a catalog
 * still points at a just-deleted Secret. Never throws — network/credential failure resolves
 * to `{ status: 0 }` and an honest `ok:false, live:false` (nothing was confirmed removed).
 */
export async function removeLiveRegistration(
  catalog: string,
  opts: { namespace: string; k8s?: RegK8s },
): Promise<RemoveK8sOutcome> {
  const k8s = opts.k8s ?? (liveK8s as RegK8s);
  const ns = opts.namespace;
  const key = `${catalog}.properties`;

  // (a) Drop the catalog key from the ConfigMap (merge-patch null removes it).
  const cmRes = await k8s('PATCH', cmPath(ns), { data: { [key]: null } });
  const configMap = { removed: removedOk(cmRes.status), status: cmRes.status };

  // (b) Delete the materialized credential-copy Secret (idempotent; 404 = already gone).
  const secName = extSecretName(catalog);
  const secRes = await k8s('DELETE', secretPath(ns, secName));
  const secret = { removed: removedOk(secRes.status), status: secRes.status };

  // (c) Roll Trino so it re-reads the ConfigMap without the dropped catalog.
  const rollout = await triggerRollout(k8s, ns, catalog);

  const reachable = cmRes.status !== 0;
  const ok = configMap.removed && secret.removed && rollout.applied;
  return {
    ok,
    live: reachable,
    catalog,
    steps: { configMap, secret, rollout },
    detail: !reachable
      ? `Could not reach the Kubernetes API to remove catalog '${catalog}' — its ConfigMap entry + '${secName}' Secret may still be live; remove them manually or re-run in-cluster.`
      : ok
        ? `Removed catalog '${catalog}' live: dropped its .properties from ${CATALOG_CM}, deleted the '${secName}' credential Secret, and rolled Trino.`
        : `Partial removal of catalog '${catalog}': configMap ${configMap.removed ? 'dropped' : `FAILED (HTTP ${configMap.status})`}, secret ${secret.removed ? 'deleted' : `FAILED (HTTP ${secret.status})`}, rollout ${rollout.applied ? 'triggered' : `FAILED (HTTP ${rollout.status})`} — resolve any leftover manually.`,
  };
}
