/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useUser } from '@/lib/useUser';
import {
  framingForRole,
  framingFor,
  hasSandbox,
  panelForRole,
} from '@/lib/tutorials/engine';
import type { FramingRole, TutorialDef, WalkMode } from '@/lib/tutorials/types';
import { useTutorial } from './TutorialProvider';
import Illustration from './Illustration';
import CoachMarks from './CoachMarks';

/**
 * The in-place tutorial overlay: an illustrated storybook (Hook -> steps) with a
 * "Walk me through it" launcher, the live coach-mark run, and a "you did it"
 * close (with next-path cross-links). Role-aware framing throughout. Closing
 * restores the caller's exact route + scroll position.
 */

type Phase = 'overview' | 'walk' | 'done';
const ROLE_LABEL: Record<FramingRole, string> = {
  user: 'User',
  creator: 'Creator',
  builder: 'Builder',
};

export default function TutorialOverlay({
  def,
  origin,
  onClose,
}: {
  def: TutorialDef;
  origin: { path: string; scrollY: number } | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { open } = useTutorial();
  const { user } = useUser();
  const role = framingForRole(user?.role);
  const framing = framingFor(def, role);

  const sandboxOk = hasSandbox(def);
  const [phase, setPhase] = useState<Phase>('overview');
  // Default to practice when the path has a usable sandbox lane; otherwise start
  // in real mode so "Walk me through it" never hands the engine an empty list.
  const [mode, setMode] = useState<WalkMode>(() => (hasSandbox(def) ? 'sandbox' : 'real'));

  // Restore the caller's place, then unmount.
  const close = useCallback(() => {
    const back = origin?.path;
    if (back && back !== pathname) router.push(back);
    const y = origin?.scrollY ?? 0;
    // restore scroll after the route paints
    window.setTimeout(() => window.scrollTo({ top: y, behavior: 'auto' }), 60);
    onClose();
  }, [origin, pathname, router, onClose]);

  // Esc closes from the storybook phases (the coach-mark layer owns Esc itself).
  useEffect(() => {
    if (phase === 'walk') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, close]);

  // ---- live walk-through: hand the screen to the coach-marks ----------------
  if (phase === 'walk') {
    return (
      <CoachMarks
        def={def}
        mode={mode}
        role={role}
        onExit={() => setPhase('overview')}
        onComplete={() => setPhase('done')}
      />
    );
  }

  const hook = panelForRole(def.hook, role);

  return (
    <div className="tut-overlay" role="dialog" aria-modal="true" aria-label={`${def.title} tutorial`}>
      <button className="tut-scrim" aria-label="Close tutorial" onClick={close} />
      <div className="tut-sheet">
        <header className="tut-head">
          <div>
            <div className="tut-eyebrow">How it works</div>
            <h2 className="tut-title">{def.title}</h2>
            <p className="tut-tagline">{def.tagline}</p>
          </div>
          <div className="tut-head-right">
            <span className="tut-role">Viewing as {ROLE_LABEL[role]}</span>
            <button className="tut-x" aria-label="Close" onClick={close}>
              ✕
            </button>
          </div>
        </header>

        {phase === 'done' ? (
          <DonePanel
            def={def}
            mode={mode}
            sandboxOk={sandboxOk}
            role={role}
            onGraduate={() => {
              setMode('real');
              setPhase('walk');
            }}
            onReplay={() => setPhase('walk')}
            onOpenNext={(k) => open(k)}
            onClose={close}
          />
        ) : (
          <div className="tut-body">
            {/* Hook */}
            <section className="tut-hook">
              <div className="tut-hook-art">
                <Illustration id={hook.illustration} size={120} />
              </div>
              <div>
                <div className="tut-hook-kicker">{framing.hook}</div>
                <h3 className="tut-hook-title">{hook.title}</h3>
                <p className="tut-hook-body">{hook.body}</p>
              </div>
            </section>

            {/* Steps storybook */}
            <div className="tut-steps">
              {def.steps.map((p, idx) => {
                const panel = panelForRole(p, role);
                return (
                  <article className="tut-panel" key={idx}>
                    <span className="tut-panel-no">{idx + 1}</span>
                    <Illustration id={panel.illustration} size={72} />
                    <h4>{panel.title}</h4>
                    <p>{panel.body}</p>
                  </article>
                );
              })}
            </div>
          </div>
        )}

        {phase === 'overview' ? (
          <footer className="tut-foot">
            <div className="tut-mode-toggle" role="group" aria-label="Practice mode">
              <button
                className={mode === 'sandbox' ? 'active' : ''}
                onClick={() => setMode('sandbox')}
                disabled={!sandboxOk}
                title={sandboxOk ? '' : 'No sandbox lane for this path yet'}
              >
                Practice on sample data
              </button>
              <button
                className={mode === 'real' ? 'active' : ''}
                onClick={() => setMode('real')}
              >
                Do it for real
              </button>
            </div>
            <div className="tut-foot-cta">
              <span className="tut-safe">
                {mode === 'sandbox'
                  ? `Safe: practices in ${def.sandbox.lane}. No governed writes.`
                  : 'Governed: OPA/RLS applies to every step.'}
              </span>
              <button className="btn tut-go" onClick={() => setPhase('walk')}>
                Walk me through it →
              </button>
            </div>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

function DonePanel({
  def,
  mode,
  sandboxOk,
  role,
  onGraduate,
  onReplay,
  onOpenNext,
  onClose,
}: {
  def: TutorialDef;
  mode: WalkMode;
  sandboxOk: boolean;
  role: FramingRole;
  onGraduate: () => void;
  onReplay: () => void;
  onOpenNext: (k: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="tut-done">
      <Illustration id="celebrate" size={120} />
      <h3>{def.outro.title}</h3>
      <p>{def.outro.body}</p>

      {mode === 'sandbox' && sandboxOk ? (
        <div className="tut-graduate">
          <strong>Ready for the real thing?</strong>
          <p>You practiced safely. Now run the same steps for real — fully governed.</p>
          <button className="btn tut-go" onClick={onGraduate}>
            Graduate — do it for real →
          </button>
        </div>
      ) : null}

      <div className="tut-next">
        <div className="tut-next-label">Try next</div>
        <div className="tut-next-row">
          {def.outro.next.map((k) => (
            <button key={k} className="tut-next-chip" onClick={() => onOpenNext(k)}>
              {k.replace('-', ' ')} →
            </button>
          ))}
        </div>
      </div>

      <div className="tut-done-actions">
        <button className="btn ghost" onClick={onReplay}>
          Replay
        </button>
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
