/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    Lifecycle — Studio → Test → Run, the second axis beside audience (D30–D32)
 * USER STORY: As a builder I want to tell a draft apart from the thing that is running, and to
 *             go live with my OWN object without publishing it to my colleagues — so lifecycle
 *             (Draft · Testing · Live) must be a separate axis from audience (My · Domain ·
 *             Company), attached to a VERSION, and what operates must read a pin rather than
 *             "whatever the head happens to be".
 * ARCHITECTURE:
 *   - PURE and import-free (no server-only, no Next, no tab imports) so both the client badges
 *     and the server go-live service share one source of truth, and every rule is unit-testable.
 *   - Total over every kind: {@link lifecycleOf} never throws and always returns a well-formed
 *     `{ draft, testing?, live? }`. An unknown kind or an object with no pin is a Draft on head.
 *   - The two axes are INDEPENDENT by construction: nothing here derives one from the other.
 *     `audienceOfTier` translates an existing persisted tier for DISPLAY only; it is never an
 *     input to any lifecycle function, and no lifecycle value is ever an input to audience.
 *   - The go-live guard is ONE function over an already-resolved dependency list, so the per-kind
 *     adapters decide WHAT the dependencies are and this file decides whether they allow go-live.
 *   - Vocabulary is closed at three lifecycle words and three audience words (the simplicity
 *     contract). `LIFECYCLE_FALLBACK_WORDS` is the documented Draft/Live fallback.
 */

// --------------------------------------------------------------- vocabulary ---

/** The THREE lifecycle words. Closed set — a fourth noun fails the simplicity contract. */
export const LIFECYCLE_WORDS = ['draft', 'testing', 'live'] as const;
export type LifecycleWord = (typeof LIFECYCLE_WORDS)[number];

/** The Draft/Live fallback the simplicity contract allows if Testing is dropped. */
export const LIFECYCLE_FALLBACK_WORDS: readonly LifecycleWord[] = ['draft', 'live'];

/** The THREE audience words — unchanged by this programme, listed here only to label a badge. */
export const AUDIENCE_WORDS = ['my', 'domain', 'company'] as const;
export type AudienceWord = (typeof AUDIENCE_WORDS)[number];

/** User-facing lifecycle labels. Exactly three, identical across every kind. */
export const LIFECYCLE_LABELS: Record<LifecycleWord, string> = {
  draft: 'Draft',
  testing: 'Testing',
  live: 'Live',
};

/** User-facing audience labels — the locked scope vocabulary (core/kernel/scopes.ts). */
export const AUDIENCE_LABELS: Record<AudienceWord, string> = {
  my: 'My',
  domain: 'Domain',
  company: 'Company',
};

/**
 * The two SURFACES the shell header toggles between. Studio shows drafts, what is in testing
 * and live objects FOR EDITING; Run shows only live artefacts, for operating and consuming.
 */
export const VIEW_SURFACES = ['studio', 'run'] as const;
export type ViewSurface = (typeof VIEW_SURFACES)[number];

export const VIEW_SURFACE_LABELS: Record<ViewSurface, string> = {
  studio: 'Studio',
  run: 'Run',
};

/**
 * Every kind the lifecycle is total over. The same seven objects the audience ladder covers.
 * `app` is Software's app; `agent` is an agent system (the tool-native noun is a LangGraph
 * StateGraph, which is what a pinned `system.yaml` compiles to).
 */
export const LIFECYCLE_KINDS = [
  'dataset',
  'metric',
  'dashboard',
  'agent',
  'app',
  'knowledge',
  'connection',
] as const;
export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];

export function isLifecycleKind(v: unknown): v is LifecycleKind {
  return typeof v === 'string' && (LIFECYCLE_KINDS as readonly string[]).includes(v);
}

export function isLifecycleWord(v: unknown): v is LifecycleWord {
  return typeof v === 'string' && (LIFECYCLE_WORDS as readonly string[]).includes(v);
}

export function isViewSurface(v: unknown): v is ViewSurface {
  return typeof v === 'string' && (VIEW_SURFACES as readonly string[]).includes(v);
}

// ------------------------------------------------------------------- model ---

/**
 * The lifecycle of ONE object, attached to versions rather than to the object:
 *   • `draft`   — the head. Always present: an object always has something you can edit.
 *   • `testing` — the ref a test is running against right now. NOT a managed state: it is set
 *                 while "run / build / preview the draft from Studio" is in flight and cleared
 *                 when it settles. There is nothing to administer.
 *   • `live`    — the PIN. A commit sha, or a tag (`live/<kind>/<id>`; for apps the SemVer
 *                 release tag). Absent ⇒ the object is not running and Run does not show it.
 */
export type Lifecycle = {
  draft: string;
  testing?: string;
  live?: string;
};

/** One recorded pin — what is live, since when, and who put it there. */
export type Pin = {
  /** The pinned ref: a commit sha, or a tag name. Opaque to this module. */
  ref: string;
  /** ISO timestamp the pin was set. */
  at: string;
  /** The principal that went live. */
  by: string;
  /** The domain whose repo carries the tag + `os/lifecycle.yml` entry. */
  domain: string;
};

/** The in-flight test marker — a ref being exercised from Studio, never a managed state. */
export type TestMarker = { ref: string; at: string };

/**
 * The whole pin index, keyed by {@link pinKey}. This is the shape `os/lifecycle.yml` carries
 * and the shape the durable store hydrates into — complexity lives HERE, where nobody looks.
 */
export type LifecycleIndex = {
  pins: Record<string, Pin>;
  tests?: Record<string, TestMarker>;
};

export const EMPTY_LIFECYCLE_INDEX: LifecycleIndex = { pins: {} };

/** `dashboard:dash_7` — the one key shape for a pin, used by the store and the yml alike. */
export function pinKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/** Split a pin key back into its halves. Returns null on anything malformed. */
export function parsePinKey(key: string): { kind: LifecycleKind; id: string } | null {
  const i = String(key ?? '').indexOf(':');
  if (i <= 0) return null;
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  if (!isLifecycleKind(kind) || !id) return null;
  return { kind, id };
}

/** The git tag a live pin carries. Apps pin their SemVer release tag instead (D31). */
export function liveTagName(kind: string, id: string): string {
  return `live/${kind}/${id}`;
}

/**
 * The lifecycle of one object. TOTAL: every kind, every id, every index — including an unknown
 * kind, a missing index and an empty head — yields a well-formed value and never throws.
 *
 * `head` is the object's current editable ref (a sha for a git-backed kind, `v<n>` for a
 * version-log-backed one). An empty head still produces a Draft, because "there is something
 * to edit" is true even before the first commit lands.
 */
export function lifecycleOf(
  kind: string,
  id: string,
  head: string,
  index: LifecycleIndex = EMPTY_LIFECYCLE_INDEX,
): Lifecycle {
  const key = pinKey(kind, id);
  const draft = typeof head === 'string' && head ? head : 'unversioned';
  const out: Lifecycle = { draft };
  const test = index.tests?.[key];
  if (test?.ref) out.testing = test.ref;
  const pin = index.pins?.[key];
  if (pin?.ref) out.live = pin.ref;
  return out;
}

/**
 * The ONE word a badge shows. Live wins over Testing wins over Draft, because the question a
 * tile answers is "is this running?" first. A live object whose draft has moved on is still
 * Live — that is the point of a pin, and the detail header shows the draft beside it.
 */
export function lifecycleWordOf(l: Lifecycle): LifecycleWord {
  if (l.live) return 'live';
  if (l.testing) return 'testing';
  return 'draft';
}

/** The badge label for an object's lifecycle. */
export function lifecycleLabelOf(l: Lifecycle): string {
  return LIFECYCLE_LABELS[lifecycleWordOf(l)];
}

/** Is the live pin behind the draft — i.e. are there unpublished edits? */
export function hasUnpublishedEdits(l: Lifecycle): boolean {
  return Boolean(l.live) && l.live !== l.draft;
}

/** Only live artefacts appear in Run. Studio shows everything, including live, for editing. */
export function visibleOnSurface(l: Lifecycle, surface: ViewSurface): boolean {
  return surface === 'run' ? Boolean(l.live) : true;
}

// ---------------------------------------------------------------- audience ---

/**
 * Translate a persisted tier/visibility value to its audience word, for the badge only.
 * Every tab spells its tier differently (`personal`/`dataset`/`Personal`,
 * `domain`/`asset`/`Shared`, `marketplace`/`product`/`Certified`); this is the one map.
 *
 * DISPLAY ONLY. No lifecycle function takes an audience, and this function takes no lifecycle —
 * that independence is what D30 is about and what `object-lifecycle.test.ts` tripwires.
 */
export function audienceOfTier(tier: string): AudienceWord {
  const t = String(tier ?? '').toLowerCase();
  if (t === 'marketplace' || t === 'product' || t === 'certified' || t === 'company') return 'company';
  if (t === 'domain' || t === 'asset' || t === 'shared') return 'domain';
  return 'my';
}

/** The badge label for an object's audience. */
export function audienceLabelOf(tier: string): string {
  return AUDIENCE_LABELS[audienceOfTier(tier)];
}

/** The two badges a tile and a detail header carry — and nothing else new on screen. */
export type Badges = {
  lifecycle: { word: LifecycleWord; label: string };
  audience: { word: AudienceWord; label: string };
};

export function badgesFor(l: Lifecycle, tier: string): Badges {
  const word = lifecycleWordOf(l);
  const aud = audienceOfTier(tier);
  return {
    lifecycle: { word, label: LIFECYCLE_LABELS[word] },
    audience: { word: aud, label: AUDIENCE_LABELS[aud] },
  };
}

// ------------------------------------------------------------- go-live guard ---

/** One dependency of the object being taken live, already resolved by its kind's adapter. */
export type LifecycleDependency = {
  kind: LifecycleKind;
  id: string;
  /** Human name for the refusal message — the user must be able to go and fix it. */
  name: string;
  /** The dependency's OWN lifecycle. The guard is about lifecycle, never audience. */
  lifecycle: Lifecycle;
};

export type GoLiveDecision =
  | { ok: true }
  | {
      ok: false;
      /** A readable refusal that NAMES the offending dependency. */
      reason: string;
      blocking: { kind: LifecycleKind; id: string; name: string; lifecycle: LifecycleWord };
    };

/**
 * THE go-live guard, one implementation for every kind: an object may go live only if its
 * dependencies are LIVE. Not "at the same audience" — a Live `My` metric is a perfectly good
 * dependency for a Live `My` dashboard (V-R3.3).
 *
 * The first non-live dependency, in the order the adapter returned them, is the one named.
 */
export function goLiveGuard(deps: readonly LifecycleDependency[]): GoLiveDecision {
  for (const d of deps ?? []) {
    const word = lifecycleWordOf(d.lifecycle);
    if (word === 'live') continue;
    return {
      ok: false,
      reason:
        `cannot go live: ${d.kind} “${d.name}” (${d.id}) is ${LIFECYCLE_LABELS[word]}, not Live. ` +
        `Take it live first, then try again.`,
      blocking: { kind: d.kind, id: d.id, name: d.name, lifecycle: word },
    };
  }
  return { ok: true };
}

// ------------------------------------------------------------ confirm copy ---

/**
 * The ONE confirm dialog's text. It must state WHAT STARTS RUNNING — the schedule, the URL,
 * the consumers — which is why the adapter hands us `consequences` in the tool's own words.
 */
export function goLiveConfirmCopy(
  kind: LifecycleKind,
  name: string,
  ref: string,
  consequences: readonly string[],
): { title: string; body: string; confirmLabel: string } {
  const what = consequences.length
    ? ` From then on: ${consequences.join('; ')}.`
    : ' Nothing is scheduled for it yet, so going live only makes it visible in Run.';
  return {
    title: `Go live with “${name}”?`,
    body: `Run will serve ${kind} “${name}” at ${shortRef(ref)} until you go live again or retire it.${what} Editing it afterwards creates a new draft and does not change what Run shows.`,
    confirmLabel: 'Go live',
  };
}

/** Retire unpins; it deletes nothing. The copy has to say so, or nobody will click it. */
export function retireConfirmCopy(
  kind: LifecycleKind,
  name: string,
): { title: string; body: string; confirmLabel: string } {
  return {
    title: `Retire “${name}”?`,
    body: `Run stops serving ${kind} “${name}”. Nothing is deleted — the draft, its history and every version stay exactly as they are, and you can go live again at any time.`,
    confirmLabel: 'Retire',
  };
}

/** A sha shortened for prose; a tag or a version label is left alone. */
export function shortRef(ref: string): string {
  const r = String(ref ?? '');
  return /^[0-9a-f]{40}$/.test(r) ? r.slice(0, 7) : r || 'its current draft';
}

// --------------------------------------------------------------- migration ---

/**
 * V-R5.1 — the migration. Every object that exists on the day this ships becomes LIVE, pinned
 * at its own head, so the Run view on day one is exactly today's screens. Objects created
 * afterwards start as Draft and are absent from Run until someone goes live (V-R5.2).
 *
 * Pure: it takes the existing objects and returns the index to persist. Idempotent — an object
 * that already carries a pin keeps the pin it has, so re-running the migration never re-pins a
 * retired object back to life.
 */
export function migrateExistingToLive(
  existing: readonly { kind: LifecycleKind; id: string; head: string; domain: string }[],
  at: string,
  by = 'migration',
  index: LifecycleIndex = EMPTY_LIFECYCLE_INDEX,
): LifecycleIndex {
  const pins: Record<string, Pin> = { ...index.pins };
  for (const o of existing ?? []) {
    const key = pinKey(o.kind, o.id);
    if (pins[key]) continue;
    pins[key] = { ref: o.head || 'unversioned', at, by, domain: o.domain };
  }
  return index.tests ? { pins, tests: index.tests } : { pins };
}

// ------------------------------------------------------------------ filter ---

/**
 * The OPTIONAL `lifecycle` filter, applied in one place. `undefined` means "the caller's current
 * view semantics", which for every existing client is "everything" — so an existing client sees
 * exactly what it saw before (V-R5.3). No new required argument anywhere.
 */
export function filterByLifecycle<T>(
  rows: readonly T[],
  want: LifecycleWord | undefined,
  lifecycleOfRow: (row: T) => Lifecycle,
): T[] {
  if (!want) return [...(rows ?? [])];
  return (rows ?? []).filter((r) => lifecycleWordOf(lifecycleOfRow(r)) === want);
}

// -------------------------------------------------- tool attribution (V-US4) ---

/**
 * The lifecycle a RUN happens in, as the underlying tools spell it: LiteLLM carries the tag
 * `env:studio|test|run` and Langfuse sets the trace `environment` to the same word. Deliberately
 * NOT a fourth noun on screen — these are the tools' own fields, invisible in the UI.
 */
export const RUN_ENVS = ['studio', 'test', 'run'] as const;
export type RunEnv = (typeof RUN_ENVS)[number];

/** Studio edits the head; a test runs the draft; the schedule and Run serve the pin. */
export function runEnvOf(word: LifecycleWord): RunEnv {
  return word === 'live' ? 'run' : word === 'testing' ? 'test' : 'studio';
}

/**
 * Per-lifecycle budgets, in LiteLLM key metadata, so a draft cannot drain what is running.
 * The numbers are a ratio of the key's own budget rather than absolute euros, because the
 * absolute cap is a platform setting and this module must stay pure.
 */
export const LIFECYCLE_BUDGET_SHARE: Record<RunEnv, number> = {
  studio: 0.2,
  test: 0.2,
  run: 1,
};

/** The metadata block a LiteLLM key carries so the gateway enforces the share above. */
export function lifecycleBudgetMetadata(env: RunEnv, keyBudget: number): Record<string, unknown> {
  const share = LIFECYCLE_BUDGET_SHARE[env];
  const max = Math.round(keyBudget * share * 100) / 100;
  return { os_env: env, os_env_budget_share: share, max_budget: max };
}
