/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    `dashboards/<slug>/dashboard.yaml` pushed by an engineer → the dashboard in the registry
 * USER STORY: As an analytics engineer I want to edit a dashboard-as-code file in VS Code, `git
 *             push`, and see the dashboard in the OS change exactly as if I had saved it in the UI —
 *             same validator, same store gate, same version history (D29, checklist E9).
 * ARCHITECTURE:
 *   - NIGHT-2 MERGE (E x D). Stream E owns the receive gate and the `registerRepoKind` seam (a core
 *     module may not import a tab); stream D owns what a pushed dashboard file MEANS
 *     (`lib/git/ingest.ts` + `lib/git/parse.ts`). This file is the join, and nothing else: it holds
 *     no parsing, no schema and no view shape of its own.
 *   - ONE VALIDATOR, TWO DOORS (D28): `parseDashboardFile` is the same function the UI's and the
 *     MCP's read path calls. A file that does not parse is a 422 on the developer's terminal naming
 *     the file, and NOTHING of the push is applied.
 *   - THE WRITE GOES THROUGH `saveDashboard`, the store chokepoint that re-gates edit scope
 *     (owner / in-domain domain_admin / admin), runs `assertServableFilters`, snapshots the prior
 *     spec to the version log and emits the commit. Never a raw record mutation.
 *   - AUDIENCE IS NOT PUSHABLE (D's H-8): `metadata.tier` is read and shape-checked so the file
 *     round-trips, then DISCARDED. `saveDashboard` keeps whatever tier the registry holds and a new
 *     dashboard starts Personal, so a `git push` can never publish to a domain audience — that is a
 *     governed promotion with its own roles and approvals.
 *   - EMPTYING IS REFUSED, and refused EARLIER than D asked for: D's `ingestAccepted(plan, {
 *     allowEmptying })` exists for the case where applying a plan would delete every dashboard in
 *     the domain, and asks E to refuse it unless a confirmation said otherwise. The gate already
 *     refuses that shape in `beginReceive` via `emptiedDirs` + `DESTRUCTIVE_PUSH`, before any
 *     validator runs — and there is NO confirmation door in a `git push`, so `allowEmptying` is
 *     never passed here. `ingestAccepted` is still consulted as the second line of defence, and a
 *     plan it refuses throws D's own `ingestRefusalMessage` rather than applying a subset.
 *   - A GENERATED file (`dashboards/index.yml`, a `README.md`) is never input: the OS writes it on
 *     every commit, and reading it back would make the two doors disagree. `matches` therefore
 *     claims only `dashboard.yaml`, which also leaves the generated files to the gate's own
 *     OS-managed refusal.
 */
import {
  AUDIENCE_MANAGED,
  governedRefResolverWired,
  registerRepoKind,
  resolveGovernedRef,
  type ChangedFile,
  type IngestReport,
  type Pusher,
} from '@core/infra/git-receive';
import { runWithSurface } from '@core/infra/request-surface';
import { getDashboard, saveDashboard, type Principal } from '@tabs/dashboards/lib/store';
import { DashboardFileError, parseDashboardFile, type RefResolver } from '@tabs/dashboards/lib/git/parse';
import {
  INGEST_KIND,
  ingestAccepted,
  ingestFromRepo,
  ingestRefusalMessage,
  isDashboardFile,
} from '@tabs/dashboards/lib/git/ingest';

export { INGEST_KIND as DASHBOARD_KIND };

/** Only a `dashboard.yaml` is input. Generated files under `dashboards/` are not. */
export function matchesDashboard(filePath: string): boolean {
  return isDashboardFile(filePath);
}

/**
 * The ONE validator — `parseDashboardFile`, exactly as the OS's own read path calls it. It checks
 * the shape, the closed enums and the `tier` spelling; binding a panel to a governed id is checked
 * in the ingest, where the pusher's entitlement is known.
 */
export function validateDashboardFile(file: { path: string; content: string }): string | null {
  try {
    parseDashboardFile(file.content, file.path);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Resolve `metric:<id>` AS THE PUSHER, through the KERNEL's seam — a tab may not import another
 * tab, so the Metrics tab installs its resolver into `core/infra/git-receive.ts` at boot and this
 * reads it back. A metric the pusher cannot see is indistinguishable from one that does not exist
 * (the OS's `not_found` convention), so a panel is never silently rebound to a same-named member of
 * a different number.
 */
export function pushRefResolver(pusher: Pusher): RefResolver {
  return (ref: string) => resolveGovernedRef(ref, pusher);
}

/** Apply a push's `dashboard.yaml` files through the governed store, as the pusher. */
export async function ingestDashboards(input: {
  domain: string;
  files: ChangedFile[];
  pusher: Pusher;
  sha: string;
}): Promise<IngestReport> {
  const { domain, files, pusher } = input;
  const report: IngestReport = { kind: INGEST_KIND, created: 0, updated: 0, skipped: 0, notes: [] };
  const principal: Principal = { id: pusher.id, domains: pusher.domains, role: pusher.role };

  const live = new Map<string, string>();
  for (const f of files) {
    if (!matchesDashboard(f.path)) continue;
    if (f.status === 'deleted' || f.content === null) {
      // NEVER RETIRE on a push. The removal is reported; deleting a dashboard is an audited,
      // reversible action per dashboard in the OS.
      report.notes.push(`${f.path} was removed from the repo; delete the dashboard in the OS to remove it`);
      continue;
    }
    live.set(f.path, f.content);
  }
  if (live.size === 0) return report;

  let plan;
  try {
    if (!governedRefResolverWired()) {
      // Say WHY rather than refusing every panel one by one with a misleading "does not exist".
      throw new Error(
        'the OS cannot resolve governed metric ids in this process (the Metrics tab did not install its ' +
          'resolver at boot), so a dashboard push cannot be bound safely. Nothing was applied.',
      );
    }
    plan = ingestFromRepo(INGEST_KIND, live, pushRefResolver(pusher));
  } catch (e) {
    // `ingestFromRepo` is total for a bad FILE (it collects rejections); a throw here is a bug or a
    // kind mismatch, and it must not be swallowed into a silent no-op.
    throw e instanceof DashboardFileError ? e : new Error(`dashboard ingest failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // `allowEmptying` is deliberately NOT passed: a `git push` has no confirmation door, and the gate
  // has already refused an emptying push with `DESTRUCTIVE_PUSH`.
  if (!ingestAccepted(plan)) throw new Error(ingestRefusalMessage(plan));
  for (const ignored of plan.ignored) report.notes.push(`${ignored} is generated by the OS and was not read as input`);

  for (const d of plan.dashboards) {
    try {
      runWithSurface('git:push', () => {
        let existed = false;
        try {
          const current = getDashboard(d.id, principal);
          existed = true;
          if (current.domain && current.domain !== domain) {
            throw new Error(`${AUDIENCE_MANAGED} — this file moves the dashboard to '${domain}' and the OS says '${current.domain}'`);
          }
        } catch (e) {
          // A dashboard the pusher cannot see is indistinguishable from one that does not exist, so
          // an id we cannot read is treated as NEW — and a new dashboard is Personal, which is the
          // only audience a push may ever produce.
          if (e instanceof Error && /managed by the OS/i.test(e.message)) throw e;
        }
        saveDashboard(principal, d.id, d.spec);
        if (existed) report.updated += 1;
        else report.created += 1;
      });
    } catch (e) {
      report.skipped += 1;
      report.notes.push(`${d.file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}

/** Register this kind with the receive gate. Idempotent; called from the boot step. */
export function registerDashboardIngest(): void {
  registerRepoKind({
    kind: INGEST_KIND,
    matches: matchesDashboard,
    validate: validateDashboardFile,
    ingest: ingestDashboards,
  });
}
