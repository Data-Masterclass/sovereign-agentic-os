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
 * four guided sections (overview / glossary / goals / context).
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

/** General domain knowledge — the pinned domain card; base context for every domain agent. */
export type DomainSection = {
  id: 'overview' | 'glossary' | 'goals' | 'context';
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
  return actor;
}

const actorKey = (category: ActorType, name: string) => `${category}::${name.trim().toLowerCase()}`;

/**
 * Derive an actor registry from the steps' distinct (category, name) pairs.
 * Used as a back-compat fallback for workflows that predate the `actors:` section
 * so they gain a registry for free. Merges any explicitly-declared actors first
 * (those keep their description); a step whose (category, name) is already
 * declared is not re-added.
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
  return out;
}

// ------------------------------------------------------ step block parse -----

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

    // Extract tacit note from the "after" text: `> tacit: ...`
    const tacitMatch = />\s*tacit:\s*([\s\S]*?)(?=\n```|\n---|\s*$)/.exec(after);
    const tacit = tacitMatch
      ? tacitMatch[1]
          .split('\n')
          .map((l) => l.replace(/^>\s?/, '').trim())
          .filter(Boolean)
          .join('\n')
      : '';

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

  // Actor registry: explicitly-declared `actors:` (if any) merged with the
  // distinct (category, name) pairs found in the steps. A pre-registry workflow
  // (no `actors:` section) therefore still gets a registry derived from its steps.
  const declared: Actor[] = Array.isArray(front.actors)
    ? (front.actors.map(parseActor).filter(Boolean) as Actor[])
    : [];
  const actors = deriveActors(steps, declared);

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
  // Actor registry — its own frontmatter section, alongside `rules:`. Persisted
  // in full so a registry entry survives even when no step references it yet
  // (add-then-assign) or it carries no description. On load it's re-merged with
  // the steps' distinct (category, name) pairs, so nothing is lost either way.
  if ((w.actors ?? []).length > 0) {
    frontDoc.actors = w.actors.map((a) => {
      const out: Record<string, unknown> = { name: a.name, category: a.category };
      if (a.id) out.id = a.id;
      if (a.description) out.description = a.description;
      return out;
    });
  }

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
      const tacit = s.tacit.trim()
        ? '\n\n' + s.tacit.trim().split('\n').map((l) => `> tacit: ${l}`).join('\n')
        : '';
      return block + tacit;
    })
    .join('\n\n');

  return frontmatter + stepBlocks + '\n';
}

// ---------------------------------------------- domain knowledge helpers ----

export const DOMAIN_SECTION_IDS = ['overview', 'glossary', 'goals', 'context'] as const;
export const DOMAIN_SECTION_TITLES: Record<string, string> = {
  overview: 'Overview',
  glossary: 'Glossary',
  goals: 'Goals',
  context: 'Key Context',
};

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
