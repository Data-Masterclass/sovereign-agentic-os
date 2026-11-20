/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The `os-data` OPA bundle: every policy document os-ui used to push, compiled into one
 *             bundle that OPA downloads, activates atomically and persists itself.
 * USER STORY: As a user I want my grants to survive every OPA restart, even while os-ui is down,
 *             and never to be replaced by a partial or empty set because a store was not loaded.
 * ARCHITECTURE:
 *   - Upstream contract: https://www.openpolicyagent.org/docs/management-bundles (bundle service,
 *     `.manifest` revision + roots, ETag / If-None-Match → 304, `persist` +
 *     `persistence_directory`). OPA polls `GET /api/opa/bundles/os-data.tar.gz` every 5–15 s.
 *   - `compileOsData()` = the chart's seed files (`OS_OPA_SEED`, rendered by the chart helper that
 *     also renders the push-mode OPA's seed files) + every `bundled` restore source run in CAPTURE mode (`opa-publish.ts`): the very
 *     code the push path runs, so the bundle holds exactly what the pushes held.
 *   - COMPLETE OR NOTHING. A source that fails or reports its store unloaded, a missing seed, or a
 *     result with zero grant principals or zero governance principals rejects the compile. The
 *     last good bundle keeps being served (same bytes, same ETag), and OPA keeps its last good
 *     activation. Before the first good compile the route answers 503, so a cold OPA stays
 *     unready and every decision fails closed.
 *   - Recompiled when a bundled document changes (`onBundledWrite`, debounced) and on a 60 s
 *     resync. The route never calls OPA and never calls a decision, so there is no start-up loop.
 *   - Interim (design 04 §5.2): the sources read os-ui's stores, so os-ui stays one replica until
 *     they move to Postgres.
 */
import { createHash } from 'node:crypto';
import { config } from '@core/kernel/config';
import { scheduleEvery } from '@core/reconcile/runtime';
import { bundledOpaStateSources } from '@core/policy/opa-reconcile';
import { OS_DATA_ROOTS, captureOpaWrites, onBundledWrite, opaPathSegments } from '@core/policy/opa-publish';
import { canonicalJson, tarGz } from '@core/policy/bundle-tar';

export type OpaBundle = {
  name: string;
  revision: string;
  etag: string;
  bytes: Buffer;
  compiledAt: string;
  detail: string;
};

export type CompileResult = { ok: true; bundle: OpaBundle } | { ok: false; detail: string };

type Tree = Record<string, unknown>;

// ---------------------------------------------------------------- os_data.users (10 F7) --

type DirectoryUser = { id: string; domains: string[]; role: string; disabled?: boolean; attrs?: Record<string, unknown> };
export type OsDataUser = { domains: Record<string, string>; tenant_role: string; active: boolean; attrs: Record<string, string> };

/** `os_data.users[uid]`. Only allow-listed attribute keys (chart `opa.dataBundle.abacAttributes`) pass. */
export function compileOsDataUsers(users: DirectoryUser[], allow: string[]): Record<string, OsDataUser> {
  const keys = new Set(allow);
  const out: Record<string, OsDataUser> = {};
  for (const u of users) {
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(u.attrs ?? {})) if (keys.has(k) && v != null) attrs[k] = String(v);
    out[u.id] = {
      domains: Object.fromEntries([...new Set(u.domains)].sort().map((d) => [d, u.role])),
      tenant_role: u.role,
      active: !u.disabled,
      attrs,
    };
  }
  return out;
}

// ---------------------------------------------------------------- the bundle file --

/** The tar.gz for `data` under `roots`, its revision being the hash of the canonical data. */
export function buildBundle(name: string, data: Tree, roots: readonly string[], revision?: string): OpaBundle {
  const json = canonicalJson(data);
  const rev = revision ?? createHash('sha256').update(json).digest('hex').slice(0, 20);
  const manifest = canonicalJson({ revision: rev, roots: [...roots] });
  return {
    name,
    revision: rev,
    etag: `"${rev}"`,
    bytes: tarGz([{ name: '.manifest', content: manifest }, { name: 'data.json', content: json }]),
    compiledAt: new Date().toISOString(),
    detail: '',
  };
}

async function readSeed(): Promise<Tree> {
  const raw = config.opaSeed;
  if (!raw) throw new Error('OS_OPA_SEED is not set — the chart seed (seed_grants, requires_approval, governance) would be missing');
  const doc = JSON.parse(raw) as unknown;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('OS_OPA_SEED is not a JSON object');
  return doc as Tree;
}

/** Keep exactly the documents under `roots`; anything else in the tree is an error. */
function pickRoots(tree: Tree, roots: readonly string[]): Tree {
  const out: Tree = {};
  const rootSegs = roots.map((r) => opaPathSegments(r));
  const walk = (node: unknown, path: string[]): void => {
    const at = rootSegs.find((r) => r.length === path.length && r.every((s, i) => s === path[i]));
    if (at) {
      let o: Tree = out;
      for (const seg of path.slice(0, -1)) o = (o[seg] ??= {}) as Tree;
      o[path[path.length - 1]] = node;
      return;
    }
    const prefix = rootSegs.some((r) => r.length > path.length && path.every((s, i) => s === r[i]));
    if (!prefix || !node || typeof node !== 'object' || Array.isArray(node)) {
      throw new Error(`document data.${path.join('.')} is outside the os-data bundle roots`);
    }
    for (const [k, v] of Object.entries(node as Tree)) walk(v, [...path, k]);
  };
  for (const [k, v] of Object.entries(tree)) walk(v, [k]);
  return out;
}

function countKeys(v: unknown): number {
  return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).length : 0;
}

/** Compile the os-data bundle. Never throws; a failure names what was refused. */
export async function compileOsData(): Promise<CompileResult> {
  let seed: Tree;
  try {
    seed = await readSeed();
  } catch (err) {
    return { ok: false, detail: `seed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const sources = bundledOpaStateSources();
  if (sources.length === 0) return { ok: false, detail: 'no bundled policy-state sources are registered' };
  const { result: outcomes, tree } = await captureOpaWrites(seed, async () => {
    const out: { name: string; ok: boolean; detail: string }[] = [];
    for (const s of sources) {
      try {
        const r = await s.restore();
        out.push({ name: s.name, ...r });
      } catch (err) {
        out.push({ name: s.name, ok: false, detail: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  });
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length) return { ok: false, detail: `refused (incomplete source): ${failed.map((f) => `${f.name}: ${f.detail}`).join('; ')}` };
  let data: Tree;
  try {
    data = pickRoots(tree, OS_DATA_ROOTS);
  } catch (err) {
    return { ok: false, detail: `refused: ${err instanceof Error ? err.message : String(err)}` };
  }
  const grants = countKeys(data.grants);
  const principals = countKeys((data.governance as Tree | undefined)?.principals);
  const tables = countKeys((data.governance as Tree | undefined)?.tables);
  // Never go to zero: an empty grant map or principal map is a store that did not load.
  if (grants === 0) return { ok: false, detail: 'refused: the compiled grants document is empty' };
  if (principals === 0) return { ok: false, detail: 'refused: the compiled governance principals are empty' };
  const bundle = buildBundle('os-data', data, OS_DATA_ROOTS);
  bundle.detail = `${grants} grant principal(s), ${principals} governance principal(s), ${tables} table(s); ${outcomes.map((o) => `${o.name}: ${o.detail}`).join('; ')}`;
  return { ok: true, bundle };
}

// ---------------------------------------------------------------- last-good cache --

type State = {
  last: OpaBundle | null;
  lastError: string | null;
  lastErrorAt: string | null;
  inflight: Promise<CompileResult> | null;
  pending: ReturnType<typeof setTimeout> | null;
  stop: (() => void) | null;
};
const KEY = Symbol.for('soa.policy.os-data-bundle');
function st(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[KEY] ??= { last: null, lastError: null, lastErrorAt: null, inflight: null, pending: null, stop: null });
}

/** Recompile now (single-flight). A failure keeps the last good bundle. */
export function recompileOsData(reason: string): Promise<CompileResult> {
  const s = st();
  if (!s.inflight) {
    s.inflight = compileOsData()
      .then((r) => {
        if (r.ok) {
          if (s.last?.revision !== r.bundle.revision) console.info(`[os-ui] os-data bundle: revision ${r.bundle.revision} (${reason}) — ${r.bundle.detail}`);
          s.last = r.bundle;
          s.lastError = null;
          s.lastErrorAt = null;
        } else {
          s.lastError = r.detail;
          s.lastErrorAt = new Date().toISOString();
          console.error(`[os-ui] os-data bundle: NOT recompiled (${reason}) — ${r.detail}; serving ${s.last ? `last good revision ${s.last.revision}` : 'nothing (OPA stays unready)'}`);
        }
        return r;
      })
      .finally(() => {
        s.inflight = null;
      });
  }
  return s.inflight;
}

/** The bundle to serve: the last good one, compiling once if there is none yet. */
export async function currentOsDataBundle(): Promise<OpaBundle | null> {
  const s = st();
  if (!s.last) await recompileOsData('first-request');
  return s.last;
}

export function osDataBundleStatus(): { revision: string | null; compiledAt: string | null; lastError: string | null; lastErrorAt: string | null } {
  const s = st();
  return { revision: s.last?.revision ?? null, compiledAt: s.last?.compiledAt ?? null, lastError: s.lastError, lastErrorAt: s.lastErrorAt };
}

/** Start the change listener and the resync (web process, bundle mode). Idempotent. */
export function startOsDataBundle(opts: { resyncMs?: number; debounceMs?: number } = {}): () => void {
  const s = st();
  if (s.stop) return s.stop;
  const debounceMs = opts.debounceMs ?? 250;
  const off = onBundledWrite(() => {
    if (s.pending) return;
    s.pending = setTimeout(() => {
      s.pending = null;
      void recompileOsData('change');
    }, debounceMs);
    s.pending.unref?.();
  });
  const stopResync = scheduleEvery('opa-bundle.os-data', opts.resyncMs ?? 60_000, () => recompileOsData('resync'));
  void recompileOsData('boot');
  s.stop = () => {
    off();
    stopResync();
    if (s.pending) clearTimeout(s.pending);
    s.pending = null;
    s.stop = null;
  };
  return s.stop;
}

/** Test hook. */
export function __resetOsDataBundle(): void {
  const s = st();
  s.stop?.();
  s.last = null;
  s.lastError = null;
  s.lastErrorAt = null;
  s.inflight = null;
}

// ---------------------------------------------------------------- HTTP --

/** The documented bundle-service response: 304 on a matching If-None-Match, else the bytes + ETag. */
export function bundleHttpResponse(b: OpaBundle, ifNoneMatch: string | null, contentType = 'application/gzip'): Response {
  const headers = { ETag: b.etag, 'Content-Type': contentType, 'Cache-Control': 'no-store' };
  if (ifNoneMatch && ifNoneMatch.split(',').map((x) => x.trim()).includes(b.etag)) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(b.bytes), { status: 200, headers });
}
