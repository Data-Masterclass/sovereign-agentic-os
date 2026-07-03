/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import type { GoldenPathKey } from '@/lib/tutorials/types';
import { getTutorial } from '@/lib/tutorials/registry';
import { useTutorial } from './TutorialProvider';

/**
 * The single tutorial trigger, used by all three entry points:
 *   - Home card      -> variant="card"       ("How it works")
 *   - Tab header     -> variant="header"     ("Tutorial", legacy topbar style)
 *   - ActionBar      -> variant="action-bar" (uses TutorialDef.buttonLabel, bigger)
 */
export default function TutorialLink({
  tutorial,
  variant = 'card',
  label,
}: {
  tutorial: GoldenPathKey;
  variant?: 'card' | 'header' | 'action-bar';
  label?: string;
}) {
  const { open } = useTutorial();

  const def = getTutorial(tutorial);
  const defaultText =
    variant === 'action-bar'
      ? (def?.buttonLabel ?? 'Tutorial')
      : variant === 'header'
        ? 'Tutorial'
        : 'How it works';
  const text = label ?? defaultText;

  return (
    <button
      type="button"
      className={`tut-link tut-link-${variant}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        open(tutorial);
      }}
    >
      <span aria-hidden className="tut-link-spark">
        ✦
      </span>
      {text}
    </button>
  );
}
