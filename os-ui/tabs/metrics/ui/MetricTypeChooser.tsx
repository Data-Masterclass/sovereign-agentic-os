/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    New-metric type chooser — Simple (aggregation) or Complex (formula)
 * USER STORY: As a creator starting a new metric I want to pick the kind of metric first so
 *             that the builder opens with the right editor.
 * ARCHITECTURE:
 *   - Client component rendered by `MetricsTab` before `MetricBuilder`; `onPick` returns the
 *     `MetricKind` the builder preselects.
 *   - Pure presentational: no fetch, no state beyond the props.
 */
'use client';

import { useTranslations } from '@core/i18n/client';

/** The two metric paths — a simple aggregation, or a formula over other metrics. */
export type MetricKind = 'simple' | 'complex';

/**
 * TWO-PATH create for a new metric — the calm type chooser that comes FIRST, mirroring the
 * Data tab's "＋ New dataset" (📥 ingest vs 🔗 curate). Choosing a card lands in the builder
 * with that path preselected: SIMPLE seeds an aggregation over a dataset's columns; COMPLEX
 * seeds the formula editor over the dataset's existing metrics. No dropdown-hunting — the
 * chooser owns the decision the buried 'formula' entry used to hide.
 */
export default function MetricTypeChooser({
  initialDatasetId,
  onPick,
  onBack,
}: {
  /** Preselected dataset (Data-tab deep-link) — carried straight into the builder. */
  initialDatasetId?: string;
  onPick: (kind: MetricKind) => void;
  onBack: () => void;
}) {
  const t = useTranslations('metrics');
  return (
    <div>
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <button className="btn ghost sm" onClick={onBack}>{t('chooser.back')}</button>
      </div>

      <div className="card" style={{ marginTop: 4 }}>
        <h3 style={{ marginTop: 0, marginBottom: 2 }}>{t('chooser.title')}</h3>
        <p className="hint" style={{ marginTop: 0 }}>{t('chooser.whatKind')}</p>
        <div className="tmpl-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', maxWidth: 680, gap: 12 }}>
          <button type="button" className="tmpl-card" style={{ padding: '18px 20px', gap: 6 }} onClick={() => onPick('simple')}>
            <span aria-hidden style={{ fontSize: 24, lineHeight: 1 }}>📊</span>
            <span className="tmpl-label" style={{ fontSize: 14 }}>{t('chooser.simpleTitle')}</span>
            <span className="tmpl-blurb" style={{ fontSize: 12 }}>{t('chooser.simpleBlurb')}</span>
          </button>
          <button type="button" className="tmpl-card" style={{ padding: '18px 20px', gap: 6 }} onClick={() => onPick('complex')}>
            <span aria-hidden style={{ fontSize: 24, lineHeight: 1 }}>🧮</span>
            <span className="tmpl-label" style={{ fontSize: 14 }}>{t('chooser.complexTitle')}</span>
            <span className="tmpl-blurb" style={{ fontSize: 12 }}>{t('chooser.complexBlurb')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
