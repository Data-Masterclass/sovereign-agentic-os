/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * AppSpec — the declarative Software-app contract (Track 2).
 *
 * v2 (Phase 3.5a): the app is a set of TABS. Each tab renders EITHER a cookbook PATTERN
 * (a named, config-only recipe — `records-table`, `master-detail`, `intake-wizard`, … — from
 * the pattern registry) OR a sandboxed CUSTOM html/css/js block. This replaces the v1
 * `sections:[{view}]` shape (a Section was exactly a one-view tab); nothing in production used
 * v1 specs yet, so the grammar is migrated cleanly rather than shimmed. The leaf column/field
 * grammar (`TableColumn`, `FormField`, `Format`, `Control`, …) is UNCHANGED and reused by
 * pattern configs.
 *
 * This is the STRUCTURAL gate: it parses an untrusted object into the closed AppSpec grammar
 * and, on failure, returns TYPED `{path, reason, fix}` issues over a tiny grammar so the
 * authoring agent can self-correct without a TS-against-vendored-API fight. Semantic invariants
 * (dataset/column/metric existence + grants, pattern-config field checks) are a SEPARATE,
 * server-only pass (`validate.ts`) that runs AFTER a successful parse here.
 *
 * ZOD DECISION: the repo does NOT depend on Zod (absent from package.json and node_modules),
 * and the house rules say don't add a dependency for this. The grammar is a small closed set,
 * so this module is a HAND-WRITTEN validator that returns the exact `{ ok, issues }` shape a
 * Zod-backed `safeParse` mapper would. No runtime dependency.
 */

import { PATTERN_IDS, parsePatternConfig, type PatternConfig, type PatternId } from './patterns.ts';
import { parseFunctions, type AppFunction } from './functions-schema.ts';

// ---------------------------------------------------------------- enums (closed sets) --

export const FORMATS = ['text', 'number', 'currency-eur', 'date', 'badge'] as const;
export type Format = (typeof FORMATS)[number];

export const CONTROLS = ['select', 'search', 'range'] as const;
export type Control = (typeof CONTROLS)[number];

export const CHARTS = ['line', 'bar', 'area', 'kpi'] as const;
export type Chart = (typeof CHARTS)[number];

export const ROLE_GATES = ['creator', 'builder', 'domain_admin', 'admin'] as const;
export type RoleGate = (typeof ROLE_GATES)[number];

export const FIELD_TYPES = ['text', 'number', 'date', 'boolean'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** A tab renders one of these two body kinds. */
export const BODY_KINDS = ['pattern', 'custom'] as const;
export type BodyKind = (typeof BODY_KINDS)[number];

// -------------------------------------------------------- shared leaf grammar (v1-stable) --

export type TableColumn = { field: string; label?: string; format?: Format };
export type TableFilter = { field: string; control: Control };
export type DetailField = { field: string; label?: string; format?: Format };
export type FormField = { name: string; label: string; type: FieldType; required?: boolean };

// --------------------------------------------------------------------- tabs / bodies ----

/** A tab whose body is a named cookbook pattern; `config` is validated per-pattern. */
export type PatternBody = { kind: 'pattern'; pattern: PatternId; config: PatternConfig };

/** A tab whose body is a sandboxed author-supplied html/css/js block (see CustomBlockRenderer). */
export type CustomBody = {
  kind: 'custom';
  html: string;
  css?: string;
  js?: string;
  /** Optional governed data injected READ-ONLY into the sandbox as `window.__DATA__`. */
  data?: { datasetId: string; as?: string };
};

export type TabBody = PatternBody | CustomBody;

/**
 * A tab↔story link — the Design-Epics→Build bridge. Each `StoryRef` names an epic + a story
 * within it; a tab may serve MANY stories and a story may be served by MANY tabs (no uniqueness
 * constraint across tabs). Validated against the app's designed epics/stories in `validate.ts`.
 */
export type StoryRef = { epicId: string; storyId: string };

export type Tab = {
  id: string;
  label: string;
  icon?: string;
  roleGate?: RoleGate;
  /** OPTIONAL, additive: the epics/stories this tab implements (many-to-many). */
  stories?: StoryRef[];
  body: TabBody;
};

/** App-wide theme: author CSS applied scoped under the app root (see AppSpecRenderer). */
export type AppTheme = { css?: string };

export type AppSpec = {
  version: 2;
  name: string;
  description: string;
  theme?: AppTheme;
  tabs: Tab[];
  /** OPTIONAL, additive: governed backend DSL functions (aggregate/expression) — Phase 3.5d. */
  functions?: AppFunction[];
};

/** A typed structural OR semantic problem: a dotted spec path, why, and a short fix hint. */
export type SpecIssue = { path: string; reason: string; fix: string };

export type ParseResult = { ok: true; spec: AppSpec } | { ok: false; issues: SpecIssue[] };

/** Size ceilings for the custom block + theme (bytes of UTF-16 length — a coarse, safe cap).
 *  Big enough for a real widget, small enough that a runaway paste can't bloat the spec. */
export const CUSTOM_HTML_MAX = 20_000;
export const CUSTOM_CSS_MAX = 10_000;
export const CUSTOM_JS_MAX = 20_000;
export const THEME_CSS_MAX = 20_000;

// ----------------------------------------------------------------- tiny validators ----
// These primitives + the `Ctx`/`bad` helpers are exported so `patterns.ts` reuses the SAME
// typed-issue machinery for pattern-config parsing (one grammar, one issue shape).

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fmtList(vals: readonly string[]): string {
  return vals.join(', ');
}

export type Ctx = { issues: SpecIssue[] };

export function bad(ctx: Ctx, path: string, reason: string, fix: string): void {
  ctx.issues.push({ path, reason, fix });
}

/** A required string field: present, a string, non-empty after trim. */
export function reqString(ctx: Ctx, obj: Record<string, unknown>, key: string, path: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) {
    bad(ctx, path, `${key} is required`, `add a "${key}" string`);
    return undefined;
  }
  if (typeof v !== 'string') {
    bad(ctx, path, `${key} must be a string`, `set ${key} to a string`);
    return undefined;
  }
  if (v.trim() === '') {
    bad(ctx, path, `${key} must not be empty`, `give ${key} a non-empty value`);
    return undefined;
  }
  return v;
}

/** An optional string field: if present, must be a non-empty string. */
export function optString(ctx: Ctx, obj: Record<string, unknown>, key: string, path: string): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.trim() === '') {
    bad(ctx, path, `${key} must be a non-empty string when present`, `remove ${key} or give it a value`);
    return undefined;
  }
  return v;
}

export function reqEnum<T extends string>(
  ctx: Ctx,
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
): T | undefined {
  const v = obj[key];
  if (v === undefined || v === null) {
    bad(ctx, path, `${key} is required`, `set ${key} to one of: ${fmtList(allowed)}`);
    return undefined;
  }
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    bad(ctx, path, `${key} "${String(v)}" is not valid`, `use one of: ${fmtList(allowed)}`);
    return undefined;
  }
  return v as T;
}

export function optEnum<T extends string>(
  ctx: Ctx,
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
): T | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    bad(ctx, path, `${key} "${String(v)}" is not valid`, `use one of: ${fmtList(allowed)}`);
    return undefined;
  }
  return v as T;
}

/** A required non-empty array; returns the raw items (per-item shape checked by caller). */
export function reqArray(ctx: Ctx, obj: Record<string, unknown>, key: string, path: string): unknown[] | undefined {
  const v = obj[key];
  if (!Array.isArray(v)) {
    bad(ctx, path, `${key} must be an array`, `set ${key} to a list`);
    return undefined;
  }
  if (v.length === 0) {
    bad(ctx, path, `${key} must have at least one entry`, `add at least one ${key} entry`);
    return undefined;
  }
  return v;
}

/** A required non-empty string with a byte-length ceiling (for custom html/css/js + theme). */
export function reqBoundedString(
  ctx: Ctx,
  obj: Record<string, unknown>,
  key: string,
  max: number,
  path: string,
): string | undefined {
  const v = reqString(ctx, obj, key, path);
  if (v === undefined) return undefined;
  if (v.length > max) {
    bad(ctx, path, `${key} is too large (${v.length} chars, max ${max})`, `shorten ${key} to under ${max} characters`);
    return undefined;
  }
  return v;
}

/** An optional string with a ceiling (for custom css/js + theme.css). */
export function optBoundedString(
  ctx: Ctx,
  obj: Record<string, unknown>,
  key: string,
  max: number,
  path: string,
): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    bad(ctx, path, `${key} must be a string`, `set ${key} to a string or remove it`);
    return undefined;
  }
  if (v.length > max) {
    bad(ctx, path, `${key} is too large (${v.length} chars, max ${max})`, `shorten ${key} to under ${max} characters`);
    return undefined;
  }
  return v;
}

// ------------------------------------------------------ shared leaf parsers (reused) ----

/** Parse a `{ field, label?, format? }` column/field object. Exported for pattern configs. */
export function parseColumnLike(
  ctx: Ctx,
  raw: unknown,
  path: string,
): { field: string; label?: string; format?: Format } | undefined {
  if (!isObject(raw)) {
    bad(ctx, path, 'column must be an object', 'use { field, label?, format? }');
    return undefined;
  }
  const field = reqString(ctx, raw, 'field', `${path}.field`);
  const label = optString(ctx, raw, 'label', `${path}.label`);
  const format = optEnum(ctx, raw, 'format', FORMATS, `${path}.format`);
  if (field === undefined) return undefined;
  return { field, ...(label !== undefined ? { label } : {}), ...(format !== undefined ? { format } : {}) };
}

/** Parse a source `{ datasetId }` object; returns the id or undefined (with a typed issue). */
export function parseDatasetSource(ctx: Ctx, raw: unknown, path: string): string | undefined {
  if (!isObject(raw)) {
    bad(ctx, path, 'source must be an object', 'use { datasetId }');
    return undefined;
  }
  return reqString(ctx, raw, 'datasetId', `${path}.datasetId`);
}

// --------------------------------------------------------------------- tab parsers ----

function parseCustomBody(ctx: Ctx, obj: Record<string, unknown>, path: string): CustomBody | undefined {
  const html = reqBoundedString(ctx, obj, 'html', CUSTOM_HTML_MAX, `${path}.html`);
  const css = optBoundedString(ctx, obj, 'css', CUSTOM_CSS_MAX, `${path}.css`);
  const js = optBoundedString(ctx, obj, 'js', CUSTOM_JS_MAX, `${path}.js`);

  let data: CustomBody['data'];
  if (obj.data !== undefined) {
    if (!isObject(obj.data)) {
      bad(ctx, `${path}.data`, 'data must be an object', 'use { datasetId, as? } or remove data');
    } else {
      const datasetId = reqString(ctx, obj.data, 'datasetId', `${path}.data.datasetId`);
      const as = optString(ctx, obj.data, 'as', `${path}.data.as`);
      if (datasetId !== undefined) data = { datasetId, ...(as !== undefined ? { as } : {}) };
    }
  }

  if (html === undefined) return undefined;
  return {
    kind: 'custom',
    html,
    ...(css !== undefined ? { css } : {}),
    ...(js !== undefined ? { js } : {}),
    ...(data !== undefined ? { data } : {}),
  };
}

function parsePatternBody(ctx: Ctx, obj: Record<string, unknown>, path: string): PatternBody | undefined {
  const pattern = reqEnum(ctx, obj, 'pattern', PATTERN_IDS, `${path}.pattern`);
  if (pattern === undefined) return undefined; // unknown pattern id already reported

  // Config is REQUIRED and validated by the pattern's own structural parser.
  if (obj.config === undefined) {
    bad(ctx, `${path}.config`, 'config is required', `add a config object for the "${pattern}" pattern`);
    return undefined;
  }
  const config = parsePatternConfig(ctx, pattern, obj.config, `${path}.config`);
  if (config === undefined) return undefined;
  return { kind: 'pattern', pattern, config };
}

function parseTabBody(ctx: Ctx, raw: unknown, path: string): TabBody | undefined {
  if (!isObject(raw)) {
    bad(ctx, path, 'body must be an object', 'set body to a { kind: "pattern" | "custom", … } object');
    return undefined;
  }
  const kind = reqEnum(ctx, raw, 'kind', BODY_KINDS, `${path}.kind`);
  switch (kind) {
    case 'pattern':
      return parsePatternBody(ctx, raw, path);
    case 'custom':
      return parseCustomBody(ctx, raw, path);
    default:
      return undefined; // kind already reported
  }
}

function parseTab(ctx: Ctx, raw: unknown, path: string): Tab | undefined {
  if (!isObject(raw)) {
    bad(ctx, path, 'tab must be an object', 'use { id, label, body }');
    return undefined;
  }
  const id = reqString(ctx, raw, 'id', `${path}.id`);
  const label = reqString(ctx, raw, 'label', `${path}.label`);
  const icon = optString(ctx, raw, 'icon', `${path}.icon`);
  const roleGate = optEnum(ctx, raw, 'roleGate', ROLE_GATES, `${path}.roleGate`);
  const stories = parseStories(ctx, raw.stories, `${path}.stories`);
  let body: TabBody | undefined;
  if (raw.body === undefined) {
    bad(ctx, `${path}.body`, 'body is required', 'add a body');
  } else {
    body = parseTabBody(ctx, raw.body, `${path}.body`);
  }
  if (id === undefined || label === undefined || body === undefined) return undefined;
  return {
    id,
    label,
    ...(icon !== undefined ? { icon } : {}),
    ...(roleGate !== undefined ? { roleGate } : {}),
    ...(stories !== undefined ? { stories } : {}),
    body,
  };
}

/** Parse the OPTIONAL `stories: StoryRef[]` (each `{ epicId, storyId }`). Existence of the refs
 *  is a SEMANTIC check (needs the app's epics) — this is the structural shape only. */
function parseStories(ctx: Ctx, raw: unknown, path: string): StoryRef[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    bad(ctx, path, 'stories must be an array', 'remove stories or set a list of { epicId, storyId }');
    return undefined;
  }
  const out: StoryRef[] = [];
  raw.forEach((s, i) => {
    const sp = `${path}[${i}]`;
    if (!isObject(s)) {
      bad(ctx, sp, 'story ref must be an object', 'use { epicId, storyId }');
      return;
    }
    const epicId = reqString(ctx, s, 'epicId', `${sp}.epicId`);
    const storyId = reqString(ctx, s, 'storyId', `${sp}.storyId`);
    if (epicId !== undefined && storyId !== undefined) out.push({ epicId, storyId });
  });
  return out;
}

/**
 * Parse an untrusted input into an AppSpec (v2). On success returns the fully-typed spec; on
 * failure returns EVERY structural issue found (not just the first), each as a typed
 * `{ path, reason, fix }` so the caller can render actionable, per-field guidance.
 */
export function parseAppSpec(input: unknown): ParseResult {
  const ctx: Ctx = { issues: [] };

  if (!isObject(input)) {
    return {
      ok: false,
      issues: [{ path: '', reason: 'AppSpec must be an object', fix: 'provide an { version, name, description, tabs } object' }],
    };
  }

  if (input.version !== 2) {
    bad(ctx, 'version', `version must be the literal 2 (got ${JSON.stringify(input.version)})`, 'set version to 2');
  }
  const name = reqString(ctx, input, 'name', 'name');
  // Description is OPTIONAL metadata. The no-code composer exposes no description field, so a
  // functional app must NEVER be blocked on it (was: reqString → "description must not be empty").
  // Missing/non-string coerces to '' rather than failing the whole save.
  const rawDesc = input.description;
  const description = typeof rawDesc === 'string' ? rawDesc : '';

  // Optional app-wide theme CSS (applied scoped under the app root by the renderer).
  let theme: AppTheme | undefined;
  if (input.theme !== undefined) {
    if (!isObject(input.theme)) {
      bad(ctx, 'theme', 'theme must be an object', 'use { css } or remove theme');
    } else {
      const css = optBoundedString(ctx, input.theme, 'css', THEME_CSS_MAX, 'theme.css');
      if (css !== undefined) {
        // SECURITY: theme.css is injected same-origin into the trusted OS DOM via
        // <style dangerouslySetInnerHTML>. The HTML tokenizer ends a <style> at the first
        // `</style>` (even inside a CSS string/url()), so any `<`/`>` is a stored-XSS breakout
        // vector. Legit CSS never needs either, so BLOCK it here — a malicious theme never persists.
        if (css.includes('<') || css.includes('>')) {
          bad(ctx, 'theme.css', "CSS cannot contain '<' or '>'", "remove any '<' or '>' from theme.css");
        } else {
          theme = { css };
        }
      } else if (Object.keys(input.theme).length === 0) theme = {}; // empty theme is allowed
    }
  }

  const tabsRaw = reqArray(ctx, input, 'tabs', 'tabs');
  const tabs: Tab[] = [];
  if (tabsRaw) {
    tabsRaw.forEach((t, i) => {
      const tab = parseTab(ctx, t, `tabs[${i}]`);
      if (tab) tabs.push(tab);
    });
  }

  // OPTIONAL governed backend DSL functions (Phase 3.5d). Delegated to its own structural parser;
  // its typed issues are merged into the same result so authoring gets ONE issue list.
  const fnResult = parseFunctions(input.functions);
  const functions: AppFunction[] = fnResult.ok ? fnResult.functions : [];
  if (!fnResult.ok) ctx.issues.push(...fnResult.issues);

  if (ctx.issues.length > 0) return { ok: false, issues: ctx.issues };

  return {
    ok: true,
    spec: {
      version: 2,
      name: name!,
      description: description!,
      ...(theme !== undefined ? { theme } : {}),
      tabs,
      ...(functions.length > 0 ? { functions } : {}),
    },
  };
}

/** The structural schema surface, exported as a namespace-style object so callers can
 *  reference it as one unit (mirrors a Zod schema export) while the parser stays the gate.
 *  Note: `PATTERN_IDS` is deliberately NOT spread in here — it lives in `patterns.ts` and
 *  referencing it at this module's eval time would trip the schema↔patterns import cycle (TDZ).
 *  Import `PATTERN_IDS` from `./patterns.ts` directly when you need the id list. */
export const AppSpecSchema = {
  parse: parseAppSpec,
  FORMATS,
  CONTROLS,
  CHARTS,
  ROLE_GATES,
  FIELD_TYPES,
  BODY_KINDS,
} as const;
