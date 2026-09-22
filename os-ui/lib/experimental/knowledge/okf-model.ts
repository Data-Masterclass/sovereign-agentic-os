/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import yaml from 'js-yaml';
import {
  type Workflow,
  type WorkflowStep,
  type WorkflowRule,
  type Actor,
  type ActorType,
  ACTOR_TYPES,
  deriveActors,
} from './schema.ts';

/**
 * OKF (Open Knowledge Format) v0.2 — the BOUNDARY interchange model. Pure module:
 * no server-only imports, no network, no zip. It is the field-mapping heart shared
 * by okf-export.ts (server) and okf-import.ts (server) and the unit tests.
 *
 * Spec: github.com/GoogleCloudPlatform/knowledge-catalog → okf/ (Apache-2.0, v0.2).
 * Corrected spec facts we build to (see docs/decisions/okf-adoption.md):
 *   - `type` is the ONLY required frontmatter key and is a FREE-FORM string. Our
 *     five vocabulary strings (workflow / decision-rule / tacit-knowledge / term /
 *     overview) ride OKF's open type field.
 *   - Recommended: title, description, resource (URI), tags. Optional families:
 *     generated {by, at}, verified [{by, at}], sources, status, stale_after.
 *   - Consumers MUST NOT reject unknown fields / unknown types / broken links /
 *     absent index files. Rejection is legal ONLY for: unparseable YAML
 *     frontmatter, missing/empty `type`, malformed reserved files.
 *   - Reserved filenames: index.md (directory listing), log.md (update history).
 *   - Extensions are explicitly allowed: our tier/owner/domain/workflow metadata
 *     that the body cannot carry losslessly rides a namespaced `sovereign_os:`
 *     block so the round-trip is ABSOLUTE for our own artifacts.
 *
 * The `sovereign_os://knowledge/<id>` resource URI is BOTH the round-trip key and
 * the import idempotency key.
 */

// ------------------------------------------------------------------ constants -

export const OKF_VERSION = '0.2';

/** The bundle-absolute URI scheme that stamps a concept as ours (round-trip + idempotency key). */
export const RESOURCE_PREFIX = 'sovereign-os://knowledge/';

/** Reserved filenames — never imported as concept documents (spec §8–9). */
export const RESERVED_FILES = new Set(['index.md', 'log.md']);

/** The last path segment (filename) of a bundle-relative path. Pure. */
export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Our five OKF `type` strings — the vocabulary carried in OKF's open type field.
 * Import accepts ANY type string (spec rule); these are the ones export emits and
 * that map to a first-class internal kind. Everything else maps to `general`.
 */
export type OkfType = 'workflow' | 'decision-rule' | 'tacit-knowledge' | 'term' | 'overview';
export const OKF_TYPES: OkfType[] = ['workflow', 'decision-rule', 'tacit-knowledge', 'term', 'overview'];

/** Our internal kinds an imported concept maps to. Unknown OKF types → 'general'. */
export type InternalKind = 'workflow' | 'general';

/** Map an (arbitrary) OKF type string to the internal kind it imports as. */
export function internalKindForType(type: string): InternalKind {
  return type.trim().toLowerCase() === 'workflow' ? 'workflow' : 'general';
}

// ------------------------------------------------------------------- shapes ---

/** A trust/provenance actor event — `{by, at}`. */
export type OkfEvent = { by: string; at: string };

/**
 * The namespaced extension block. Everything the OKF body + standard families
 * cannot carry losslessly for OUR artifacts lives here so export→import is exact.
 */
export type SovereignExt = {
  /** Full internal tier — Personal | Shared | Marketplace (status only coarsely maps this). */
  tier?: string;
  owner?: string;
  domain?: string;
  /** Internal artifact id (also encoded in `resource`, duplicated for convenience). */
  id?: string;
  /** Workflow structure that headings can't round-trip losslessly (ids, rule scope, actor categories). */
  workflow?: {
    version?: string;
    status?: 'draft' | 'live';
    actors?: Actor[];
    rules?: WorkflowRule[];
    steps?: WorkflowStep[];
    /** Data & Metrics id links (kept verbatim so a re-import restores them). */
    links?: { datasets: string[]; metrics: string[] };
  };
};

/** A single OKF concept document: parsed frontmatter + markdown body. */
export type OkfDoc = {
  /** REQUIRED: the free-form type string. */
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  generated?: OkfEvent;
  /** Always normalised to a list on read (graceful degradation: bare map → [map]). */
  verified?: OkfEvent[];
  sources?: Record<string, unknown>[];
  status?: 'draft' | 'stable' | 'deprecated';
  stale_after?: string;
  /** Our extension block (spec-legal namespaced key). */
  sovereign_os?: SovereignExt;
  /** Any OTHER frontmatter keys, preserved VERBATIM (foreign-field pass-through). */
  extra?: Record<string, unknown>;
  /** The markdown body (everything after the frontmatter). */
  body: string;
};

/** A file in the bundle: its POSIX-relative path + text content. */
export type BundleFile = { path: string; content: string };

/** An in-memory OKF bundle — a directory tree of markdown files. */
export type OkfBundle = { files: BundleFile[] };

// ----------------------------------------------------- frontmatter parse ------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The recognised (mapped) frontmatter keys — everything else is foreign `extra`. */
const KNOWN_KEYS = new Set([
  'type', 'title', 'description', 'resource', 'tags',
  'generated', 'verified', 'sources', 'status', 'stale_after', 'sovereign_os',
]);

/** Split a markdown string into `{ frontmatter: rawYaml | null, body }`. */
export function splitFrontmatter(text: string): { raw: string | null; body: string } {
  const norm = text.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(norm);
  if (!m) return { raw: null, body: norm };
  return { raw: m[1], body: norm.slice(m[0].length) };
}

export class OkfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OkfParseError';
  }
}

/** Normalise a bare `verified` map to a single-element list (spec graceful degradation). */
function normEvents(v: unknown): OkfEvent[] | undefined {
  if (v === undefined || v === null) return undefined;
  const list = Array.isArray(v) ? v : [v];
  const out: OkfEvent[] = [];
  for (const e of list) {
    if (isRecord(e)) out.push({ by: String(e.by ?? ''), at: String(e.at ?? '') });
  }
  return out.length ? out : undefined;
}

function strArray(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v ? [v] : undefined;
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => String(x)).filter(Boolean);
  return out.length ? out : undefined;
}

/**
 * Parse a concept document's markdown into an {@link OkfDoc}. Throws OkfParseError
 * ONLY on the two conformance failures the caller must reject: unparseable YAML
 * frontmatter, or a missing/empty `type`. Everything else is accepted and, for
 * unrecognised keys, preserved verbatim in `extra`.
 */
export function parseOkfDoc(text: string): OkfDoc {
  const { raw, body } = splitFrontmatter(text);
  if (raw === null) throw new OkfParseError('missing YAML frontmatter (--- … ---)');
  let front: unknown;
  try {
    front = yaml.load(raw);
  } catch (e) {
    throw new OkfParseError(`frontmatter is not valid YAML — ${(e as Error).message}`);
  }
  if (!isRecord(front)) throw new OkfParseError('frontmatter must be a YAML mapping');

  const type = typeof front.type === 'string' ? front.type.trim() : '';
  if (!type) throw new OkfParseError('frontmatter is missing a non-empty `type`');

  // Preserve every unrecognised key verbatim (foreign-frontmatter pass-through).
  const extra: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(front)) {
    if (!KNOWN_KEYS.has(k)) extra[k] = val;
  }

  const doc: OkfDoc = { type, body };
  if (typeof front.title === 'string') doc.title = front.title;
  if (typeof front.description === 'string') doc.description = front.description;
  if (typeof front.resource === 'string') doc.resource = front.resource;
  const tags = strArray(front.tags);
  if (tags) doc.tags = tags;
  if (isRecord(front.generated)) doc.generated = { by: String(front.generated.by ?? ''), at: String(front.generated.at ?? '') };
  const verified = normEvents(front.verified);
  if (verified) doc.verified = verified;
  if (Array.isArray(front.sources)) doc.sources = front.sources.filter(isRecord) as Record<string, unknown>[];
  if (front.status === 'draft' || front.status === 'stable' || front.status === 'deprecated') doc.status = front.status;
  if (front.stale_after !== undefined) doc.stale_after = String(front.stale_after);
  if (isRecord(front.sovereign_os)) doc.sovereign_os = front.sovereign_os as SovereignExt;
  if (Object.keys(extra).length) doc.extra = extra;
  return doc;
}

/** Serialize an {@link OkfDoc} back to markdown (`--- yaml ---\n\nbody`). */
export function serializeOkfDoc(doc: OkfDoc): string {
  const front: Record<string, unknown> = { type: doc.type };
  if (doc.title !== undefined) front.title = doc.title;
  if (doc.description !== undefined) front.description = doc.description;
  if (doc.resource !== undefined) front.resource = doc.resource;
  if (doc.tags && doc.tags.length) front.tags = doc.tags;
  if (doc.generated) front.generated = doc.generated;
  if (doc.verified && doc.verified.length) front.verified = doc.verified;
  if (doc.sources && doc.sources.length) front.sources = doc.sources;
  if (doc.status) front.status = doc.status;
  if (doc.stale_after !== undefined) front.stale_after = doc.stale_after;
  if (doc.sovereign_os) front.sovereign_os = doc.sovereign_os;
  // Foreign fields last so ours read first, but never dropped.
  if (doc.extra) for (const [k, v] of Object.entries(doc.extra)) front[k] = v;
  const fm = yaml.dump(front, { lineWidth: 100, noRefs: true, sortKeys: false });
  const body = doc.body.replace(/^\n+/, '');
  return `---\n${fm}---\n\n${body}${body.endsWith('\n') ? '' : '\n'}`;
}

// -------------------------------------------------- workflow ⇄ OKF body -------

const HEADING_STEPS = '# Steps';
const HEADING_RULES = '# Rules';
const HEADING_ACTORS = '# Actors';
const HEADING_TACIT = '# Tacit knowledge';

/**
 * Render a workflow's structure into a HUMAN-READABLE OKF body (renders on GitHub)
 * with defined headings. The lossless machine copy rides `sovereign_os.workflow`;
 * this body is the readable narration so the bundle is useful to a human/agent that
 * never looks at the extension block.
 */
export function workflowToOkfBody(w: Workflow): string {
  const out: string[] = [];
  if (w.body.trim()) out.push(w.body.trim(), '');

  if (w.actors.length) {
    out.push(HEADING_ACTORS, '');
    for (const a of w.actors) {
      out.push(`- **${a.name}** (${a.category})${a.description ? ` — ${a.description}` : ''}`);
    }
    out.push('');
  }

  out.push(HEADING_STEPS, '');
  w.steps.forEach((s, i) => {
    out.push(`## ${i + 1}. ${s.title}`);
    out.push(`- Actor: ${s.actor}${s.actor_name ? ` — ${s.actor_name}` : ''}`);
    if (s.inputs.length) out.push(`- Inputs: ${s.inputs.join(', ')}`);
    if (s.outputs.length) out.push(`- Outputs: ${s.outputs.join(', ')}`);
    for (const r of s.rules) out.push(`- Rule${r.hard ? ' (hard)' : ''}: ${r.text}`);
    if (s.tacit.trim()) out.push('', `> tacit: ${s.tacit.trim().split('\n').join('\n> tacit: ')}`);
    out.push('');
  });

  const wfRules = w.rules.filter((r) => r.scope !== 'step');
  if (wfRules.length) {
    out.push(HEADING_RULES, '');
    for (const r of wfRules) out.push(`- ${r.hard ? '**(hard)** ' : ''}${r.text}`);
    out.push('');
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/**
 * Build the full OKF concept doc for a workflow. The body is human-readable; the
 * `sovereign_os.workflow` extension carries the exact structure for a lossless
 * round-trip. `id` is the internal artifact id → drives the resource URI.
 */
export function workflowToOkfDoc(
  w: Workflow,
  meta: {
    id: string;
    owner: string;
    domain: string;
    tier: string;
    generatedAt?: string;
    verified?: OkfEvent[];
    tacit?: string;
    links?: { datasets: string[]; metrics: string[] };
    tags?: string[];
  },
): OkfDoc {
  const doc: OkfDoc = {
    type: 'workflow',
    title: w.title,
    resource: `${RESOURCE_PREFIX}${meta.id}`,
    body: workflowToOkfBody(w) + (meta.tacit && meta.tacit.trim() ? `\n${HEADING_TACIT}\n\n${meta.tacit.trim()}\n` : ''),
    status: tierToStatus(meta.tier),
    sovereign_os: {
      tier: meta.tier,
      owner: meta.owner,
      domain: meta.domain,
      id: meta.id,
      workflow: {
        version: w.version,
        status: w.status,
        actors: w.actors,
        rules: w.rules,
        steps: w.steps,
        ...(meta.links ? { links: meta.links } : {}),
      },
    },
  };
  if (meta.tags && meta.tags.length) doc.tags = meta.tags;
  if (meta.generatedAt && meta.owner) doc.generated = { by: `human:${meta.owner}`, at: meta.generatedAt };
  if (meta.verified && meta.verified.length) doc.verified = meta.verified;
  return doc;
}

/**
 * Reconstruct a {@link Workflow} from an OKF concept doc on IMPORT. Prefers the
 * lossless `sovereign_os.workflow` extension (round-trip of our own bundles); if it
 * is absent (a foreign OKF bundle typed `workflow`), degrades gracefully to a
 * minimal workflow that carries the body as prose — never throws.
 */
export function okfDocToWorkflow(doc: OkfDoc, fallbackId: string, domain: string): Workflow {
  const ext = doc.sovereign_os?.workflow;
  const title = doc.title?.trim() || 'Imported Workflow';
  if (ext && Array.isArray(ext.steps)) {
    const steps = ext.steps.map(coerceStep).filter(Boolean) as WorkflowStep[];
    const rules = Array.isArray(ext.rules) ? (ext.rules.map(coerceRule).filter(Boolean) as WorkflowRule[]) : [];
    const declared = Array.isArray(ext.actors) ? (ext.actors.map(coerceActor).filter(Boolean) as Actor[]) : [];
    return {
      id: fallbackId,
      title,
      domain,
      visibility: 'Personal',
      status: 'draft',
      version: String(ext.version ?? '1'),
      rules,
      actors: deriveActors(steps, declared),
      steps,
      body: '',
    };
  }
  // Foreign workflow bundle — no structure to recover; keep the readable body.
  return {
    id: fallbackId,
    title,
    domain,
    visibility: 'Personal',
    status: 'draft',
    version: '1',
    rules: [],
    actors: [],
    steps: [],
    body: doc.body.trim(),
  };
}

function coerceStep(raw: unknown): WorkflowStep | null {
  if (!isRecord(raw)) return null;
  const actor = (raw.actor as ActorType) ?? 'Human';
  return {
    id: String(raw.id ?? '').trim() || `step-${Math.random().toString(36).slice(2, 6)}`,
    title: String(raw.title ?? '').trim() || 'Untitled Step',
    actor: ACTOR_TYPES.includes(actor) ? actor : 'Human',
    actor_name: String(raw.actor_name ?? '').trim(),
    inputs: Array.isArray(raw.inputs) ? raw.inputs.map(String) : [],
    outputs: Array.isArray(raw.outputs) ? raw.outputs.map(String) : [],
    links: [],
    rules: Array.isArray(raw.rules) ? (raw.rules.map(coerceStepRule).filter(Boolean) as WorkflowStep['rules']) : [],
    tacit: String(raw.tacit ?? '').trim(),
  };
}

function coerceStepRule(raw: unknown): WorkflowStep['rules'][number] | null {
  if (!isRecord(raw)) return null;
  const id = String(raw.id ?? '').trim();
  const text = String(raw.text ?? '').trim();
  if (!id || !text) return null;
  return { id, text, hard: Boolean(raw.hard) };
}

function coerceRule(raw: unknown): WorkflowRule | null {
  if (!isRecord(raw)) return null;
  const id = String(raw.id ?? '').trim();
  const text = String(raw.text ?? '').trim();
  if (!id || !text) return null;
  const scope = raw.scope === 'step' ? 'step' : 'workflow';
  const rule: WorkflowRule = { id, text, hard: Boolean(raw.hard), scope };
  if (scope === 'step' && typeof raw.step_id === 'string') rule.step_id = raw.step_id;
  return rule;
}

function coerceActor(raw: unknown): Actor | null {
  if (!isRecord(raw)) return null;
  const name = String(raw.name ?? '').trim();
  const category = String(raw.category ?? '') as ActorType;
  if (!name || !ACTOR_TYPES.includes(category)) return null;
  const actor: Actor = { name, category };
  if (typeof raw.description === 'string' && raw.description.trim()) actor.description = raw.description.trim();
  return actor;
}

// ----------------------------------------------------------- tier ⇄ status ----

/** Personal → draft; Shared/Marketplace → stable (spec lifecycle mapping). */
export function tierToStatus(tier: string): 'draft' | 'stable' {
  return tier === 'Personal' ? 'draft' : 'stable';
}

// --------------------------------------------------- resource URI helpers -----

/** Extract our internal artifact id from a `sovereign-os://knowledge/<id>` URI, or null. */
export function idFromResource(resource: string | undefined): string | null {
  if (!resource) return null;
  return resource.startsWith(RESOURCE_PREFIX) ? resource.slice(RESOURCE_PREFIX.length) || null : null;
}

// --------------------------------------------------- knowledge link nav --------

/** A resolved first-class link between Knowledge artifacts. */
export type KnowledgeLink = { id: string; title: string };
/** A markdown link that could not be resolved to a Knowledge artifact (preserved + flagged). */
export type UnresolvedLink = { href: string; label: string };

export type ResolvedLinks = { links: KnowledgeLink[]; unresolved: UnresolvedLink[] };

/**
 * Scan a piece of markdown for links to OTHER Knowledge artifacts and resolve them
 * to first-class references (decision #6). Two link forms are recognised:
 *   - our resource URI:  [label](sovereign-os://knowledge/<id>)  or a bare URI
 *   - relative concept link: [label](../workflows/foo.md)  → resolved via `byPath`
 * `resolveId` returns the artifact title for a known id (or null). Unresolvable
 * links are PRESERVED and flagged, never dropped. Deduped by id.
 */
export function resolveKnowledgeLinks(
  markdown: string,
  resolveId: (id: string) => string | null,
): ResolvedLinks {
  const links: KnowledgeLink[] = [];
  const unresolved: UnresolvedLink[] = [];
  const seen = new Set<string>();

  const push = (id: string, label: string) => {
    if (seen.has(id)) return;
    const title = resolveId(id);
    if (title) { seen.add(id); links.push({ id, title }); }
    else unresolved.push({ href: `${RESOURCE_PREFIX}${id}`, label });
  };

  // Markdown links `[label](href)`.
  const linkRe = /\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(markdown)) !== null) {
    const label = m[1].trim();
    const href = m[2].trim();
    const id = idFromResource(href);
    if (id) push(id, label || id);
    else if (/\.md(#|$)/i.test(href) && !/^[a-z]+:\/\//i.test(href)) {
      unresolved.push({ href, label: label || href });
    }
  }

  // Bare resource URIs not inside a markdown link.
  const bareRe = new RegExp(`${RESOURCE_PREFIX.replace(/[/:]/g, '\\$&')}([A-Za-z0-9:_-]+)`, 'g');
  while ((m = bareRe.exec(markdown)) !== null) {
    // Skip if already captured as a markdown link (same id already seen).
    if (!seen.has(m[1])) push(m[1], m[1]);
  }

  return { links, unresolved };
}

// -------------------------------------------------------- index.md rendering --

/**
 * Render a spec-correct `index.md` directory listing. Subdirectories use the
 * `# Subdirectories` heading; concept files list `* [Title](file.md) - description`.
 */
export function renderIndexMd(
  entries: { path: string; title: string; description?: string; isDir?: boolean }[],
): string {
  const dirs = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);
  const out: string[] = [];
  if (dirs.length) {
    out.push('# Subdirectories', '');
    for (const d of dirs) out.push(`* [${d.title}](${d.path})${d.description ? ` - ${d.description}` : ''}`);
    out.push('');
  }
  if (files.length) {
    out.push('# Concepts', '');
    for (const f of files) out.push(`* [${f.title}](${f.path})${f.description ? ` - ${f.description}` : ''}`);
    out.push('');
  }
  return out.join('\n').trim() + '\n';
}
