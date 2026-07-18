/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * DemoteButton — the ONE consistent "revoke sharing / step down the ladder" control
 * for every tab, the mirror of <PromoteButton>. Marketplace/Company → Shared/Domain
 * ("Revoke from Company") and Shared/Domain → Personal/My ("Unshare"), rendered with
 * the same button, copy and confirm everywhere so a user learns it once.
 *
 * Revoking sharing is a governed, reach-lowering step, so BOTH rungs run behind the
 * shared <ConfirmDialog> (unlike Promote, whose low-stakes first rung fires directly).
 * It POSTs `demoteUrl`; on success it calls `onDone()` so the host re-fetches. The
 * server (each tab's demote route → the governed demote seam) is the real gate — this
 * only surfaces the control when the caller may act.
 */

import { useCallback, useState } from 'react';
import { useConfirm } from './ConfirmDialog';
import { useToast } from '@/components/core/Toast';
import { demoteVerb, type Visibility } from '@/lib/core/scopes';

export type DemoteTier = 'Personal' | 'Shared' | 'Marketplace';

export default function DemoteButton({
  kind,
  tier,
  demoteUrl,
  onDone,
  label,
}: {
  /** Human noun for confirm copy, e.g. 'pillar', 'connection'. */
  kind: string;
  /** The artifact's CURRENT tier — drives the verb + confirm copy. */
  tier: DemoteTier;
  /** The route that POSTs the demotion (revoke sharing) one rung down. */
  demoteUrl: string;
  /** Called after a successful demotion so the host can re-fetch. */
  onDone?: () => void;
  /** Override the default button label. */
  label?: string;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const isRevokeCert = tier === 'Marketplace';
  const verb = demoteVerb(tier as Visibility);
  const text = label ?? verb;

  const run = useCallback(async () => {
    setErr('');
    const ok = await confirm({
      title: isRevokeCert ? `Revoke this ${kind} from Company?` : `Unshare this ${kind}?`,
      body: isRevokeCert
        ? `This lowers the ${kind} from Company back to Domain — it stops being available across every domain. It is not deleted; you can promote it again later.`
        : `This lowers the ${kind} from Domain back to My — it stops being visible to your domain. It is not deleted; you can promote it again later.`,
      confirmLabel: verb,
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(demoteUrl, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (data as { error?: string }).error ?? 'Revoke failed';
        setErr(msg);
        toast.error(msg);
        return;
      }
      toast.success(`${kind} ${isRevokeCert ? 'revoked from Company' : 'unshared'}`);
      onDone?.();
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }, [confirm, isRevokeCert, kind, verb, demoteUrl, onDone, toast]);

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
