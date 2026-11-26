/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       ui
 * FEATURE:    The ONE Studio | Run header toggle
 * USER STORY: As a user I want one switch that answers the complaint "everything is on one
 *             screen with no indication of whether it is an experiment or the thing the company
 *             runs" — and I want it remembered, so I set it once.
 * ARCHITECTURE: A shell over `useViewSurface`. It reuses the existing `.seg` segmented control,
 *               fires the shared event every tile list listens for, and persists the choice per
 *               user through /api/prefs/view-surface. Two buttons, two words, nothing else.
 * I18N:       converted (wave 1) — labels and hints from `shell.surface.*` (English identical to VIEW_SURFACE_LABELS / VIEW_SURFACE_HINTS).
 */
'use client';

import { VIEW_SURFACES } from '@core/kernel/object-lifecycle';
import { useTranslations } from '@core/i18n/client';
import { useViewSurface } from '@core/ui/lifecycle/useLifecycleView';

export default function StudioRunToggle({ role = 'creator' }: { role?: string }) {
  const t = useTranslations('shell');
  const { surface, setSurface } = useViewSurface(role);
  return (
    <div className="seg" role="group" aria-label={t('surface.group')}>
      {VIEW_SURFACES.map((s) => (
        <button
          key={s}
          type="button"
          className={surface === s ? 'on' : ''}
          aria-pressed={surface === s}
          title={t(`surface.${s}Hint`)}
          onClick={() => setSurface(s)}
        >
          {t(`surface.${s}`)}
        </button>
      ))}
    </div>
  );
}
