/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    The builder card's capability lines read the same in English and exist in every language
 * USER STORY: As an English author I see exactly the capability lines I saw before i18n; as a German or
 *             Polish author I read them in my language, with the capability names translated too.
 * ARCHITECTURE:
 *   - `capabilityStateMessage` / `staleLimitMessage` / `capabilityLabelMessage` return catalog keys; this
 *     test renders them through the English catalog and compares with the old English functions, and
 *     checks every key in all 7 locales. Pure: synthetic states, no store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilityStateLine, staleLimitNote, capabilityStateMessage, staleLimitMessage, capabilityLabelMessage,
  CAPABILITY_LABELS, type AgentCapabilityState,
} from '@tabs/agents/lib/agent-capabilities';
import { catalogText, CATALOG_LOCALES } from '@core/testing/catalog-text';

const limited = (labels: string[]): AgentCapabilityState => ({
  mode: 'limited', tools: ['x'], missing: labels.map((_, i) => `t${i}`), missingLabels: labels,
});
const STATES: AgentCapabilityState[] = [
  { mode: 'inherits', toolCount: 3 },
  limited([]),
  limited(['File reading']),
  limited(['File reading', 'File saving']),
  limited(['Data reading', 'File reading', 'File saving']),
  limited(['Data reading', 'File reading', 'File saving', 'Metrics', 'Connection setup']),
];

test('capability messages — English through the catalog is byte-identical', () => {
  for (const s of STATES) {
    for (const n of [0, 1, 2, 7]) assert.equal(catalogText('agents', capabilityStateMessage(s, n)), capabilityStateLine(s, n));
    const m = staleLimitMessage(s);
    const old = staleLimitNote(s);
    assert.equal(m === null ? null : catalogText('agents', m), old);
  }
  for (const label of CAPABILITY_LABELS) {
    const m = capabilityLabelMessage(label);
    assert.ok(m, `no key for ${label}`);
    assert.equal(catalogText('agents', m), label);
  }
  assert.equal(capabilityLabelMessage('some_unmapped_tool'), null);
});

test('capability messages — every key renders in all 7 locales', () => {
  for (const locale of CATALOG_LOCALES) {
    const label = (en: string) => catalogText('agents', capabilityLabelMessage(en)!, locale);
    for (const s of STATES) {
      for (const n of [0, 1, 2, 5, 22]) assert.ok(catalogText('agents', capabilityStateMessage(s, n), locale));
      const m = staleLimitMessage(s, label);
      if (m) assert.ok(catalogText('agents', m, locale));
    }
  }
});
