/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    The reader for `dashboards/<slug>/dashboard.yaml` — round-trip, and loud on a bad id
 * USER STORY: As an engineer I want to hand-edit a dashboard file, push it, and have the OS accept
 *             exactly what the UI would have written — or refuse it with a message naming the file
 *             and the reason (D-R3.2, D-R3.4, D9).
 * ARCHITECTURE:
 *   - The SAME validator both doors call: the receive gate (stream E) and the UI/MCP write path
 *     use `parseDashboardFile` + `importDashboard`. If the gate grew its own, the two sides of the
 *     coin would drift within a week and the drift would read as "the UI refused this and git
 *     accepted it", which is the worst failure a governance product can have.
 *   - Every refusal is a typed `status: 400` naming the field. Never a generic throw, never a
 *     silent default: a dashboard that quietly loses a panel on import is worse than a rejection.
 *   - ROUND-TRIP: `parseDashboardFile` returns the `SnapshotDashboard` shape `generate.ts` renders
 *     from, so `render(parse(render(x))) === render(x)` is a byte comparison, which is what
 *     `generate.test.ts` asserts. There is no second, lossy intermediate model.
 *   - D-R3.3: the parser REFUSES any key that looks like an embedded query (`sql`, `query`,
 *     `expression`, …) anywhere in `spec`. The format has no such field, and the refusal is what
 *     stops one being smuggled in by a hand edit.
 *   - D-R3.4: `importDashboard` resolves every `metric:<id>` / `dataset:<id>` in the TARGET domain
 *     and fails loudly on a missing one. It never falls back to the member name, because a
 *     dashboard that silently binds to a different number is the exact failure mode the governed
 *     layer exists to prevent.
 */
import { load } from 'js-yaml';
import type { DashTier } from '@tabs/dashboards/lib/governance';
import { VIZ_TYPES, type DashboardSpec, type Panel, type PanelFilter, type VizType, isServableOperator } from '@tabs/dashboards/lib/model';
import { API_VERSION, UNRESOLVED_REF } from '@tabs/dashboards/lib/git/generate';
import type { SnapshotDashboard, SnapshotPanel } from '@tabs/dashboards/lib/git/snapshot';

/**
 * A typed, actionable refusal: `status: 400`, and the message names the FILE and the field, so a
 * developer's terminal tells them what to fix. No TypeScript parameter properties — Node's
 * type-stripping loader, which runs this suite, refuses them.
 */
export class DashboardFileError extends Error {
  status = 400;
  /** The repo-relative path the refusal is about, when the caller supplied one. */
  file: string | undefined;
  constructor(message: string, file?: string) {
    super(file ? `${file}: ${message}` : message);
    this.name = 'DashboardFileError';
    this.file = file;
  }
}

function bad(message: string, file?: string): never {
  throw new DashboardFileError(message, file);
}

/** Keys that would be an embedded query. The format has none; a hand edit may not add one. */
const FORBIDDEN_KEYS = ['sql', 'query', 'rawsql', 'expression', 'adhoc', 'subquery', 'datasource'];

function assertNoQueryKeys(node: unknown, where: string, file?: string): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => assertNoQueryKeys(n, `${where}[${i}]`, file));
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.includes(k.toLowerCase())) {
      bad(
        `\`${where}.${k}\` is not a field of this format. A panel addresses GOVERNED METRIC MEMBERS ` +
          'only — a dashboard may never carry its own SQL, because that would put a number outside ' +
          'the metric registry and outside its row-level security. Define a governed metric in the ' +
          'Metrics tab and reference it by `metric:<id>`.',
        file,
      );
    }
    assertNoQueryKeys(v, `${where}.${k}`, file);
  }
}

function str(v: unknown, where: string, file?: string): string {
  if (typeof v !== 'string' || v.trim() === '') bad(`\`${where}\` must be a non-empty string`, file);
  return (v as string).trim();
}

function strArr(v: unknown, where: string, file?: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) bad(`\`${where}\` must be a list`, file);
  return (v as unknown[]).map((x, i) => str(x, `${where}[${i}]`, file));
}

function filters(v: unknown, where: string, file?: string): PanelFilter[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) bad(`\`${where}\` must be a list`, file);
  return (v as unknown[]).map((raw, i) => {
    if (!raw || typeof raw !== 'object') bad(`\`${where}[${i}]\` must be a mapping`, file);
    const f = raw as Record<string, unknown>;
    const operator = str(f.operator, `${where}[${i}].operator`, file);
    if (!isServableOperator(operator)) {
      bad(
        `\`${where}[${i}].operator\` is “${operator}”, which the governed query path cannot serve ` +
          '(it compiles a filter to an IN list, so only `equals` and `in` are servable). The file is ' +
          'REFUSED rather than imported and then silently under-filtered at render time.',
        file,
      );
    }
    return {
      member: str(f.member, `${where}[${i}].member`, file),
      operator,
      values: strArr(f.values, `${where}[${i}].values`, file),
    };
  });
}

function gridPos(v: unknown, where: string, file?: string): SnapshotPanel['gridPos'] {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object') bad(`\`${where}\` must be a mapping of x/y/w/h`, file);
  const g = v as Record<string, unknown>;
  const n = (k: string): number => {
    const raw = g[k];
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) bad(`\`${where}.${k}\` must be a non-negative integer`, file);
    return raw as number;
  };
  return { x: n('x'), y: n('y'), w: n('w'), h: n('h') };
}

const TIERS: DashTier[] = ['personal', 'domain', 'marketplace'];

/**
 * Parse one `dashboard.yaml` into the SAME shape the generator renders from, so a parse → render
 * round trip is byte-stable. Every failure is a typed 400 naming the field.
 */
export function parseDashboardFile(text: string, file?: string): SnapshotDashboard {
  let doc: unknown;
  try {
    doc = load(text);
  } catch (e) {
    bad(`not valid YAML — ${e instanceof Error ? e.message : String(e)}`, file);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) bad('the file must be a YAML mapping', file);
  const root = doc as Record<string, unknown>;

  const apiVersion = str(root.apiVersion, 'apiVersion', file);
  if (apiVersion !== API_VERSION) {
    bad(`\`apiVersion\` is “${apiVersion}”; this OS reads “${API_VERSION}”`, file);
  }
  if (str(root.kind, 'kind', file) !== 'Dashboard') bad('`kind` must be `Dashboard`', file);

  const meta = (root.metadata ?? {}) as Record<string, unknown>;
  if (!meta || typeof meta !== 'object') bad('`metadata` must be a mapping', file);
  const spec = (root.spec ?? {}) as Record<string, unknown>;
  if (!spec || typeof spec !== 'object') bad('`spec` must be a mapping', file);
  assertNoQueryKeys(spec, 'spec', file);

  const tier = str(meta.tier, 'metadata.tier', file) as DashTier;
  if (!TIERS.includes(tier)) bad(`\`metadata.tier\` must be one of ${TIERS.join(' | ')}`, file);

  // `sources[]` is DERIVED from the panels on generate, so it is read back only to recover each
  // member's governed id. A member absent from `sources` is treated as unresolved, not as an error:
  // the panels are the authority on what the dashboard charts.
  const refByMember = new Map<string, string>();
  const rawSources = spec.sources;
  if (rawSources !== undefined && rawSources !== null) {
    if (!Array.isArray(rawSources)) bad('`spec.sources` must be a list', file);
    for (const [i, raw] of (rawSources as unknown[]).entries()) {
      if (!raw || typeof raw !== 'object') bad(`\`spec.sources[${i}]\` must be a mapping`, file);
      const s = raw as Record<string, unknown>;
      const ref = str(s.ref, `spec.sources[${i}].ref`, file);
      if (ref !== UNRESOLVED_REF && !/^(metric|dataset):[A-Za-z0-9._:-]+$/.test(ref)) {
        bad(
          `\`spec.sources[${i}].ref\` is “${ref}”; a source must be a stable OS id — ` +
            `\`metric:<id>\` or \`dataset:<id>\` — or \`${UNRESOLVED_REF}\``,
          file,
        );
      }
      if (typeof s.member === 'string' && ref !== UNRESOLVED_REF) refByMember.set(s.member.trim(), ref);
    }
  }

  const rawPanels = spec.panels;
  if (rawPanels !== undefined && rawPanels !== null && !Array.isArray(rawPanels)) bad('`spec.panels` must be a list', file);
  const panels: SnapshotPanel[] = ((rawPanels ?? []) as unknown[]).map((raw, i) => {
    if (!raw || typeof raw !== 'object') bad(`\`spec.panels[${i}]\` must be a mapping`, file);
    const p = raw as Record<string, unknown>;
    const viz = str(p.viz, `spec.panels[${i}].viz`, file) as VizType;
    if (!(VIZ_TYPES as readonly string[]).includes(viz)) {
      bad(`\`spec.panels[${i}].viz\` is “${viz}”; it must be one of ${VIZ_TYPES.join(' | ')}`, file);
    }
    const members = strArr(p.metrics, `spec.panels[${i}].metrics`, file);
    if (members.length === 0) bad(`\`spec.panels[${i}].metrics\` must name at least one governed member`, file);
    const timeDimension = p.timeDimension === undefined || p.timeDimension === null ? undefined : str(p.timeDimension, `spec.panels[${i}].timeDimension`, file);
    const timeGrain = p.timeGrain === undefined || p.timeGrain === null ? undefined : str(p.timeGrain, `spec.panels[${i}].timeGrain`, file);
    return {
      id: str(p.id, `spec.panels[${i}].id`, file),
      name: str(p.name, `spec.panels[${i}].name`, file),
      viz,
      metrics: members.map((member) => ({ member, ref: refByMember.get(member) ?? null })),
      dimensions: strArr(p.dimensions, `spec.panels[${i}].dimensions`, file),
      ...(timeDimension ? { timeDimension } : {}),
      ...(timeGrain ? { timeGrain } : {}),
      filters: filters(p.filters, `spec.panels[${i}].filters`, file),
      ...(() => {
        const g = gridPos(p.gridPos, `spec.panels[${i}].gridPos`, file);
        return g ? { gridPos: g } : {};
      })(),
    };
  });

  const lifecycleRaw = meta.lifecycle;
  let lifecycle: SnapshotDashboard['lifecycle'];
  if (lifecycleRaw && typeof lifecycleRaw === 'object') {
    const l = lifecycleRaw as Record<string, unknown>;
    const pick = (k: 'draft' | 'testing' | 'live') => (typeof l[k] === 'string' && (l[k] as string).trim() ? { [k]: (l[k] as string).trim() } : {});
    const merged = { ...pick('draft'), ...pick('testing'), ...pick('live') };
    if (Object.keys(merged).length > 0) lifecycle = merged;
  }

  const view = str(spec.view, 'spec.view', file);
  const viewSource = ((rawSources ?? []) as Record<string, unknown>[]).find((s) => typeof s?.view === 'string');
  return {
    id: str(meta.id, 'metadata.id', file),
    name: str(meta.name, 'metadata.name', file),
    view,
    viewRef: typeof viewSource?.ref === 'string' && viewSource.ref !== UNRESOLVED_REF ? (viewSource.ref as string) : null,
    // The file carries only the OPAQUE owner token; the real principal lives in the OS registry
    // and in the commit. `ownerIsToken` tells the generator not to hash it again (sha256 of a
    // 12-hex token is not that token), which is what makes the round trip byte-stable.
    owner: str(meta.owner, 'metadata.owner', file),
    ownerIsToken: true,
    tier,
    folder: typeof meta.folder === 'string' && meta.folder.trim() ? meta.folder.trim() : '/',
    archived: false,
    filters: filters(spec.filters, 'spec.filters', file),
    panels,
    ...(lifecycle ? { lifecycle } : {}),
  };
}

/**
 * Resolve a governed id in the TARGET domain. Returns the member a `metric:<id>` serves, or `null`
 * when the id does not exist for this caller — which is a REFUSAL, never a fallback.
 */
export type RefResolver = (ref: string) => { member: string } | null;

/**
 * Import a parsed file as a `DashboardSpec` the store can save, resolving every governed id in the
 * target domain. A missing id fails loudly, naming the id and the panel (D-R3.4).
 */
export function importDashboard(doc: SnapshotDashboard, resolve: RefResolver, file?: string): DashboardSpec {
  const charts: Panel[] = doc.panels.map((p) => {
    const metrics = p.metrics.map((m) => {
      if (!m.ref || m.ref === UNRESOLVED_REF) {
        bad(
          `panel “${p.name}” charts member “${m.member}”, which this file does not bind to a governed ` +
            'metric id. Import is REFUSED: binding by member name alone could attach the panel to a ' +
            'different number in this domain. Add `spec.sources[] { ref: metric:<id>, member: ' +
            `${m.member} }\`, or define the metric here first.`,
          file,
        );
      }
      const hit = resolve(m.ref);
      if (!hit) {
        bad(
          `panel “${p.name}” references \`${m.ref}\`, which does not exist in this domain (or is ` +
            'outside your entitlement). Import is REFUSED — a dashboard is never silently rebound.',
          file,
        );
      }
      return hit.member;
    });
    return {
      name: p.name,
      vizType: p.viz,
      metrics,
      ...(p.dimensions.length > 0 ? { dimensions: p.dimensions } : {}),
      ...(p.timeDimension ? { timeDimension: p.timeDimension } : {}),
      ...(p.timeGrain ? { timeGrain: p.timeGrain as Panel['timeGrain'] } : {}),
      ...(p.filters.length > 0 ? { filters: p.filters } : {}),
      ...(p.gridPos ? { gridPos: p.gridPos } : {}),
    };
  });
  return {
    name: doc.name,
    view: doc.view,
    charts,
    ...(doc.filters.length > 0 ? { filters: doc.filters } : {}),
  };
}
