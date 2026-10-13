/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Dataset, DataCheck } from './dataset-schema.ts';
import {
  compileCheck,
  failingRowsSql,
  passingRowsSql,
  ruleLabel,
  DqError,
  type CheckResult,
  type CheckStatus,
} from './dq.ts';
import {
  MODEL_SAMPLE_ROWS,
  CONTRAST_SAMPLE_ROWS,
  TABLE_SAMPLE_ROWS,
  ROWS_THRESHOLD,
  columnFixable,
  rowsEligibility,
  resolveRowIdentity,
  reasoningPrompt,
  rowsFillPrompt,
  parseModelJson,
  coerceProposal,
  coerceRowsFill,
  batchMergeSql,
  rowsMergeSql,
  fixPreviewSql,
  residualSql,
  type FixProposal,
  type RowFix,
} from './dq-fix.ts';
import { validateFixExpr } from './dq-fix-guard.ts';
import { parseDescribe, type ProfileColumn } from './profile.ts';
import { sliceBatchId } from './sync-run-server.ts';
import {
  ensureRemediationsHydrated,
  recordRemediation,
  type RemediationRecord,
} from './dq-remediations.ts';
import { assistantComplete } from '@/lib/assistant/complete';
import { completeWithEscalation } from '@/lib/assistant/escalate';

/**
 * AI-PROPOSED DQ REMEDIATIONS — the governed server orchestration (Validate stage).
 *
 * `proposeFixes` runs ONE failing rule's diagnosis end to end: count → sample failing
 * + passing rows (governed reads AS the resolver's principal) → REASONING model
 * establishes the fix (strict JSON contract) → the expression is guard-validated →
 * a read-only PREVIEW measures before→after + the residual count (estimatedFix is
 * MEASURED, never trusted from the model) → when the pattern is per-row and the
 * failing set is larger than the sample, the STANDARD model fills the remaining rows
 * (the cheap half of the split). An unreachable/unconfigured/over-cap model degrades
 * to an honest `offline` envelope — the run results stay real, nothing is faked.
 *
 * `applyFixes` executes ONLY what the user explicitly accepted, as ONE governed
 * MERGE through the injected executor (the query-tool /execute re-validates shape +
 * schema/role), re-checks the rule immediately (a fix that didn't fix stays red),
 * and records a durable remediation run (batch id + pre-apply snapshot id) so the
 * change is auditable and Console-revertable.
 *
 * Identity/gating is the CALLER's job (route/MCP): canView for propose, the
 * requireDatasetEditable edit gate for apply — the same split the checks route uses.
 * Executors are injected so the whole flow is unit-tested offline.
 */

export type FixQueryFn = (sql: string) => Promise<{ rows: string[][]; columns: string[] }>;

export type AssistantMsg = { role: 'system' | 'user' | 'assistant'; content: string };

export type FixProposeDeps = {
  /** null ⇒ nothing built yet (honest not_run). */
  fqn: string | null;
  layer: string | null;
  /** Governed read executor, bound to the resolver's principal by the caller. */
  queryFn: FixQueryFn;
  /**
   * The model call, by ROLE — the caller wires `assistantComplete(messages,
   * { model: roleModel(role), user })`. Throws AssistantNotConfiguredError /
   * CostCapExceededError / transport errors; propose degrades those to `offline`.
   */
  complete: (messages: AssistantMsg[], role: 'reasoning' | 'standard') => Promise<string>;
};

/**
 * The GOVERNED model wiring both callers (the propose route + the MCP tool) share, so
 * they run the SAME cost-routed path (MCP parity by construction).
 *
 * Cost routing: the `'reasoning'` diagnosis call runs STANDARD-FIRST and escalates to
 * reasoning ONLY when the cheap reply is not usable JSON — the JSON-shape guard
 * ({@link parseModelJson}) is the gate the surface already applies (its output is then
 * further guard-validated by {@link coerceProposal}, so a bad expression is still
 * withheld honestly). The `'standard'` per-row fill call stays on standard directly.
 * Every call goes through the ONE audited, cost-capped `assistantComplete` gateway.
 */
export function dqComplete(user: { id: string; domains?: string[] }): FixProposeDeps['complete'] {
  return async (messages, role) => {
    if (role === 'standard') {
      return (await assistantComplete(messages, { user })).content;
    }
    // reasoning diagnosis → standard-first, escalate on non-JSON.
    const { content } = await completeWithEscalation(messages, {
      user,
      validate: (raw) => parseModelJson(raw) !== null,
    });
    return content;
  };
}

export type ProposeEnvelope = {
  checkId: string;
  label: string;
  status: CheckStatus;
  violations: number | null;
  /** Why the rule didn't run, when status is not_run. */
  reason?: string;
  /** Failing rows for the problems table (≤ TABLE_SAMPLE_ROWS, honest showing/total). */
  sample: { columns: string[]; rows: string[][]; showing: number; total: number } | null;
  proposal: FixProposal | null;
  /** Batch preview: measured before→after pairs + residual violations after the fix. */
  preview: { changes: number; residual: number | null; estimatedFix: 'all' | 'partial' | null; pairs: { before: string; after: string }[] } | null;
  rowsEligible: boolean;
  rowsIneligibleReason?: string;
  pkColumn?: string;
  /** True when the model is unconfigured/over-cap/unreachable — never a fake proposal. */
  offline: boolean;
  offlineReason?: string;
  /** Why no proposal despite the model answering (e.g. invalid expression). */
  proposalReason?: string;
};

async function firstCount(queryFn: FixQueryFn, sql: string): Promise<number> {
  const res = await queryFn(sql);
  const n = Number(res.rows?.[0]?.[0]);
  return Number.isFinite(n) ? n : 0;
}

async function describeColumns(queryFn: FixQueryFn, fqn: string): Promise<ProfileColumn[]> {
  const res = await queryFn(`describe ${fqn}`);
  return parseDescribe({ engine: '', tables: [], columns: [], rows: res.rows, rowCount: res.rows.length });
}

function notRun(check: DataCheck, reason: string): ProposeEnvelope {
  return {
    checkId: check.id,
    label: safeLabel(check),
    status: 'not_run',
    violations: null,
    reason,
    sample: null,
    proposal: null,
    preview: null,
    rowsEligible: false,
    offline: false,
  };
}

function safeLabel(check: DataCheck): string {
  try {
    return ruleLabel(check);
  } catch {
    return check.name || 'check';
  }
}

export async function proposeFixes(
  dataset: Dataset,
  check: DataCheck,
  deps: FixProposeDeps,
): Promise<ProposeEnvelope> {
  if (!deps.fqn) return notRun(check, 'no built layer to check yet');

  // 1 — run THIS rule for real (same compile path as "Run checks").
  let violations: number;
  try {
    violations = await firstCount(deps.queryFn, compileCheck(check, deps.fqn).sql);
  } catch (e) {
    const reason = e instanceof DqError ? e.message : (e as Error).message;
    return notRun(check, reason);
  }

  const base: ProposeEnvelope = {
    checkId: check.id,
    label: safeLabel(check),
    status: violations > 0 ? 'fail' : 'pass',
    violations,
    sample: null,
    proposal: null,
    preview: null,
    rowsEligible: false,
    offline: false,
  };
  if (violations === 0) return base; // nothing to fix — honest pass, no invented work.

  // 2 — the real column schema (governed DESCRIBE) + failing/passing samples.
  let columns: ProfileColumn[];
  let failing: { columns: string[]; rows: string[][] };
  try {
    columns = await describeColumns(deps.queryFn, deps.fqn);
    const res = await deps.queryFn(failingRowsSql(check, deps.fqn, TABLE_SAMPLE_ROWS));
    failing = { columns: res.columns, rows: res.rows };
  } catch (e) {
    return { ...base, reason: (e as Error).message };
  }
  base.sample = {
    columns: failing.columns,
    rows: failing.rows,
    showing: Math.min(failing.rows.length, violations),
    total: violations,
  };

  let passingRows: string[][] = [];
  const passSql = passingRowsSql(check, deps.fqn, CONTRAST_SAMPLE_ROWS);
  if (passSql) {
    try {
      passingRows = (await deps.queryFn(passSql)).rows;
    } catch {
      passingRows = []; // contrast is additive — its absence never blocks a proposal.
    }
  }

  // 3 — eligibility (server-decided, never the model's call).
  const colNames = columns.map((c) => c.name);
  const allowBatch = columnFixable(check);
  const elig = rowsEligibility(check, dataset.checks ?? [], colNames, violations);
  base.rowsEligible = elig.ok;
  if (elig.ok) base.pkColumn = elig.pk;
  else base.rowsIneligibleReason = elig.reason;

  // 4 — REASONING model: establish the fix (or an honest 'none' diagnosis).
  const prompt = reasoningPrompt({
    datasetName: dataset.name,
    check,
    columns,
    violations,
    failingColumns: failing.columns,
    failingRows: failing.rows.slice(0, MODEL_SAMPLE_ROWS),
    passingRows,
    allowBatch,
    allowRows: elig.ok,
    ...(elig.ok ? { pkColumn: elig.pk } : {}),
  });
  let reply: string;
  try {
    reply = await deps.complete(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      'reasoning',
    );
  } catch (e) {
    return { ...base, offline: true, offlineReason: (e as Error).message };
  }

  const proposal = coerceProposal(parseModelJson(reply), {
    allowBatch,
    allowRows: elig.ok,
    column: (check.column ?? '').trim(),
    columns: colNames,
  });
  if (!proposal) {
    return { ...base, proposalReason: 'the model did not return a usable, safe proposal' };
  }
  base.proposal = proposal;

  // 5 — batch: measure the preview + residual (estimatedFix is DERIVED, not trusted).
  if (proposal.kind === 'batch') {
    try {
      const prev = await deps.queryFn(fixPreviewSql(deps.fqn, check, proposal.sqlExpr));
      const residual = await firstCount(deps.queryFn, residualSql(deps.fqn, check, proposal.sqlExpr));
      proposal.estimatedFix = residual === 0 ? 'all' : 'partial';
      base.preview = {
        changes: violations,
        residual,
        estimatedFix: proposal.estimatedFix,
        pairs: prev.rows.map((r) => ({ before: r[0] ?? '', after: r[1] ?? '' })),
      };
    } catch (e) {
      // A preview that cannot run is reported, and the proposal is withheld — never
      // offer an apply whose expression the engine already refused.
      return { ...base, proposal: null, preview: null, proposalReason: `preview failed: ${(e as Error).message}` };
    }
  }

  // 6 — rows: when the failing set is bigger than the reasoning sample, the STANDARD
  // model fills the rest from the established pattern (the smart split).
  if (proposal.kind === 'rows' && elig.ok && violations > proposal.fixes.length) {
    try {
      const full = await deps.queryFn(failingRowsSql(check, deps.fqn, ROWS_THRESHOLD));
      const fill = rowsFillPrompt({
        check,
        pkColumn: elig.pk,
        pattern: proposal.rationale || 'apply the same correction shown in the examples',
        failingColumns: full.columns,
        failingRows: full.rows,
      });
      const filled = coerceRowsFill(
        parseModelJson(
          await deps.complete(
            [
              { role: 'system', content: fill.system },
              { role: 'user', content: fill.user },
            ],
            'standard',
          ),
        ),
        (check.column ?? '').trim(),
      );
      if (filled.length > 0) {
        // The reasoning model's explicit fixes win on pk collision (it saw them closest).
        const byPk = new Map<string, RowFix>();
        for (const f of filled) byPk.set(f.pk, f);
        for (const f of proposal.fixes) byPk.set(f.pk, f);
        proposal.fixes = Array.from(byPk.values()).slice(0, ROWS_THRESHOLD);
      }
    } catch {
      /* the reasoning model's own fixes still stand — partial coverage, honestly shown */
    }
  }

  return base;
}

// ------------------------------------------------------------------- apply ----

export type FixApplyInput =
  | { mode: 'batch'; sqlExpr: string }
  | { mode: 'rows'; fixes: { pk: string; proposed: string }[] };

export type FixApplyDeps = {
  fqn: string;
  layer: string;
  /** Governed read executor (recheck + snapshot probe), resolver-principal-bound. */
  queryFn: FixQueryFn;
  /** Governed WRITE executor — the caller wires executeRun with the caller identity. */
  executeFn: (sql: string) => Promise<{ rowsAffected: number | null }>;
  ranBy: string;
  domain: string;
  now?: () => string;
};

export type FixApplyOutcome = {
  rowsChanged: number | null;
  /** The REAL re-check after apply — a fix that didn't fix stays red. */
  recheck: CheckResult;
  remediation: RemediationRecord | null;
};

/** Latest Iceberg snapshot id BEFORE the fix (throws-safe ⇒ null; recorded for the
 *  honest "revert via Console" path — no governed rollback shape exists today). */
async function probeSnapshotId(fqn: string, queryFn: FixQueryFn): Promise<string | null> {
  const m = /^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/i.exec(fqn.trim());
  if (!m) return null;
  try {
    const res = await queryFn(
      `select snapshot_id from ${m[1]}.${m[2]}."${m[3]}$snapshots" order by committed_at desc limit 1`,
    );
    const id = res.rows?.[0]?.[0];
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

export async function applyFixes(
  dataset: Dataset,
  check: DataCheck,
  input: FixApplyInput,
  deps: FixApplyDeps,
): Promise<FixApplyOutcome> {
  if (!columnFixable(check)) {
    throw new DqError('this rule is not fixable by editing a single column — it needs a manual/structural fix');
  }
  const now = deps.now ?? (() => new Date().toISOString());
  const ranAt = now();

  const columns = await describeColumns(deps.queryFn, deps.fqn);
  const colNames = columns.map((c) => c.name);
  const target = columns.find((c) => c.name.toLowerCase() === (check.column ?? '').trim().toLowerCase());
  if (!target) throw new DqError(`column '${check.column}' does not exist on ${deps.fqn}`);

  // Build the ONE governed MERGE — re-validating EVERYTHING server-side (the client
  // payload is never trusted; the guard re-checks even a previously-validated expr).
  let sql: string;
  let sqlExpr: string | undefined;
  let rowsFixed: number | undefined;
  if (input.mode === 'batch') {
    const checked = validateFixExpr(input.sqlExpr, colNames);
    if (!checked.ok) throw new DqError(checked.reason);
    sqlExpr = checked.expr;
    sql = batchMergeSql(deps.fqn, check, checked.expr);
  } else {
    const pkName = resolveRowIdentity(dataset.checks ?? [], colNames);
    if (!pkName) {
      throw new DqError('no declared row identity — add a unique rule on your key column to enable per-row fixes');
    }
    const pk = columns.find((c) => c.name.toLowerCase() === pkName.toLowerCase())!;
    const fixes = (input.fixes ?? []).filter((f) => typeof f.pk === 'string' && f.pk.length > 0 && typeof f.proposed === 'string');
    if (fixes.length === 0) throw new DqError('no accepted row fixes to apply');
    rowsFixed = fixes.length;
    sql = rowsMergeSql(deps.fqn, pk, target, fixes);
  }

  const violationsBefore = await firstCount(deps.queryFn, compileCheck(check, deps.fqn).sql);
  const snapshotIdBefore = await probeSnapshotId(deps.fqn, deps.queryFn);
  const batchId = sliceBatchId(dataset.id, `dqfix.${ranAt}`);

  const executed = await deps.executeFn(sql); // throws on guard rejection / Trino error

  // The REAL re-check: violated → still red; fixed → green. Never inferred.
  let recheck: CheckResult;
  let violationsAfter: number | null;
  try {
    violationsAfter = await firstCount(deps.queryFn, compileCheck(check, deps.fqn).sql);
    recheck = {
      id: check.id,
      label: safeLabel(check),
      status: violationsAfter > 0 ? 'fail' : 'pass',
      violations: violationsAfter,
    };
  } catch (e) {
    violationsAfter = null;
    recheck = {
      id: check.id,
      label: safeLabel(check),
      status: 'not_run',
      violations: null,
      reason: (e as Error).message,
    };
  }

  // Durable audit record — best-effort (a mirror hiccup never fails the applied fix).
  let remediation: RemediationRecord | null = null;
  try {
    await ensureRemediationsHydrated();
    remediation = recordRemediation({
      datasetId: dataset.id,
      checkId: check.id,
      ruleLabel: safeLabel(check),
      ranAt,
      ranBy: deps.ranBy,
      domain: deps.domain,
      mode: input.mode,
      ...(sqlExpr ? { sqlExpr } : {}),
      ...(typeof rowsFixed === 'number' ? { rowsFixed } : {}),
      rowsChanged: executed.rowsAffected,
      violationsBefore,
      violationsAfter,
      batchId,
      snapshotIdBefore,
      fqn: deps.fqn,
      layer: deps.layer,
    });
  } catch {
    remediation = null;
  }

  return { rowsChanged: executed.rowsAffected, recheck, remediation };
}
