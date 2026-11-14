/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       mcp
 * FEATURE:    The ONE central lifecycle filter for every list_* tool
 * USER STORY: As an AI client I want to ask "show me only what is live" on any list tool, with
 *             the same argument name and the same three words everywhere — and as an EXISTING
 *             client I want to send exactly what I sent yesterday and get exactly what I got.
 * ARCHITECTURE:
 *   - ONE helper, a one-line integration per tool (simplicity contract §4). `withLifecycleArg`
 *     adds the optional property to a tool's schema; `lifecycleView` annotates and filters the
 *     payload. A tool's own handler is unchanged apart from being wrapped.
 *   - The argument is OPTIONAL and its absence means "everything", which is precisely today's
 *     behaviour — so no existing client sees a different answer and no required argument is
 *     added anywhere (V-R5.3).
 *   - Shape-agnostic on purpose: the list tools return either a flat array or the scope-grouped
 *     `{ mine, domain, marketplace }` payload the stores produce. One walker handles both, and
 *     for a grouped payload the GROUP KEY is the audience, which is where that word already
 *     lives — no tab had to grow a new field.
 *   - `lifecycle` and `audience` are added to every row, never substituted for anything: a row
 *     that already carries a `tier`/`visibility` keeps it.
 *   - An unknown `lifecycle` value is a typed `bad_request` naming the three words, so the
 *     error shape the registry-wide conformance test pins is unchanged.
 */
import 'server-only';

import type { JsonSchema } from '@core/mcp/server';
import {
  LIFECYCLE_WORDS,
  LIFECYCLE_KINDS,
  audienceOfTier,
  isLifecycleWord,
  lifecycleOf,
  lifecycleWordOf,
  type AudienceWord,
  type LifecycleKind,
  type LifecycleWord,
} from '@core/kernel/object-lifecycle';
import { lifecycleIndex } from '@core/infra/lifecycle-pins';

/** The optional property every artifact list tool advertises. */
export const LIFECYCLE_PROP = {
  type: 'string',
  enum: [...LIFECYCLE_WORDS],
  description:
    'OPTIONAL. Show only objects at this point of their life: `draft` (being built), `testing` (a draft being tried out right now) or `live` (the version the OS runs). Omit to see everything, which is the default and what every existing caller gets. This is INDEPENDENT of My · Domain · Company, which says who may use an object rather than which version runs.',
};

/**
 * Add the optional `lifecycle` property to a tool's schema without touching anything else —
 * same `required`, same examples, plus one worked example for the new argument.
 */
export function withLifecycleArg(schema: JsonSchema): JsonSchema {
  const examples = Array.isArray(schema.examples) ? schema.examples : [];
  const base = (examples[0] ?? {}) as Record<string, unknown>;
  return {
    ...schema,
    properties: { ...(schema.properties ?? {}), lifecycle: LIFECYCLE_PROP },
    examples: [...examples, { ...base, lifecycle: 'live' }],
  };
}

/** Parse the optional argument. Unknown value ⇒ a 400 that names the three words. */
export function lifecycleArg(args: Record<string, unknown> | undefined): LifecycleWord | undefined {
  const raw = args?.lifecycle;
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (!isLifecycleWord(raw)) {
    const e = new Error(
      `\`lifecycle\` must be one of: ${LIFECYCLE_WORDS.join(', ')} — or omit it to see everything`,
    ) as Error & { status: number };
    e.status = 400;
    throw e;
  }
  return raw;
}

/** The scope-grouped payload shape the stores return. */
const GROUP_TIERS: Record<string, string> = { mine: 'personal', domain: 'domain', marketplace: 'marketplace' };

type Row = Record<string, unknown>;

function isRow(v: unknown): v is Row {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The tier a row carries, falling back to the group it was listed under.
 *
 * Review L-4: `status` is NOT a tier on any store — an app's `status` is its deploy state and a
 * knowledge process's is its publish state — so reading it here would have mapped `archived` or
 * `draft` onto the audience axis. Only the two real tier fields are consulted, and the group key
 * (which is always correct for a grouped payload) is the fallback.
 */
function tierOf(row: Row, groupTier: string): string {
  const t = row.tier ?? row.visibility;
  return typeof t === 'string' && t ? t : groupTier;
}

/**
 * Review L-5: a row's id is `id`, or the one alternative key each store genuinely uses as its
 * identity (`metricId`/`member` for a metric member, `slug` for an app). `name` is deliberately
 * NOT in the list: a display name is not an identity, and falling back to it would have looked up
 * a pin under a string that can change and collide.
 */
function idOf(row: Row): string {
  for (const k of ['id', 'metricId', 'member', 'slug']) {
    const v = row[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/**
 * Annotate (and optionally filter) a list payload. The ONE place `lifecycle` and `audience`
 * are added to a result, so the fields cannot drift between tools.
 *
 * `head` is deliberately NOT resolved per row: a list is a cheap read, and the only thing a
 * list needs to know is whether a row has a pin. A row's own draft ref belongs on its detail
 * page, where `get_*` resolves it.
 */
export async function lifecycleView<T>(
  kind: LifecycleKind,
  args: Record<string, unknown> | undefined,
  payload: T | Promise<T>,
): Promise<T> {
  const want = lifecycleArg(args);
  const resolved = await payload;
  const index = await lifecycleIndex();

  const annotate = (row: unknown, groupTier: string): Row | null => {
    if (!isRow(row)) return null;
    const id = idOf(row);
    const life = lifecycleOf(kind, id, 'unversioned', index);
    const lifecycle: LifecycleWord = lifecycleWordOf(life);
    const audience: AudienceWord = audienceOfTier(tierOf(row, groupTier));
    if (want && lifecycle !== want) return null;
    return { ...row, lifecycle, audience };
  };

  const mapList = (list: unknown[], groupTier: string): Row[] =>
    list.map((r) => annotate(r, groupTier)).filter((r): r is Row => r !== null);

  if (Array.isArray(resolved)) return mapList(resolved, 'personal') as unknown as T;
  if (!isRow(resolved)) return resolved;

  const out: Row = { ...resolved };
  let touched = false;
  for (const [group, groupTier] of Object.entries(GROUP_TIERS)) {
    const list = out[group];
    if (Array.isArray(list)) {
      out[group] = mapList(list, groupTier);
      touched = true;
    }
  }
  // A single-object payload (not a list and not grouped) is annotated as one row.
  if (!touched) return (annotate(resolved, 'personal') ?? resolved) as unknown as T;
  return out as unknown as T;
}

/**
 * The list tools that are NOT about a lifecycle-bearing object, and therefore do not take the
 * filter. Each is here for a stated reason, so a reviewer can disagree with the reason rather
 * than wonder whether it was forgotten. The conformance extension asserts this list and the
 * registry agree, which is what stops a new artifact list tool quietly skipping the filter.
 */
export const LIST_TOOLS_WITHOUT_LIFECYCLE: Readonly<Record<string, string>> = {
  list_capabilities: 'the tool catalogue, not objects',
  list_runs: 'an agent run is an event, not a version that can be pinned',
  list_approvals: 'a promotion request lives on the AUDIENCE axis',
  list_operating_manual_versions: 'the manual has its own version ladder',
  list_connection_templates: 'a template is a catalogue entry, not an object you own',
  list_exposure_sets: 'a grant on a connection, not an artifact with a draft',
  list_exposed_tables: 'upstream tables, discovered rather than authored',
  list_adoptable_actions: 'upstream actions, discovered rather than authored',
  list_files: 'a file has no versioned definition to pin — it IS its bytes',
};

/** The kinds a list tool may annotate — the same seven the model is total over. */
export const LIFECYCLE_LIST_KINDS: readonly LifecycleKind[] = LIFECYCLE_KINDS;
