/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { anchorSelector } from '@/lib/tutorials/anchors';
import { targetAnchor, walkSteps } from '@/lib/tutorials/engine';
import type { FramingRole, TutorialDef, WalkMode } from '@/lib/tutorials/types';
import Illustration from './Illustration';

/**
 * The coach-mark walk-through engine (the load-bearing surface).
 *
 * It NEVER acts — it only locates an existing element by its stable
 * `data-tutorial-anchor` id and paints a spotlight + tooltip over it, leaving the
 * real (OPA/RLS-governed) control clickable underneath. So a real-mode run is
 * fully governed; a sandbox run targets the tab's personal lane (governed-write
 * steps were already removed by `walkSteps`), and nothing persists to real data.
 *
 * Anchor stability: the DOM node is re-queried on every measurement (never
 * cached), so React re-renders that swap nodes can't desync the highlight. We
 * also navigate to the step's tab first, then retry-measure to catch async
 * render, and degrade gracefully to a centered "open this tab" card if absent.
 */

type Rect = { top: number; left: number; width: number; height: number };

const PAD = 8; // spotlight padding around the target

export default function CoachMarks({
  def,
  mode,
  role,
  onExit,
  onComplete,
}: {
  def: TutorialDef;
  mode: WalkMode;
  role: FramingRole;
  onExit: () => void;
  onComplete: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const steps = walkSteps(def, mode, role);
  const [rawI, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [missing, setMissing] = useState(false);
  const rafRef = useRef<number | null>(null);

  // Clamp the index: the step list can shrink mid-walk (e.g. the async useUser
  // role resolves and removes builder-only steps), so a fixed index must never
  // index past the end and blank the walk.
  const i = steps.length === 0 ? 0 : Math.min(rawI, steps.length - 1);
  const step = steps[i];
  const anchorId = step ? targetAnchor(step, mode) : '';
  const stepRoute = step?.route;

  // Measure the live target (re-queried every call → anchor-stable).
  const measure = useCallback(() => {
    if (!anchorId) return;
    const el = document.querySelector(anchorSelector(anchorId));
    if (!el) {
      setMissing(true);
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setMissing(false);
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [anchorId]);

  // On step change: navigate to the right tab if needed, scroll target into
  // view, then measure now + a few delayed retries (async render safety).
  useEffect(() => {
    if (!step) return;
    setMissing(false);
    setRect(null);
    if (stepRoute && pathname !== stepRoute) {
      router.push(stepRoute);
    }
    const el = () => document.querySelector(anchorSelector(anchorId));
    const tryScroll = () => {
      const node = el();
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    const timers = [0, 120, 320, 650, 1000].map((ms) =>
      window.setTimeout(() => {
        tryScroll();
        measure();
      }, ms),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, anchorId, stepRoute]);

  // Keep the spotlight glued to the target through scroll/resize/layout shifts.
  useLayoutEffect(() => {
    const onMove = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(measure);
    };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [measure]);

  const next = useCallback(() => {
    if (i + 1 >= steps.length) onComplete();
    else setI(i + 1);
  }, [i, steps.length, onComplete]);
  const back = useCallback(() => setI((v) => Math.max(0, v - 1)), []);

  // Keyboard: → / Enter = next, ← = back, Esc = exit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      else if (e.key === 'ArrowLeft') back();
      else if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, back, onExit]);

  if (!step) return null;

  // Tooltip placement: below the target if room, else above; clamped to viewport.
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const below = rect ? rect.top + rect.height + 14 : vh / 2;
  const placeAbove = rect ? below + 200 > vh && rect.top > 220 : false;
  const tipTop = rect
    ? placeAbove
      ? Math.max(12, rect.top - 14)
      : Math.min(vh - 12, below)
    : vh / 2 - 90;
  const tipLeft = rect
    ? Math.min(Math.max(12, rect.left), vw - 372)
    : vw / 2 - 180;

  return (
    <div className="tut-coach" aria-live="polite">
      {/* Spotlight: a ring whose huge box-shadow dims everything else. The ring
          has pointer-events:none so the real control underneath stays clickable. */}
      {rect && !missing ? (
        <div
          className="tut-spot"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
          }}
        />
      ) : (
        <div className="tut-dim" />
      )}

      {/* Tooltip card */}
      <div
        className="tut-tip"
        style={{
          top: tipTop,
          left: tipLeft,
          transform: placeAbove ? 'translateY(-100%)' : undefined,
        }}
      >
        <div className="tut-tip-head">
          <span className="tut-step-no">
            {i + 1}/{steps.length}
          </span>
          <span className={`tut-mode ${mode}`}>
            {mode === 'sandbox' ? 'Practice — sandbox' : 'For real — governed'}
          </span>
        </div>

        {missing ? (
          <div className="tut-missing">
            <Illustration id="sandbox" size={40} />
            <div>
              <strong>{step.title}</strong>
              <p>
                This step lives on the {def.title} tab.{' '}
                {stepRoute ? (
                  <button className="tut-link" onClick={() => router.push(stepRoute)}>
                    Open it to follow along →
                  </button>
                ) : (
                  'Open the tab to follow along.'
                )}
              </p>
            </div>
          </div>
        ) : (
          <>
            <strong className="tut-tip-title">{step.title}</strong>
            <p className="tut-tip-body">{step.body}</p>
          </>
        )}

        <div className="tut-tip-actions">
          <button className="btn ghost" onClick={onExit}>
            Back to overview
          </button>
          <div className="row" style={{ gap: 8 }}>
            {i > 0 ? (
              <button className="btn ghost" onClick={back}>
                Back
              </button>
            ) : null}
            <button className="btn" onClick={next}>
              {i + 1 >= steps.length ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
