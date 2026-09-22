/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * PURE helpers shared by the 3.5c interactive renderers — field coercion, the honest write-result
 * classification, and the "who am I" derivation for stamping `by`. Kept DOM-free + unit-tested so
 * the renderers own only their chrome. See DESIGN.md "the write door" — writes are append-only via
 * `os.records.add`, envelope-gated, and NEVER faked into a success.
 */
import type { FieldType } from './schema.ts';
import type { RecordResult, WhoAmI } from '@/lib/app-sdk/index.ts';

/** Coerce a raw string entry to its declared field type (empty stays undefined → omitted). */
export function coerceField(type: FieldType, raw: string): unknown {
  if (raw === '') return undefined;
  if (type === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (type === 'boolean') return raw === 'true';
  return raw;
}

/**
 * Is this record-op source a REAL, durable save? BOTH the durable OS-side app-records store
 * (`'os-records-store'` — the default write door for the static-SPA template) and a live app pod
 * (`'live-app'`) persist for real; only `'demo-seed'` is illustrative. The single source of truth
 * so no renderer regresses to an `=== 'live-app'`-only check (which wrongly reported the durable
 * store's saves as "not saved for real").
 */
export function isRealSave(source: RecordResult['source'] | undefined): boolean {
  return source === 'os-records-store' || source === 'live-app';
}

/**
 * Classify a `records.add` result HONESTLY into what the UI should say. A real save is either the
 * durable OS store or a live app pod (see {@link isRealSave}); a `'demo-seed'` (runner not live) is
 * illustrative, never claimed as saved.
 */
export type WriteOutcome = { saved: boolean; tone: 'success' | 'info'; message: string };

export function classifyWriteResult(result: RecordResult, savedMessage: string): WriteOutcome {
  if (isRealSave(result.source)) return { saved: true, tone: 'success', message: savedMessage };
  return {
    saved: false,
    tone: 'info',
    message: `Not saved for real — ${result.note ?? 'the app runner is not live (demo-seed).'}`,
  };
}

/**
 * The signed-in user's stamp for a `by` field, from `os.whoami()`. Prefers username, falls back to
 * id, then a benign 'unknown' (never an empty string) so a decision/completion always carries an
 * author. The real identity is enforced server-side; this is only the display stamp.
 */
export function actorStamp(who: WhoAmI | null | undefined): string {
  const u = who?.user;
  if (!u) return 'unknown';
  return (u.username && String(u.username)) || (u.id && String(u.id)) || 'unknown';
}
