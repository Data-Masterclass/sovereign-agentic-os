/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    What the continuous key reconcile found: which agent systems' model keys at the
 *             gateway no longer match their definition.
 *
 * USER STORY: As a platform admin I see, in Admin and in Monitoring, that someone changed a
 *             system's key in LiteLLM — what changed, and since when.
 *             As a system owner I see the drift of MY systems only.
 *
 * ARCHITECTURE:
 *   - OWNERSHIP. LiteLLM owns providers, credentials, models and global budgets; the OS owns the
 *     per-system virtual key (its models, budget, limits and `allowed_tools`, all derived from the
 *     system's grants). The platform team may edit that key in LiteLLM; the OS does not hide it and
 *     does not silently undo it: the difference is REPORTED here. It is undone only by an admin
 *     ("re-apply from the OS") or, per system, when an admin switched auto-correct on.
 *   - This module is the kernel's HOLDER of the last report (a process-local slot, like the sweep's
 *     and the migration's). The pass itself lives in the Agents tab
 *     (`tabs/agents/lib/build/key-reconcile.ts`) because only it knows what a system's key should
 *     be; Monitoring and Admin read the report from here, so no tab imports another.
 *   - PURE: no IO, no secrets. An entry carries a system id, an alias and sentences about what
 *     differs — never a key value or a token id.
 */

/**
 *   drift      the key is the OS's key but a property differs from the definition
 *   missing    the OS holds a key for the system and the gateway no longer does
 *   duplicate  the gateway holds more than one key under the system's alias
 *   not-ours   the gateway's key is not the one the OS stored (or the stored copy cannot be read)
 */
export type KeyDriftKind = 'drift' | 'missing' | 'duplicate' | 'not-ours';

/** alert = reported only; corrected = an admin-enabled auto-correct fixed it this pass. */
export type KeyDriftAction = 'alert' | 'corrected' | 'correction-failed';

export type KeyDriftEntry = {
  systemId: string;
  alias: string;
  kind: KeyDriftKind;
  /** Human sentences ("budget $500 → $5"). */
  changes: string[];
  /** When this drift was first seen (epoch ms); kept from pass to pass while it stands. */
  firstSeenAt: number;
  action: KeyDriftAction;
  /** Why an attempted correction failed. */
  error?: string;
};

export type KeyReconcileReport = {
  at: number;
  /** false = the pass could not look (gateway or registry unreadable): "could not check", never "in sync". */
  ok: boolean;
  scanned: number;
  inSync: number;
  /** Systems with no stored key and no key at the gateway: never built, nothing to compare. */
  notBuilt: number;
  /** Systems skipped because a key replacement is still completing (the journal holds it). */
  inFlight: number;
  entries: KeyDriftEntry[];
  /** Systems the pass could not read (the gateway failed for them) — not in sync, not drifted: unknown. */
  unchecked: { systemId: string; error: string }[];
  error?: string;
};

type Slot = { last?: KeyReconcileReport };
const g = globalThis as unknown as { __osKeyReconcile?: Slot };
const slot = (): Slot => (g.__osKeyReconcile ??= {});

/** The last pass this process ran, or null before the first one. */
export function lastKeyReconcile(): KeyReconcileReport | null {
  return slot().last ?? null;
}

export function setKeyReconcile(report: KeyReconcileReport): void {
  slot().last = report;
}

/** Only the drift of the given systems — the viewer's own scope; nothing about any other system. */
export function driftForSystems(report: KeyReconcileReport, systemIds: Iterable<string>): KeyDriftEntry[] {
  const ids = new Set(systemIds);
  return report.entries.filter((e) => ids.has(e.systemId));
}
