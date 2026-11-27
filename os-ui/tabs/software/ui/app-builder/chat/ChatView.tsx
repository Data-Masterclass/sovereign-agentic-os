/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - the Chat view (requirements become diff cards; approved changes show the build)
 * USER STORY: As an app builder I want to type a requirement, see how the OS classifies it as a story change, approve
 *             it, and watch tests and code being built for it.
 * ARCHITECTURE:
 *   - Spec section 11 view 2, workstream B. POST /api/apps/[id]/requirements turns a requirement into a diff card;
 *     GET /api/apps/[id]/proposals lists the cards (with their diffs, the unreviewed set and the story lights); POST
 *     /api/apps/[id]/proposals/[pid] approves, edits or rejects one, always with the card's `rev` (409 ⇒ someone else
 *     changed it: reload).
 *   - A post-hoc "change without a story" card offers to create or update a story from the change (pre-fills the
 *     requirement with the card's summary). Unreviewed changes are announced: Domain/Company go-live waits for them.
 *   - Text: `software` namespace, `appBuilder.chat.*` (status and light words reuse `appBuilder.stories.*`); outcomes in
 *     a polite live region, failures in an alert; status is text, never colour alone. Classifier output (rationale,
 *     story text) is the user's content and is shown as written.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from '@core/i18n/client';
import type { AppBuilderViewProps } from '@tabs/software/ui/app-builder/AppBuilderShell';
import { editBody, lightRows, orderCards, storylessPrefill, type CardView, type ProposalsPayload } from '@tabs/software/ui/app-builder/chat/model';

const SPEC_KINDS = ['refine-story', 'refine-epic', 'new-story', 'new-epic'] as const;

export default function ChatView({ app }: AppBuilderViewProps) {
  const t = useTranslations('software');
  const base = `/api/apps/${encodeURIComponent(app.id)}`;
  const [data, setData] = useState<ProposalsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [asked, setAsked] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`${base}/proposals`, { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as ProposalsPayload & { error?: string };
      if (!res.ok) throw new Error(body.error ?? String(res.status));
      setData(body);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(
    async (requirement: string, prefer?: string) => {
      setBusy(true);
      setError('');
      setNotice('');
      try {
        const res = await fetch(`${base}/requirements`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: requirement, ...(prefer ? { prefer } : {}) }) });
        const body = (await res.json().catch(() => ({}))) as { proposal?: CardView; error?: string; code?: string };
        if (res.status === 503) throw new Error(t('appBuilder.chat.classifierUnavailable', { error: body.error ?? String(res.status) }));
        if (!res.ok || !body.proposal) throw new Error(t('appBuilder.chat.proposeFailed', { error: body.error ?? String(res.status) }));
        setAsked((a) => ({ ...a, [body.proposal!.id]: requirement }));
        setText('');
        setNotice(t('appBuilder.chat.proposed', { id: body.proposal.id }));
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [base, load, t],
  );

  const decide = useCallback(
    async (card: CardView, body: Record<string, unknown>): Promise<boolean> => {
      setError('');
      setNotice('');
      try {
        const res = await fetch(`${base}/proposals/${encodeURIComponent(card.id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rev: card.rev, ...body }) });
        const out = (await res.json().catch(() => ({}))) as { error?: string; commit?: { sha: string } };
        if (res.status === 409) {
          setError(t('appBuilder.chat.conflict', { error: out.error ?? '' }));
          await load();
          return false;
        }
        if (!res.ok) throw new Error(out.error ?? String(res.status));
        if (body.decision === 'approve') setNotice(out.commit ? t('appBuilder.chat.approved', { sha: out.commit.sha.slice(0, 12) }) : t('appBuilder.chat.approvedPosthoc'));
        else if (body.decision === 'reject') setNotice(t('appBuilder.chat.rejected'));
        else setNotice(t('appBuilder.chat.edited'));
        await load();
        return true;
      } catch (e) {
        setError(t('appBuilder.chat.decideFailed', { error: e instanceof Error ? e.message : String(e) }));
        return false;
      }
    },
    [base, load, t],
  );

  if (loadError && !data) {
    return (
      <div className="card" data-testid="app-builder-chat">
        <h3>{t('appBuilder.chat.title')}</h3>
        <p className="error" role="alert">{t('appBuilder.chat.loadFailed', { error: loadError })}</p>
        <button type="button" className="btn sm" onClick={() => void load()}>{t('appBuilder.chat.reload')}</button>
      </div>
    );
  }

  const cards = data ? orderCards(data.proposals) : { pending: [], decided: [] };
  return (
    <div className="card" data-testid="app-builder-chat">
      <h3>{t('appBuilder.chat.title')}</h3>
      <p className="muted">{t('appBuilder.chat.intro', { app: app.name })}</p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void submit(text.trim());
        }}
        style={{ display: 'grid', gap: 8, marginBottom: 16 }}
      >
        <label htmlFor="ab-requirement">{t('appBuilder.chat.requirementLabel')}</label>
        <textarea id="ab-requirement" rows={3} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('appBuilder.chat.placeholder')} disabled={busy} />
        <div>
          <button type="submit" className="btn sm primary" disabled={busy || !text.trim()}>{busy ? t('appBuilder.chat.submitting') : t('appBuilder.chat.submit')}</button>
        </div>
      </form>

      <p className="muted" role="status" aria-live="polite">{notice}</p>
      {error ? <p className="error" role="alert">{error}</p> : null}

      {!data ? (
        <p className="muted" role="status" aria-busy="true">{t('appBuilder.chat.loading')}</p>
      ) : (
        <>
          {data.unreviewed.length > 0 ? (
            <div className="card" role="note" data-testid="app-builder-unreviewed" style={{ borderLeft: '4px solid var(--warn, #b45309)', marginBottom: 12 }}>
              <strong>{t('appBuilder.chat.unreviewedTitle', { count: data.unreviewed.length })}</strong>
              <p className="muted" style={{ margin: '4px 0 0' }}>{t('appBuilder.chat.unreviewedBody')}</p>
            </div>
          ) : null}

          <h4>{t('appBuilder.chat.pendingTitle', { count: cards.pending.length })}</h4>
          {cards.pending.length === 0 ? <p className="muted">{t('appBuilder.chat.noCards')}</p> : null}
          {cards.pending.map((c) => (
            <ProposalCard
              key={`${c.id}:${c.rev}`}
              card={c}
              canDecide={data.canDecide}
              requirement={asked[c.id]}
              onDecide={(body) => decide(c, body)}
              onReclassify={(kind) => asked[c.id] && submit(asked[c.id], kind)}
              onStorylessOffer={() => setText(storylessPrefill(c))}
            />
          ))}

          <h4>{t('appBuilder.chat.lightsTitle')}</h4>
          {lightRows(data.lights).length === 0 ? (
            <p className="muted">{t('appBuilder.chat.noStories')}</p>
          ) : (
            <ul data-testid="app-builder-lights">
              {data.truncated ? <li className="muted">{t('appBuilder.chat.truncated')}</li> : null}
              {lightRows(data.lights).map(({ id, light }) => (
                <li key={id}>
                  <span className="mono">{id}</span> · {t(`appBuilder.stories.status.${light.status}`)} · {t('appBuilder.stories.lightLabel')}: {t(`appBuilder.stories.light.${light.light}`)}
                  {light.criteria.length > 0 ? (
                    <span className="muted"> ({light.criteria.map((c) => `${c.ref.split('/')[1]} ${t(`appBuilder.chat.criterion.${c.state}`)}`).join(', ')})</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {cards.decided.length > 0 ? (
            <details>
              <summary>{t('appBuilder.chat.decidedTitle', { count: cards.decided.length })}</summary>
              {cards.decided.map((c) => (
                <ProposalCard key={`${c.id}:${c.rev}`} card={c} canDecide={false} onDecide={async () => false} onReclassify={() => undefined} onStorylessOffer={() => undefined} />
              ))}
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}

function ProposalCard(props: {
  card: CardView;
  canDecide: boolean;
  requirement?: string;
  onDecide: (body: Record<string, unknown>) => Promise<boolean>;
  onReclassify: (kind: string) => void;
  onStorylessOffer: () => void;
}) {
  const { card, canDecide } = props;
  const t = useTranslations('software');
  const [editing, setEditing] = useState(false);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState(false);
  const pending = card.status === 'pending';
  const storyless = card.posthoc && card.classification === 'code-change';
  const act = async (body: Record<string, unknown>) => {
    setWorking(true);
    const ok = await props.onDecide(body);
    setWorking(false);
    if (ok) {
      setEditing(false);
      setRejecting(false);
    }
  };
  return (
    <article className="card" data-testid="app-builder-card" aria-label={t('appBuilder.chat.cardLabel', { id: card.id })} style={{ marginBottom: 12 }}>
      <header className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <strong>{storyless ? t('appBuilder.chat.storyless') : t(`appBuilder.chat.classification.${card.classification}`)}</strong>
        {card.targetId ? <span className="mono">{card.targetId}</span> : null}
        <span className="chip">{t(`appBuilder.chat.status.${card.status}`)}</span>
        {card.posthoc ? <span className="chip">{t('appBuilder.chat.posthocBadge')}</span> : null}
        <span className="muted mono" style={{ marginLeft: 'auto' }}>{card.id}</span>
      </header>
      {props.requirement ? <p className="muted">{t('appBuilder.chat.yourRequirement', { text: props.requirement })}</p> : null}
      <p>{card.rationale}</p>
      {!card.posthoc ? <p className="muted">{t('appBuilder.chat.confidence', { value: Math.round(card.confidence * 100) })}</p> : null}
      {pending && card.alternatives.length > 0 && props.requirement ? (
        <p className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <span className="muted">{t('appBuilder.chat.alternatives')}</span>
          {card.alternatives.filter((a) => (SPEC_KINDS as readonly string[]).includes(a)).map((a) => (
            <button key={a} type="button" className="btn sm" onClick={() => props.onReclassify(a)}>{t('appBuilder.chat.classifyAs', { kind: t(`appBuilder.chat.classification.${a}`) })}</button>
          ))}
        </p>
      ) : null}
      <p className="muted">{card.change.summary}</p>
      {card.needsRevert ? <p className="error" role="note">{t('appBuilder.chat.needsRevert')}</p> : null}
      {card.reason && card.status !== 'pending' ? <p className="muted">{t('appBuilder.chat.reasonLine', { reason: card.reason })}</p> : null}
      {card.decidedBy ? <p className="muted">{t('appBuilder.chat.decidedBy', { who: card.decidedBy })}</p> : null}

      {card.change.writes.length > 0 ? (
        <details open={pending && !card.posthoc}>
          <summary>{t('appBuilder.chat.filesTitle', { count: card.change.writes.length })}</summary>
          {card.change.writes.map((w) => {
            const diff = card.diffs?.find((d) => d.path === w.path)?.diff;
            return (
              <div key={w.path}>
                <p className="mono">{w.path}</p>
                {editing ? (
                  <textarea aria-label={t('appBuilder.chat.editFile', { path: w.path })} rows={14} style={{ width: '100%' }} value={contents[w.path] ?? w.content} onChange={(e) => setContents((c) => ({ ...c, [w.path]: e.target.value }))} />
                ) : (
                  <pre className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' }}>{diff || w.content}</pre>
                )}
              </div>
            );
          })}
        </details>
      ) : null}

      {pending && canDecide ? (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {editing ? (
            <>
              <button type="button" className="btn sm primary" disabled={working} onClick={() => void act(editBody(card, contents))}>{t('appBuilder.chat.saveEdit')}</button>
              <button type="button" className="btn sm" disabled={working} onClick={() => setEditing(false)}>{t('appBuilder.chat.cancel')}</button>
            </>
          ) : rejecting ? (
            <>
              <label htmlFor={`reason-${card.id}`}>{t('appBuilder.chat.rejectReason')}</label>
              <input id={`reason-${card.id}`} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              <button type="button" className="btn sm" disabled={working || !reason.trim()} onClick={() => void act({ decision: 'reject', reason: reason.trim() })}>{t('appBuilder.chat.rejectConfirm')}</button>
              <button type="button" className="btn sm" disabled={working} onClick={() => setRejecting(false)}>{t('appBuilder.chat.cancel')}</button>
            </>
          ) : (
            <>
              <button type="button" className="btn sm primary" disabled={working} onClick={() => void act({ decision: 'approve' })}>{working ? t('appBuilder.chat.approving') : t('appBuilder.chat.approve')}</button>
              {!card.posthoc ? <button type="button" className="btn sm" disabled={working} onClick={() => setEditing(true)}>{t('appBuilder.chat.edit')}</button> : null}
              <button type="button" className="btn sm" disabled={working} onClick={() => setRejecting(true)}>{t('appBuilder.chat.reject')}</button>
              {storyless ? <button type="button" className="btn sm" onClick={props.onStorylessOffer}>{t('appBuilder.chat.storylessOffer')}</button> : null}
            </>
          )}
        </div>
      ) : null}
      {pending && !canDecide ? <p className="muted">{t('appBuilder.chat.cannotDecide')}</p> : null}
    </article>
  );
}
