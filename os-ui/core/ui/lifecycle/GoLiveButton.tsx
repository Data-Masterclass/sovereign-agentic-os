/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       ui
 * FEATURE:    The ONE Go live button, with the ONE confirm dialog
 * USER STORY: As a builder I want a single button that makes the version I am looking at the one
 *             the OS runs, after a dialog that tells me exactly what will start running — and if
 *             a dependency is still a draft, I want to be told which one.
 * ARCHITECTURE:
 *   - Reuses the existing `<ConfirmProvider>` / `useConfirm()` dialog: the lifecycle adds no
 *     second dialog and no new modal (simplicity contract §2).
 *   - Every string and the blocked-state rule come from `./go-live-client.ts`, which is what the
 *     tests import. The component only wires the click.
 *   - Go live and Retire are the same button in its two states, so a detail header gains ONE
 *     control, never two.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useConfirm } from '@core/ui/lifecycle/ConfirmDialog';
import { hasUnpublishedEdits, lifecycleWordOf } from '@core/kernel/object-lifecycle';
import {
  fetchGoLivePreview,
  fetchLifecycleStatus,
  goLiveButtonLabel,
  goLiveDialogCopy,
  postGoLive,
  postRetire,
  retireDialogCopy,
  type LifecycleStatusDto,
} from '@core/ui/lifecycle/go-live-client';

export default function GoLiveButton({
  kind,
  id,
  onChanged,
}: {
  kind: string;
  id: string;
  onChanged?: () => void;
}) {
  const confirm = useConfirm();
  const [status, setStatus] = useState<LifecycleStatusDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchLifecycleStatus(kind, id)
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
  }, [kind, id]);

  useEffect(reload, [reload]);

  if (error) return <span className="muted" title={error}>Lifecycle unavailable</span>;
  if (!status) return null;

  const word = lifecycleWordOf(status.lifecycle);
  const unpublished = hasUnpublishedEdits(status.lifecycle);
  const label = goLiveButtonLabel(word, unpublished);

  const goLiveClick = async () => {
    setBusy(true);
    try {
      const preview = await fetchGoLivePreview(kind, id);
      const copy = goLiveDialogCopy(preview);
      const ok = await confirm(copy);
      if (ok && !preview.blocked) {
        await postGoLive(kind, id);
        reload();
        onChanged?.();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const retireClick = async () => {
    setBusy(true);
    try {
      const ok = await confirm(retireDialogCopy(status.object.name, kind));
      if (ok) {
        await postRetire(kind, id);
        reload();
        onChanged?.();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="lifecycle-actions">
      {word === 'live' && !unpublished ? (
        <button type="button" className="btn ghost" disabled={busy} onClick={retireClick}>
          {label}
        </button>
      ) : (
        <button type="button" className="btn" disabled={busy} onClick={goLiveClick}>
          {label}
        </button>
      )}
    </span>
  );
}
