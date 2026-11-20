/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    WP-50 — a domain's `knowledge/` subtree as an OKF v0.3 bundle, and its inverse
 * USER STORY: As an engineer who clones my domain's repository I want its shared workflows, their
 *             tacit notes, their hard rules as OPA data and the domain operating manual as an Open
 *             Knowledge Format bundle; as the OS I want to read the same files back into the store,
 *             so the repository is the source of truth (design 11 A19–A21, A24, A29; design 12).
 * ARCHITECTURE:
 *   - PURE: records in, `path → text` out (`generateKnowledgeFiles`), and back (`readKnowledgeBundle`).
 *   - N (native, OKF v0.3 SPEC.md @ 527e81af): `index.md` (bundle root, `okf_version: "0.3"`),
 *     `workflows/<slug>/workflow.md` (`type: Workflow`), `workflows/<slug>/tacit.md`
 *     (`type: Tacit Knowledge`), `manual/domain.md` (`type: Operating Manual`) and `README.md`
 *     (`type: Guide`, so the strict validator sees a concept, not a stray file). OKF `status` is
 *     `draft | stable`; the OS's `live` maps to `stable`.
 *   - O (OS layer): ONLY the `x-sovereign-os-meta` mapping (OKF §4.1's `x-<producer>-<name>`
 *     extension point) — id, domain, owner, scope, OS status, version, folder.
 *   - A24: `workflows/<slug>/guardrails.json` is the OPA data document the guardrail compiler
 *     already produces (`compileGuardrails(...).data`), written only when the workflow has hard rules.
 *   - ACCESS BOUNDARY: the domain repository is readable by every domain member, so a Personal
 *     draft (My scope) and an archived workflow are never written here.
 *   - YAML is dumped with the core schema and double quotes, so versions and timestamps stay
 *     strings (OKF W117) and `okf_version` is `"0.3"`.
 *   - The inverse returns the workflow `md` in the store's own canonical form
 *     (`serializeWorkflow(parseWorkflow(...))`), so a store-written workflow round-trips byte for byte.
 */
import yaml from 'js-yaml';
import { KNOWLEDGE_DIR, KNOWLEDGE_MANUAL_PATH, KNOWLEDGE_WORKFLOWS_DIR, knowledgeWorkflowDir, prefixOf } from '@core/infra/repo-layout';
import { compileGuardrails } from '@tabs/knowledge/lib/guardrails';
import { parseWorkflow, serializeWorkflow, type DomainKnowledge, type DomainSection } from '@tabs/knowledge/lib/schema';

export const KNOWLEDGE_PREFIX = prefixOf(KNOWLEDGE_DIR);
export const OS_META_KEY = 'x-sovereign-os-meta';
export const OKF_VERSION = '0.3';
const WORKFLOWS = KNOWLEDGE_WORKFLOWS_DIR;
const MANUAL_PATH = KNOWLEDGE_MANUAL_PATH;

/** The fields of a stored workflow the bundle reads. */
export type BundleWorkflow = {
  id: string;
  domain: string;
  owner: string;
  md: string;
  tacit: string;
  title: string;
  visibility: string;
  status: string;
  folder?: string;
  archived?: boolean;
  updatedAt?: string;
};

export type KnowledgeSnapshot = { workflows: BundleWorkflow[]; manual: DomainKnowledge | null };

const DUMP: yaml.DumpOptions = { schema: yaml.CORE_SCHEMA, lineWidth: -1, noRefs: true, quotingType: '"' };

/** `---\n<yaml>\n---\n<body>` → the parsed mapping, its raw text and the body (verbatim). */
export function splitFrontmatter(text: string): { front: Record<string, unknown>; raw: string; body: string } {
  const norm = text.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(norm);
  if (!m) return { front: {}, raw: '', body: norm };
  const front = yaml.load(m[1], { schema: yaml.CORE_SCHEMA });
  return { front: (front && typeof front === 'object' ? front : {}) as Record<string, unknown>, raw: m[1], body: norm.slice(m[0].length) };
}

function withFront(front: Record<string, unknown>, body: string): string {
  return `---\n${yaml.dump(front, DUMP)}---\n${body}`;
}

function slugify(s: string): string {
  const v = s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return v || 'workflow';
}

function okfStatus(osStatus: string): string {
  return osStatus === 'live' ? 'stable' : 'draft';
}

/** The workflows that belong in the DOMAIN bundle: shared or certified, live in this domain. */
export function bundledWorkflows(domain: string, workflows: BundleWorkflow[]): BundleWorkflow[] {
  return workflows.filter((w) => w.domain === domain && !w.archived && w.visibility !== 'Personal').sort((a, b) => a.id.localeCompare(b.id));
}

/** Stable folder names: the title's slug; a later id with the same slug gets `-<id>` appended. */
export function placeWorkflows(workflows: BundleWorkflow[]): { w: BundleWorkflow; slug: string }[] {
  const used = new Set<string>();
  return workflows.map((w) => {
    let slug = slugify(w.title);
    if (used.has(slug)) slug = `${slug}-${slugify(w.id)}`;
    used.add(slug);
    return { w, slug };
  });
}

const OS_FRONT_KEYS = new Set(['id', 'title', 'domain', 'visibility', 'status', 'version']);

function workflowConcept(w: BundleWorkflow): string {
  const { front, body } = splitFrontmatter(w.md);
  const rest = Object.fromEntries(Object.entries(front).filter(([k]) => !OS_FRONT_KEYS.has(k)));
  return withFront(
    {
      type: 'Workflow',
      title: String(front.title ?? w.title),
      status: okfStatus(w.status),
      ...rest,
      [OS_META_KEY]: {
        id: w.id,
        domain: w.domain,
        owner: w.owner,
        scope: w.visibility,
        status: w.status,
        version: String(front.version ?? '1'),
        folder: w.folder ?? '/',
      },
    },
    body,
  );
}

function tacitConcept(w: BundleWorkflow): string {
  return withFront({ type: 'Tacit Knowledge', title: `${w.title}: tacit notes`, [OS_META_KEY]: { workflow: w.id } }, `${w.tacit}\n`);
}

function manualConcept(dk: DomainKnowledge): string {
  const body = dk.sections.map((s) => `<!-- os-section: ${s.id} -->\n# ${s.title}\n\n${s.content}\n\n`).join('');
  return withFront({ type: 'Operating Manual', title: `${dk.domain} operating manual`, [OS_META_KEY]: { domain: dk.domain, scope: 'domain' } }, body);
}

function readme(domain: string): string {
  return withFront(
    { type: 'Guide', title: `About the ${domain} knowledge bundle` },
    [
      `# ${domain} knowledge`,
      '',
      'An Open Knowledge Format (OKF) v0.3 bundle: the shared workflows of this domain, their tacit notes,',
      'their hard rules as OPA data (`guardrails.json`) and the domain operating manual.',
      '',
      '## Use it without the OS',
      '',
      '```sh',
      'python3 validate.py knowledge --strict   # OKF reference validator, skills/okf-generate/scripts/validate.py',
      'opa eval -d knowledge/workflows/<slug>/guardrails.json data.guardrails',
      '```',
      '',
      '`x-sovereign-os-meta` keys are the OS layer (owner, scope); any OKF consumer may ignore them.',
      '',
      'Docs: https://github.com/open-knowledge-format/open-knowledge-format/blob/main/SPEC.md',
      '',
    ].join('\n'),
  );
}

function rootIndex(domain: string, placed: { w: BundleWorkflow; slug: string }[], hasManual: boolean): string {
  const lines: string[] = [];
  if (placed.length) {
    lines.push('# Workflows', '');
    for (const { w, slug } of placed) lines.push(`- [${w.title.replace(/[[\]]/g, '')}](workflows/${slug}/workflow.md)`);
    lines.push('');
  }
  if (hasManual) lines.push('# Operating manual', '', '- [Domain operating manual](manual/domain.md)', '');
  lines.push('# About', '', '- [About this bundle](README.md)', '');
  return withFront({ okf_version: OKF_VERSION, title: `${domain} knowledge`, description: `Shared workflows and the operating manual of the ${domain} domain.` }, lines.join('\n'));
}

/** Generate `domain`'s complete `knowledge/**` subtree. Empty when there is nothing to share. */
export function generateKnowledgeFiles(domain: string, snap: KnowledgeSnapshot): Map<string, string> {
  const files = new Map<string, string>();
  const placed = placeWorkflows(bundledWorkflows(domain, snap.workflows));
  const manual = snap.manual && snap.manual.domain === domain && snap.manual.sections.some((s) => s.content.trim()) ? snap.manual : null;
  if (!placed.length && !manual) return files;
  for (const { w, slug } of placed) {
    const dir = knowledgeWorkflowDir(slug);
    files.set(`${dir}/workflow.md`, workflowConcept(w));
    if (w.tacit.trim()) files.set(`${dir}/tacit.md`, tacitConcept(w));
    const data = compileGuardrails(parseWorkflow(w.md)).data;
    if (data.guardrails.length) files.set(`${dir}/guardrails.json`, `${JSON.stringify(data, null, 2)}\n`);
  }
  if (manual) files.set(MANUAL_PATH, manualConcept(manual));
  files.set(`${KNOWLEDGE_DIR}/index.md`, rootIndex(domain, placed, Boolean(manual)));
  files.set(`${KNOWLEDGE_DIR}/README.md`, readme(domain));
  return files;
}

export type BundleReadBack = {
  workflows: (BundleWorkflow & { folder: string })[];
  manual: { domain: string; sections: DomainSection[] } | null;
};

function readManual(text: string): BundleReadBack['manual'] {
  const { front, body } = splitFrontmatter(text);
  const meta = (front[OS_META_KEY] ?? {}) as Record<string, unknown>;
  const sections: DomainSection[] = [];
  const re = /<!-- os-section: ([A-Za-z0-9_-]+) -->\n# (.*)\n\n/g;
  const marks = [...body.matchAll(re)];
  marks.forEach((m, i) => {
    const start = m.index! + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index! : body.length;
    sections.push({ id: m[1] as DomainSection['id'], title: m[2], content: body.slice(start, end).replace(/\n\n$/, '') });
  });
  return { domain: String(meta.domain ?? ''), sections };
}

/** THE INVERSE: the files of a `knowledge/` subtree → the store's records. */
export function readKnowledgeBundle(files: Map<string, string>): BundleReadBack {
  const out: BundleReadBack = { workflows: [], manual: null };
  for (const [path, text] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const m = new RegExp(`^${WORKFLOWS}/([^/]+)/workflow\\.md$`).exec(path);
    if (!m) continue;
    const { front, body } = splitFrontmatter(text);
    const meta = front[OS_META_KEY] as Record<string, unknown> | undefined;
    if (!meta?.id) continue; // an OKF concept the OS did not write: not a store record
    const rest = Object.fromEntries(Object.entries(front).filter(([k]) => !['type', 'title', 'status', OS_META_KEY].includes(k)));
    const original = {
      id: String(meta.id),
      title: String(front.title ?? ''),
      domain: String(meta.domain ?? ''),
      visibility: String(meta.scope ?? 'Shared'),
      status: String(meta.status ?? 'draft'),
      version: String(meta.version ?? '1'),
      ...rest,
    };
    const md = serializeWorkflow(parseWorkflow(`---\n${yaml.dump(original, DUMP)}---\n${body}`));
    const tacitText = files.get(`${WORKFLOWS}/${m[1]}/tacit.md`);
    const tacit = tacitText ? splitFrontmatter(tacitText).body.replace(/\n$/, '') : '';
    out.workflows.push({
      id: original.id,
      domain: original.domain,
      owner: String(meta.owner ?? ''),
      md,
      tacit,
      title: original.title,
      visibility: original.visibility,
      status: original.status,
      folder: String(meta.folder ?? '/'),
    });
  }
  const manual = files.get(MANUAL_PATH);
  if (manual) out.manual = readManual(manual);
  return out;
}

/** The store's canonical form of a workflow `md` (what the inverse returns). */
export function canonicalMd(md: string): string {
  return serializeWorkflow(parseWorkflow(md));
}
