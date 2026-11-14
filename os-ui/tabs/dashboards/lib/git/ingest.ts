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
  /**
   * H-8: there is deliberately NO `tier` here. `metadata.tier` is the AUDIENCE ladder
   * (`personal` → `domain` → `marketplace`), which moves only through the governed promotion
   * path with its roles, requests and approvals. Carrying it into the plan would let a creator's
   * `git push` publish their own dashboard to the whole company with no approver — a governance
   * bypass wearing a green tick. The file's tier is read and shape-checked by
   * `lib/git/parse.ts` so a typo is caught and the file round-trips, and it is then DISCARDED:
   * on ingest the OS keeps whatever tier the registry already holds, and a new dashboard starts
   * where every new dashboard starts.
   */
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
  /**
   * How many `dashboard.yaml` files the pushed tree carries, whether or not they parsed. This is
   * the DENOMINATOR the caller needs; `dashboards.length` alone cannot distinguish "a push with
   * no dashboard files in it" from "a push that deletes every dashboard in the domain".
   */
  files: number;
  /**
   * H-7: true when the pushed tree touches `dashboards/` but contains NO `dashboard.yaml` at all —
   * i.e. applying this plan would EMPTY the subtree. It is reported rather than decided here,
   * because only the caller knows whether the domain had dashboards before the push. Stream E must
   * refuse such a push unless it is a deliberate, confirmed deletion: the OS's
   * `DestructiveReconcileError` exists for exactly this shape of mistake, and an ingest that
   * silently applied it would delete a domain's dashboards from a push that merely forgot a path.
   */
  emptied: boolean;
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
  const plan: IngestPlan = { kind: INGEST_KIND, dashboards: [], rejected: [], ignored: [], files: 0, emptied: false };
  let touchesSubtree = false;
  for (const path of [...files.keys()].sort()) {
    if (path.startsWith(DASHBOARDS_PREFIX)) touchesSubtree = true;
    if (isGeneratedDashboardFile(path)) {
      plan.ignored.push(path);
      continue;
    }
    if (!isDashboardFile(path)) continue;
    plan.files += 1;
    try {
      const doc = parseDashboardFile(files.get(path) ?? '', path);
      const spec = importDashboard(doc, resolve, path);
      plan.dashboards.push({ file: path, id: doc.id, spec, doc });
    } catch (e) {
      plan.rejected.push({ file: path, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  plan.emptied = touchesSubtree && plan.files === 0;
  return plan;
}

/**
 * True when the push may be accepted. E turns `false` into a pre-receive refusal.
 *
 * H-7: an EMPTYING push is not accepted by default. A tree that touches `dashboards/` but carries
 * no `dashboard.yaml` would delete every dashboard in the domain, which is almost always a push
 * that forgot a path rather than an intent. A caller that really means it passes
 * `{ allowEmptying: true }` after its own confirmation — the same shape as the git store's
 * `DestructiveReconcileError` guard, and for the same reason.
 */
export function ingestAccepted(plan: IngestPlan, opts: { allowEmptying?: boolean } = {}): boolean {
  if (plan.rejected.length > 0) return false;
  if (plan.emptied && !opts.allowEmptying) return false;
  return true;
}

/** The message a developer's terminal shows for a refused push. One line per bad file. */
export function ingestRefusalMessage(plan: IngestPlan): string {
  if (plan.rejected.length === 0) {
    if (!plan.emptied) return '';
    return [
      'Rejected: this push removes every dashboard.yaml from `dashboards/` while still changing that',
      'subtree, so applying it would delete every dashboard in this domain.',
      'If that is really what you mean, delete them in the OS (or over the MCP) where the removal is',
      'an audited, reversible action per dashboard. Nothing was applied.',
    ].join('\n');
  }
  return [
    `Rejected: ${plan.rejected.length} dashboard file${plan.rejected.length === 1 ? '' : 's'} the OS cannot accept.`,
    ...plan.rejected.map((r) => `  ${r.reason}`),
    'Nothing was applied — fix the file(s) and push again.',
  ].join('\n');
}
