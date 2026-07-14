/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * PromoteButton — the ONE consistent "promote up the ladder" control for every tab.
 * Personal → Shared (Promote) and Shared → Marketplace (Certify), rendered with the
 * same button, copy and states everywhere so a user learns it once.
 *
 * It speaks the governance-ladder contract (`promoteOrRequest`, 0.1.102):
 *   • POST `promoteUrl`. If the response is `{ requested: true }` the caller is a
 *     non-approver OWNER and a request was FILED — we switch to a calm "awaiting a
 *     domain admin's approval" pill instead of dead-ending them.
 *   • Otherwise the item was promoted in one shot → we call `onDone()` so the host
 *     re-fetches (each tab keeps its own success-refresh behaviour).
 *   • On mount we GET `promoteUrl` (which returns `{ request }`, the pending approval
 *     or null) so the pill PERSISTS across a reload.
 *
 * Certify (Shared → Marketplace) is the higher-stakes rung, so it runs behind the
 * shared <ConfirmDialog>. Promote (Personal → Shared) is low-stakes and reversible
 * (Demote), so it fires directly.
 */

import { useCallback, useEffect, useState } from 'react';
import { useConfirm } from './ConfirmDialog';

export type PromoteTier = 'Personal' | 'Shared' | 'Marketplace';

export default function PromoteButton({
  id,
  kind,
  tier,
  promoteUrl,
  canApprove = true,
  onDone,
  label,
}: {
  id: string;
  /** Human noun for confirm/pill copy, e.g. 'metric', 'dashboard'. */
  kind: string;
  tier: PromoteTier;
  /** The route that both POSTs the promotion and GETs the pending request. */
  promoteUrl: string;
  /** Whether the signed-in user can approve at this tier (drives copy + the certify gate). */
  canApprove?: boolean;
  /** Called after a successful one-shot promotion so the host can re-fetch. */
  onDone?: () => void;
  /** Override the default button label. */
  label?: string;
}) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  const [err, setErr] = useState('');

  // Persist the "awaiting approval" pill across reloads: ask the route for any
  // pending request this owner already filed. Silent on failure — a missing pill
  // is never worse than a spurious one.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(promoteUrl, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        if (live && data?.request) setRequested(true);
      } catch {
        /* ignore — pill just won't pre-fill */
      }
    })();
    return () => {
      live = false;
    };
  }, [promoteUrl, id]);

  const isCertify = tier === 'Shared';
  // Honest copy: a non-approver at Personal is PROPOSING (their POST files a request);
  // an approver promotes directly. Marketplace is the top — nothing to do.
  const defaultLabel =
    tier === 'Personal'
      ? canApprove
        ? 'Promote to Shared'
        : 'Propose to Shared'
      : 'Certify to Marketplace';
  const text = label ?? defaultLabel;

  const run = useCallback(async () => {
    setErr('');
    if (isCertify) {
      const ok = await confirm({
        title: `Certify this ${kind} to the Marketplace?`,
        body: `Certifying makes this ${kind} available across every domain in the Marketplace. This is a governed step that a platform admin vouches for.`,
        confirmLabel: 'Certify',
        danger: false,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await fetch(promoteUrl, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr((data as { error?: string }).error ?? 'Promotion failed');
        return;
      }
      if ((data as { requested?: boolean }).requested) {
        setRequested(true);
        return;
      }
      onDone?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [confirm, isCertify, kind, promoteUrl, onDone]);

  // Top of the ladder — nothing to promote.
  if (tier === 'Marketplace') return null;

  if (requested) {
    return (
      <span className="pill" title="A domain admin will review this in Governance" style={{ textTransform: 'none', letterSpacing: 0 }}>
        ⏳ Requested — awaiting a domain admin&apos;s approval
      </span>
    );
  }

  return (
    <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <button type="button" className="btn" onClick={run} disabled={busy}>
        {busy ? <span className="spin" /> : text}
      </button>
      {err ? <span className="error" style={{ marginTop: 0 }}>{err}</span> : null}
    </div>
  );
}
