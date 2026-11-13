/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       tabs/software
 * FEATURE:    Tolerant pre-validation shape normalisation for a model-authored AppSpec
 * USER STORY: As a creator pressing "Build app" I want the assistant's app to be built even when
 *             it writes a reference the shorthand way ("metric": "m_123" instead of
 *             "metric": { "metricId": "m_123" }), and to be TOLD what was tidied up, instead of
 *             losing the whole build to a shape the OS could read perfectly well.
 * ARCHITECTURE:
 *   - Pure + DOM-free: no store, no IO, no mutation of the input. One exported function.
 *   - TOLERANT PARSE, STRICT OUTPUT: this runs BEFORE parseAppSpec (schema.ts), which is NOT
 *     loosened — the spec that persists is always canonical.
 *   - Only UNAMBIGUOUS rewrites, derived from the grammar in patterns.ts: a bare id for a
 *     single-required-key slot, and the `{ id }` → `{ <slot>Id }` rename. Everything else is
 *     left for the gate to reject with its own typed { path, reason, fix } issue.
 */
/**
 * TOLERANT PARSE, STRICT OUTPUT — the one pre-validation shape normaliser for a model-authored
 * AppSpec.
 *
 * PROBLEM (production 0.8.0, Software tab → stage 4 "Build app"): the reasoning model routinely
 * emits a reference slot as a BARE ID STRING (`"metric": "m_revenue"`) or with a generic `id` key
 * (`"metric": { "id": "m_revenue" }`) where the grammar wants the canonical object
 * (`"metric": { "metricId": "m_revenue" }`). The structural gate rejected it with
 * `metric must be an object / use { metricId }` and, after three attempts, the whole build failed
 * with "The assistant couldn't produce a valid app from your design" — over a shape the OS can
 * read perfectly well.
 *
 * SHAPE OF THE FIX: normalise FIRST, then validate STRICTLY. `parseAppSpec` is NOT loosened — the
 * STORED spec stays canonical, so every renderer, the semantic gate and the composer keep one
 * shape. Only the model's raw reply passes through here, and every rewrite is recorded as a note
 * the Build stage shows the user ("normalised metric id → { metricId }"), so a silent coercion is
 * never invisible.
 *
 * ONLY UNAMBIGUOUS SHAPES. Two rewrite rules, both derived from the grammar in `patterns.ts`:
 *
 *   1. BARE ID → canonical object, for slots whose canonical object has exactly ONE required key,
 *      so the id alone determines the whole object: `metric` ({metricId}), `function`
 *      ({functionId}) and `source` ({datasetId}). `source` carries the ONE carve-out: the literal
 *      string `'records'` is itself valid grammar (the app's own record store) and is left alone.
 *   2. `{ id }` → `{ <slot>Id }`, a pure key RENAME that invents nothing. Safe for every reference
 *      slot, including the multi-key ones — `dataset` ({datasetId, agg, field?}) and `assignTo`
 *      ({datasetId, optionLabelField}) — because the sibling keys are preserved untouched and a
 *      missing one still fails validation with its own typed issue.
 *
 * Everything else is left EXACTLY as the model wrote it: a bare-id `dataset`/`assignTo` would need
 * a fabricated `agg`/`optionLabelField` (not unambiguous → still rejected), and no other key is
 * touched. There is no `dashboard` or `knowledge` slot in the AppSpec grammar.
 *
 * Pure and DOM-free: no store, no IO, no mutation of the input.
 */

/** A rewrite the normaliser applied, as a user-facing line for the build notes. */
export type NormaliseNote = string;

export type NormaliseResult = { value: unknown; notes: NormaliseNote[] };

/**
 * Reference slots whose canonical object has exactly ONE required key → the key that holds the id.
 * A bare id string is unambiguous for these, and `{ id }` renames to the canonical key.
 */
const BARE_ID_SLOTS: Readonly<Record<string, string>> = {
  metric: 'metricId',
  function: 'functionId',
  source: 'datasetId',
};

/**
 * Reference slots where ONLY the `{ id }` → `{ <slot>Id }` rename is safe (their canonical object
 * has further REQUIRED keys that a bare id cannot supply).
 */
const RENAME_ONLY_SLOTS: Readonly<Record<string, string>> = {
  dataset: 'datasetId',
  assignTo: 'datasetId',
};

/** Grammar-valid bare strings for a slot — never rewritten. `source:'records'` is real grammar. */
const RESERVED_BARE: Readonly<Record<string, readonly string[]>> = {
  source: ['records'],
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The id key for a slot, for either rule — or undefined when the key is not a reference slot. */
function idKeyFor(slot: string): string | undefined {
  return BARE_ID_SLOTS[slot] ?? RENAME_ONLY_SLOTS[slot];
}

/**
 * Normalise a model-authored spec's reference slots into the canonical grammar. Returns a NEW
 * value (the input is never mutated) plus one note per rewrite. Non-object input passes straight
 * through — `parseAppSpec` owns that refusal.
 */
export function normaliseSpecShapes(input: unknown): NormaliseResult {
  const notes: NormaliseNote[] = [];
  const value = walk(input, '', notes);
  return { value, notes };
}

function walk(node: unknown, path: string, notes: NormaliseNote[]): unknown {
  if (Array.isArray(node)) return node.map((item, i) => walk(item, `${path}[${i}]`, notes));
  if (!isPlainObject(node)) return node;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(node)) {
    const here = path ? `${path}.${key}` : key;
    out[key] = walk(normaliseSlot(key, raw, here, notes), here, notes);
  }
  return out;
}

/** Apply the two rewrite rules to ONE key's value. Returns the value unchanged when neither fits. */
function normaliseSlot(key: string, raw: unknown, path: string, notes: NormaliseNote[]): unknown {
  const idKey = idKeyFor(key);
  if (idKey === undefined) return raw;

  // RULE 1 — bare id string → the canonical single-key object.
  if (typeof raw === 'string') {
    if (!(key in BARE_ID_SLOTS)) return raw; // a bare id cannot complete a multi-key slot
    const id = raw.trim();
    if (id === '') return raw; // an empty id is a real error; let the gate say so
    if ((RESERVED_BARE[key] ?? []).includes(id)) return raw; // valid grammar already
    notes.push(`normalised ${key} id → { ${idKey} } (${path})`);
    return { [idKey]: id };
  }

  // RULE 2 — `{ id }` → `{ <slot>Id }`, a key rename that preserves every sibling key.
  if (isPlainObject(raw) && raw[idKey] === undefined && typeof raw.id === 'string') {
    const { id, ...rest } = raw;
    notes.push(`normalised ${key}.id → ${key}.${idKey} (${path})`);
    return { [idKey]: id, ...rest };
  }

  return raw;
}
