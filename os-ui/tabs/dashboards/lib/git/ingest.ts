/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    `ingestFromRepo('dashboard', files)` — the per-kind reverse mapping stream E calls
 * USER STORY: As an engineer I want to edit `dashboards/<slug>/dashboard.yaml` in VS Code, push it,
 *             and see the OS registry pick it up — the same coin as the UI and the MCP (D29, D-R3.4).
 * ARCHITECTURE:
 *   - THE CONTRACT FOR STREAM E. `reconcileFromGit(domain, fromSha, toSha)` is E's orchestration;
 *     this is the dashboards half: pushed file bytes in, a typed plan out. It is PURE — it decides
 *     and reports, it does not write — so E can run it inside the receive gate (to REFUSE a bad
 *     push before it lands) and again after the push (to apply it), with the same code.
 *   - Both doors share ONE validator: `lib/git/parse.ts`. The receive gate must not grow its own,
 *     or "the UI refused this and git accepted it" becomes possible, which is the worst failure a
 *     governance product can have.
 *   - A push that references a metric this domain does not have is REFUSED, naming the id — never
 *     partially applied, and never rebound to a same-named member (D-R3.4).
 *   - The plan is attributed to the PUSHER by E (`OS-Surface: git:push`); nothing here mints an
 *     actor, a timestamp or an id.
 *   - Only `dashboards/**\/dashboard.yaml` is read. `index.yml` and `README.md` are GENERATED, so a
 *     hand edit to them is ignored rather than honoured — the OS regenerates both on the next
 *     commit, and treating a generated file as input would make the two doors disagree.
 */
import type { DashboardSpec } from '@tabs/dashboards/lib/model';
import { DASHBOARDS_PREFIX } from '@tabs/dashboards/lib/git/generate';
import { DashboardFileError, importDashboard, parseDashboardFile, type RefResolver } from '@tabs/dashboards/lib/git/parse';
import type { SnapshotDashboard } from '@tabs/dashboards/lib/git/snapshot';

/** The object kinds this module handles. One kind, by design — E composes the others. */
export const INGEST_KIND = 'dashboard';

/** One dashboard the push wants the registry to hold. */
export type DashboardIngest = {
  /** The repo-relative path the dashboard came from, for every message. */
  file: string;
  /** The dashboard's frozen OS id, from `metadata.id`. */
  id: string;
  /** The audience tier declared in the file. */
  tier: SnapshotDashboard['tier'];
  /** The spec the store should save, with every governed id already resolved. */
  spec: DashboardSpec;
  /** The parsed file, for the lifecycle pin and anything else E wants to record. */
  doc: SnapshotDashboard;
};

/** One file the push could not accept, with the reason a developer's terminal will show. */
export type IngestRejection = { file: string; reason: string };

/** The decision: what to apply, and what to refuse. */
export type IngestPlan = {
  kind: typeof INGEST_KIND;
  dashboards: DashboardIngest[];
  rejected: IngestRejection[];
  /** Files under `dashboards/` that are generated, so deliberately not read as input. */
  ignored: string[];
};

/** Is this repo path a dashboard-as-code artefact (and not a generated file)? */
export function isDashboardFile(path: string): boolean {
  return path.startsWith(DASHBOARDS_PREFIX) && path.endsWith('/dashboard.yaml');
}

/** Is this a file under `dashboards/` that the OS GENERATES and therefore never reads back? */
export function isGeneratedDashboardFile(path: string): boolean {
  if (!path.startsWith(DASHBOARDS_PREFIX)) return false;
  return path === `${DASHBOARDS_PREFIX}index.yml` || path.endsWith('/README.md');
}

/**
 * Decide what a pushed `dashboards/**` tree means for the registry.
 *
 * `files` is repo-relative path → UTF-8 content, exactly as the receive gate has it. `resolve`
 * resolves a `metric:<id>` / `dataset:<id>` **in the target domain, as the pusher** — so a
 * reference the pusher cannot see is indistinguishable from one that does not exist, which is the
 * OS's `not_found` convention.
 *
 * Every failure lands in `rejected` with a readable reason rather than throwing, so one bad file
 * does not hide the other nine; E refuses the push when `rejected` is non-empty.
 */
export function ingestFromRepo(kind: string, files: Map<string, string>, resolve: RefResolver): IngestPlan {
  if (kind !== INGEST_KIND) {
    throw new DashboardFileError(`ingestFromRepo: this module handles kind '${INGEST_KIND}', not '${kind}'`);
  }
  const plan: IngestPlan = { kind: INGEST_KIND, dashboards: [], rejected: [], ignored: [] };
  for (const path of [...files.keys()].sort()) {
    if (isGeneratedDashboardFile(path)) {
      plan.ignored.push(path);
      continue;
    }
    if (!isDashboardFile(path)) continue;
    try {
      const doc = parseDashboardFile(files.get(path) ?? '', path);
      const spec = importDashboard(doc, resolve, path);
      plan.dashboards.push({ file: path, id: doc.id, tier: doc.tier, spec, doc });
    } catch (e) {
      plan.rejected.push({ file: path, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return plan;
}

/** True when the push may be accepted. E turns `false` into a pre-receive refusal. */
export function ingestAccepted(plan: IngestPlan): boolean {
  return plan.rejected.length === 0;
}

/** The message a developer's terminal shows for a refused push. One line per bad file. */
export function ingestRefusalMessage(plan: IngestPlan): string {
  if (plan.rejected.length === 0) return '';
  return [
    `Rejected: ${plan.rejected.length} dashboard file${plan.rejected.length === 1 ? '' : 's'} the OS cannot accept.`,
    ...plan.rejected.map((r) => `  ${r.reason}`),
    'Nothing was applied — fix the file(s) and push again.',
  ].join('\n');
}
