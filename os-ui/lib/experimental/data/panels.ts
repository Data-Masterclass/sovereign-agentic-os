/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Layer, Versions } from './dataset-schema.ts';

/**
 * Plain-language copy + small rules for the guided medallion panels (data-ui-ux.md
 * "Build a version — guided, one step at a time"). The user never sees dlt / dbt /
 * Cube; they see "Bring it in / Clean it up / Make it ready". Pure + tested so the
 * stepper, the panels and the data agent share one vocabulary and one set of gates.
 */

export type StageCopy = {
  /** The plain-language verb shown on the step + panel header. */
  title: string;
  /** One-line description of what this version IS. */
  subtitle: string;
  /** The hidden native tool, surfaced only by "Show the code". */
  tool: string;
};

export const STAGE_COPY: Record<Layer, StageCopy> = {
  bronze: {
    title: 'Bring it in',
    subtitle: 'The raw version, exactly as loaded.',
    tool: 'dlt / upload → Iceberg (via Trino)',
  },
  silver: {
    title: 'Clean it up + set the key',
    subtitle: 'Cleaned, typed and keyed — not yet integrated.',
    tool: 'dbt staging + tests',
  },
  gold: {
    title: 'Make it ready + monitoring',
    subtitle: 'The trusted, business-ready version.',
    tool: 'dbt mart + data-quality tests',
  },
};

const ORDER: Layer[] = ['bronze', 'silver', 'gold'];

export function priorLayer(layer: Layer): Layer | null {
  const i = ORDER.indexOf(layer);
  return i <= 0 ? null : ORDER[i - 1];
}

export function nextLayer(layer: Layer): Layer | null {
  const i = ORDER.indexOf(layer);
  return i < 0 || i === ORDER.length - 1 ? null : ORDER[i + 1];
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'dataset';
}

/** The tool-native file path for a version (one canonical name, threaded downstream
 *  per the FQN handover contract). Surfaced by "Show the code". */
export function stageArtifact(name: string, layer: Layer): string {
  const s = slug(name);
  if (layer === 'bronze') return `bronze/${s}.dlt.yml`;
  if (layer === 'silver') return `silver/stg_${s}.sql`;
  return `gold/mart_${s}.sql`;
}

/**
 * A step is buildable only once the prior layer exists (built OR passed through):
 * you cannot clean what you haven't brought in. Bronze is always available.
 */
export function canBuildStage(versions: Versions, layer: Layer): boolean {
  const prior = priorLayer(layer);
  if (!prior) return true;
  const p = versions[prior];
  return p.built;
}

/** Pass-through (data-ui-ux.md) — warn, then carry the prior version forward
 *  unchanged. There is nothing to carry for Bronze (it is the entry point). */
export function canPassThrough(layer: Layer): boolean {
  return priorLayer(layer) !== null;
}

export function passThroughWarning(layer: Layer): string {
  const prior = priorLayer(layer);
  return `Skipping ${STAGE_COPY[layer].title.toLowerCase()} carries the ${prior ?? ''} version forward unchanged. Only do this if the data is already ${
    layer === 'silver' ? 'clean and keyed' : 'business-ready'
  }.`;
}

export type StageState = {
  layer: Layer;
  copy: StageCopy;
  built: boolean;
  passThrough: boolean;
  quality: Dataset['versions'][Layer]['quality'];
  updatedAt: string | null;
  artifact: string | null;
  /** True when this step can be opened/built now (prior layer present). */
  buildable: boolean;
};

/** Project a dataset into the three stepper steps the UI renders. */
export function stepperStages(d: Dataset): StageState[] {
  return ORDER.map((layer) => {
    const v = d.versions[layer];
    return {
      layer,
      copy: STAGE_COPY[layer],
      built: v.built,
      passThrough: v.passThrough,
      quality: v.quality,
      updatedAt: v.updatedAt,
      artifact: v.artifact,
      buildable: canBuildStage(d.versions, layer),
    };
  });
}
