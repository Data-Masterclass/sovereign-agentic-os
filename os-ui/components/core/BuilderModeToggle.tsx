/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import type { ViewMode } from '@/lib/core/view-mode';

/**
 * The OS-wide builder view-mode toggle — a compact Simple ⇄ Developer segmented
 * control, generalised from the Agents tab's header toggle
 * (components/agents/SystemView.tsx). Purely presentational + controlled: the host
 * owns the `ViewMode` state (and any persistence), so any tab can drop this in.
 * Reuses the existing `.mode-toggle` segmented-control language — no new styling.
 *
 * Simple = the guided staged flow; Developer = the raw/technical surface the host
 * tab provides beside it.
 */
export default function BuilderModeToggle({
  mode,
  onChange,
  simpleLabel = 'Simple',
  developerLabel = 'Developer',
  simpleHint = 'Guided, plain-language builder',
  developerHint = 'The raw technical surface',
  ariaLabel = 'Builder view mode',
}: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
  simpleLabel?: string;
  developerLabel?: string;
  simpleHint?: string;
  developerHint?: string;
  ariaLabel?: string;
}) {
  return (
    <div className="mode-toggle" role="group" aria-label={ariaLabel}>
      <button
        type="button"
        className={mode === 'simple' ? 'active' : ''}
        aria-pressed={mode === 'simple'}
        onClick={() => onChange('simple')}
        title={simpleHint}
      >
        {simpleLabel}
      </button>
      <button
        type="button"
        className={mode === 'developer' ? 'active' : ''}
        aria-pressed={mode === 'developer'}
        onClick={() => onChange('developer')}
        title={developerHint}
      >
        {developerLabel}
      </button>
    </div>
  );
}
