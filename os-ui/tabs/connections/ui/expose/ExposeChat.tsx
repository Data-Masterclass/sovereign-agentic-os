/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 * I18N:       converted (wave 2) — texts from `connections.exposeChat.*`.
 */
'use client';

import { useCallback, useRef, useState } from 'react';
import Markdown from '@core/ui/Markdown';
import { useTranslations } from '@core/i18n/client';

/**
 * ExposeChat — ONE persistent, governed, multi-turn assistant mounted across all FOUR Expose
 * stages (Catalog · Organize · Assign · Review) in the ExposePanel's StageShell assistant slot
 * (lakehouse-expose-experience.md, Phase C). It follows the OS suggestion-card pattern
 * (the `.sac-*` skin): the assistant only PROPOSES; every

 * mutation runs through the host's governed callback on an explicit Apply click.
 *
 * The thread is kept locally and POSTed to /api/connections/[id]/expose-assistant (multi-turn),
 * which grounds each turn in the REAL snapshot summary, classification state (category counts +
 * lastRunDetail), the current selection, the REAL domain list, and the existing exposure sets.
 * Suggestions are VALIDATED SERVER-SIDE against that feed before an Apply card renders — a
 * hallucinated table/domain/category is refused with the honest reason (only the prose stands).
 * Honest failure: 503 (no model) / 402 (cost cap) surface plainly.
 *
 * Three card types (validated server-side):
 *   • classify   → run the classifier (the same POST the Organize "Organize with AI" runs).
 *   • selection  → merge the named tables into the selection Set + jump to Organize.
 *   • exposure   → prefill the Assign form (name, domains, mode, tier, tables) + jump to Review —
 *                  the admin still clicks Create.
 */

/** A validated selection suggestion: real `schema.table` keys to merge into the selection. */
export type SelectionSuggestion = { tables: string[] };
/** A validated exposure suggestion: real domains + tables, ready to prefill Assign.
 *  `actions` (operational sources only) carries the per-entity agent-action grant — write
 *  actions (create/update) render with the "requires admin approval to enable" note. */
export type ExposureSuggestion = {
  name?: string;
  domains: string[];
  mode?: 'live' | 'sync';
  tier?: 'silver' | 'gold';
  tables: string[];
  actions?: Record<string, { read?: boolean; search?: boolean; create?: boolean; update?: boolean }>;
};

type Turn = { role: 'user' | 'assistant'; content: string };
type Suggestions = { classify?: boolean; selection?: SelectionSuggestion; exposure?: ExposureSuggestion };

/** True when any entity's action grant requests a write (create/update) — the card then
 *  shows the "requires admin approval to enable" note. */
function exposureHasWrite(actions: ExposureSuggestion['actions']): boolean {
  return Object.values(actions ?? {}).some((g) => g.create || g.update);
}

/** The example prompts (catalog keys; the English is in `connections.exposeChat.starters.*`). */
const STARTERS = [
  'exposeChat.starters.organize',
  'exposeChat.starters.exposeCustomer',
  'exposeChat.starters.exposeAccounts',
  'exposeChat.starters.whatChanged',
] as const;

const ACTION_KINDS = ['read', 'search', 'create', 'update'] as const;

export default function ExposeChat({
  connectionId,
  stage,
  onApplyClassify,
  onApplySelection,
  onApplyExposure,
}: {
  connectionId: string;
  /** The current stage — sent to the server so it grounds/steers per stage. */
  stage: string;
  /** Run the classifier (host POSTs the governed classification route + jumps to Organize). */
  onApplyClassify: () => void;
  /** Merge the validated tables into the selection Set + jump to Organize. */
  onApplySelection: (s: SelectionSuggestion) => void;
  /** Prefill the Assign form from the validated exposure + jump to Review. */
  onApplyExposure: (s: ExposureSuggestion) => void;
}) {
  const t = useTranslations('connections');
  const [thread, setThread] = useState<Turn[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestions>({});
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || busy) return;
      const nextThread: Turn[] = [...thread, { role: 'user', content: q }];
      setThread(nextThread);
      setInput('');
      setError('');
      setSuggestions({});
      setBusy(true);
      try {
        const res = await fetch(`/api/connections/${connectionId}/expose-assistant`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stage, messages: nextThread }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          message?: string;
          suggestions?: Suggestions;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error ?? t('exposeChat.requestFailed', { status: res.status }));
        setThread((t) => [...t, { role: 'assistant', content: data.message ?? '' }]);
        setSuggestions(data.suggestions ?? {});
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [connectionId, stage, thread, busy, t],
  );

  const s = suggestions;
  const hasCard = !!s.classify || !!s.selection || !!s.exposure;

  return (
    <div className="sac">
      <div className="sac-head">
        <span className="sac-title">{t('exposeChat.title')}</span>
        <span className="sac-intro">{t('exposeChat.intro')}</span>
      </div>

      <div className="sac-thread" ref={scrollRef}>
        {thread.length === 0 && !busy ? (
          <div className="sac-empty">
            <p className="hint" style={{ margin: 0 }}>{t('exposeChat.empty')}</p>
            <div className="sac-starters">
              {STARTERS.map((k) => (
                <button key={k} type="button" className="btn ghost sm" onClick={() => void send(t(k))}>{t(k)}</button>
              ))}
            </div>
          </div>
        ) : null}

        {thread.map((turn, i) => (
          <div key={i} className={`sac-turn sac-${turn.role}`}>
            {turn.role === 'assistant' ? <Markdown>{turn.content || '…'}</Markdown> : <span>{turn.content}</span>}
          </div>
        ))}

        {busy ? (
          <div className="sac-turn sac-assistant">
            <span className="spin" /> <span className="muted" style={{ fontSize: 12 }}>{t('exposeChat.thinking')}</span>
          </div>
        ) : null}
      </div>

      {hasCard ? (
        <div className="sac-suggestions">
          {s.classify ? (
            <SuggestionCard label={t('exposeChat.classify.label')} applyLabel={t('exposeChat.classify.apply')} onApply={onApplyClassify}>
              <p style={{ margin: 0 }}>{t('exposeChat.classify.body')}</p>
            </SuggestionCard>
          ) : null}

          {s.selection ? (
            <SuggestionCard
              label={t('exposeChat.selection.label')}
              applyLabel={t('exposeChat.selection.apply', { count: s.selection.tables.length })}
              onApply={() => onApplySelection(s.selection!)}
            >
              <p style={{ margin: '0 0 4px' }}>{t('exposeChat.selection.body', { count: s.selection.tables.length })}</p>
              <div className="sac-chips">
                {s.selection.tables.slice(0, 12).map((tb) => <span key={tb} className="mono sac-chip">{tb}</span>)}
                {s.selection.tables.length > 12 ? <span className="muted" style={{ fontSize: 11 }}>{t('exposeChat.selection.more', { count: s.selection.tables.length - 12 })}</span> : null}
              </div>
            </SuggestionCard>
          ) : null}

          {s.exposure ? (
            <SuggestionCard
              label={t('exposeChat.exposure.label')}
              applyLabel={t('exposeChat.exposure.apply')}
              onApply={() => onApplyExposure(s.exposure!)}
            >
              <ul className="sac-list">
                {s.exposure.name ? <li><span className="muted">{t('exposeChat.exposure.name')}</span> <strong>{s.exposure.name}</strong></li> : null}
                <li><span className="muted">{t('exposeChat.exposure.domains')}</span> {s.exposure.domains.join(', ')}</li>
                <li><span className="muted">{t('exposeChat.exposure.modeTier')}</span> {t(`exposeChat.mode.${s.exposure.mode ?? 'live'}`)} · {t(`exposeChat.tier.${s.exposure.tier ?? 'silver'}`)}</li>
                <li><span className="muted">{t('exposeChat.exposure.tables')}</span> {s.exposure.tables.length}</li>
                {s.exposure.actions && Object.keys(s.exposure.actions).length > 0 ? (
                  <li><span className="muted">{t('exposeChat.exposure.actions')}</span> {Object.entries(s.exposure.actions).map(([e, g]) => `${e} (${ACTION_KINDS.filter((k) => g[k]).map((k) => t(`exposeChat.actionKind.${k}`)).join('/')})`).join(', ')}</li>
                ) : null}
              </ul>
              {exposureHasWrite(s.exposure.actions) ? (
                <p className="muted" style={{ fontSize: 11.5, margin: '4px 0 0' }}>{t.rich('exposeChat.exposure.writeNote', { b: (c) => <strong>{c}</strong> })}</p>
              ) : null}
              <p className="muted" style={{ fontSize: 11.5, margin: '4px 0 0' }}>{t('exposeChat.exposure.appliedNote')}</p>
            </SuggestionCard>
          ) : null}
        </div>
      ) : null}

      {error ? <div className="error" style={{ margin: '8px 0 0' }}>{error}</div> : null}

      <form className="sac-input" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <input
          type="text" value={input} onChange={(e) => setInput(e.target.value)}
          placeholder={t('exposeChat.placeholder')} disabled={busy} aria-label={t('exposeChat.inputAria')}
        />
        <button className="btn sm" type="submit" disabled={busy || !input.trim()}>
          {busy ? <span className="spin" /> : t('exposeChat.send')}
        </button>
      </form>

      {/* i18n-ignore — styled-jsx CSS, not text */}
      <style jsx>{`
        .sac { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); padding: 12px 14px; margin-top: 16px; display: flex; flex-direction: column; gap: 10px; }
        .sac-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
        .sac-title { font-weight: 600; }
        .sac-intro { color: var(--text-muted); font-size: 12.5px; }
        .sac-thread { display: flex; flex-direction: column; gap: 10px; max-height: 340px; overflow-y: auto; padding-right: 2px; }
        .sac-empty { padding: 8px 2px; display: flex; flex-direction: column; gap: 10px; }
        .sac-starters { display: flex; flex-wrap: wrap; gap: 6px; }
        .sac-turn { font-size: 13.5px; line-height: 1.55; max-width: 100%; }
        .sac-user { align-self: flex-end; background: var(--gold-soft); border: 1px solid var(--gold-line); color: var(--text); border-radius: 12px 12px 4px 12px; padding: 7px 11px; max-width: 85%; }
        .sac-assistant { align-self: flex-start; background: var(--tile, var(--bg-elevated, var(--panel))); border: 1px solid var(--border); border-radius: 12px 12px 12px 4px; padding: 8px 12px; max-width: 92%; }
        .sac-suggestions { display: flex; flex-direction: column; gap: 8px; }
        .sac-list { margin: 6px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
        .sac-chips { display: flex; flex-wrap: wrap; gap: 4px; }
        .sac-chip { font-size: 11px; background: var(--panel); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; }
        .sac-input { display: flex; gap: 8px; align-items: center; }
        .sac-input input { flex: 1; }
      `}</style>
    </div>
  );
}

function SuggestionCard({
  label, applyLabel, onApply, children,
}: {
  label: string; applyLabel: string; onApply: () => void; children: React.ReactNode;
}) {
  const t = useTranslations('connections');
  const [applied, setApplied] = useState(false);
  return (
    <div className="sac-card">
      <div className="sac-card-head">
        <span className="sac-card-label">{label}</span>
        <button type="button" className="btn sm" disabled={applied} onClick={() => { onApply(); setApplied(true); }}>
          {applied ? t('exposeChat.applied') : applyLabel}
        </button>
      </div>
      <div className="sac-card-body">{children}</div>
      {/* i18n-ignore — styled-jsx CSS, not text */}
      <style jsx>{`
        .sac-card { border: 1px solid var(--gold-line); background: var(--gold-soft); border-radius: 8px; padding: 10px 12px; }
        .sac-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .sac-card-label { font-weight: 600; font-size: 12.5px; }
        .sac-card-body { margin-top: 6px; font-size: 13px; }
      `}</style>
    </div>
  );
}
