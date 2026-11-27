/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    Catalog keys for the builder's fixed English labels (capability chips, templates, presets, judge, model)
 * USER STORY: As a German or Polish author I read the capability cards, agent templates, safety presets, judge
 *             dimensions and model choices of the agent builder in my language; as an English author I see
 *             exactly the words I saw before.
 * ARCHITECTURE:
 *   - The English labels live in shared modules other code reads too (`capability-tools.ts` CAPABILITY_CHIPS,
 *     `agent-templates.ts`, `access-levels.ts` AGENT_SAFETY_PRESETS + PRESET_RUNTIME_NOTE, `evaluate-judge.ts`
 *     dimensions, `agent-model.ts` modelChoiceLabel) — some of it reaches a model or a PDF and must stay
 *     English. Those modules are not changed; this one maps their stable ids to `agents` catalog keys
 *     (relative to the namespace), and the UI renders the key.
 *   - `builder-labels.test.ts` renders every key through the English catalog and asserts it equals the
 *     English source, so the two cannot drift; and that every key exists in all 7 locales.
 *   - An unknown id returns null — the caller shows the English source text as is.
 *   - Pure, import-free: safe in a client component and a unit test.
 */

const camel = (id: string) => id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** The capability chip ids (`CAPABILITY_CHIPS[].id`) that have catalog keys. */
export const CHIP_IDS = [
  'read-data', 'search-knowledge', 'read-workflows', 'use-connection', 'create-files', 'query-metrics', 'read-operating-manual',
] as const;

/** Chip label / description keys: `builder.capabilities.chips.<camelId>.label|description`. */
export function chipKeys(id: string): { label: string; description: string } | null {
  if (!(CHIP_IDS as readonly string[]).includes(id)) return null;
  const base = `builder.capabilities.chips.${camel(id)}`;
  return { label: `${base}.label`, description: `${base}.description` };
}

/** The chip group names (`CAPABILITY_CHIPS[].domain`) that have catalog keys. */
export const CHIP_DOMAINS = ['Data', 'Knowledge', 'Workflows', 'Connections', 'Files', 'Metrics', 'Plan'] as const;

/** A chip group name's key: `builder.capabilities.domains.<lowercase>`. */
export function chipDomainKey(domain: string): string | null {
  return (CHIP_DOMAINS as readonly string[]).includes(domain) ? `builder.capabilities.domains.${domain.toLowerCase()}` : null;
}

/** The agent template keys (`AGENT_TEMPLATES[].key`) that have catalog keys. */
export const TEMPLATE_IDS = ['blank', 'analyst', 'recommender', 'reviewer', 'researcher'] as const;

/** Template card keys: `builder.templates.<key>.label|blurb`. Display only — the stored role stays English. */
export function templateKeys(key: string): { label: string; blurb: string } | null {
  if (!(TEMPLATE_IDS as readonly string[]).includes(key)) return null;
  return { label: `builder.templates.${key}.label`, blurb: `builder.templates.${key}.blurb` };
}

/** The safety preset ids (`AGENT_SAFETY_PRESETS[].id`) that have catalog keys. */
export const PRESET_IDS = ['read-only', 'read-propose', 'read-bounded', 'full-in-scope'] as const;

/** Safety preset card keys: `runtime.presets.<camelId>.label|consequence`. */
export function presetKeys(id: string): { label: string; consequence: string } | null {
  if (!(PRESET_IDS as readonly string[]).includes(id)) return null;
  const base = `runtime.presets.${camel(id)}`;
  return { label: `${base}.label`, consequence: `${base}.consequence` };
}

/** The note under the preset picker (`PRESET_RUNTIME_NOTE`). */
export const PRESET_NOTE_KEY = 'runtime.presetNote';

/** The judge dimensions (`JudgeDimension`) that have catalog keys. */
export const DIMENSION_IDS = ['clarity', 'grounding', 'actionability'] as const;

/** A judge dimension's key: `builder.evaluate.dimensions.<id>`. */
export function dimensionKey(d: string): string | null {
  return (DIMENSION_IDS as readonly string[]).includes(d) ? `builder.evaluate.dimensions.${d}` : null;
}

/** The model choices (`AgentModelChoice`) that have catalog keys. */
export const MODEL_CHOICE_IDS = ['strong', 'standard', 'auto'] as const;

/** A model choice's key: `editor.model.choices.<id>`. */
export function modelChoiceKey(c: string): string | null {
  return (MODEL_CHOICE_IDS as readonly string[]).includes(c) ? `editor.model.choices.${c}` : null;
}
