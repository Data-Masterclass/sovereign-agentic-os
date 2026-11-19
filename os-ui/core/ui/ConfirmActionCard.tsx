/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useId, useState } from 'react';
import type { ConfirmCard } from '@core/runtime/confirm-card';

/**
 * THE CONFIRM CARD — one change an assistant wants to make, waiting for the user's own decision.
 *
 * Shared: any assistant surface that parks a call renders it with this component (Ask the OS
 * today). Everything shown comes from the SERVER's record of the held call (`ConfirmCard`,
 * `core/runtime/confirm-card.ts`) — the plain title, the tool, the arguments, the consequence,
 * the expiry, and whether a third button may be offered. Nothing here is model prose, and every
 * value is rendered as a text node.
 *
 * The buttons only report a decision word; the surface posts it. "Allow for this conversation"
 * appears only when the server said the tool is session-allowable.
 */

export type ConfirmDecision = 'confirm' | 'decline' | 'allow_for_conversation';

/** Where one card stands, as the surface knows it. */
export type ConfirmCardState =
  | { kind: 'pending' }
  | { kind: 'deciding'; decision: ConfirmDecision }
  | { kind: 'executed'; note?: string; allowed?: boolean }
  | { kind: 'failed'; note?: string }
  | { kind: 'declined' }
  | { kind: 'expired' }
  | { kind: 'error'; note: string };

function remaining(expiresAt: string, now: number): number {
  const end = Date.parse(expiresAt);
  return Number.isFinite(end) ? Math.max(0, end - now) : 0;
}

function clock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default function ConfirmActionCard({
  card,
  state,
  onDecide,
  disabled = false,
}: {
  card: ConfirmCard;
  state: ConfirmCardState;
  onDecide: (decision: ConfirmDecision) => void;
  /** True while the surface is busy with something else (a turn is running). */
  disabled?: boolean;
}) {
  const detailsId = useId();
  const [showDetails, setShowDetails] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const open = state.kind === 'pending' || state.kind === 'deciding';

  // The countdown only ticks while the card can still be decided.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);

  const left = remaining(card.expiresAt, now);
  const lapsed = state.kind === 'expired' || (open && left <= 0);
  const busy = state.kind === 'deciding';
  const locked = disabled || busy || lapsed || !open;

  let status: string | null = null;
  if (lapsed) status = 'Expired — nothing was changed. Ask again if you still want it.';
  else if (state.kind === 'executed') {
    status = state.allowed
      ? `Done — it ran as you. The assistant may use ${card.tool} again in this conversation without asking.`
      : 'Done — it ran as you.';
  } else if (state.kind === 'failed') status = `You confirmed it, and it did not succeed.${state.note ? ` ${state.note}` : ''}`;
  else if (state.kind === 'declined') status = 'Cancelled — nothing was changed.';
  else if (state.kind === 'error') status = state.note;

  return (
    <div
      className={`osa-confirm${card.danger ? ' danger' : ''}${open && !lapsed ? '' : ' settled'}`}
      role="group"
      aria-label={`Confirm action: ${card.title}`}
    >
      <div className="osa-confirm-title">
        The assistant wants to: <strong>{card.title}</strong>
      </div>
      <div className="osa-confirm-tool">
        <span className="mono">{card.tool}</span>
        {card.description ? <span className="osa-confirm-desc"> — {card.description}</span> : null}
      </div>

      {card.keyArgs.length > 0 ? (
        <dl className="osa-confirm-args">
          {card.keyArgs.map((a) => (
            <div key={a.name} className="osa-confirm-arg">
              <dt>{a.name}</dt>
              <dd>{a.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <button
        type="button"
        className="osa-confirm-toggle"
        aria-expanded={showDetails}
        aria-controls={detailsId}
        onClick={() => setShowDetails((v) => !v)}
      >
        {showDetails ? 'Hide details' : 'Show everything it will send'}
      </button>
      {showDetails ? (
        <pre id={detailsId} className="osa-confirm-details" tabIndex={0} aria-label={`All arguments for ${card.tool}`}>
          {card.argsJson}
        </pre>
      ) : null}

      <p className="osa-confirm-consequence">
        {card.danger ? <strong>This cannot be undone. </strong> : null}
        {card.consequence}
      </p>

      {open && !lapsed ? (
        <>
          <div className="osa-confirm-actions">
            <button
              type="button"
              className={`btn sm${card.danger ? ' osa-confirm-danger' : ''}`}
              onClick={() => onDecide('confirm')}
              disabled={locked}
              aria-label={`Confirm: ${card.title}`}
            >
              {busy && state.decision === 'confirm' ? <span className="spin" /> : 'Confirm'}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => onDecide('decline')}
              disabled={locked}
              aria-label={`Cancel: do not ${card.title}. Nothing will be changed.`}
            >
              {busy && state.decision === 'decline' ? <span className="spin" /> : 'Cancel'}
            </button>
            {card.sessionAllowable ? (
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => onDecide('allow_for_conversation')}
                disabled={locked}
                aria-label={`Confirm, and allow ${card.tool} for the rest of this conversation without asking again`}
              >
                {busy && state.decision === 'allow_for_conversation' ? <span className="spin" /> : 'Allow for this conversation'}
              </button>
            ) : null}
          </div>
          <div className="osa-confirm-expiry" aria-label={`This confirmation expires in ${clock(left)}`}>
            Waiting for you · expires in {clock(left)}
            {card.sessionAllowable ? ` · “Allow for this conversation” runs this now and stops asking for ${card.tool} in this chat.` : ''}
          </div>
        </>
      ) : null}

      {status ? (
        <div className="osa-confirm-status" role="status" aria-live="polite">
          {status}
        </div>
      ) : null}
    </div>
  );
}
