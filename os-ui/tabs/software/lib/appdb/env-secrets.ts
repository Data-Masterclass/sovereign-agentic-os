/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - an app's own env variables and secrets per env (write-only)
 * USER STORY: As an app builder I set an API key for my app in Dev or Prod; it is never shown again, never logged, the
 *             app sees it after the rollout, and the audit says who changed which name, never the value.
 * ARCHITECTURE: (spec 7 "Env and secrets")
 *   - Storage is ONE Kubernetes Secret per app and env, `appResourceName(domain, slug, 'env')` in the env namespace,
 *     injected with `envFrom` (deploy-env-block.ts). No second store: the list (name, kind, updated-by, updated-at)
 *     is the Secret's `soa.dev/env-meta` annotation; values exist only in the Secret's data.
 *   - Writes are JSON merge patches guarded by the read `resourceVersion` (409 ⇒ re-read and retry, bounded); a value
 *     is never read back, returned, logged or put in an error. `setAppEnv` returns the entry without its value.
 *   - Names `^[A-Z][A-Z0-9_]{0,63}$`; the prefixes `PG`, `OS_`, `APP_` (and `KUBERNETES_`) and the names the runtime
 *     owns (PORT, HOSTNAME, NODE_ENV, NODE_OPTIONS, …) are refused: the platform sets those.
 *   - Platform keys (kind `platform`, written by `ensurePlatformEnv` before every rollout): `APP_ENV` and
 *     `OS_PUBLIC_URL`, which differ per env or per installation and so cannot be literals in the manifest that is
 *     identical in both envs (workstream E's sign-in reads them).
 *   - A change rolls the app's Deployments in that env (pod-template annotation `soa.dev/env-checksum`, the
 *     Deployment and, in Dev, both preview slots); a Deployment that does not exist yet is fine.
 *   - Rights are checked by the caller (access.ts); this module enforces names, sizes and write-only-ness.
 */
import { createHash } from 'node:crypto';
import { config } from '@core/kernel/config';
import type { Fetched } from '@core/adapters/_contract';
import { annotatePodTemplate, createSecretOnce, patchSecret, secretMeta, type CnpgObj } from '@core/adapters/cnpg/client';
import { appResourceName, type AppEnv } from '@tabs/software/lib/app-builder-contracts';
import { appDbNames, liveAppDbDeps, type AppDbDeps } from '@tabs/software/lib/appdb/database';
import { envNameProblem } from '@tabs/software/lib/appdb/env-names';

export const ENV_META_ANNOTATION = 'soa.dev/env-meta';
export const ENV_CHECKSUM_ANNOTATION = 'soa.dev/env-checksum';
export { ENV_NAME_RE, RESERVED_NAMES, RESERVED_PREFIXES } from '@tabs/software/lib/appdb/env-names';
/** A Secret holds at most 1 MiB; one value is capped well below that. */
export const MAX_VALUE_BYTES = 32 * 1024;
export const MAX_ENTRIES = 100;

export type EnvKind = 'plain' | 'secret' | 'platform';
export type EnvEntry = { name: string; kind: EnvKind; updatedBy: string; updatedAt: string };
type Meta = Record<string, { kind: EnvKind; by: string; at: string }>;

/** Null when `name` is a name an author may set; else the reason (the rule itself lives in env-names.ts). */
export function envNameRefusal(name: string): string | null {
  const p = envNameProblem(name);
  if (!p) return null;
  if (p.code === 'pattern') return 'a name is 1-64 characters: an upper-case letter, then upper-case letters, digits or _';
  if (p.code === 'prefix') return `names starting with ${p.prefix} are set by the platform`;
  return `${p.name} is set by the platform`;
}

const withStatus = (e: Error, status: number) => Object.assign(e, { status });
const failed = (f: Extract<Fetched<unknown>, { ok: false }>, what: string) =>
  withStatus(new Error(`${what}: ${f.detail}`), f.reason === 'forbidden' ? 403 : f.reason === 'unreachable' || f.reason === 'timeout' ? 503 : 502);

function parseMeta(annotations: Record<string, string>): Meta {
  const raw = annotations[ENV_META_ANNOTATION] ?? '{}';
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch (e) {
    // Never guessed around: a hand-edited annotation would otherwise hide entries or lose their kind.
    throw withStatus(new Error(`the ${ENV_META_ANNOTATION} annotation of the app env Secret is not JSON (${(e as Error).message}); fix or remove it`), 502);
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw withStatus(new Error(`the ${ENV_META_ANNOTATION} annotation of the app env Secret is not an object`), 502);
  return m as Meta;
}

function entriesOf(meta: Meta, keys: string[]): EnvEntry[] {
  return keys
    .map((name) => ({ name, kind: meta[name]?.kind ?? 'secret', updatedBy: meta[name]?.by ?? '', updatedAt: meta[name]?.at ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function envSecretManifest(ns: string, domain: string, slug: string): CnpgObj {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name: appDbNames(domain, slug).envSecret,
      namespace: ns,
      labels: { 'app.kubernetes.io/managed-by': 'os-ui', 'soa.dev/app-secret': 'env', 'soa.dev/app': appResourceName(domain, slug) },
      annotations: { 'soa.dev/domain': domain, 'soa.dev/slug': slug, [ENV_META_ANNOTATION]: '{}' },
    },
    data: {},
  };
}

/** Names (no values) of `domain/slug`'s env in `env`. */
export async function listAppEnv(domain: string, slug: string, env: AppEnv, deps: AppDbDeps = liveAppDbDeps()): Promise<EnvEntry[]> {
  const m = await secretMeta(deps.k8s, deps.namespace(env), appDbNames(domain, slug).envSecret);
  if (!m.ok) throw failed(m, 'reading the app env');
  return m.value ? entriesOf(parseMeta(m.value.annotations), m.value.keys) : [];
}

type Change = { set?: { name: string; value: string; kind: EnvKind }[]; unset?: string[] };

/** Apply `change` to the env Secret (creating it first), then roll the app. Returns the entries after the change. */
async function applyChange(domain: string, slug: string, env: AppEnv, by: string, change: Change, deps: AppDbDeps): Promise<{ entries: EnvEntry[]; rolled: string[] }> {
  const ns = deps.namespace(env);
  const name = appDbNames(domain, slug).envSecret;
  const made = await createSecretOnce(deps.k8s, envSecretManifest(ns, domain, slug));
  if (!made.ok) throw failed(made, 'creating the app env');
  for (let attempt = 0; attempt < 4; attempt++) {
    const m = await secretMeta(deps.k8s, ns, name);
    if (!m.ok) throw failed(m, 'reading the app env');
    if (!m.value) continue; // deleted between create and read: create again on the next round
    const meta = parseMeta(m.value.annotations);
    const data: Record<string, string | null> = {};
    const at = deps.now();
    for (const s of change.set ?? []) {
      data[s.name] = Buffer.from(s.value, 'utf8').toString('base64');
      meta[s.name] = { kind: s.kind, by, at };
    }
    for (const u of change.unset ?? []) {
      data[u] = null;
      delete meta[u];
    }
    const keys = new Set(m.value.keys);
    for (const k of Object.keys(data)) (data[k] === null ? keys.delete(k) : keys.add(k));
    if (keys.size > MAX_ENTRIES) throw withStatus(new Error(`an app may have at most ${MAX_ENTRIES} env entries per env`), 400);
    const rv = await patchSecret(deps.k8s, ns, name, { metadata: { resourceVersion: m.value.resourceVersion, annotations: { [ENV_META_ANNOTATION]: JSON.stringify(meta) } }, data });
    if (!rv.ok && rv.reason === 'conflict') continue;
    if (!rv.ok) throw failed(rv, 'writing the app env');
    const rolled = await rollApp(domain, slug, env, rv.value, deps);
    return { entries: entriesOf(meta, [...keys]), rolled };
  }
  throw withStatus(new Error('the app env kept changing; try again'), 409);
}

/** Roll the app's Deployments in `env` so they read the changed Secret. Names of the Deployments that were rolled. */
export async function rollApp(domain: string, slug: string, env: AppEnv, resourceVersion: string, deps: AppDbDeps = liveAppDbDeps()): Promise<string[]> {
  const checksum = createHash('sha256').update(`${domain}/${slug}:${env}:${resourceVersion}`).digest('hex').slice(0, 16);
  const targets = [appResourceName(domain, slug), ...(env === 'dev' ? [appResourceName(domain, slug, 'p1'), appResourceName(domain, slug, 'p2')] : [])];
  const rolled: string[] = [];
  for (const d of targets) {
    const r = await annotatePodTemplate(deps.k8s, deps.namespace(env), d, { [ENV_CHECKSUM_ANNOTATION]: checksum });
    if (!r.ok) throw failed(r, `the env was saved, but rolling ${d} failed`);
    if (r.value) rolled.push(d);
  }
  return rolled;
}

/** Set one author variable or secret. The value is never returned. */
export async function setAppEnv(
  domain: string,
  slug: string,
  env: AppEnv,
  by: string,
  input: { name: string; value: string; secret: boolean },
  deps: AppDbDeps = liveAppDbDeps(),
): Promise<{ entry: EnvEntry; rolled: string[] }> {
  const why = envNameRefusal(input.name);
  if (why) throw withStatus(new Error(why), 400);
  if (typeof input.value !== 'string') throw withStatus(new Error('the value must be text'), 400);
  if (Buffer.byteLength(input.value, 'utf8') > MAX_VALUE_BYTES) throw withStatus(new Error(`a value may be at most ${MAX_VALUE_BYTES / 1024} KiB`), 400);
  const r = await applyChange(domain, slug, env, by, { set: [{ name: input.name, value: input.value, kind: input.secret ? 'secret' : 'plain' }] }, deps);
  const entry = r.entries.find((e) => e.name === input.name)!;
  return { entry, rolled: r.rolled };
}

/** Remove one author entry. Removing a name that is not there is a 404. Platform keys cannot be removed. */
export async function unsetAppEnv(domain: string, slug: string, env: AppEnv, by: string, name: string, deps: AppDbDeps = liveAppDbDeps()): Promise<{ removed: string; rolled: string[] }> {
  const why = envNameRefusal(name);
  if (why) throw withStatus(new Error(why), 400);
  const now = await listAppEnv(domain, slug, env, deps);
  if (!now.some((e) => e.name === name)) throw withStatus(new Error(`${name} is not set in ${env}`), 404);
  const r = await applyChange(domain, slug, env, by, { unset: [name] }, deps);
  return { removed: name, rolled: r.rolled };
}

/** The platform keys an App Builder app reads (workstream E's sign-in): written before every rollout, kind `platform`. */
export function platformEnv(env: AppEnv, osPublicUrl: string = config.osPublicUrl): { name: string; value: string }[] {
  return [{ name: 'APP_ENV', value: env }, ...(osPublicUrl ? [{ name: 'OS_PUBLIC_URL', value: osPublicUrl }] : [])];
}

/**
 * Write the platform keys when they differ from what the meta says was written (no rollout when nothing changed: the
 * rollout that follows deploys the new pods anyway). Returns the names written.
 */
export async function ensurePlatformEnv(domain: string, slug: string, env: AppEnv, deps: AppDbDeps = liveAppDbDeps(), osPublicUrl: string = config.osPublicUrl): Promise<string[]> {
  const ns = deps.namespace(env);
  const name = appDbNames(domain, slug).envSecret;
  const made = await createSecretOnce(deps.k8s, envSecretManifest(ns, domain, slug));
  if (!made.ok) throw failed(made, 'creating the app env');
  const want = platformEnv(env, osPublicUrl);
  const digest = createHash('sha256').update(JSON.stringify(want)).digest('hex').slice(0, 16);
  for (let attempt = 0; attempt < 4; attempt++) {
    const m = await secretMeta(deps.k8s, ns, name);
    if (!m.ok) throw failed(m, 'reading the app env');
    if (!m.value) continue;
    if (m.value.annotations['soa.dev/platform-env'] === digest) return [];
    const meta = parseMeta(m.value.annotations);
    const at = deps.now();
    const data: Record<string, string> = {};
    for (const w of want) {
      data[w.name] = Buffer.from(w.value, 'utf8').toString('base64');
      meta[w.name] = { kind: 'platform', by: 'os', at };
    }
    const rv = await patchSecret(deps.k8s, ns, name, {
      metadata: { resourceVersion: m.value.resourceVersion, annotations: { [ENV_META_ANNOTATION]: JSON.stringify(meta), 'soa.dev/platform-env': digest } },
      data,
    });
    if (rv.ok) return want.map((w) => w.name);
    if (rv.reason !== 'conflict') throw failed(rv, 'writing the platform env');
  }
  throw withStatus(new Error('the app env kept changing; try again'), 409);
}
