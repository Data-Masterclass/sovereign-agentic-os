/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    `generateDashboardFiles(snapshot)` — a domain's dashboards as readable code in git
 * USER STORY: As a user I want every save of a dashboard to be a commit I can read, and as an
 *             engineer I want to clone the domain repo and find the dashboard as one human-editable
 *             YAML file I could hand-edit and push back (D-R3.1, D-R3.2, D8, D9).
 * ARCHITECTURE:
 *   - PURE and byte-stable: same snapshot ⇒ identical file map, so `commitSubtree` commits nothing
 *     when nothing changed. No timestamps, ids, randomness or clocks are minted here.
 *   - Writes ONLY under `dashboards/` — the subtree this tab owns in the shared domain repo
 *     (`reserveSubtree('dashboards/')` + `commitSubtree`), exactly as `agents/` already does.
 *   - Layout: `dashboards/<slug>/` for a Domain/Company dashboard; `dashboards/personal/<token>/<slug>/`
 *     for a Personal one — the SAME lane split the data side chose (`models/personal/<uid>/`) and
 *     the agents side reused, so one repo has one convention. `dashboards/index.yml` maps slug → id,
 *     because a directory name is not an identity.
 *   - The format is the plan's D10 / research §4.4: `apiVersion: os.sovereign/v1`, `kind: Dashboard`,
 *     `metadata`, `spec.sources[]` by STABLE OS ID, `spec.panels[]`, `spec.layout`. It emits ONLY
 *     what the OS model actually holds today — there is no filter bar, no tab tree and no
 *     dashboard-level time range yet, so none is written. A format that promises fields the product
 *     cannot fill is a lie a future reader will believe.
 *   - References are `metric:<id>` / `dataset:<id>`, NEVER an embedded query: a dashboard file
 *     cannot smuggle SQL past the metric registry (D-R3.3). A member the registry does not own is
 *     written as `ref: unresolved` with the member name kept, so the file is honest rather than
 *     either silently wrong or missing the panel.
 *   - YAML is hand-rendered rather than dumped, so the bytes carry explanatory comments and a
 *     stable key order. `lib/git/parse.ts` reads it back; `generate.test.ts` pins the round trip.
 */
import type { DashboardProjectSnapshot, SnapshotDashboard, SnapshotPanel } from '@tabs/dashboards/lib/git/snapshot';
import { ownerToken, segment } from '@tabs/dashboards/lib/git/snapshot';

/** The subtree the Dashboards tab owns in a domain repo (always with the trailing slash). */
export const DASHBOARDS_PREFIX = 'dashboards/';

/** The directory a PERSONAL dashboard's lane lives under — mirrors `models/personal/<uid>/`. */
const PERSONAL_DIR = 'personal';

/** The format version written into every file. Bump only with a reader that accepts both. */
export const API_VERSION = 'os.sovereign/v1';

/** What `ref:` says when no governed id owns the member — never a fabricated id. */
export const UNRESOLVED_REF = 'unresolved';

export type PlacedDashboard = {
  dashboard: SnapshotDashboard;
  slug: string;
  scope: 'personal' | 'domain';
  /** Repo-relative directory, e.g. `dashboards/personal/1a2b3c4d5e6f/sales-overview`. */
  dir: string;
};

/**
 * The opaque owner token to WRITE for a dashboard. A snapshot taken from the registry carries the
 * real principal id and is hashed here; one parsed back from a file already carries the token, and
 * hashing a token again would break the round trip (sha256 of a 12-hex token is not that token).
 */
export function ownerRef(d: SnapshotDashboard): string {
  return d.ownerIsToken ? d.owner : ownerToken(d.owner);
}

/** The disambiguator appended when two dashboards in one directory slug identically. */
function shortId(id: string): string {
  return segment(id, 'x').slice(-12);
}

/**
 * Where each dashboard's directory goes. Deterministic: dashboards are taken in id order, the
 * first claimant of a slug keeps it and a later one gets `<slug>-<id suffix>`. A domain-scope
 * dashboard that would slug to `personal` is disambiguated too, so it can never shadow the lane.
 */
export function placeDashboards(snapshot: DashboardProjectSnapshot): PlacedDashboard[] {
  const taken = new Set<string>();
  const out: PlacedDashboard[] = [];
  for (const dashboard of [...snapshot.dashboards].sort((a, b) => a.id.localeCompare(b.id))) {
    const scope: 'personal' | 'domain' = dashboard.tier === 'personal' ? 'personal' : 'domain';
    const parent =
      scope === 'personal'
        ? `${DASHBOARDS_PREFIX}${PERSONAL_DIR}/${ownerRef(dashboard)}`
        : DASHBOARDS_PREFIX.slice(0, -1);
    const base = segment(dashboard.name, 'dashboard');
    const reserved = scope === 'domain' && base === PERSONAL_DIR;
    let slug = reserved ? `${base}-${shortId(dashboard.id)}` : base;
    if (taken.has(`${parent}/${slug}`)) slug = `${base}-${shortId(dashboard.id)}`;
    taken.add(`${parent}/${slug}`);
    out.push({ dashboard, slug, scope, dir: `${parent}/${slug}` });
  }
  return out;
}

// ------------------------------------------------------------------------- yaml ---

/**
 * A YAML scalar that cannot be mis-read: plain when obviously safe, else single-quoted.
 *
 * L-1: a value with leading or trailing whitespace is ALWAYS quoted. A plain YAML scalar is
 * stripped on read, so `name: 'Sales  '` written plain would come back as `Sales` and the
 * generate → read → generate round trip would not be byte-stable — the one property every other
 * guarantee here rests on.
 */
export function y(v: string | number | boolean): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v ?? '');
  const safe = /^[A-Za-z0-9][A-Za-z0-9 ._/:-]*$/.test(s) && s === s.trim() && !/ {2}/.test(s);
  if (safe && !/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

/** A YAML inline sequence of scalars (`[a, b]`), or `[]`. */
function seq(items: (string | number | boolean)[]): string {
  return items.length === 0 ? '[]' : `[${items.map(y).join(', ')}]`;
}

/** The deduplicated, sorted `spec.sources[]` of a dashboard: every governed id it depends on. */
export function sourcesOf(d: SnapshotDashboard): { ref: string; member?: string; view?: string }[] {
  const out: { ref: string; member?: string; view?: string }[] = [];
  const seen = new Set<string>();
  if (d.viewRef) {
    out.push({ ref: d.viewRef, view: d.view });
    seen.add(d.viewRef);
  }
  for (const panel of d.panels) {
    for (const m of panel.metrics) {
      const ref = m.ref ?? UNRESOLVED_REF;
      const key = `${ref}|${m.member}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ref, member: m.member });
    }
  }
  return out;
}

function panelBlock(p: SnapshotPanel): string[] {
  const lines = [
    `    - id: ${y(p.id)}`,
    `      name: ${y(p.name)}`,
    `      viz: ${y(p.viz)}`,
    `      metrics: ${seq(p.metrics.map((m) => m.member))}`,
  ];
  if (p.dimensions.length > 0) lines.push(`      dimensions: ${seq(p.dimensions)}`);
  if (p.timeDimension) lines.push(`      timeDimension: ${y(p.timeDimension)}`);
  if (p.timeGrain) lines.push(`      timeGrain: ${y(p.timeGrain)}`);
  if (p.filters.length > 0) {
    lines.push('      filters:');
    for (const f of p.filters) {
      lines.push(`        - member: ${y(f.member)}`, `          operator: ${y(f.operator)}`, `          values: ${seq(f.values)}`);
    }
  }
  if (p.gridPos) {
    lines.push(`      gridPos: { x: ${p.gridPos.x}, y: ${p.gridPos.y}, w: ${p.gridPos.w}, h: ${p.gridPos.h} }`);
  }
  return lines;
}

/** `dashboards/<slug>/dashboard.yaml` — THE artefact. */
export function renderDashboardYaml(placed: PlacedDashboard, domain: string): string {
  const d = placed.dashboard;
  const lines: string[] = [
    '# A Sovereign OS dashboard, as code. Generated by the OS; safe to hand-edit and push back —',
    '# the receive gate validates this file with the SAME schema the UI and the MCP use.',
    '#',
    '# `spec.sources[].ref` is a STABLE OS ID (`metric:<id>` / `dataset:<id>`). A panel addresses',
    '# governed metric members ONLY: there is no SQL field, and there never will be, so a dashboard',
    '# file cannot smuggle a query past the metric registry. Every number is still resolved live,',
    '# as the VIEWER, with that viewer\'s row-level security applied.',
    `apiVersion: ${API_VERSION}`,
    'kind: Dashboard',
    'metadata:',
    `  id: ${y(d.id)}`,
    `  name: ${y(d.name)}`,
    `  domain: ${y(domain)}`,
    // The OWNER is an opaque, stable token, never a username or an e-mail address: this file
    // travels to every mirror and clone of the repository. The person is named in the commit.
    `  owner: ${y(ownerRef(d))}   # opaque token for the owning principal (sha256 prefix)`,
    `  tier: ${y(d.tier)}                 # personal | domain | marketplace (the AUDIENCE ladder)`,
    `  folder: ${y(d.folder)}`,
  ];
  if (d.lifecycle) {
    lines.push(
      '  lifecycle:                      # which VERSION is being built / tested / run (set by the OS)',
      ...(d.lifecycle.draft ? [`    draft: ${y(d.lifecycle.draft)}`] : []),
      ...(d.lifecycle.testing ? [`    testing: ${y(d.lifecycle.testing)}`] : []),
      ...(d.lifecycle.live ? [`    live: ${y(d.lifecycle.live)}`] : []),
    );
  }
  lines.push('spec:', `  view: ${y(d.view)}`, '  sources:');
  const sources = sourcesOf(d);
  if (sources.length === 0) {
    lines.pop();
    lines.push('  sources: []');
  } else {
    for (const s of sources) {
      lines.push(`    - ref: ${y(s.ref)}`);
      if (s.member) lines.push(`      member: ${y(s.member)}`);
      if (s.view) lines.push(`      view: ${y(s.view)}`);
    }
  }
  if (d.filters.length > 0) {
    lines.push('  filters:                        # the dashboard\'s authored default filter chips');
    for (const f of d.filters) {
      lines.push(`    - member: ${y(f.member)}`, `      operator: ${y(f.operator)}`, `      values: ${seq(f.values)}`);
    }
  }
  lines.push('  panels:');
  if (d.panels.length === 0) {
    lines.pop();
    lines.push('  panels: []');
  } else {
    for (const p of d.panels) lines.push(...panelBlock(p));
  }
  // H-6: `spec.layout` is NOT emitted. It was a second copy of each panel's `gridPos`, and the
  // file invites hand editing — so an engineer who re-ordered the layout block and not the panels
  // would have had their change silently lost, which is the worst outcome of the two doors. One
  // fact, written once: a panel's position is its `gridPos`. (`lib/git/parse.ts` still READS a
  // `layout` block, so a file written by an older OS, or by hand, is accepted — and a block that
  // disagrees with the panels is refused by name rather than ignored. Tabs and drag/resize are
  // backlog item D14; when a real layout TREE exists it will carry something `gridPos` cannot,
  // and then it earns its place in the file.)
  return `${lines.join('\n')}\n`;
}

/** `dashboards/index.yml` — the slug → identity map. A directory name is not an identity. */
export function renderIndex(snapshot: DashboardProjectSnapshot, placed: PlacedDashboard[]): string {
  const lines = [
    '# Dashboards of this domain, generated by Sovereign OS. Do not edit by hand.',
    '# A directory name is a slug; the `id` is the dashboard\'s frozen identity in the OS.',
    '# `owner` is an OPAQUE, stable token for the owning principal (sha256 prefix), never a',
    '# username or an e-mail address: this file travels to every mirror and clone of the repo.',
    'version: 1',
    `domain: ${y(snapshot.domain)}`,
  ];
  if (placed.length === 0) {
    lines.push('dashboards: []');
    return `${lines.join('\n')}\n`;
  }
  lines.push('dashboards:');
  for (const p of placed) {
    const d = p.dashboard;
    lines.push(`  - slug: ${y(p.slug)}`);
    lines.push(`    id: ${y(d.id)}`);
    lines.push(`    path: ${y(p.dir)}`);
    lines.push(`    name: ${y(d.name)}`);
    lines.push(`    owner: ${y(ownerRef(d))}`);
    lines.push(`    scope: ${y(p.scope)}`);
    lines.push(`    tier: ${y(d.tier)}`);
    lines.push(`    view: ${y(d.view)}`);
    lines.push(`    panels: ${d.panels.length}`);
    lines.push(`    folder: ${y(d.folder)}`);
    if (d.lifecycle?.live) lines.push(`    live: ${y(d.lifecycle.live)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The generated `README.md` — what it charts, who owns it, how to open it. */
export function renderReadme(placed: PlacedDashboard, domain: string): string {
  const d = placed.dashboard;
  const out: string[] = [`# ${d.name}`, ''];
  out.push(
    `- **Id** \`${d.id}\` · **Domain** \`${domain}\``,
    `- **Audience** \`${d.tier}\` · **Owner** \`${ownerRef(d)}\` (opaque token) · **Scope** ${placed.scope}`,
    `- **Governed view** \`${d.view}\`${d.viewRef ? ` (\`${d.viewRef}\`)` : ' — no dataset id resolved'}`,
    `- **Folder** \`${d.folder}\``,
  );
  if (d.lifecycle) {
    const bits = [
      d.lifecycle.draft ? `draft \`${d.lifecycle.draft}\`` : null,
      d.lifecycle.testing ? `testing \`${d.lifecycle.testing}\`` : null,
      d.lifecycle.live ? `live \`${d.lifecycle.live}\`` : null,
    ].filter(Boolean);
    out.push(`- **Lifecycle** ${bits.length > 0 ? bits.join(' · ') : 'no version pinned'}`);
  }
  out.push('', '## Panels', '');
  if (d.panels.length === 0) {
    out.push('None yet — this dashboard has no panels.');
  } else {
    out.push('| Panel | Viz | Governed members | Grouped by | Over time |', '|---|---|---|---|---|');
    for (const p of d.panels) {
      const members = p.metrics.map((m) => `\`${m.member}\`${m.ref ? '' : ' **(unresolved)**'}`).join(', ') || '—';
      const dims = p.dimensions.length > 0 ? p.dimensions.map((x) => `\`${x}\``).join(', ') : '—';
      const time = p.timeDimension ? `\`${p.timeDimension}\`${p.timeGrain ? ` by ${p.timeGrain}` : ''}` : '—';
      out.push(`| ${p.name} | ${p.viz} | ${members} | ${dims} | ${time} |`);
    }
  }
  const unresolved = d.panels.flatMap((p) => p.metrics.filter((m) => !m.ref).map((m) => m.member));
  if (unresolved.length > 0) {
    out.push(
      '',
      '> **Some members do not resolve to a governed metric id.** They are written as',
      `> \`ref: ${UNRESOLVED_REF}\` with the member name kept, rather than given an invented id. The`,
      '> dashboard still renders, with the OS\'s honest missing-member warning on the affected panel,',
      `> until the metric exists in this domain: ${unresolved.map((m) => `\`${m}\``).join(', ')}.`,
    );
  }
  out.push(
    '',
    '## How the numbers are resolved',
    '',
    'A panel addresses **governed metric members only** — there is no SQL in this file and no SQL',
    'field in the format. At render time each member is resolved through the metric registry and',
    'served as one governed Trino `SELECT` **as the viewer**, so two people opening the same',
    'dashboard see the rows their own entitlements allow. A member the governed model does not',
    'expose produces a visible warning, never a silently un-grouped chart.',
    '',
    '## Working on this outside the OS',
    '',
    '```sh',
    `git clone <os>/git/${domain}.git && cd ${domain}`,
    `$EDITOR ${placed.dir}/dashboard.yaml`,
    'git commit -am "edit dashboard" && git push',
    '```',
    '',
    'The push is validated by the same schema the UI and the MCP use, and the OS reconciles its',
    'registry from the file. Charting a member that does not exist in this domain is **refused** on',
    'push, naming the file and the id.',
    '',
    '---',
    '',
    'Generated by Sovereign OS from the dashboard registry. Edit the dashboard in the OS',
    '(Dashboards tab or the OS MCP), or edit `dashboard.yaml` and push; this file is regenerated on',
    'the next change.',
    '',
  );
  return out.join('\n');
}

/** Every file of one dashboard's directory. */
export function generateDashboardDir(placed: PlacedDashboard, domain: string): Map<string, string> {
  const files = new Map<string, string>();
  files.set(`${placed.dir}/dashboard.yaml`, renderDashboardYaml(placed, domain));
  files.set(`${placed.dir}/README.md`, renderReadme(placed, domain));
  return files;
}

/**
 * The complete `dashboards/` subtree of a domain: path → content, sorted by path. Hand this
 * straight to `commitSubtree(domain, DASHBOARDS_PREFIX, files, …)`; an empty snapshot yields just
 * the index, so the last dashboard's removal is a visible commit rather than a vanished directory.
 */
export function generateDashboardFiles(snapshot: DashboardProjectSnapshot): Map<string, string> {
  const placed = placeDashboards(snapshot);
  const files = new Map<string, string>();
  files.set(`${DASHBOARDS_PREFIX}index.yml`, renderIndex(snapshot, placed));
  for (const p of placed) {
    for (const [path, content] of generateDashboardDir(p, snapshot.domain)) files.set(path, content);
  }
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
