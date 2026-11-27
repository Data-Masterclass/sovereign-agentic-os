/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    The builder's catalog keys say exactly what the shared English sources say
 * USER STORY: As a maintainer I want a changed chip, template, preset, judge or model label in its source
 *             module to fail here until the catalog follows, and every key to exist in all 7 languages.
 * ARCHITECTURE:
 *   - Renders each `builder-labels.ts` key through the English catalog and compares with the source
 *     constant; checks every source id has a key; checks every key in all 7 locales.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chipKeys, chipDomainKey, templateKeys, presetKeys, PRESET_NOTE_KEY, dimensionKey, modelChoiceKey,
  DIMENSION_IDS,
} from '@tabs/agents/lib/builder-labels';
import { CAPABILITY_CHIPS } from '@tabs/agents/lib/capability-tools';
import { AGENT_TEMPLATES } from '@tabs/agents/lib/agent-templates';
import { AGENT_SAFETY_PRESETS, PRESET_RUNTIME_NOTE } from '@tabs/agents/lib/access-levels';
import { dimensionLabel } from '@tabs/agents/lib/evaluate-judge';
import { AGENT_MODEL_CHOICES, modelChoiceLabel } from '@tabs/agents/lib/agent-model';
import { catalogText, hasCatalogKey, CATALOG_LOCALES } from '@core/testing/catalog-text';

const en = (key: string) => catalogText('agents', { key });

/** [key, English source] for every label the builder renders from a key. */
function pairs(): [string, string][] {
  const out: [string, string][] = [];
  for (const c of CAPABILITY_CHIPS) {
    const k = chipKeys(c.id);
    assert.ok(k, `chip ${c.id} has no key`);
    out.push([k.label, c.label], [k.description, c.description]);
    const d = chipDomainKey(c.domain);
    assert.ok(d, `chip domain ${c.domain} has no key`);
    out.push([d, c.domain]);
  }
  for (const t of AGENT_TEMPLATES) {
    const k = templateKeys(t.key);
    assert.ok(k, `template ${t.key} has no key`);
    out.push([k.label, t.label], [k.blurb, t.blurb]);
  }
  for (const p of AGENT_SAFETY_PRESETS) {
    const k = presetKeys(p.id);
    assert.ok(k, `preset ${p.id} has no key`);
    out.push([k.label, p.label], [k.consequence, p.consequence]);
  }
  out.push([PRESET_NOTE_KEY, PRESET_RUNTIME_NOTE]);
  for (const d of DIMENSION_IDS) out.push([dimensionKey(d)!, dimensionLabel(d)]);
  for (const c of AGENT_MODEL_CHOICES) {
    const k = modelChoiceKey(c);
    assert.ok(k, `model choice ${c} has no key`);
    out.push([k, modelChoiceLabel(c)]);
  }
  return out;
}

test('builder labels — English catalog equals the shared English sources', () => {
  for (const [key, english] of pairs()) assert.equal(en(key), english, key);
});

test('builder labels — every key exists in all 7 locales', () => {
  for (const locale of CATALOG_LOCALES) {
    for (const [key] of pairs()) assert.ok(hasCatalogKey('agents', key, locale), `${locale}: ${key}`);
  }
});

test('builder labels — unknown ids give null (the caller shows the source text)', () => {
  assert.equal(chipKeys('nope'), null);
  assert.equal(chipDomainKey('Nope'), null);
  assert.equal(templateKeys('nope'), null);
  assert.equal(presetKeys('nope'), null);
  assert.equal(dimensionKey('nope'), null);
  assert.equal(modelChoiceKey('nope'), null);
});
