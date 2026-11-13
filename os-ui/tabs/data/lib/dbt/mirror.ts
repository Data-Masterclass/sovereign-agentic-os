/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Push-mirror configuration per domain repo (admin-only) and push-after-commit
 * USER STORY: As a platform admin I want to mirror a domain's data-project repo to our GitHub /
 *             Forgejo remote, with the token held as a Secret reference the OS never shows, and I
 *             want a failed push to be reported — never to block a save (checklist X2).
 * ARCHITECTURE:
 *   - The record holds `{url, tokenSecretRef}` only; the token lives in the secrets helper and is
 *     resolved by the git store at push time. Status (`lastSha`, `lastError`) is kept beside the
 *     record; errors are already scrubbed by the git store.
 *   - In-process map + the best-effort OpenSearch mirror (`os-data-project-mirrors`), the same
 *     durability pattern as every other OS store. Server-only.
 *   - URL rule: http(s) and allowed by the egress allowlist (an internal host must be explicitly
 *     allowlisted — the SSRF rule every connector endpoint obeys).
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { osMirror } from '@core/infra/os-mirror';
import { push, type MirrorConfig, type GitStoreOptions } from '@core/infra/git-store';
import { hasSecret, isEgressAllowed, type SecretRef } from '@core/infra/secrets';
import { DatasetError } from '@tabs/data/lib/dataset-schema';

export type MirrorStatus = { lastSha?: string; lastPushedAt?: string; lastError?: string; lastErrorAt?: string };

export type ProjectMirror = MirrorConfig & {
  domain: string;
  updatedAt: string;
  updatedBy: string;
  status: MirrorStatus;
};

type State = { byDomain: Map<string, ProjectMirror>; hydration: Promise<void> | null };
const KEY = Symbol.for('soa.data.project-mirrors');
function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  if (!g[KEY]) g[KEY] = { byDomain: new Map(), hydration: null };
  return g[KEY]!;
}

const durable = osMirror({ index: config.dataProjectMirrorsIndex });

export async function ensureMirrorsHydrated(): Promise<void> {
  const s = state();
  if (!s.hydration) {
    s.hydration = (async () => {
      const docs = await durable.hydrate(500);
      if (docs === null) {
        s.hydration = null; // retry on the next read — never cache a failed hydration
        return;
      }
      for (const doc of docs as ProjectMirror[]) {
        if (doc && doc.domain && !s.byDomain.has(doc.domain)) s.byDomain.set(doc.domain, doc);
      }
    })();
  }
  return s.hydration;
}

/** Validate + store a mirror for `domain`. The token is NEVER accepted here — only its reference. */
export function setProjectMirror(domain: string, input: { url: string; tokenSecretRef: SecretRef }, actor: { id: string }): ProjectMirror {
  const url = String(input.url ?? '').trim();
  if (!/^https?:\/\/[^\s]+$/.test(url)) throw new DatasetError('mirror url must be an http(s) URL', 400);
  const egress = isEgressAllowed(url);
  if (!egress.allowed) throw new DatasetError(`mirror host '${egress.host}' is not on the egress allowlist`, 400);
  const ref = input.tokenSecretRef;
  if (!ref || !ref.name || !ref.key) throw new DatasetError('tokenSecretRef {name, key} is required', 400);
  if (!hasSecret(ref)) throw new DatasetError(`secret '${ref.name}/${ref.key}' is not set — store the token first`, 400);
  const prev = state().byDomain.get(domain);
  const rec: ProjectMirror = {
    domain,
    url,
    tokenSecretRef: { name: ref.name, key: ref.key },
    updatedAt: new Date().toISOString(),
    updatedBy: actor.id,
    status: prev && prev.url === url ? prev.status : {},
  };
  state().byDomain.set(domain, rec);
  durable.writeThrough(domain, rec);
  return rec;
}

export function clearProjectMirror(domain: string): boolean {
  const had = state().byDomain.delete(domain);
  if (had) durable.deleteThrough(domain);
  return had;
}

export function getProjectMirror(domain: string): ProjectMirror | null {
  return state().byDomain.get(domain) ?? null;
}

/** Push `main` to the configured mirror; records the outcome. Returns null when none is configured. */
export async function pushProjectMirror(domain: string, opts: GitStoreOptions = {}): Promise<{ ok: boolean; error?: string } | null> {
  const rec = state().byDomain.get(domain);
  if (!rec) return null;
  const res = await push(domain, { url: rec.url, tokenSecretRef: rec.tokenSecretRef }, opts);
  const at = new Date().toISOString();
  rec.status = res.ok
    ? { ...rec.status, lastSha: res.sha, lastPushedAt: at, lastError: undefined, lastErrorAt: undefined }
    : { ...rec.status, lastError: res.error, lastErrorAt: at };
  durable.writeThrough(domain, rec);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** Fire-and-forget push after a changed commit: reports, never blocks or throws. */
export async function pushMirrorAfterCommit(domain: string, sha: string, opts: GitStoreOptions = {}): Promise<void> {
  try {
    await ensureMirrorsHydrated();
    const res = await pushProjectMirror(domain, opts);
    if (res && !res.ok) console.warn(`[data-projects] mirror push for ${domain} @ ${sha.slice(0, 7)} failed: ${res.error}`);
  } catch (e) {
    console.warn(`[data-projects] mirror push for ${domain} errored: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Test hook. */
export function __resetProjectMirrors(): void {
  state().byDomain.clear();
  state().hydration = null;
  durable.__reset();
}
