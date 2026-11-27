/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - an app's own env variables and secrets per env (write-only)
 * USER STORY: As an app builder I set an API key for my app in Dev or Prod; it is never shown again, never logged, the
 *             app sees it after the rollout, and the audit says who changed which name, never the value.
 * ARCHITECTURE: (spec 7 "Env and secrets")
 *   - Values live ONLY in one Kubernetes Secret per app and env, `appResourceName(domain, slug, 'env')` in the env
 *     namespace, injected with `envFrom` (deploy-env-block.ts). os-ui WRITES that Secret (merge patches of single keys)
 *     and never reads it: it holds no `get` on Secrets in the env namespaces (security review of #393).
 *   - The list (name, kind, updated-by, updated-at) is a ConfigMap of the same name (`data.meta`, JSON), written after the
 *     Secret and guarded by its `resourceVersion` (409 ⇒ re-read and retry, bounded). Names only, never a value.
 *   - An existing Secret or ConfigMap of that name must belong to this app (adapter `createOnce`: an admission-checked
 *     patch of the owner annotations, never a read).
 *   - Names `^[A-Z][A-Z0-9_]{0,63}$`; the prefixes and names the platform or the runtime owns are refused (env-names.ts).
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
import { annotatePodTemplate, createConfigMapOnce, createSecretOnce, patchConfigMap, patchSecret, readConfigMap, type CnpgObj } from '@core/adapters/cnpg/client';
import { appResourceName, type AppEnv } from '@tabs/software/lib/app-builder-contracts';
import { appDbNames, liveAppDbDeps, type AppDbDeps } from '@tabs/software/lib/appdb/database';
import { envNameProblem } from '@tabs/software/lib/appdb/env-names';

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
  withStatus(new Error(`${what}: ${f.detail}`), f.reason === 'forbidden' ? 403 : f.reason === 'conflict' ? 409 : f.reason === 'unreachable' || f.reason === 'timeout' ? 503 : 502);

function parseMeta(raw: string | undefined): Meta {
  let m: unknown;
  try {
    m = JSON.parse(raw ?? '{}');
  } catch (e) {
    // Never guessed around: a hand-edited list would otherwise hide entries or lose their kind.
    throw withStatus(new Error(`the env list (ConfigMap data.meta) is not JSON (${(e as Error).message}); fix or remove it`), 502);
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw withStatus(new Error('the env list (ConfigMap data.meta) is not an object'), 502);
  return m as Meta;
}

const entriesOf = (meta: Meta): EnvEntry[] =>
  Object.entries(meta)
    .map(([name, m]) => ({ name, kind: m.kind, updatedBy: m.by ?? '', updatedAt: m.at ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name));

const owner = (domain: string, slug: string) => ({ 'soa.dev/domain': domain, 'soa.dev/slug': slug });
const labels = (domain: string, slug: string, kind: string) => ({ 'app.kubernetes.io/managed-by': 'os-ui', 'soa.dev/app-secret': kind, 'soa.dev/app': appResourceName(domain, slug) });

function envSecretManifest(ns: string, domain: string, slug: string): CnpgObj {
  return { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: { name: appDbNames(domain, slug).envSecret, namespace: ns, labels: labels(domain, slug, 'env'), annotations: owner(domain, slug) }, data: {} };
}
function envListManifest(ns: string, domain: string, slug: string): CnpgObj {
  return { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: appDbNames(domain, slug).envSecret, namespace: ns, labels: labels(domain, slug, 'env-list'), annotations: owner(domain, slug) }, data: { meta: '{}' } };
}

/** Names (no values) of `domain/slug`'s env in `env`. */
export async function listAppEnv(domain: string, slug: string, env: AppEnv, deps: AppDbDeps = liveAppDbDeps()): Promise<EnvEntry[]> {
  const cm = await readConfigMap(deps.k8s, deps.namespace(env), appDbNames(domain, slug).envSecret);
  if (!cm.ok) throw failed(cm, 'reading the app env list');
  return cm.value ? entriesOf(parseMeta(cm.value.data.meta)) : [];
}

async function ensureStores(ns: string, domain: string, slug: string, deps: AppDbDeps): Promise<void> {
  const s = await createSecretOnce(deps.k8s, envSecretManifest(ns, domain, slug));
  if (!s.ok) throw failed(s, 'creating the app env');
  const c = await createConfigMapOnce(deps.k8s, envListManifest(ns, domain, slug));
  if (!c.ok) throw failed(c, 'creating the app env list');
}

type Change = { set?: { name: string; value: string; kind: EnvKind }[]; unset?: string[] };

/** Write the Secret keys, then the list (resourceVersion-guarded), then roll the app. Returns the entries after it. */
async function applyChange(domain: string, slug: string, env: AppEnv, by: string, change: Change, deps: AppDbDeps, extra: Record<string, string> = {}): Promise<{ entries: EnvEntry[]; rolled: string[] }> {
  const ns = deps.namespace(env);
  const name = appDbNames(domain, slug).envSecret;
  await ensureStores(ns, domain, slug, deps);
  for (let attempt = 0; attempt < 4; attempt++) {
    const cm = await readConfigMap(deps.k8s, ns, name);
    if (!cm.ok) throw failed(cm, 'reading the app env list');
    if (!cm.value) throw withStatus(new Error('the app env list disappeared while it was being changed; try again'), 409);
    const meta = parseMeta(cm.value.data.meta);
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
    if (Object.keys(meta).length > MAX_ENTRIES) throw withStatus(new Error(`an app may have at most ${MAX_ENTRIES} env entries per env`), 400);
    const rv = await patchSecret(deps.k8s, ns, name, { data });
    if (!rv.ok) throw failed(rv, 'writing the app env');
    const listed = await patchConfigMap(deps.k8s, ns, name, { metadata: { resourceVersion: cm.value.resourceVersion }, data: { meta: JSON.stringify(meta), ...extra } });
    if (!listed.ok && listed.reason === 'conflict') continue; // the Secret write is per key and idempotent: retried as is
    if (!listed.ok) throw failed(listed, 'writing the app env list');
    const rolled = await rollApp(domain, slug, env, rv.value, deps);
    return { entries: entriesOf(meta), rolled };
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
 * Write the platform keys when they differ from what the list says was written (no rollout when nothing changed: the
 * rollout that follows deploys the new pods anyway). Returns the names written.
 */
export async function ensurePlatformEnv(domain: string, slug: string, env: AppEnv, deps: AppDbDeps = liveAppDbDeps(), osPublicUrl: string = config.osPublicUrl): Promise<string[]> {
  const ns = deps.namespace(env);
  const name = appDbNames(domain, slug).envSecret;
  await ensureStores(ns, domain, slug, deps);
  const want = platformEnv(env, osPublicUrl);
  const digest = createHash('sha256').update(JSON.stringify(want)).digest('hex').slice(0, 16);
  for (let attempt = 0; attempt < 4; attempt++) {
    const cm = await readConfigMap(deps.k8s, ns, name);
    if (!cm.ok) throw failed(cm, 'reading the app env list');
    if (!cm.value) throw withStatus(new Error('the app env list disappeared; try again'), 409);
    if (cm.value.data.platformEnv === digest) return [];
    const meta = parseMeta(cm.value.data.meta);
    const at = deps.now();
    const data: Record<string, string> = {};
    for (const w of want) {
      data[w.name] = Buffer.from(w.value, 'utf8').toString('base64');
      meta[w.name] = { kind: 'platform', by: 'os', at };
    }
    const rv = await patchSecret(deps.k8s, ns, name, { data });
    if (!rv.ok) throw failed(rv, 'writing the platform env');
    const listed = await patchConfigMap(deps.k8s, ns, name, { metadata: { resourceVersion: cm.value.resourceVersion }, data: { meta: JSON.stringify(meta), platformEnv: digest } });
    if (listed.ok) return want.map((w) => w.name);
    if (listed.reason !== 'conflict') throw failed(listed, 'writing the app env list');
  }
  throw withStatus(new Error('the app env kept changing; try again'), 409);
}
