/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Tests for the agentic builder's grounding pack
 * USER STORY: As the engineer fixing the builder harness I want the grounding pack's extraction and
 *             rendering pinned by tests, so the prompt cannot silently drift from the source the
 *             compile gate checks against.
 * ARCHITECTURE: Pure unit tests over `grounding.ts`, plus a REAL extraction over the shipped
 *               `core/app-sdk`, `core/app-ui` and `core/app-ui/theme.css` source, which is what
 *               makes "extracted, not hand-written" (checklist H1/H3) a measurement.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSdkSource } from '../app-sdk-vendor.ts';
import { readUiSource } from '../app-ui-vendor.ts';
import {
  GROUNDING_EXEMPLAR_MAX_CHARS,
  TIER2_CONSTRAINTS,
  extractDesignTokens,
  extractSdkSurface,
  extractUiSurface,
  groundingSummary,
  pickExemplar,
  renderGroundingPack,
  type GroundingPack,
} from './grounding.ts';

// --------------------------------------------------- extraction from REAL source ---

test('H1 the SDK surface is extracted from core/app-sdk source, not hand-written', () => {
  const sdk = extractSdkSurface(readSdkSource('node_modules/@sovereign-os/app-sdk'));
  assert.equal(sdk.note, undefined, 'the real SDK source must be readable');
  const text = sdk.signatures.join('\n');
  // Shape: the OsClient interface itself, with its real members.
  assert.ok(text.includes('interface OsClient {'));
  for (const member of ['whoami(', 'datasets:', 'metrics:', 'records:', 'knowledge:']) {
    assert.ok(text.includes(member), `missing ${member}`);
  }
  // Comments are stripped — the pack carries signatures, not prose.
  assert.ok(!text.includes('/**'));
  assert.ok(!text.includes('* Resolve to a normalized'));
  // The barrel's named exports ride along, so the coder knows what it may import.
  assert.ok(text.includes('named exports:'));
  assert.ok(text.includes('createOsClient'));
});

test('H1 the UI surface is extracted from core/app-ui source with each Props type members', () => {
  const ui = extractUiSurface(readUiSource('node_modules/@sovereign-os/ui'));
  assert.equal(ui.note, undefined, 'the real UI source must be readable');
  for (const c of ['AppShell', 'Badge', 'Button', 'Card', 'Table']) {
    assert.ok(ui.components.includes(c), `missing component ${c}`);
  }
  const badge = ui.props.find((p) => p.type === 'BadgeProps');
  assert.ok(badge, 'BadgeProps must be extracted');
  // The gate's own diagnostic hint knows Badge takes `tone`, not `variant`; so must the pack.
  assert.ok(badge.members.includes('tone'));
  assert.ok(!badge.members.includes('variant'));
});

test('H3 the design tokens are extracted from the shipped theme.css', () => {
  const css = readFileSync(join(process.cwd(), 'core', 'app-ui', 'theme.css'), 'utf8');
  const tokens = extractDesignTokens(css);
  assert.equal(tokens.note, undefined);
  assert.ok(tokens.names.length > 20, `expected a real palette, got ${tokens.names.length}`);
  assert.ok(tokens.names.includes('--sb-gold'));
  assert.ok(tokens.names.includes('--sb-text'));
  // Deduped: a token redeclared in the dark block appears once.
  assert.equal(new Set(tokens.names).size, tokens.names.length);
});

test('extraction FAILS HONESTLY on unreadable source — never silently empty', () => {
  const sdk = extractSdkSurface([{ path: 'client.ts', content: 'export const x = 1;' }]);
  assert.ok(sdk.note && sdk.note.includes('could not read'));
  const ui = extractUiSurface([{ path: 'index.ts', content: '// nothing' }]);
  assert.ok(ui.note && ui.note.includes('could not read'));
  assert.ok(extractDesignTokens(':root { color: red; }').note);
});

test('the exemplar is clipped to whole files inside the budget, and says what it dropped', () => {
  const files = [
    { path: 'a.ts', content: 'x'.repeat(40) },
    { path: 'b.ts', content: 'y'.repeat(4_000) },
    { path: 'c.ts', content: 'z'.repeat(40) },
  ];
  const ex = pickExemplar('demo', files, 200);
  assert.deepEqual(
    ex.files.map((f) => f.path),
    ['a.ts', 'c.ts'],
    'the oversized file is skipped; the small ones stay WHOLE',
  );
  assert.ok(ex.note && ex.note.includes('1 further exemplar file'));
  assert.equal(pickExemplar('demo', files, GROUNDING_EXEMPLAR_MAX_CHARS).note, undefined);
});

// ----------------------------------------------------------------- the renderer ---

function pack(over: Partial<GroundingPack> = {}): GroundingPack {
  return {
    app: { id: 'app_1', name: 'Invoices', slug: 'invoices', description: 'Track invoices.', template: 'sovereign-app' },
    target: 'all',
    stories: [
      {
        epicId: 'e1',
        storyId: 's1',
        title: 'See every open invoice',
        narrative: 'As a finance lead I want to see open invoices so that I can chase them',
        features: ['A table of open invoices'],
        nfrs: ['Loads in under two seconds'],
        rules: ['Only invoices of my own domain'],
      },
    ],
    datasets: [
      {
        id: 'ds_1',
        name: 'Invoices',
        columns: ['invoice_id', 'amount_eur', 'status'],
        sampleColumns: ['invoice_id', 'amount_eur', 'status'],
        sampleRows: [['INV-1', '120.5', 'open']],
      },
    ],
    metrics: [{ id: 'm_1', name: 'Open invoice value', definition: 'measures:\n  - name: open_value' }],
    sdk: { package: '@sovereign-os/app-sdk', signatures: ['interface OsClient {', '  whoami(): Promise<WhoAmI>;', '}'] },
    ui: { package: '@sovereign-os/ui', components: ['Card', 'Table'], props: [{ type: 'BadgeProps', members: ['tone'] }] },
    tokens: { names: ['--sb-gold', '--sb-text'] },
    exemplar: { name: 'vite-os', files: [{ path: 'src/main.tsx', content: 'export {};' }] },
    constraints: [...TIER2_CONSTRAINTS],
    gaps: [],
    ...over,
  };
}

test('H4 renderGroundingPack is deterministic and carries every section', () => {
  const a = renderGroundingPack(pack());
  const b = renderGroundingPack(pack());
  assert.equal(a, b, 'the same pack must render byte-identical text');
  for (const heading of [
    '## What you are building (the runtime, non-negotiable)',
    '## User stories — the definition of done',
    '## Granted datasets — real columns and real sample rows',
    '## Granted metrics — their definitions as the OS holds them',
    '## Design tokens (CSS custom properties available to your styles)',
    '## An exemplar of a correct app',
  ]) {
    assert.ok(a.includes(heading), `missing section ${heading}`);
  }
  // The story, its narrative, its nfr and its rule all reach the prompt.
  assert.ok(a.includes('story e1/s1: See every open invoice'));
  assert.ok(a.includes('As a finance lead'));
  assert.ok(a.includes('nfr: Loads in under two seconds'));
  assert.ok(a.includes('rule: Only invoices of my own domain'));
  // The REAL sample row is there, with the real columns.
  assert.ok(a.includes('sample (1 real row(s)): invoice_id | amount_eur | status'));
  assert.ok(a.includes('INV-1 | 120.5 | open'));
  // The metric DEFINITION is there, not a paraphrase.
  assert.ok(a.includes('measures:'));
  // The tier constraints are stated, including the no-secret rule.
  assert.ok(a.includes('NEVER embed a secret'));
  // No gaps section when there are no gaps.
  assert.ok(!a.includes('could NOT give you'));
});

test('H2 a pack with gaps RENDERS them — a missing sample is never silent', () => {
  const p = pack({
    datasets: [{ id: 'ds_2', name: 'ds_2', columns: [], sampleColumns: [], sampleRows: [], note: 'not readable: forbidden' }],
    gaps: ['dataset ds_2: not readable as you right now (forbidden) — do not reference its columns'],
  });
  const text = renderGroundingPack(p);
  assert.ok(text.includes('## What this brief could NOT give you'));
  assert.ok(text.includes('dataset ds_2: not readable'));
  assert.ok(text.includes('(unknown — do not reference columns of this dataset)'));
  // And nothing in the rendered pack invents a row.
  assert.ok(!text.includes('sample ('));
});

test('groundingSummary counts what the build was actually given', () => {
  assert.equal(
    groundingSummary(pack()),
    '1 story(ies) · 1 dataset(s) / 1 sample row(s) · 1 metric(s) · 3 SDK line(s) · 2 UI export(s) · 2 token(s) · 1 exemplar file(s)',
  );
  assert.ok(groundingSummary(pack({ gaps: ['x', 'y'] })).endsWith('2 gap(s)'));
});
