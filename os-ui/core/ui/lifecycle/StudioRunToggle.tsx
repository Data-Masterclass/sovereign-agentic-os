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
 *               App Builder (F): with the App Builder switch on, the two buttons read Dev | Prod (`viewSurfaceLabelKey`);
 *               the ids `studio` / `run`, the stored preference and the filtering are unchanged. With it off the
 *               buttons are exactly Studio | Run (the flag defaults to off until the preference read answers).
 * I18N:       converted (wave 1) — labels and hints from `shell.surface.*` (English identical to VIEW_SURFACE_LABELS / VIEW_SURFACE_HINTS;
 *             `dev`/`prod`/`devHint`/`prodHint`/`groupDevProd` with the App Builder on).
 */
'use client';

import { VIEW_SURFACES, viewSurfaceLabelKey } from '@core/kernel/object-lifecycle';
import { useTranslations } from '@core/i18n/client';
import { useViewSurface } from '@core/ui/lifecycle/useLifecycleView';
import { useAppBuilderFlag } from '@core/ui/lifecycle/useAppBuilderFlag';

export default function StudioRunToggle({ role = 'creator' }: { role?: string }) {
  const t = useTranslations('shell');
  const { surface, setSurface } = useViewSurface(role);
  const appBuilder = useAppBuilderFlag();
  return (
    <div className="seg" role="group" aria-label={t(appBuilder ? 'surface.groupDevProd' : 'surface.group')}>
      {VIEW_SURFACES.map((s) => {
        const key = viewSurfaceLabelKey(s, appBuilder);
        return (
          <button
            key={s}
            type="button"
            className={surface === s ? 'on' : ''}
            aria-pressed={surface === s}
            title={t(`surface.${key}Hint`)}
            onClick={() => setSurface(s)}
          >
            {t(`surface.${key}`)}
          </button>
        );
      })}
    </div>
  );
}
