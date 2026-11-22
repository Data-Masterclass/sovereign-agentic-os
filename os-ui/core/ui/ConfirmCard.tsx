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
 */
'use client';

import Link from 'next/link';
import { confirmCardArgs, linkForResult, plainError, type TypedError } from '@core/ui/chat-view';

export type Pending = {
  confirmationId: string;
  tool: string;
  args: Record<string, unknown>;
  expiresAt: string;
  state?: 'open' | 'running' | 'done' | 'declined' | 'failed' | 'gone';
  note?: string;
  link?: { href: string; label: string };
};

export type DecisionBody = { status?: string; text?: string; error?: TypedError; changes?: unknown };

/** The card state to show for a decision's response body. Pure. */
export function cardStateFor(p: Pick<Pending, 'tool'>, j: DecisionBody): Partial<Pending> {
  if (j.status === 'executed') return { state: 'done', note: 'Done.', link: linkForResult(p.tool, j.text) ?? undefined };
  if (j.status === 'declined') return { state: 'declined', note: 'Cancelled. Nothing was changed.' };
  if (j.status === 'failed') return { state: 'failed', note: j.error ? plainError(j.error) : 'It did not run.' };
  return { state: 'gone', note: 'This request is no longer available (it expired or was already used). Ask again.' };
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

export default function ConfirmCard({ p, onDecide }: { p: Pending; onDecide: (decision: 'confirm' | 'decline') => void }) {
  return (
    <div className="hc-confirm" role="group" aria-label={`Confirm ${p.tool}`}>
      <p className="hc-confirm-title">Waiting for your OK: <code>{p.tool}</code></p>
      <pre className="hc-confirm-args">{JSON.stringify(confirmCardArgs(p.args), null, 2)}</pre>
      {p.state === 'open' || p.state === 'running' ? (
        <div className="hc-confirm-actions">
          <button type="button" className="hc-run" disabled={p.state === 'running'} onClick={() => onDecide('confirm')}>Run it</button>
          <button type="button" className="hc-cancel" disabled={p.state === 'running'} onClick={() => onDecide('decline')}>Cancel</button>
        </div>
      ) : (
        <p className={`hc-confirm-note is-${p.state}`}>{p.note}{p.link ? <> <Link href={p.link.href}>{p.link.label} →</Link></> : null}</p>
      )}
    </div>
  );
}
