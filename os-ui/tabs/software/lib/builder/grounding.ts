/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    The agentic builder's GROUNDING PACK — the structured context a coding agent needs
 * USER STORY: As the owner of a well-described set of user stories I want the OS to build GOOD
 *             software from them, so the model must be handed the dataset schemas with real sample
 *             rows, the metric definitions, the exact SDK and UI API it compiles against, the design
 *             tokens, one exemplar app and the tier constraints — instead of being asked to fill a
 *             schema from a one-paragraph brief.
 * ARCHITECTURE:
 *   - PURE and DOM-free: types, extractors and one deterministic renderer. No store, no fs, no fetch.
 *     `grounding-server.ts` gathers the material through the governed doors and calls these.
 *   - The SDK and UI API surfaces are EXTRACTED FROM SOURCE (`core/app-sdk`, `core/app-ui`), never
 *     hand-written, so the prompt cannot drift from the code the compile gate checks against. The
 *     design tokens are extracted from the same portable `theme.css` an app imports.
 *   - HONESTY: everything the pack could not get, or clipped, lands in `gaps[]` and is RENDERED.
 *     A missing sample row is a labelled gap, never a fabricated row.
 *   - DETERMINISM: `renderGroundingPack` is a pure function of the pack, so the same inputs render
 *     byte-identical prompt text (snapshot-tested) and a build is reproducible/diffable.
 */

/** A source file as every software-tab surface already models it. */
export type SourceFile = { path: string; content: string };

/** One user story, flattened with its Design spec lists. */
export type GroundingStory = {
  epicId: string;
  storyId: string;
  title: string;
  /** The story's own "As a … I want … so that …" sentence, when the designer wrote one. */
  narrative?: string;
  features: string[];
  nfrs: string[];
  rules: string[];
};

/** A granted dataset: its REAL columns plus up to N REAL sample rows (or an honest note). */
export type GroundingDataset = {
  id: string;
  name: string;
  columns: string[];
  /** The columns the sample is keyed on (may be a subset of `columns` when clipped). */
  sampleColumns: string[];
  sampleRows: string[][];
  /** Honest label when the schema or the sample could not be read, or was clipped. */
  note?: string;
};

/** A granted metric: its id, name and its definition as the OS holds it (YAML/SQL/measure list). */
export type GroundingMetric = { id: string; name: string; definition: string | null; note?: string };

/** An API surface extracted from source — one signature per line, comments stripped. */
export type ApiSurface = { package: string; signatures: string[]; note?: string };

/** The vendored UI package's component surface: the exported names + each Props type's members. */
export type UiSurface = {
  package: string;
  components: string[];
  props: { type: string; members: string[] }[];
  note?: string;
};

/** The design tokens an app may rely on (CSS custom properties from the portable theme). */
export type DesignTokens = { names: string[]; note?: string };

/** One exemplar app tree, clipped to a byte budget. */
export type Exemplar = { name: string; files: SourceFile[]; note?: string };

/** The whole pack. Everything in it is governed material the caller may already see. */
export type GroundingPack = {
  app: { id: string; name: string; slug: string; description: string; template: string };
  /** What this build is for — `all`, an epic id, or an `epic/story` pair. */
  target: string;
  stories: GroundingStory[];
  datasets: GroundingDataset[];
  metrics: GroundingMetric[];
  sdk: ApiSurface;
  ui: UiSurface;
  tokens: DesignTokens;
  exemplar: Exemplar;
  constraints: string[];
  /** Everything the pack could NOT get, or clipped — rendered, never silent. */
  gaps: string[];
};

// ------------------------------------------------------------------------ bounds ---

/** Sample rows per dataset. Small on purpose: shape and value-style, not a data dump. */
export const GROUNDING_SAMPLE_ROWS = 5;
/** Columns carried per dataset sample (the schema list is never clipped; the SAMPLE is). */
export const GROUNDING_SAMPLE_COLUMNS = 12;
/** Characters of exemplar source. One real page is worth more than a whole truncated tree. */
export const GROUNDING_EXEMPLAR_MAX_CHARS = 6_000;
/** Characters of one metric definition. */
export const GROUNDING_METRIC_MAX_CHARS = 1_200;

/**
 * The TIER-2 CONSTRAINTS (R4's `runtime` tier): what a generated app IS, so the coder stops
 * inventing a Next.js server, an API key or a second auth path. These are facts about the
 * runtime the app is served by, not style preferences.
 */
export const TIER2_CONSTRAINTS: string[] = [
  'This is a Vite + React single-page app. There is NO server of your own: no Next.js, no API routes, no server-side rendering.',
  "Data and writes go through the OS SDK only: `import { createOsClient } from '@sovereign-os/app-sdk'`. The client runs SAME-ORIGIN with the signed-in user's session — it acts AS the user, so row- and document-level security already applies.",
  'NEVER embed a secret, token, API key, connection string or password. There is no credential for you to hold; the session is the credential.',
  "UI comes from `@sovereign-os/ui` (plus `import '@sovereign-os/ui/theme.css'`) and the design tokens below. Do not add a CSS framework or a component library.",
  'Reference ONLY the dataset ids, metric ids and column names listed below. An invented id or column fails the governed gate and the whole build is wasted.',
  'Every fetch has an honest loading, empty and error state. A failure says what failed — never substitute placeholder data that reads as success.',
  "The app's own new data goes to `os.records` (the governed append-only record store). You cannot create a dataset.",
];

// -------------------------------------------------------------- source extraction ---

/** Strip `/* *\/` and `//` comments from a source slice, preserving line structure. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The body of `export interface <name> {` … its matching `}`, or null when absent. */
function interfaceBody(source: string, name: string): string | null {
  const head = new RegExp(`export\\s+interface\\s+${name}\\s*\\{`).exec(source);
  if (!head) return null;
  let depth = 0;
  for (let i = head.index + head[0].length - 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(head.index + head[0].length, i);
    }
  }
  return null;
}

/**
 * The OS SDK's API surface, EXTRACTED from `core/app-sdk` source: the `OsClient` interface's
 * own lines (comments stripped, blank lines dropped) plus the package's named exports. Nothing
 * here is retyped by hand, so the prompt and the compile gate always agree.
 */
export function extractSdkSurface(files: SourceFile[], pkg = '@sovereign-os/app-sdk'): ApiSurface {
  const client = files.find((f) => f.path.endsWith('client.ts'));
  const index = files.find((f) => f.path.endsWith('index.ts'));
  const signatures: string[] = [];
  const body = client ? interfaceBody(stripComments(client.content), 'OsClient') : null;
  if (body) {
    signatures.push('interface OsClient {');
    for (const raw of body.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (line.trim().length === 0) continue;
      signatures.push(line.startsWith('  ') ? line : `  ${line.trim()}`);
    }
    signatures.push('}');
  }
  const exported = index ? namedExports(stripComments(index.content)) : [];
  if (exported.length > 0) signatures.push(`// named exports: ${exported.join(', ')}`);
  return body
    ? { package: pkg, signatures }
    : { package: pkg, signatures, note: `could not read the OsClient interface from ${pkg} source — write against the SDK README instead` };
}

/** Value + type names re-exported by a barrel's `export { … } from '…'` blocks, deduped+sorted. */
function namedExports(source: string): string[] {
  const names = new Set<string>();
  for (const block of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of block[1].split(',')) {
      const t = raw.trim().replace(/^type\s+/, '').replace(/\s+as\s+\w+$/, '');
      if (t.length > 0) names.add(t);
    }
  }
  return [...names].sort();
}

/**
 * The vendored UI package's surface, EXTRACTED from `core/app-ui` source: the barrel's named
 * exports, and for each `export type <X>Props = … { … }` the CUSTOM members the component adds
 * beyond the native HTML props. This is the same parse `compile-gate.ts` uses for its diagnostic
 * hints — here it is handed to the coder BEFORE it guesses a prop, not after.
 */
export function extractUiSurface(files: SourceFile[], pkg = '@sovereign-os/ui'): UiSurface {
  const components = new Set<string>();
  const props: { type: string; members: string[] }[] = [];
  for (const f of files) {
    if (!/\.tsx?$/.test(f.path)) continue;
    const src = stripComments(f.content);
    if (f.path.endsWith('index.ts')) for (const n of namedExports(src)) components.add(n);
    for (const m of src.matchAll(/export\s+type\s+(\w+Props)\s*=\s*[^{;]*\{([^}]*)\}/g)) {
      const members = [...m[2].matchAll(/([A-Za-z_$][\w$]*)\s*\??\s*:/g)].map((x) => x[1]);
      if (members.length > 0) props.push({ type: m[1], members });
    }
  }
  props.sort((a, b) => a.type.localeCompare(b.type));
  const list = [...components].sort();
  return list.length > 0
    ? { package: pkg, components: list, props }
    : { package: pkg, components: list, props, note: `could not read the ${pkg} barrel — check the primitives in the exemplar instead` };
}

/**
 * The design tokens, EXTRACTED from the portable `theme.css`: every `--sb-*` custom property
 * declared on `:root`. Deduped, declaration-ordered (an alphabetical sort would scatter the
 * palette groups a designer reads together).
 */
export function extractDesignTokens(css: string): DesignTokens {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const m of css.matchAll(/^\s*(--sb-[\w-]+)\s*:/gm)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      names.push(m[1]);
    }
  }
  return names.length > 0 ? { names } : { names, note: 'could not read the design tokens from theme.css' };
}

/**
 * One exemplar app tree, clipped to `maxChars`. Files are taken in the order given (the scaffold
 * already orders entry → shell → page → client), whole files only, so the coder never reads half
 * a function. Returns an honest note naming how many files were left out.
 */
export function pickExemplar(name: string, files: SourceFile[], maxChars = GROUNDING_EXEMPLAR_MAX_CHARS): Exemplar {
  const kept: SourceFile[] = [];
  let used = 0;
  let skipped = 0;
  for (const f of files) {
    const cost = f.path.length + f.content.length;
    if (used + cost > maxChars) {
      skipped++;
      continue;
    }
    kept.push(f);
    used += cost;
  }
  return skipped > 0
    ? { name, files: kept, note: `${skipped} further exemplar file(s) omitted to stay inside the ${maxChars}-character budget` }
    : { name, files: kept };
}

/** Clip a metric definition to the budget, labelling the clip. */
export function clipDefinition(text: string, maxChars = GROUNDING_METRIC_MAX_CHARS): { text: string; clipped: boolean } {
  return text.length <= maxChars ? { text, clipped: false } : { text: `${text.slice(0, maxChars)}\n… (clipped)`, clipped: true };
}

// ------------------------------------------------------------------- the renderer ---

function storiesBlock(stories: GroundingStory[]): string {
  if (stories.length === 0) return '(no user stories designed yet — the builder cannot build without them)';
  return stories
    .map((s) => {
      const lines = [`- story ${s.epicId}/${s.storyId}: ${s.title}`];
      if (s.narrative) lines.push(`    ${s.narrative}`);
      for (const f of s.features) lines.push(`    feature: ${f}`);
      for (const n of s.nfrs) lines.push(`    nfr: ${n}`);
      for (const r of s.rules) lines.push(`    rule: ${r}`);
      return lines.join('\n');
    })
    .join('\n');
}

function datasetsBlock(datasets: GroundingDataset[]): string {
  if (datasets.length === 0) return '(no dataset granted — you may not read any dataset)';
  return datasets
    .map((d) => {
      const lines = [`- datasetId "${d.id}" (${d.name})`, `    columns: ${d.columns.length > 0 ? d.columns.join(', ') : '(unknown — do not reference columns of this dataset)'}`];
      if (d.sampleRows.length > 0) {
        lines.push(`    sample (${d.sampleRows.length} real row(s)): ${d.sampleColumns.join(' | ')}`);
        for (const row of d.sampleRows) lines.push(`      ${row.join(' | ')}`);
      }
      if (d.note) lines.push(`    note: ${d.note}`);
      return lines.join('\n');
    })
    .join('\n');
}

function metricsBlock(metrics: GroundingMetric[]): string {
  if (metrics.length === 0) return '(no metric granted)';
  return metrics
    .map((m) => {
      const lines = [`- metricId "${m.id}" (${m.name})`];
      if (m.definition) lines.push(m.definition.split('\n').map((l) => `    ${l}`).join('\n'));
      if (m.note) lines.push(`    note: ${m.note}`);
      return lines.join('\n');
    })
    .join('\n');
}

function uiBlock(ui: UiSurface): string {
  const lines = [`${ui.package} exports: ${ui.components.length > 0 ? ui.components.join(', ') : '(unknown)'}`];
  for (const p of ui.props) lines.push(`  ${p.type.replace(/Props$/, '')} accepts: ${p.members.join(', ')}`);
  if (ui.note) lines.push(`  note: ${ui.note}`);
  return lines.join('\n');
}

function exemplarBlock(ex: Exemplar): string {
  const lines = [`Exemplar app: ${ex.name}`];
  for (const f of ex.files) lines.push(`--- ${f.path} ---`, f.content.replace(/\s+$/, ''));
  if (ex.note) lines.push(`note: ${ex.note}`);
  return lines.join('\n');
}

/**
 * Render the pack as the deterministic prompt text the planner and coder are grounded in.
 * PURE: the same pack renders byte-identical text (snapshot-tested), which is what makes a
 * build diffable and a regression in the harness visible.
 */
export function renderGroundingPack(pack: GroundingPack): string {
  const sections: string[] = [
    `# App: ${pack.app.name} (${pack.app.slug})`,
    pack.app.description ? `${pack.app.description}` : '(no description)',
    `Template: ${pack.app.template} · build target: ${pack.target}`,
    '',
    '## What you are building (the runtime, non-negotiable)',
    pack.constraints.map((c, i) => `${i + 1}. ${c}`).join('\n'),
    '',
    '## User stories — the definition of done',
    storiesBlock(pack.stories),
    '',
    '## Granted datasets — real columns and real sample rows',
    datasetsBlock(pack.datasets),
    '',
    '## Granted metrics — their definitions as the OS holds them',
    metricsBlock(pack.metrics),
    '',
    `## ${pack.sdk.package} — the API you compile against (extracted from source)`,
    pack.sdk.signatures.join('\n'),
    ...(pack.sdk.note ? [`note: ${pack.sdk.note}`] : []),
    '',
    `## ${pack.ui.package} — the components you compose with (extracted from source)`,
    uiBlock(pack.ui),
    '',
    '## Design tokens (CSS custom properties available to your styles)',
    pack.tokens.names.length > 0 ? pack.tokens.names.join(', ') : '(unknown)',
    ...(pack.tokens.note ? [`note: ${pack.tokens.note}`] : []),
    '',
    '## An exemplar of a correct app',
    exemplarBlock(pack.exemplar),
  ];
  if (pack.gaps.length > 0) {
    sections.push(
      '',
      '## What this brief could NOT give you (do not guess around these)',
      pack.gaps.map((g) => `- ${g}`).join('\n'),
    );
  }
  return sections.join('\n');
}

/**
 * A one-line, honest summary of the pack — for the activity feed, the tool result and the trace,
 * so a thin grounding pack is VISIBLE instead of silently producing a thin app.
 */
export function groundingSummary(pack: GroundingPack): string {
  const samples = pack.datasets.reduce((n, d) => n + d.sampleRows.length, 0);
  const parts = [
    `${pack.stories.length} story(ies)`,
    `${pack.datasets.length} dataset(s) / ${samples} sample row(s)`,
    `${pack.metrics.length} metric(s)`,
    `${pack.sdk.signatures.length} SDK line(s)`,
    `${pack.ui.components.length} UI export(s)`,
    `${pack.tokens.names.length} token(s)`,
    `${pack.exemplar.files.length} exemplar file(s)`,
  ];
  return pack.gaps.length > 0 ? `${parts.join(' · ')} · ${pack.gaps.length} gap(s)` : parts.join(' · ');
}
