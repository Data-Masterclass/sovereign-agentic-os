/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    `generateAgentFiles(snapshot)` — a domain's agent systems as a readable git subtree
 * USER STORY: As an AI engineer I want the agent systems of my domain to exist in the domain's
 *             repository the way I would commit them myself — the canonical `system.yaml`, each
 *             agent's prompt as its own markdown file, the compiled LangGraph IR the engine
 *             actually runs, and a README I can read without the OS — so nothing I build lives
 *             only inside the OS (checklist A2/A3/A4).
 * ARCHITECTURE:
 *   - PURE and byte-stable: same snapshot ⇒ identical file map, so `commitSubtree` commits nothing
 *     when nothing changed. No timestamps, ids or randomness are minted here.
 *   - Writes ONLY under `agents/` (the subtree the Agents tab owns in the shared domain repo —
 *     `core/infra/git-store.ts` `commitSubtree` / `reserveSubtree`). The dbt project at the root
 *     belongs to the Data tab and is never touched.
 *   - Layout: `agents/<slug>/…` for a Shared/Marketplace system; `agents/personal/<uid>/<slug>/…`
 *     for a Personal one — the SAME lane split B1 chose for the data side
 *     (`models/personal/<uid>/`), so one repo has one convention. `agents/index.yml` maps slug →
 *     id, owner, scope and source version, because a directory name is not an identity.
 *   - NO SECRETS: the tree carries grant NAMES and ids only. `lastBuild.litellmKeyRef` (a Secret
 *     reference) and every run artefact are excluded by the snapshot, not here.
 *   - NO PRINCIPAL IDENTIFIERS (Part D review M-1): an OS principal id can BE an e-mail address,
 *     and a repository is the most widely copied artefact the OS produces — it is pushed to a
 *     mirror, cloned by Dagster, exported by any domain member. So the owner appears as
 *     {@link ownerToken}: a stable, opaque sha256 prefix, in `index.yml`, in each README and as
 *     the personal lane's path segment. The principal id itself stays in the COMMIT (`OS-Actor`),
 *     where it belongs — git authorship is the one place a person is meant to be named.
 *   - A system whose stored yaml does not parse still gets its `system.yaml` committed verbatim
 *     plus a README that says so — losing the source would be worse than an unreadable one.
 */
import { createHash } from 'node:crypto';
import { parseSystem, type System, type ArtifactGrant, type AgentSpec } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import type { AgentProjectSnapshot, SnapshotSystem } from '@tabs/agents/lib/git/snapshot';

/** The subtree the Agents tab owns in a domain repo (always with the trailing slash). */
export const AGENTS_PREFIX = 'agents/';

/** The directory a PERSONAL system's lane lives under — mirrors `models/personal/<uid>/`. */
const PERSONAL_DIR = 'personal';

/**
 * The stable, opaque token that stands for an OS principal in the repository: the first 12 hex
 * characters of `sha256(<principal id>)`.
 *
 * WHY NOT THE ID (review M-1): ids in this OS are frequently e-mail addresses, and everything in
 * `agents/**` is published far beyond the person — the configured git mirror, the Dagster
 * code-location clone, every `…/export` of the domain project. A directory name and an index entry
 * do not need to identify anybody; they need to be the SAME for the same owner on every
 * regeneration, which a hash is. The mapping is resolvable only inside the OS (the system's
 * `owner` field), which is exactly the property we want.
 */
export function ownerToken(owner: string): string {
  return createHash('sha256').update(String(owner ?? '')).digest('hex').slice(0, 12);
}

/** A safe single path segment: lowercase, `[a-z0-9-]`, never empty, never `..`. */
export function segment(s: string, fallback: string): string {
  const out = String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || fallback;
}

/** The disambiguator appended when two systems in one directory slug identically. */
function shortId(id: string): string {
  return segment(id, 'x').slice(-12);
}

export type PlacedSystem = {
  system: SnapshotSystem;
  slug: string;
  scope: 'personal' | 'domain';
  /** Repo-relative directory, e.g. `agents/personal/amir/support-triage`. */
  dir: string;
};

/**
 * Where each system's directory goes. Deterministic: systems are taken in id order, the first
 * claimant of a slug keeps it and a later one gets `<slug>-<id suffix>`. A domain-scope system
 * that would slug to `personal` is disambiguated too, so it can never shadow the personal lane.
 */
export function placeSystems(snapshot: AgentProjectSnapshot): PlacedSystem[] {
  const taken = new Set<string>();
  const out: PlacedSystem[] = [];
  // Sorted HERE, not only in the snapshot: placement must depend on the set of systems, never on
  // the order they happened to arrive in, or a directory would move when nothing changed.
  for (const system of [...snapshot.systems].sort((a, b) => a.id.localeCompare(b.id))) {
    const scope: 'personal' | 'domain' = system.visibility === 'Personal' ? 'personal' : 'domain';
    const parent = scope === 'personal' ? `${AGENTS_PREFIX}${PERSONAL_DIR}/${ownerToken(system.owner)}` : AGENTS_PREFIX.slice(0, -1);
    const base = segment(system.name, 'system');
    const reserved = scope === 'domain' && base === PERSONAL_DIR;
    let slug = reserved ? `${base}-${shortId(system.id)}` : base;
    if (taken.has(`${parent}/${slug}`)) slug = `${base}-${shortId(system.id)}`;
    taken.add(`${parent}/${slug}`);
    out.push({ system, slug, scope, dir: `${parent}/${slug}` });
  }
  return out;
}

// ------------------------------------------------------------------- yaml ---

/** A YAML scalar that cannot be mis-read: plain when obviously safe, else single-quoted. */
function y(v: string | number | boolean): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v ?? '');
  if (/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

/** `agents/index.yml` — the slug → identity map. A directory name is not an identity. */
export function renderIndex(snapshot: AgentProjectSnapshot, placed: PlacedSystem[]): string {
  const lines = [
    '# Agent systems of this domain, generated by Sovereign OS. Do not edit by hand.',
    '# A directory name is a slug; the `id` is the system\'s frozen identity in the OS.',
    '# `owner` is an OPAQUE, stable token for the owning principal (sha256 prefix), never a',
    '# username or an e-mail address: this file travels to every mirror and clone of the repo.',
    'version: 1',
    `domain: ${y(snapshot.domain)}`,
  ];
  if (placed.length === 0) {
    lines.push('systems: []');
    return `${lines.join('\n')}\n`;
  }
  lines.push('systems:');
  for (const p of placed) {
    const s = p.system;
    lines.push(`  - slug: ${y(p.slug)}`);
    lines.push(`    id: ${y(s.id)}`);
    lines.push(`    path: ${y(p.dir)}`);
    lines.push(`    name: ${y(s.name)}`);
    lines.push(`    owner: ${y(ownerToken(s.owner))}`);
    lines.push(`    scope: ${y(p.scope)}`);
    lines.push(`    visibility: ${y(s.visibility)}`);
    lines.push(`    version: ${s.version}`);
    lines.push(`    origin: ${y(s.origin)}`);
    if (s.sourceId) lines.push(`    source_id: ${y(s.sourceId)}`);
    lines.push(`    running: ${s.running}`);
    lines.push(`    schedule: ${y(s.schedule.kind)}`);
    if (s.schedule.cron) lines.push(`    cron: ${y(s.schedule.cron)}`);
    if (s.schedule.event) lines.push(`    event: ${y(s.schedule.event)}`);
    lines.push(`    folder: ${y(s.folder || '/')}`);
  }
  return `${lines.join('\n')}\n`;
}

// ----------------------------------------------------------------- README ---

function grantRows(label: string, items: ArtifactGrant[]): string[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => `${a.id}${a.folder?.path ?? ''}`.localeCompare(`${b.id}${b.folder?.path ?? ''}`));
  return sorted.map((g) => {
    const target = g.folder ? `folder \`${g.folder.path}\` (${g.folder.scope})` : `\`${g.id}\``;
    // `layer` is DATA-only, and the serializer never persists `gold` (it is the serving default),
    // so an absent layer on a data grant means gold — say that rather than showing a dash.
    const layer = label === 'data' ? (g.layer ?? 'gold (default)') : '—';
    return `| ${label} | ${target} | ${g.capability} | ${layer} |`;
  });
}

function memberRow(a: AgentSpec, disabled: Set<string>): string {
  const tools = a.tools === undefined ? 'inherits all' : a.tools.length === 0 ? 'none' : a.tools.map((t) => `\`${t}\``).join(', ');
  const supervises = (a.members ?? []).length > 0 ? (a.members ?? []).map((m) => `\`${m}\``).join(', ') : '—';
  return `| \`${a.id}\` | ${a.role || '—'} | ${a.model ? `\`${a.model}\`` : 'auto'} | ${tools} | ${supervises} | ${disabled.has(a.id) ? 'disabled' : 'yes'} |`;
}

/** The generated README — purpose, members, grants, channels, handoffs, last build. */
export function renderReadme(s: SnapshotSystem, placed: PlacedSystem, sys: System | null): string {
  const out: string[] = [`# ${s.name}`, ''];
  if (!sys) {
    out.push(
      '> **This system\'s `system.yaml` does not currently parse.** The source is committed beside this',
      '> file exactly as the OS holds it, so nothing is lost; the compiled graph and the per-agent',
      '> prompt files are omitted until it parses again.',
      '',
      `- **Id** \`${s.id}\``,
      `- **Owner** \`${ownerToken(s.owner)}\` (opaque token) · **Scope** ${placed.scope}`,
      '',
      '---',
      '',
      'Generated by Sovereign OS from `system.yaml`. Edit the system in the OS (Agents tab or the OS MCP);',
      'this file is regenerated on the next change.',
      '',
    );
    return out.join('\n');
  }
  if (sys.system.description) out.push(sys.system.description.trim(), '');
  out.push(
    `- **Id** \`${s.id}\` · **Source version** ${s.version}`,
    `- **Scope** ${placed.scope} — visibility \`${s.visibility}\`, owner \`${ownerToken(s.owner)}\` (opaque token), domain \`${sys.system.domain}\``,
    `- **Folder** \`${s.folder || '/'}\` · **Origin** ${s.origin}${s.sourceId ? ` (from \`${s.sourceId}\`)` : ''}`,
    `- **Engine** \`${sys.runtime}\` · **Safety preset** \`${sys.safetyPreset}\` · **Entrypoint** \`${sys.entrypoint}\``,
    `- **Schedule** ${sys.schedule?.kind ?? s.schedule.kind}${s.schedule.cron ? ` \`${s.schedule.cron}\`` : ''}${s.schedule.event ? ` on \`${s.schedule.event}\`` : ''} · **Running** ${s.running ? 'yes' : 'no'}`,
    `- **Last build** ${s.lastBuild ? `${s.lastBuild.ok ? 'ok' : 'FAILED'} at ${new Date(s.lastBuild.at).toISOString()}` : 'never built'}`,
    '',
    '## Members',
    '',
    '| Agent | Role | Model | Tools | Supervises | Enabled |',
    '|---|---|---|---|---|---|',
  );
  const disabled = new Set(s.disabledAgents);
  for (const a of sys.agents) out.push(memberRow(a, disabled));
  out.push('', '## Grants', '');
  const rows = [
    ...(sys.grants.tools.length > 0 ? [...sys.grants.tools].sort().map((t) => `| tool | \`${t}\` | — | — |`) : []),
    ...grantRows('data', sys.grants.data),
    ...grantRows('knowledge', sys.grants.knowledge),
    ...grantRows('metrics', sys.grants.metrics),
    ...grantRows('connections', sys.grants.connections),
    ...grantRows('files', sys.grants.files),
    ...grantRows('plan', sys.grants.plan),
  ];
  if (rows.length === 0) out.push('No grants declared — this system can reach nothing.');
  else out.push('| Kind | Target | Capability | Layer |', '|---|---|---|---|', ...rows);
  out.push(
    '',
    'Grant entries are **names and ids**, never credentials: at run time each one is resolved and',
    're-checked for the acting user by the governed MCP door (`grantedToolExecutor` → `handleRpc`).',
    '',
    '## State channels',
    '',
  );
  const channels = Object.entries(sys.state.channels).sort(([a], [b]) => a.localeCompare(b));
  if (channels.length === 0) out.push('None declared.');
  else {
    out.push('| Channel | Declared type |', '|---|---|');
    for (const [name, type] of channels) out.push(`| \`${name}\` | \`${type}\` |`);
  }
  out.push('', '## Edges', '');
  if (sys.edges.length === 0) out.push('None — a single-agent system.');
  else {
    out.push('| From | To | Type | When |', '|---|---|---|---|');
    for (const e of sys.edges) out.push(`| \`${e.from}\` | \`${e.to}\` | ${e.type} | ${e.when ? `\`${e.when}\`` : '—'} |`);
  }
  if (sys.outputs && sys.outputs.length > 0) {
    out.push('', '## Declared outputs', '');
    out.push('| Kind | Name | Folder |', '|---|---|---|');
    for (const o of sys.outputs) out.push(`| ${o.kind} | ${o.name} | \`${o.folder.path}\` (${o.folder.scope}) |`);
  }
  out.push(
    '',
    '---',
    '',
    'Generated by Sovereign OS from `system.yaml`. `graph.json` is the compiled LangGraph IR the',
    'engine builds its `StateGraph` from; `agents/<id>.md` is each agent\'s instruction file.',
    'Edit the system in the OS (Agents tab or the OS MCP); this file is regenerated on the next change.',
    '',
  );
  return out.join('\n');
}

// --------------------------------------------------------------- generate ---

/** Every file of one system's directory. */
export function generateSystemFiles(placed: PlacedSystem): Map<string, string> {
  const s = placed.system;
  const files = new Map<string, string>();
  files.set(`${placed.dir}/system.yaml`, s.yaml.endsWith('\n') ? s.yaml : `${s.yaml}\n`);
  let sys: System | null = null;
  try {
    sys = parseSystem(s.yaml);
  } catch {
    sys = null; // recorded in the README; the source is still committed above
  }
  if (sys) {
    for (const a of sys.agents) {
      const body = (a.agent_md ?? '').replace(/\s+$/, '');
      files.set(`${placed.dir}/agents/${segment(a.id, 'agent')}.md`, `${body}\n`);
    }
    files.set(`${placed.dir}/graph.json`, `${JSON.stringify(compile(sys), null, 2)}\n`);
  }
  files.set(`${placed.dir}/README.md`, renderReadme(s, placed, sys));
  return files;
}

/**
 * The complete `agents/` subtree of a domain: path → content, sorted by path. Hand this straight
 * to `commitSubtree(domain, AGENTS_PREFIX, files, …)`; an empty snapshot yields just the index,
 * so the last system's removal is a visible commit rather than a vanished directory.
 */
export function generateAgentFiles(snapshot: AgentProjectSnapshot): Map<string, string> {
  const placed = placeSystems(snapshot);
  const files = new Map<string, string>();
  files.set(`${AGENTS_PREFIX}index.yml`, renderIndex(snapshot, placed));
  for (const p of placed) {
    for (const [path, content] of generateSystemFiles(p)) files.set(path, content);
  }
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
