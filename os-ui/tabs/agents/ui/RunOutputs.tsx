/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Where a run's results went — one row per declared output, with its state and a link
 * USER STORY: As the person who ran a system I want to see, right under the result, that the
 *             report is in My files, that the note waits for a domain admin, and that the rows
 *             were not saved because the result had no table — and to save again with one click
 *             when a save failed.
 * ARCHITECTURE:
 *   - Pure presentation of `OutputResult[]` (`lib/output-saver.ts`): the sentence shown is the
 *     one the engine wrote, so the panel, `get_agent_run` and the stored run always agree.
 *   - "Try saving again" / "Save now" POSTs to the system's `outputs/save` route — the same save
 *     the engine runs, as the signed-in user; it looks for what the run already wrote first, so a
 *     second click never writes a second copy. The route answers with the new list.
 *   - Used by the Run panel (under the final output) and by Evaluate. Renders nothing for a
 *     system that declares no output.
 */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations, useServerMessage } from '@core/i18n/client';
import type { OutputResult } from '@tabs/agents/lib/output-saver';
import type { DeclaredOutput, OutputKind } from '@tabs/agents/lib/system-schema';

/** `label` is the `agents.outputs.kind.<kind>` key. */
const KIND_LABEL: Record<OutputKind, 'files' | 'data' | 'knowledge'> = { files: 'files', data: 'data', knowledge: 'knowledge' };
/** `label` is the `agents.outputs.state.<label>` key. */
const STATE_BADGE: Record<OutputResult['state'], { cls: string; label: 'saved' | 'notSaved' | 'pending' }> = {
  saved: { cls: 'ok', label: 'saved' },
  not_saved: { cls: 'warn', label: 'notSaved' },
  failed: { cls: 'err', label: 'notSaved' },
  pending: { cls: 'muted', label: 'pending' },
};

export default function RunOutputs({
  systemId, outputs, declared, canSave, running, onSaved,
}: {
  systemId: string;
  /** The run's own record of its outputs. Absent on a run recorded before outputs were saved. */
  outputs?: OutputResult[];
  /** The outputs declared on Define — the fallback when the run recorded none. */
  declared?: DeclaredOutput[];
  canSave: boolean;
  /** A run is in progress: its outputs are saved when it finishes, so nothing can be retried yet. */
  running?: boolean;
  /** The new list, and the run it belongs to (the save route names it). */
  onSaved: (outputs: OutputResult[], runId?: string) => void;
}) {
  const t = useTranslations('agents');
  const msg = useServerMessage();
  const [busy, setBusy] = useState<number | 'all' | null>(null);
  const [err, setErr] = useState('');
  const rows = outputs ?? [];
  if (rows.length === 0 && (declared ?? []).length === 0) return null;

  const save = async (index?: number) => {
    if (busy !== null) return;
    setBusy(index ?? 'all');
    setErr('');
    try {
      const res = await fetch(`/api/agents/systems/${systemId}/outputs/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(typeof index === 'number' ? { index } : {}),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(msg(body, t('outputs.saveFailed')));
      onSaved(Array.isArray(body.outputs) ? body.outputs : [], typeof body.runId === 'string' ? body.runId : undefined);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const unsaved = rows.filter((r) => r.state === 'failed' || r.state === 'not_saved').length;
  const settled = rows.length > 0 && !rows.some((r) => r.state === 'pending');

  return (
    <div style={{ marginTop: 0, marginBottom: 10, padding: '8px 12px', border: '1px solid var(--border, #e5e5e5)', borderRadius: 10 }}>
      <div className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <strong>{t('outputs.title')}</strong>
        {settled && unsaved > 0 ? <span className="badge warn">{t('outputs.unsaved')}</span> : null}
        {settled && unsaved === 0 ? <span className="badge ok">{t('outputs.allSaved')}</span> : null}
      </div>
      {rows.length === 0 ? (
        <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="hint" style={{ marginTop: 0 }}>
            {t('outputs.notRecorded')}
          </span>
          {canSave && !running ? (
            <button type="button" className="btn ghost sm" disabled={busy !== null} onClick={() => void save()}>
              {busy === 'all' ? <span className="spin" /> : t('outputs.saveNow')}
            </button>
          ) : null}
        </div>
      ) : (
        rows.map((r) => (
          <div key={r.key} className="row" style={{ alignItems: 'baseline', gap: 8, flexWrap: 'wrap', padding: '3px 0' }}>
            <span className="badge muted">{t(`outputs.kind.${KIND_LABEL[r.kind]}`)}</span>
            <strong>{r.name}</strong>
            <span className={`badge ${STATE_BADGE[r.state].cls}`}>{t(`outputs.state.${STATE_BADGE[r.state].label}`)}</span>
            {r.promotion?.state === 'requested' ? <span className="badge warn">{t('outputs.waitingAdmin')}</span> : null}
            <span style={{ flexBasis: '100%' }} className="hint">
              {r.message}
              {r.state === 'saved' && r.link ? <> · <Link href={r.link} target="_blank" rel="noopener">{t('outputs.open')}</Link></> : null}
              {r.promotion?.state === 'requested' ? <> · <Link href="/governance" target="_blank" rel="noopener">{t('outputs.governanceInbox')}</Link></> : null}
            </span>
            {canSave && !running && r.retry ? (
              <button type="button" className="btn ghost sm" disabled={busy !== null} onClick={() => void save(r.index)}>
                {busy === r.index ? <span className="spin" /> : r.retry === 'by-hand' ? t('outputs.saveNow') : t('outputs.tryAgain')}
              </button>
            ) : null}
          </div>
        ))
      )}
      {err ? <div className="error" style={{ marginTop: 6 }}>{err}</div> : null}
    </div>
  );
}
