/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import yaml from 'js-yaml';

/**
 * `workflow.md` — the SINGLE source of truth for a knowledge workflow (Knowledge
 * tab). Each workflow lives as one markdown file with YAML frontmatter + fenced
 * `step` blocks. Pure module — no server-only imports, no network — shared by the
 * editor, the swimlane canvas, the Mermaid renderer, the store, and unit tests.
 *
 * Format:
 *
 *   ---
 *   id: bank-submission
 *   title: Bank Submission
 *   domain: sales
 *   visibility: Personal
 *   status: draft
 *   version: "1"
 *   rules:
 *     - {id: r1, text: "Quality over speed", hard: false, scope: workflow}
 *   ---
 *
 *   ```step
 *   id: prepare-documents
 *   title: Prepare Documents
 *   actor: Human
 *   actor_name: Loan Officer
 *   inputs: [Customer application form]
 *   outputs: [Document package]
 *   links:
 *     - {type: data, ref: "sales.gold.customer_applications", label: Customer Applications}
 *   rules:
 *     - {id: sr1, text: "All fields required", hard: false}
 *   ```
 *
 *   > tacit: Check section 4 — the date field is frequently missed.
 *
 * General domain knowledge is stored as a separate `DomainKnowledge` object with
 * seven guided sections (general / strategy / business / organization / architecture / data / glossary).
 */

export type Visibility = 'Personal' | 'Shared' | 'Marketplace';
export type WorkflowStatus = 'draft' | 'live';
/**
 * Five actor categories. `Customer` and `Partner` are EXTERNAL actors (outside
 * the organisation) — the swimlane renders their lanes visually distinct.
 */
export type ActorType = 'Human' | 'Software' | 'Agent' | 'Customer' | 'Partner';
export type LinkType = 'data' | 'app' | 'agent' | 'file';

/** Actor categories that live outside the organisation. */
export const EXTERNAL_ACTORS: ActorType[] = ['Customer', 'Partner'];

/**
 * A first-class actor in the workflow's registry — a named, described entity.
 * Steps reference an actor by its (category, name); the registry lets each actor
 * carry a description and be picked from a dropdown rather than free-typed.
 */
export type Actor = {
  id?: string;
  name: string;
  category: ActorType;
  description?: string;
  /**
   * The actor's LONG agent prompt (markdown, multi-line). It is the head of the
   * `AGENT.md` the agent system scaffolded from this workflow carries, with the
   * actor's steps compiled in beneath it (`lib/actor-prompt.ts`).
   *
   * Only an `Agent` actor is OFFERED one in the editor, but the model parses and
   * serializes it for every category: dropping the prompt when the category changed
   * would silently destroy the author's work on a mis-click.
   */
  prompt?: string;
  /**
   * Set by a READ path (`parseActor`, an OKF import) when the stored prompt was over
   * {@link MAX_ACTOR_PROMPT_BYTES} and had to be truncated: the original byte length, so the
   * editor can tell the author what happened (`actor-prompt.ts` → `promptWarnings`).
   *
   * EDITOR-ONLY state — `serializeWorkflow` never writes it. A read path truncates rather
   * than throwing, because a workflow that cannot be opened is worse than a bounded prompt
   * the author is told about; the WRITE paths still refuse an over-cap prompt outright.
   */
  promptTruncatedFrom?: number;
};

export type StepLink = {
  type: LinkType;
  ref: string;
  label?: string;
};

export type StepRule = {
  id: string;
  text: string;
  hard: boolean;
};

export type WorkflowStep = {
  id: string;
  title: string;
  actor: ActorType;
  actor_name: string;
  inputs: string[];
  outputs: string[];
  links: StepLink[];
  rules: StepRule[];
  /** Inline tacit note from `> tacit:` blockquote after the step block. */
  tacit: string;
};

export type WorkflowRule = {
  id: string;
  text: string;
  hard: boolean;
  /** 'workflow' = applies to the whole workflow; 'step' = per-step guardrail. */
  scope: 'workflow' | 'step';
  step_id?: string;
};

export type WorkflowMeta = {
  id: string;
  title: string;
  domain: string;
  visibility: Visibility;
  status: WorkflowStatus;
  version: string;
  /** Workflow-level decision rules (soft + hard). */
  rules: WorkflowRule[];
  /**
   * The workflow's actor registry — first-class described actors. Derived from
   * the steps' distinct (category, name) pairs on load when no `actors:` section
   * is present, so old workflows gain a registry for free (back-compat).
   */
  actors: Actor[];
};

export type Workflow = WorkflowMeta & {
  steps: WorkflowStep[];
  /** Raw markdown body (after frontmatter). Round-tripped unchanged when steps aren't touched. */
  body: string;
};

/** General domain knowledge — the pinned operating-model card; base context for every domain agent. */
export type DomainSectionId =
  | 'general'
  | 'strategy'
  | 'business'
  | 'organization'
  | 'architecture'
  | 'data'
  | 'glossary'
  // Legacy section ids — carried forward during migration, never created fresh.
  | 'overview'
  | 'goals'
  | 'context';

export type DomainSection = {
  id: DomainSectionId;
  title: string;
  content: string;
};

export type DomainKnowledge = {
  domain: string;
  sections: DomainSection[];
  updatedAt: string;
};

/** Validation / parse error; carries an HTTP-friendly status. */
export class KnowledgeError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'KnowledgeError';
    this.status = status;
  }
}

// ---------------------------------------------------------------- constants ---

export const ACTOR_TYPES: ActorType[] = ['Human', 'Software', 'Agent', 'Customer', 'Partner'];
const LINK_TYPES: LinkType[] = ['data', 'app', 'agent', 'file'];
const VISIBILITIES: Visibility[] = ['Personal', 'Shared', 'Marketplace'];
const STATUSES: WorkflowStatus[] = ['draft', 'live'];

// ----------------------------------------------------------- helpers ---------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strArray(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') return v ? [v] : [];
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter(Boolean);
}

function parseLink(raw: unknown): StepLink | null {
  if (!isRecord(raw)) return null;
  const type = String(raw.type ?? '') as LinkType;
  if (!LINK_TYPES.includes(type)) return null;
  const ref = String(raw.ref ?? '').trim();
  if (!ref) return null;
  const link: StepLink = { type, ref };
  if (typeof raw.label === 'string' && raw.label.trim()) link.label = raw.label.trim();
  return link;
}

function parseStepRule(raw: unknown): StepRule | null {
  if (!isRecord(raw)) return null;
  const id = String(raw.id ?? '').trim();
  const text = String(raw.text ?? '').trim();
  if (!id || !text) return null;
  return { id, text, hard: Boolean(raw.hard) };
}

function parseWorkflowRule(raw: unknown): WorkflowRule | null {
  if (!isRecord(raw)) return null;
  const id = String(raw.id ?? '').trim();
  const text = String(raw.text ?? '').trim();
  if (!id || !text) return null;
  const scope = raw.scope === 'step' ? 'step' : 'workflow';
  const rule: WorkflowRule = { id, text, hard: Boolean(raw.hard), scope };
  if (scope === 'step' && typeof raw.step_id === 'string') rule.step_id = raw.step_id;
  return rule;
}

function parseActor(raw: unknown): Actor | null {
  if (!isRecord(raw)) return null;
  const name = String(raw.name ?? '').trim();
  const category = String(raw.category ?? '') as ActorType;
  if (!name || !ACTOR_TYPES.includes(category)) return null;
  const actor: Actor = { name, category };
  const id = String(raw.id ?? '').trim();
  if (id) actor.id = id;
  const description = String(raw.description ?? '').trim();
  if (description) actor.description = description;
  // Normalised on the way in AND written normalised on the way out, so a save is a fixed
  // point rather than a file that grows a newline per round trip. This is a READ path, so an
  // over-cap prompt is TRUNCATED and marked (a workflow that cannot be opened is worse than
  // a bounded prompt the author is told about); every write path refuses one outright.
  const { prompt, truncatedFrom } = readActorPrompt(String(raw.prompt ?? ''));
  if (prompt) actor.prompt = prompt;
  if (truncatedFrom !== undefined) actor.promptTruncatedFrom = truncatedFrom;
  return actor;
}

/**
 * The cap on an actor's long `prompt`: 64 KiB. It bounds what the OS puts in front of a
 * model and commits into a `system.yaml`, so it is enforced at EVERY inlet — `parseActor`
 * (a hand-edited or OKF-imported file), `serializeWorkflow` (the editor's commit, where the
 * user can still see their draft), the `step-edit` mutations and the MCP `mapActors` —
 * rather than only wherever the UI happens to type.
 */
export const MAX_ACTOR_PROMPT_BYTES = 64 * 1024;

/**
 * Normalise an actor prompt to exactly what the file keeps: CRLF/CR → LF (so `js-yaml`
 * writes a readable `|-` block scalar instead of a quoted string full of `\r\n`), trimmed
 * at both ends, and bounded by {@link MAX_ACTOR_PROMPT_BYTES}.
 *
 * TRIMMED-LOSSLESS, to be precise: nothing inside the prompt is altered — only the line
 * endings and the surrounding blank space, neither of which a round trip could preserve.
 */
export function normalizeActorPrompt(name: string, raw: string): string {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_ACTOR_PROMPT_BYTES) {
    throw new KnowledgeError(
      `actor '${name}': prompt is ${bytes} bytes, over the 64 KiB cap (${MAX_ACTOR_PROMPT_BYTES} bytes)`,
    );
  }
  return text;
}

/**
 * The READ half of the same rule, for a document that already exists: the same
 * normalisation, but an over-cap prompt is TRUNCATED to the cap and the original byte
 * length is reported, instead of throwing.
 *
 * Why not throw: `parseActor` runs on every load, so a throw would make a stored workflow
 * unopenable — the author could not even shorten the prompt that wedged it. A bounded
 * prompt plus a warning the editor shows (`actor-prompt.ts` → `promptWarnings`) keeps the
 * document editable and keeps the truncation visible, which is the rule a fallback has to
 * obey: never substitute data silently. Writes still refuse (see {@link normalizeActorPrompt}).
 *
 * The cut is made on the decoded string, so it can never split a codepoint.
 */
export function readActorPrompt(raw: string): { prompt: string; truncatedFrom?: number } {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  const encoder = new TextEncoder();
  const total = encoder.encode(text).length;
  if (total <= MAX_ACTOR_PROMPT_BYTES) return { prompt: text };
  // Codepoint by codepoint (`Array.from`, not `slice`): a byte-wise cut can split a
  // surrogate pair, and half a codepoint encodes back as U+FFFD — a visible corruption.
  const kept: string[] = [];
  let size = 0;
  for (const ch of Array.from(text)) {
    const n = encoder.encode(ch).length;
    if (size + n > MAX_ACTOR_PROMPT_BYTES) break;
    size += n;
    kept.push(ch);
  }
  return { prompt: kept.join(''), truncatedFrom: total };
}

/**
 * The identity of an actor REFERENCE on a step: its (category, name) pair.
 * Interior whitespace is collapsed as well as trimmed, so a hand-typed
 * `actor_name: "Loan  Officer"` still resolves to the registry's `Loan Officer`
 * (otherwise it reads as an unknown actor and a rename never reaches it).
 */
export const actorKey = (category: ActorType, name: string) =>
  `${category}::${name.trim().replace(/\s+/g, ' ').toLowerCase()}`;

/**
 * A deterministic id for an actor that arrives without one (a legacy file's derived
 * entry, or a hand-written `actors:` row). Deterministic matters: the id is written
 * back on the next serialize, so a non-stable id would churn the file on every load
 * and a serialize → parse round trip would never be a fixed point.
 */
export function stableActorId(category: ActorType, name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
  return `actor-${category.toLowerCase()}-${slug}`;
}

/**
 * Fill in a missing id so EVERY registry actor is addressable (and therefore deletable),
 * and make the ids UNIQUE: `Loan Officer` and `Loan-Officer` slugify to the same string,
 * and one id addressing two actors means a delete removes both, the inspector always
 * opens the first, and React sees duplicate keys. A clash is suffixed `-2`, `-3`, …
 */
export function withActorIds(actors: Actor[]): Actor[] {
  const taken = new Set<string>();
  return actors.map((a) => {
    const base = a.id?.trim() || stableActorId(a.category, a.name);
    let id = base;
    let n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    taken.add(id);
    return a.id === id ? a : { ...a, id };
  });
}

/**
 * Derive an actor registry from the steps' distinct (category, name) pairs, merged
 * behind any explicitly-declared actors (those keep their description). This is the
 * AUTHORING helper — it is what the MCP `author_knowledge` path wants, where actors
 * implied by the submitted steps should be registered.
 *
 * It is NOT what loading a stored workflow does: see {@link resolveActorRegistry}.
 * Merging on every parse is what used to resurrect a deleted actor.
 */
export function deriveActors(steps: WorkflowStep[], declared: Actor[] = []): Actor[] {
  const out: Actor[] = [];
  const seen = new Set<string>();
  for (const a of declared) {
    const key = actorKey(a.category, a.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  for (const s of steps) {
    const name = s.actor_name.trim();
    if (!name) continue; // unnamed steps don't seed a registry entry
    const key = actorKey(s.actor, name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, category: s.actor });
  }
  return withActorIds(out);
}

/**
 * The registry of a STORED workflow. Once an `actors:` section exists it is the
 * source of truth — even when it is empty, which is how "I deleted the last actor"
 * is expressed. Only a legacy file with no `actors:` section at all derives its
 * registry from the steps (and that derivation is written back on the next save).
 *
 * A step naming an actor the registry does not hold is a validation warning
 * (`actor-registry.ts` → `actorWarnings`), never a re-added registry entry.
 */
export function resolveActorRegistry(steps: WorkflowStep[], declared: Actor[] | undefined): Actor[] {
  if (declared === undefined) return deriveActors(steps);
  const out: Actor[] = [];
  const seen = new Set<string>();
  for (const a of declared) {
    const key = actorKey(a.category, a.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return withActorIds(out);
}

// ------------------------------------------------------ step block parse -----

/**
 * Read a step's `> tacit:` note out of the text that follows its fence.
 *
 * A LINE SCAN, deliberately, and symmetric with {@link serializeTacit}, which writes
 * `> tacit:` on every line:
 *   - the note starts at the first line matching `> tacit:` and runs for as long as
 *     the blockquote does (every consecutive line starting `>`);
 *   - markdown's own LAZY CONTINUATION is honoured: a hand-written note whose second
 *     line has no `>` is still part of the blockquote, so it is kept rather than
 *     deleted by the next commit. A blank line, a fence, a `---` or a heading ends it;
 *   - each line sheds its `>` + one space, then an optional `tacit:` + one space.
 *
 * The two defects this replaces: a regex that stripped only `> ` grew a literal
 * `tacit: ` prefix on every continuation line each round trip, and its lookahead
 * (`\n```` ` / `\n---`) truncated any note containing a fence or a `---` line. In a
 * blockquote both are ordinary `> `-prefixed lines, so neither can end the note.
 */
function parseTacit(after: string): string {
  const lines = after.split('\n');
  const start = lines.findIndex((l) => /^\s*>\s*tacit:/.test(l));
  if (start < 0) return '';
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*>/.test(line)) {
      // Lazy continuation: unquoted prose directly under the blockquote belongs to it.
      // A blank line, a fence, a thematic break or a heading closes the paragraph.
      const closes = line.trim() === '' || /^\s*(```|---|#)/.test(line);
      if (closes) break;
      out.push(line.trim());
      continue;
    }
    out.push(line.replace(/^\s*>\s?/, '').replace(/^tacit:[ \t]?/, ''));
  }
  // Trim blank lines at the edges but keep the note's own interior line breaks.
  while (out.length > 0 && out[0].trim() === '') out.shift();
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out.join('\n');
}

/** Write a step's tacit note as a `> tacit:`-prefixed blockquote ({@link parseTacit} reads it). */
function serializeTacit(tacit: string): string {
  const note = tacit.trim();
  if (!note) return '';
  const body = note.split('\n').map((l) => (l.trim() ? `> tacit: ${l}` : '> tacit:')).join('\n');
  return '\n\n' + body;
}

/**
 * Extract all fenced ```step blocks and their immediately-following
 * `> tacit:` blockquotes from the workflow body.
 */
function parseSteps(body: string): WorkflowStep[] {
  const steps: WorkflowStep[] = [];

  // We walk through the body collecting step blocks + the text that follows
  // each one until the next step block (or end of document).
  const segments: { yaml: string; after: string }[] = [];

  let lastFenceEnd = 0;
  const fenceRe = /^```step\s*\n([\s\S]*?)^```/gm;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(body)) !== null) {
    const blockStart = match.index;
    const blockEnd = match.index + match[0].length;
    // The "after" is everything between the END of this fence and START of next
    // We'll collect it after we know where the next fence is.
    segments.push({ yaml: match[1], after: '' });
    if (segments.length > 1) {
      // Fill in the "after" for the previous segment.
      // It's the text from lastFenceEnd to blockStart.
      segments[segments.length - 2].after = body.slice(lastFenceEnd, blockStart);
    }
    lastFenceEnd = blockEnd;
  }
  // Remainder after the last step block.
  if (segments.length > 0) {
    segments[segments.length - 1].after = body.slice(lastFenceEnd);
  }

  for (const { yaml: rawYaml, after } of segments) {
    let doc: unknown;
    try {
      doc = yaml.load(rawYaml);
    } catch {
      continue; // skip malformed blocks
    }
    if (!isRecord(doc)) continue;

    const actor = (doc.actor as ActorType) ?? 'Human';
    if (!ACTOR_TYPES.includes(actor)) continue;

    const tacit = parseTacit(after);

    const step: WorkflowStep = {
      id: String(doc.id ?? '').trim() || `step-${steps.length + 1}`,
      title: String(doc.title ?? '').trim() || 'Untitled Step',
      actor,
      actor_name: String(doc.actor_name ?? '').trim(),
      inputs: strArray(doc.inputs),
      outputs: strArray(doc.outputs),
      links: Array.isArray(doc.links)
        ? (doc.links.map(parseLink).filter(Boolean) as StepLink[])
        : [],
      rules: Array.isArray(doc.rules)
        ? (doc.rules.map(parseStepRule).filter(Boolean) as StepRule[])
        : [],
      tacit,
    };
    steps.push(step);
  }

  return steps;
}

// ---------------------------------------------------- parse / serialize ------

/** Parse a `workflow.md` string into a normalized {@link Workflow}. */
export function parseWorkflow(text: string): Workflow {
  // Split off the YAML frontmatter.
  const norm = text.replace(/\r\n/g, '\n');
  const fmMatch = /^---\n([\s\S]*?)\n---\n?/.exec(norm);
  if (!fmMatch) throw new KnowledgeError('workflow.md: missing YAML frontmatter (---...---)', 400);

  let front: unknown;
  try {
    front = yaml.load(fmMatch[1]);
  } catch (e) {
    throw new KnowledgeError(`workflow.md: frontmatter is not valid YAML — ${(e as Error).message}`);
  }
  if (!isRecord(front)) throw new KnowledgeError('workflow.md: frontmatter must be a YAML mapping');

  const visibility = (front.visibility ?? 'Personal') as Visibility;
  if (!VISIBILITIES.includes(visibility)) {
    throw new KnowledgeError(`workflow.md: visibility '${String(front.visibility)}' is invalid (expected ${VISIBILITIES.join('|')})`);
  }

  const status = (front.status ?? 'draft') as WorkflowStatus;
  if (!STATUSES.includes(status)) {
    throw new KnowledgeError(`workflow.md: status '${String(front.status)}' is invalid (expected draft|live)`);
  }

  const rules: WorkflowRule[] = Array.isArray(front.rules)
    ? (front.rules.map(parseWorkflowRule).filter(Boolean) as WorkflowRule[])
    : [];

  const body = norm.slice(fmMatch[0].length);
  const steps = parseSteps(body);

  // Actor registry: the `actors:` section IS the registry once it exists — including
  // when it is empty, which is how a deleted last actor stays deleted. Only a
  // pre-registry file (no `actors:` key at all) derives one from its steps.
  const declared: Actor[] | undefined = Array.isArray(front.actors)
    ? (front.actors.map(parseActor).filter(Boolean) as Actor[])
    : undefined;
  const actors = resolveActorRegistry(steps, declared);

  return {
    id: String(front.id ?? '').trim() || 'untitled',
    title: String(front.title ?? '').trim() || 'Untitled',
    domain: String(front.domain ?? '').trim(),
    visibility,
    status,
    version: String(front.version ?? '1'),
    rules,
    actors,
    steps,
    body,
  };
}

/** Serialize a {@link WorkflowMeta} + steps back to canonical `workflow.md`. */
export function serializeWorkflow(w: Workflow): string {
  const frontDoc: Record<string, unknown> = {
    id: w.id,
    title: w.title,
    domain: w.domain,
    visibility: w.visibility,
    status: w.status,
    version: w.version,
  };
  if (w.rules.length > 0) {
    frontDoc.rules = w.rules.map((r) => {
      const out: Record<string, unknown> = { id: r.id, text: r.text, hard: r.hard, scope: r.scope };
      if (r.step_id) out.step_id = r.step_id;
      return out;
    });
  }
  // Actor registry — its own frontmatter section, alongside `rules:`. ALWAYS written,
  // the empty list included: the presence of the key is what tells the parser "this
  // registry is the source of truth, do not derive one from the steps". Without the
  // empty list, deleting the last actor would hand the next load a section-less file
  // and every actor would be re-derived from the steps it still names.
  frontDoc.actors = (w.actors ?? []).map((a) => {
    const out: Record<string, unknown> = { name: a.name, category: a.category };
    if (a.id) out.id = a.id;
    if (a.description) out.description = a.description;
    // `js-yaml` writes a multi-line prompt as a `|-` block scalar, so the markdown stays
    // readable in the file and a `---` line or a fence inside it is just text.
    if (a.prompt?.trim()) out.prompt = normalizeActorPrompt(a.name, a.prompt);
    return out;
  });

  const frontmatter = '---\n' + yaml.dump(frontDoc, { lineWidth: 100, noRefs: true }) + '---\n\n';

  const stepBlocks = w.steps
    .map((s) => {
      const stepDoc: Record<string, unknown> = {
        id: s.id,
        title: s.title,
        actor: s.actor,
      };
      if (s.actor_name) stepDoc.actor_name = s.actor_name;
      if (s.inputs.length > 0) stepDoc.inputs = s.inputs;
      if (s.outputs.length > 0) stepDoc.outputs = s.outputs;
      if (s.links.length > 0) stepDoc.links = s.links;
      if (s.rules.length > 0) stepDoc.rules = s.rules.map((r) => ({ id: r.id, text: r.text, hard: r.hard }));

      const block = '```step\n' + yaml.dump(stepDoc, { lineWidth: 100, noRefs: true }) + '```';
      return block + serializeTacit(s.tacit);
    })
    .join('\n\n');

  return frontmatter + stepBlocks + '\n';
}

// ---------------------------------------------- domain knowledge helpers ----

/**
 * Canonical section ids for the Operating Model card (7 sections, fixed order).
 * The old 4-section ids (overview / goals / context) are legacy and never created
 * fresh; `glossary` survived intact.
 */
export const DOMAIN_SECTION_IDS = [
  'general',
  'strategy',
  'business',
  'organization',
  'architecture',
  'data',
  'glossary',
] as const;

export const DOMAIN_SECTION_TITLES: Record<string, string> = {
  general: 'General',
  strategy: 'Strategy',
  business: 'Business',
  organization: 'Organization',
  architecture: 'Architecture',
  data: 'Data',
  glossary: 'Glossary',
};

/**
 * Migration mapping: old 4-section ids → new canonical section ids.
 * `glossary` is identity (survived unchanged).
 */
export const DOMAIN_SECTION_MIGRATION: Record<string, string> = {
  overview: 'general',
  goals: 'strategy',
  context: 'business',
  glossary: 'glossary',
};

/**
 * Reconcile a stored DomainKnowledge card (potentially old 4-section shape) to the
 * canonical 7-section shape. Migration rules:
 *   overview → general, goals → strategy, context → business, glossary → glossary
 * New sections (organization / architecture / data) start empty.
 * If the card already has the new shape, it is returned with all 7 sections present
 * (missing ones are filled as empty). No content is ever lost.
 */
export function reconcileSections(dk: DomainKnowledge): DomainKnowledge {
  // Build a lookup of existing sections by id (old or new).
  const byId: Record<string, string> = {};
  for (const sec of dk.sections) {
    byId[sec.id] = sec.content;
  }

  // Carry old-id content into the new id (only if the new id has no content yet).
  for (const [oldId, newId] of Object.entries(DOMAIN_SECTION_MIGRATION)) {
    if (oldId !== newId && oldId in byId && !(newId in byId)) {
      byId[newId] = byId[oldId];
    }
  }

  return {
    ...dk,
    sections: DOMAIN_SECTION_IDS.map((id) => ({
      id,
      title: DOMAIN_SECTION_TITLES[id],
      content: byId[id] ?? '',
    })),
  };
}

export function emptyDomainKnowledge(domain: string): DomainKnowledge {
  return {
    domain,
    sections: DOMAIN_SECTION_IDS.map((id) => ({
      id,
      title: DOMAIN_SECTION_TITLES[id],
      content: '',
    })),
    updatedAt: new Date().toISOString(),
  };
}
