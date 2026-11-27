/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       auth
 * FEATURE:    App Builder (E) - the user's consent per app and env, revocable in My Settings
 * USER STORY: As a user I want to see once what an app may do as me (read these datasets, run these agents, these
 *             actions), say yes or no, be asked again when the app wants more, and take it back at any time.
 * ARCHITECTURE:
 *   - One record per (user, app, env), all of a user's records in ONE doc `app-consents-<userId>` of the
 *     `os-app-consents` index, read by id (no whole-index read). Only the web process writes it (the worker never
 *     accepts an app bearer), so a whole-doc write cannot erase another process's edit.
 *   - A record names WHAT was agreed: the scopes, the granted read items (`<kind>:<id>`) and the agent systems, plus
 *     the app id (an app deleted and re-created under the same slug does not inherit consent). A login asks again
 *     when the app's current needs are not a subset of the record (a widened deploy); narrowing never asks.
 *   - Every bearer call checks the record again (`consentFor`), so a revoke takes effect on the next call. A store
 *     that does not answer is `undefined` and the caller refuses — never "no consent needed".
 *   - Writes are awaited (`writeConfirmed`): the UI never says "revoked" for a change the shared store did not take.
 */
import 'server-only';
import { osMirror } from '@core/infra/os-mirror';
import { appTokenScope, isSubset, readKey, type AppTokenApp, type AppTokenEnv, type ConsentView } from '@core/auth/app-token';

export type AppConsent = ConsentView & {
  key: string;
  appId: string;
  appName: string;
  domain: string;
  slug: string;
  env: AppTokenEnv;
  grantedAt: string;
};
type ConsentDoc = { userId: string; consents: Record<string, AppConsent>; updatedAt: string };

/** The store behind the records (injectable for tests). */
export type ConsentBackend = {
  read(userId: string): Promise<ConsentDoc | null | 'unreachable'>;
  write(userId: string, doc: ConsentDoc): Promise<{ ok: true } | { ok: false; reason: string }>;
};

const docId = (userId: string) => `app-consents-${userId}`;

function mirrorBackend(): ConsentBackend {
  const mirror = osMirror({ index: 'os-app-consents' });
  return {
    async read(userId) {
      const r = await mirror.read(docId(userId));
      if (r.state === 'unreachable') return 'unreachable';
      if (r.state === 'absent') return null;
      return normalizeDoc(userId, r.doc);
    },
    write: (userId, doc) => mirror.writeConfirmed(docId(userId), doc),
  };
}

function normalizeDoc(userId: string, raw: unknown): ConsentDoc {
  const d = (raw ?? {}) as Partial<ConsentDoc>;
  const consents: Record<string, AppConsent> = {};
  for (const [k, v] of Object.entries(d.consents ?? {})) {
    const c = v as Partial<AppConsent>;
    if (!c || typeof c.appId !== 'string' || (c.env !== 'dev' && c.env !== 'prod')) continue;
    const list = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);
    consents[k] = {
      key: k,
      appId: c.appId,
      appName: String(c.appName ?? ''),
      domain: String(c.domain ?? ''),
      slug: String(c.slug ?? ''),
      env: c.env,
      scopes: list(c.scopes),
      reads: list(c.reads),
      agents: list(c.agents),
      grantedAt: String(c.grantedAt ?? ''),
    };
  }
  return { userId, consents, updatedAt: String(d.updatedAt ?? '') };
}

type State = { backend: ConsentBackend | null; cache: Map<string, { doc: ConsentDoc | null; at: number }> };
const KEY = Symbol.for('soa.core.app-consent');
function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  if (!g[KEY]) g[KEY] = { backend: null, cache: new Map() };
  return g[KEY]!;
}
const backend = (): ConsentBackend => (state().backend ??= mirrorBackend());
const CACHE_MS = 15_000;

/** Test seam: an in-memory backend (or the real one again with null). */
export function __setConsentBackendForTests(b: ConsentBackend | null): void {
  state().backend = b;
  state().cache.clear();
}

/** The record key of an app+env: `<domain>/<slug>:<env>`. */
export const consentKey = (app: Pick<AppTokenApp, 'domain' | 'slug'>, env: AppTokenEnv) => `${app.domain}/${app.slug}:${env}`;

/** What a login must have consent for NOW: the derived scope, every granted read item, every granted agent. */
export function requiredConsent(app: AppTokenApp): ConsentView {
  return {
    scopes: appTokenScope(app),
    reads: [...new Set(app.reads.map((r) => readKey(r.kind, r.id)))].sort(),
    agents: [...new Set(app.agents.map((a) => a.id))].sort(),
  };
}

/** Does `consent` cover `need`? (Narrowing is covered; any addition is not.) */
export function consentCovers(consent: ConsentView | null | undefined, need: ConsentView): boolean {
  return !!consent && isSubset(need.scopes, consent.scopes) && isSubset(need.reads, consent.reads) && isSubset(need.agents, consent.agents);
}

async function readDoc(userId: string, fresh: boolean): Promise<ConsentDoc | null | undefined> {
  const s = state();
  const hit = s.cache.get(userId);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.doc;
  const r = await backend().read(userId);
  if (r === 'unreachable') return undefined;
  s.cache.set(userId, { doc: r, at: Date.now() });
  return r;
}

/** The user's consent for this app (same id) and env; null = none; undefined = the store did not answer. */
export async function consentFor(userId: string, app: Pick<AppTokenApp, 'id' | 'domain' | 'slug'>, env: AppTokenEnv): Promise<AppConsent | null | undefined> {
  const doc = await readDoc(userId, false);
  if (doc === undefined) return undefined;
  const c = doc?.consents[consentKey(app, env)];
  return c && c.appId === app.id ? c : null;
}

/** Every consent of the user (My Settings). undefined = the store did not answer. */
export async function listConsents(userId: string): Promise<AppConsent[] | undefined> {
  const doc = await readDoc(userId, true);
  if (doc === undefined) return undefined;
  return Object.values(doc?.consents ?? {}).sort((a, b) => a.key.localeCompare(b.key));
}

/** Store the user's consent for what the app needs now (replaces an older record of the same app+env). */
export async function grantConsent(userId: string, app: AppTokenApp, env: AppTokenEnv, now: Date = new Date()): Promise<{ ok: true; consent: AppConsent } | { ok: false; reason: string }> {
  const doc = await readDoc(userId, true);
  if (doc === undefined) return { ok: false, reason: 'the consent store did not answer' };
  const key = consentKey(app, env);
  const consent: AppConsent = { key, appId: app.id, appName: app.name, domain: app.domain, slug: app.slug, env, ...requiredConsent(app), grantedAt: now.toISOString() };
  const next: ConsentDoc = { userId, consents: { ...(doc?.consents ?? {}), [key]: consent }, updatedAt: now.toISOString() };
  const w = await backend().write(userId, next);
  if (!w.ok) return w;
  state().cache.set(userId, { doc: next, at: Date.now() });
  return { ok: true, consent };
}

/** Revoke one consent by key. `absent` when there was none. */
export async function revokeConsent(userId: string, key: string, now: Date = new Date()): Promise<{ ok: true; revoked: AppConsent | null } | { ok: false; reason: string }> {
  const doc = await readDoc(userId, true);
  if (doc === undefined) return { ok: false, reason: 'the consent store did not answer' };
  const existing = doc?.consents[key] ?? null;
  if (!existing) return { ok: true, revoked: null };
  const consents = { ...doc!.consents };
  delete consents[key];
  const next: ConsentDoc = { userId, consents, updatedAt: now.toISOString() };
  const w = await backend().write(userId, next);
  if (!w.ok) return w;
  state().cache.set(userId, { doc: next, at: Date.now() });
  return { ok: true, revoked: existing };
}
