/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import type { GoldenPathKey } from '@/lib/tutorials/types';
import { useTutorial } from './TutorialProvider';

/**
 * The single tutorial trigger, used by BOTH entry points so they resolve the
 * same registry entry:
 *   - Home card  -> variant="card"   ("How it works")
 *   - Tab header -> variant="header" ("Tutorial")
 */
export default function TutorialLink({
  tutorial,
  variant = 'card',
  label,
}: {
  tutorial: GoldenPathKey;
  variant?: 'card' | 'header';
  label?: string;
}) {
  const { open } = useTutorial();
  const text = label ?? (variant === 'header' ? 'Tutorial' : 'How it works');
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
