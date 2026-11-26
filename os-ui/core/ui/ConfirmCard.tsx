/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The confirm card — "Waiting for your OK" for a write the assistant parked
 * USER STORY: As a user I want to see exactly what the assistant wants to change and press Run or
 *             Cancel, on Home and in the Ask-the-OS drawer alike.
 * ARCHITECTURE:
 *   - One component for both surfaces. It only renders and reports the decision; the POST to
 *     `/api/assistant/chat` is `sendDecision`, so the arguments that run are the ones stored with
 *     the confirmation server-side, never anything from here.
 *   - Args are rendered as text (`confirmCardArgs` redacts secrets); no model-supplied markup.
 *   - A mail draft/send shows the whole message instead (`mailPreviewOf`): To, Cc, Subject and the full
 *     body, uncut and as plain text, so the person reads exactly what will go out before pressing Run.
 * I18N:       converted (wave 2) — strings from the `home` namespace (`home.confirm.*`). A card's note is a
 *             catalog key (`ViewText`) or the server's own text; `cardStateFor` stays pure and returns keys.
 */
'use client';

import Link from 'next/link';
import { useTranslations } from '@core/i18n/client';
import { confirmCardArgs, linkForResult, mailPreviewOf, plainError, viewText, type MailPreview, type Shown, type TypedError, type ViewText } from '@core/ui/chat-view';

export type Pending = {
  confirmationId: string;
  tool: string;
  args: Record<string, unknown>;
  expiresAt: string;
  state?: 'open' | 'running' | 'done' | 'declined' | 'failed' | 'gone';
  /** What happened, shown under the card: a catalog key, or the text a failed request returned. */
  note?: Shown;
  link?: { href: string; label: ViewText };
  /** Display-only facts the server looked up for this card (e.g. the thread a reply goes to). */
  context?: Record<string, unknown>;
};

export type DecisionBody = { status?: string; text?: string; error?: TypedError; changes?: unknown };

/** The card state to show for a decision's response body. Pure. */
export function cardStateFor(p: Pick<Pending, 'tool'>, j: DecisionBody): Partial<Pending> {
  if (j.status === 'executed') return { state: 'done', note: viewText('confirm.notes.done'), link: linkForResult(p.tool, j.text) ?? undefined };
  if (j.status === 'declined') return { state: 'declined', note: viewText('confirm.notes.declined') };
  if (j.status === 'failed') return { state: 'failed', note: j.error ? plainError(j.error) : viewText('confirm.notes.failed') };
  return { state: 'gone', note: viewText('confirm.notes.gone') };
}

/**
 * Confirm or decline one parked write on `endpoint` (each surface has its own route, which pins
 * the surface and re-applies that surface's bound ids and allowlist). Returns the card state and
 * the raw response body. Never throws.
 */
export async function postDecision(
  p: Pending,
  conversationId: string,
  decision: 'confirm' | 'decline',
  opts: { endpoint?: string; extra?: Record<string, unknown> } = {},
): Promise<{ patch: Partial<Pending>; body: DecisionBody | null }> {
  try {
    const res = await fetch(opts.endpoint ?? '/api/assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(opts.extra ?? {}), confirmation: { id: p.confirmationId, conversationId, decision } }),
    });
    const j = (await res.json()) as DecisionBody;
    return { patch: cardStateFor(p, j), body: j };
  } catch (e) {
    return { patch: { state: 'failed', note: (e as Error).message }, body: null };
  }
}

/** Confirm or decline one parked write; returns the card state to show. Never throws. */
export async function sendDecision(p: Pending, conversationId: string, decision: 'confirm' | 'decline'): Promise<Partial<Pending>> {
  return (await postDecision(p, conversationId, decision)).patch;
}

type HomeT = ReturnType<typeof useTranslations<'home'>>;

/** A note or label for the screen: the server's own text as is, a catalog key in the user's language. */
export function shownText(t: HomeT, v: Shown | undefined): string {
  if (v === undefined || typeof v === 'string') return v ?? '';
  return t(v.key as Parameters<HomeT>[0], v.args);
}

/** A parked mail write: the whole message as text — To, Cc, Subject, Body — nothing cut, nothing rendered as markup. */
function MailMessage({ m }: { m: MailPreview }) {
  const t = useTranslations('home');
  const what = m.kind === 'send'
    ? (m.replyTo ? t('confirm.mail.sendReply') : t('confirm.mail.send'))
    : (m.replyTo ? t('confirm.mail.draftReply') : t('confirm.mail.draft'));
  return (
    <div className="hc-confirm-mail" aria-label={m.kind === 'send' ? t('confirm.mail.ariaSend') : t('confirm.mail.ariaDraft')}>
      <p className="hc-confirm-mail-what">{what}</p>
      <dl>
        {m.replyTo ? <><dt>{t('confirm.mail.replyTo')}</dt><dd>{m.thread
          ? t('confirm.mail.thread', { subject: m.thread.subject || t('confirm.mail.noSubject'), from: m.thread.from || t('confirm.mail.unknownSender') })
          : t('confirm.mail.pickedMessage')}</dd></> : null}
        <dt>{t('confirm.mail.to')}</dt><dd>{m.to.join(', ') || '—'}</dd>
        {m.cc.length ? <><dt>{t('confirm.mail.cc')}</dt><dd>{m.cc.join(', ')}</dd></> : null}
        <dt>{t('confirm.mail.subject')}</dt><dd>{m.subject === null ? t('confirm.mail.threadSubject') : m.subject || '—'}</dd>
      </dl>
      <pre className="hc-confirm-mail-body">{m.body}</pre>
      {m.replyTo ? <p className="hc-confirm-mail-what">{t('confirm.mail.quoted')}</p> : null}
    </div>
  );
}

export default function ConfirmCard({ p, onDecide }: { p: Pending; onDecide: (decision: 'confirm' | 'decline') => void }) {
  const t = useTranslations('home');
  const mail = mailPreviewOf(p.tool, p.args, p.context);
  return (
    <div className="hc-confirm" role="group" aria-label={t('confirm.aria', { tool: p.tool })}>
      <p className="hc-confirm-title">{t.rich('confirm.title', { tool: p.tool, code: (c) => <code>{c}</code> })}</p>
      {mail ? <MailMessage m={mail} /> : <pre className="hc-confirm-args">{JSON.stringify(confirmCardArgs(p.args), null, 2)}</pre>}
      {p.state === 'open' || p.state === 'running' ? (
        <div className="hc-confirm-actions">
          <button type="button" className="hc-run" disabled={p.state === 'running'} onClick={() => onDecide('confirm')}>{t('confirm.run')}</button>
          <button type="button" className="hc-cancel" disabled={p.state === 'running'} onClick={() => onDecide('decline')}>{t('confirm.cancel')}</button>
        </div>
      ) : (
        <p className={`hc-confirm-note is-${p.state}`}>{shownText(t, p.note)}{p.link ? <> <Link href={p.link.href}>{t('confirm.linkArrow', { label: shownText(t, p.link.label) })}</Link></> : null}</p>
      )}
    </div>
  );
}
