/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    PromoteButton — the "Promote/Propose to Domain" and "Certify to Company" control
 * USER STORY: As an artifact owner I want one button that promotes my artifact up a scope, or files
 *             an approval request when I am not an approver, so that sharing never dead-ends.
 * ARCHITECTURE:
 *   - Uses the `promoteOrRequest` route contract. POST `promoteUrl`: `{ requested: true }` means a
 *     request was filed, so the button shows an "awaiting approval" pill and notifies through
 *     `useApprovalNotifier`. Any other success calls `onDone()`.
 *   - On mount it GETs `promoteUrl` to restore a pending-request pill after a reload, and disables
 *     the button with the reason when the server reports a closed `gate`.
 *   - Certify (Shared → Marketplace) asks for confirmation through `useConfirm()` with an
 *     informational dependents line. Promote (Personal → Shared) fires directly because it can be
 *     undone with `DemoteButton`. Labels come from `promoteVerb` in `@core/kernel/scopes`.
 * I18N:       converted (wave 4) — copy from `common.lifecycle.promote.*`, the verb from `useScopeLabel()`, server
 *             refusals and the gate reason through `useServerMessage()`. `kind` is the caller's noun.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useConfirm } from '@core/ui/lifecycle/ConfirmDialog';
import { useToast } from '@core/ui/core/Toast';
import { useApprovalNotifier } from '@core/ui/lifecycle/useApprovalNotifier';
import { useServerMessage, useTranslations } from '@core/i18n/client';
import { useScopeLabel } from '@core/ui/useScopeLabel';
import type { FiledApproval } from '@core/policy/approval-notice';

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
  const toast = useToast();
  const { notifyApprovalFiled } = useApprovalNotifier();
  const t = useTranslations('common');
  const scopes = useScopeLabel();
  const serverMsg = useServerMessage();
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  const [err, setErr] = useState('');
  // A gate the server already knows is closed. Rendering an enabled button over one means every
  // click is a refusal the user could have been shown first (the Metrics tab's dataset-derived
  // audience is the case that forced this).
  const [gate, setGate] = useState<{ ok: boolean; reason?: string } | null>(null);

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
        if (!live) return;
        if (data?.request) setRequested(true);
        if (data?.gate && data.gate.ok === false) setGate(data.gate as { ok: boolean; reason?: string });
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
  // Display verbs from the OS-wide scope vocabulary (lib/core/scopes.ts): the
  // Personal rung reads "Promote/Propose to Domain", the Shared rung "Certify to
  // Company". The PromoteTier enum values are unchanged.
  const defaultLabel =
    tier === 'Personal'
      ? scopes.promoteVerb('Personal', { propose: !canApprove })
      : scopes.promoteVerb('Shared');
  const text = label ?? defaultLabel;

  const run = useCallback(async () => {
    setErr('');
    if (isCertify) {
      const ok = await confirm({
        title: t('lifecycle.promote.certifyTitle', { kind }),
        body: t('lifecycle.promote.certifyBody', { kind }),
        confirmLabel: t('lifecycle.promote.certifyLabel'),
        danger: false,
        // Informational (0.6.98): certifying re-points dependents to the promoted copy.
        dependents: { artifactId: id, direction: 'promote' },
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await fetch(promoteUrl, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = serverMsg(data, t('lifecycle.promote.failed'));
        setErr(msg);
        toast.error(msg);
        return;
      }
      if ((data as { requested?: boolean }).requested) {
        setRequested(true);
        // ONE OS-wide "this needs approval" confirmation: names Policies & Approvals,
        // links there, and (if this user can) offers Approve now inline.
        const approval = (data as { approval?: FiledApproval }).approval;
        if (approval?.id) {
          notifyApprovalFiled(approval, kind, () => {
            setRequested(false);
            onDone?.();
          });
        } else {
          toast.info(t('lifecycle.promote.requestFiled', { kind }));
        }
        return;
      }
      toast.success(isCertify ? t('lifecycle.promote.certifiedDone', { label: text }) : t('lifecycle.promote.promotedToDomain', { kind }));
      onDone?.();
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }, [confirm, isCertify, kind, promoteUrl, onDone, toast, text, notifyApprovalFiled, id, t, serverMsg]);

  // Top of the ladder — nothing to promote.
  if (tier === 'Marketplace') return null;

  if (requested) {
    return (
      <span className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="pill" title={t('lifecycle.promote.awaitingHint')} style={{ textTransform: 'none', letterSpacing: 0 }}>
          {t('lifecycle.promote.requested')}
        </span>
        <a className="btn ghost sm" href="/governance" style={{ textDecoration: 'none' }}>
          {t('lifecycle.promote.approvalsLink')}
        </a>
      </span>
    );
  }

  const blocked = gate?.ok === false;
  const gateReason = gate?.reason ? serverMsg(gate, gate.reason, 'reason') : undefined;
  return (
    <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <button type="button" className="btn" onClick={run} disabled={busy || blocked} title={blocked ? gateReason : undefined}>
        {busy ? <span className="spin" /> : text}
      </button>
      {blocked && gateReason ? <span className="hint" style={{ margin: 0 }}>{gateReason}</span> : null}
      {err ? <span className="error" style={{ marginTop: 0 }}>{err}</span> : null}
    </div>
  );
}
