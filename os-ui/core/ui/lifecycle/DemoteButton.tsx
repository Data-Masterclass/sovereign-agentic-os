/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    DemoteButton — the "Unshare" / "Revoke from Company" control, one rung down the ladder
 * USER STORY: As an artifact owner I want to lower an artifact's reach (Company → Domain, or
 *             Domain → My) behind a confirmation that lists its dependents, so that I can take
 *             back sharing without deleting anything.
 * ARCHITECTURE:
 *   - The mirror of `PromoteButton`. Both rungs go through `useConfirm()` with a
 *     dependents warning when `artifactId` is given. It then POSTs `demoteUrl` and calls
 *     `onDone()` so the host re-fetches. Renders nothing at the Personal tier.
 *   - The tab's demote route is the real permission check. The host decides whether to show the
 *     button. Used by the Data, Metrics and Dashboards builders.
 * I18N:       converted (wave 4) — copy from `common.lifecycle.demote.*`, the verb from `useScopeLabel()`, server
 *             refusals through `useServerMessage()`. `kind` and `body` are the caller's.
 */
'use client';

import { useCallback, useState } from 'react';
import { useConfirm } from '@core/ui/lifecycle/ConfirmDialog';
import { useToast } from '@core/ui/core/Toast';
import type { Visibility } from '@core/kernel/scopes';
import { useServerMessage, useTranslations } from '@core/i18n/client';
import { useScopeLabel } from '@core/ui/useScopeLabel';

export type DemoteTier = 'Personal' | 'Shared' | 'Marketplace';

export default function DemoteButton({
  kind,
  tier,
  demoteUrl,
  onDone,
  label,
  body,
  artifactId,
}: {
  /** Human noun for confirm copy, e.g. 'dashboard', 'connection'. */

  kind: string;
  /** The artifact's CURRENT tier — drives the verb + confirm copy. */
  tier: DemoteTier;
  /** The route that POSTs the demotion (revoke sharing) one rung down. */
  demoteUrl: string;
  /** Called after a successful demotion so the host can re-fetch. */
  onDone?: () => void;
  /** Override the default button label. */
  label?: string;
  /** Override the confirm-dialog body — for kinds whose demotion reaches wider
   *  than the artifact itself (e.g. a metric moves its dataset too). */
  body?: string;
  /** The artifact id — enables the warn-before-break dependents line (0.6.98). Demotion
   *  narrows visibility, so it's the transition that most often broke dependents. */
  artifactId?: string;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const t = useTranslations('common');
  const scopes = useScopeLabel();
  const serverMsg = useServerMessage();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const isRevokeCert = tier === 'Marketplace';
  const verb = scopes.demoteVerb(tier as Visibility);
  const text = label ?? verb;

  const run = useCallback(async () => {
    setErr('');
    const ok = await confirm({
      title: isRevokeCert ? t('lifecycle.demote.revokeTitle', { kind }) : t('lifecycle.demote.unshareTitle', { kind }),
      body: body ?? (isRevokeCert
        ? t('lifecycle.demote.revokeBody', { kind })
        : t('lifecycle.demote.unshareBody', { kind })),
      confirmLabel: verb,
      danger: true,
      ...(artifactId ? { dependents: { artifactId, direction: 'break' as const } } : {}),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(demoteUrl, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = serverMsg(data, t('lifecycle.demote.failed'));
        setErr(msg);
        toast.error(msg);
        return;
      }
      toast.success(isRevokeCert ? t('lifecycle.demote.revoked', { kind }) : t('lifecycle.demote.unshared', { kind }));
      // A side effect that did not land (e.g. the immediate query-engine policy push) is shown, never silent.
      // Server-written side-effect text; it carries no code yet, so it shows as sent (wave 4 leftover).
      const warning = (data as { warning?: string }).warning;
      if (warning) { setErr(warning); toast.error(warning); }
      onDone?.();
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }, [confirm, isRevokeCert, kind, verb, body, demoteUrl, onDone, toast, artifactId, t, serverMsg]);

  // Personal/My is the bottom of the ladder — nothing to revoke.
  if (tier === 'Personal') return null;

  return (
    <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <button type="button" className="btn ghost" onClick={run} disabled={busy}>
        {busy ? <span className="spin" /> : text}
      </button>
      {err ? <span className="error" style={{ marginTop: 0 }}>{err}</span> : null}
    </div>
  );
}
