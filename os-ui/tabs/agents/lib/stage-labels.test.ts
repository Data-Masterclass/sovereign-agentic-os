/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The agent builder's stage rail renders in the user's language without changing its rules
 * USER STORY: As a maintainer I want proof that the localized rail reads exactly as before in English, that
 *             every reason `AGENT_STAGES` can return has a key in all seven languages, and that the gates and
 *             ✓ rules are untouched.
 * ARCHITECTURE: Renders keys through the real catalogs (`core/testing/catalog-text.ts`). Drives every stage's
 *   `pending` / `problem` through a set of contexts so a new English reason without a key fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_STAGES, type AgentStageCtx } from '@tabs/agents/lib/stages';
import { AGENT_STAGE_STATUS_KEYS, localizeAgentStages, stageStatusKey } from '@tabs/agents/lib/stage-labels';
import { catalogText, hasCatalogKey, CATALOG_LOCALES } from '@core/testing/catalog-text';

const base: AgentStageCtx = {
  named: false, hasGoal: false, grantCount: 0, emptyGrantCount: 0, grantWarning: '', ready: false,
  builtOk: false, buildFailed: false, hasRun: false, runFailed: false, runInterrupted: false, checksPass: false,
} as unknown as AgentStageCtx;
const contexts: AgentStageCtx[] = [
  base,
  { ...base, named: true },
  { ...base, named: true, grantCount: 2, emptyGrantCount: 2 },
  { ...base, ready: true, buildFailed: true },
  { ...base, ready: true, builtOk: true, runFailed: true, hasRun: true },
  { ...base, ready: true, builtOk: true, runInterrupted: true, hasRun: true },
  { ...base, ready: true, builtOk: true, hasRun: true },
];

const en = (k: string) => catalogText('agents', { key: k });

test('every English reason AGENT_STAGES returns has a key, in all seven languages', () => {
  const seen = new Set<string>();
  for (const s of AGENT_STAGES) {
    for (const c of contexts) {
      const p = s.pending?.(c);
      if (p) seen.add(p);
      const pr = s.problem?.(c);
      if (pr && pr.label) seen.add(pr.label);
    }
  }
  for (const text of seen) assert.ok(stageStatusKey(text), `no key for "${text}"`);
  for (const k of Object.values(AGENT_STAGE_STATUS_KEYS)) {
    for (const l of CATALOG_LOCALES) assert.ok(hasCatalogKey('agents', `stages.status.${k}`, l), `${l}: stages.status.${k}`);
  }
  for (const s of AGENT_STAGES) for (const l of CATALOG_LOCALES) assert.ok(hasCatalogKey('agents', `stages.titles.${s.id}`, l));
});

test('English: the localized rail reads exactly like AGENT_STAGES', () => {
  const loc = localizeAgentStages(AGENT_STAGES, en);
  loc.forEach((s, i) => {
    const orig = AGENT_STAGES[i];
    assert.equal(s.title, orig.title);
    for (const c of contexts) {
      assert.equal(s.pending?.(c), orig.pending?.(c));
      assert.deepEqual(s.problem?.(c) ?? null, orig.problem?.(c) ?? null);
      assert.equal(s.enabled?.(c), orig.enabled?.(c), 'gates untouched');
      assert.equal(s.completed?.(c), orig.completed?.(c), '✓ rule untouched');
    }
  });
});

test('German: titles and reasons are translated; an unknown reason (the grant warning) passes through', () => {
  const de = localizeAgentStages(AGENT_STAGES, (k) => catalogText('agents', { key: k }, 'de'));
  assert.equal(de[0].title, 'Definieren');
  assert.equal(de[0].pending?.(base), 'noch kein Name');
  const grant = de.find((s) => s.id === 'grant')!;
  const warned = { ...base, named: true, grantCount: 1, emptyGrantCount: 1, grantWarning: 'Dieser Ordner ist leer' } as AgentStageCtx;
  assert.equal(grant.problem?.(warned)?.label, 'Dieser Ordner ist leer');
});
