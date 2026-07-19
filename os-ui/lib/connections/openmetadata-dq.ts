/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Dataset, DataCheck } from '@/lib/data';
import { slug } from '@/lib/data/metrics';
import { ruleLabel } from '@/lib/data/dq';
import { type OmWrite, omVersionWritable } from '@/lib/data';
import { OS_SERVICE, MANAGED_BY } from '@/lib/connections/openmetadata-sync';

/**
 * Phase 2 (DQ) — SCOPED, INTEGRITY-SAFE write-back of OS-authored DATA-QUALITY into a
 * customer's OpenMetadata as first-class TestSuites / TestCases, reusing the EXACT seven
 * guards of the metadata write-back engine (`openmetadata-sync.ts`). This module is the
 * DQ LEG: it maps each OS rule kind to an OM built-in TestDefinition, builds a Basic
 * (executable) TestSuite bound to the gold mart's OS-namespace FQN, and one TestCase per
 * rule. It is PURE (no I/O) up to the `apply*` step, which executes through an injected
 * client so the whole leg is unit-tested against a FAKE OM with zero network.
 *
 * The seven guards, unchanged from the metadata write-back:
 *  1. Namespace isolation — the TestSuite is bound to the OS gold table under the dedicated
 *     `sovereign_os` Database Service; every TestSuite/TestCase FQN is asserted to live in
 *     that namespace before any write.
 *  2. Additive only — TestSuites/TestCases are OS-authored entities; we PUT-create them and
 *     APPEND results. No `remove`, no mutation of a human-authored field, ever.
 *  3. `managedBy=SovereignOS` stamped in every entity's extension.
 *  4. Idempotency — OM PUT on a TestSuite/TestCase is create-or-update; the same body PUT
 *     twice is a no-op. FQNs are deterministic from the dataset + rule id.
 *  5. Optimistic concurrency — the OS-namespace TestSuite/TestCase are OS-owned; a re-sync
 *     is idempotent. (Result-append is a pure additive time-series — never a mutation.)
 *  6. Dry-run / preview — {@link buildDqSyncPlan} + {@link previewDqSync} render the exact
 *     PUT bodies with ZERO writes; {@link applyDqSync} runs only after governance approval.
 *  7. OM-side RBAC + version range — every write REFUSES outside the tested OM version
 *     (`omVersionWritable`) and goes through the least-privilege writer bot.
 *
 * REST endpoints (OM 1.x): `PUT /api/v1/dataQuality/testSuites`, `PUT
 * /api/v1/dataQuality/testCases`. Results are appended via the EXISTING
 * `createOmTestCaseResult()` (`PUT .../testCases/{fqn}/testCaseResult`).
 */

// --- Rule → OM built-in TestDefinition mapping (the plan's §6 table) ------------

/** One OM built-in test the OS emits for a rule. A `not_blank` rule maps to TWO
 *  (NotNull + LengthsToBeBetween(min:1)), so a rule yields ONE OR MORE of these. */
export type OmTestSpec = {
  /** The OM built-in TestDefinition name (fullyQualifiedName is the same for built-ins). */
  testDefinition: string;
  /** OM test parameters (`[{ name, value }]`) — string-encoded, as OM stores them. */
  parameters: { name: string; value: string }[];
};

/**
 * Map ONE OS rule to its OM built-in TestDefinition(s). Column-level tests bind to the
 * column via the TestCase's `entityLink`; the parameter shapes follow OM's built-in
 * column tests. Returns an empty array for a rule that is not executable (no `rule`, or
 * missing the args the OM test needs) — the caller SKIPS it rather than inventing a test.
 *
 *   not_null        → columnValuesToBeNotNull
 *   not_blank       → columnValuesToBeNotNull + columnValueLengthsToBeBetween(minLength:1)
 *   unique          → columnValuesToBeUnique
 *   accepted_values → columnValuesToBeInSet(allowedValues)
 *   range           → columnValuesToBeBetween(minValue?, maxValue?)
 */
export function mapRuleToOmTests(check: DataCheck): OmTestSpec[] {
  if (!check.rule) return []; // legacy free-text intention — no executable OM test.
  const col = (check.column ?? '').trim();
  if (!col) return []; // every executable OS rule needs a column; so does every OM column test.

  switch (check.rule) {
    case 'not_null':
      return [{ testDefinition: 'columnValuesToBeNotNull', parameters: [] }];
    case 'not_blank':
      return [
        { testDefinition: 'columnValuesToBeNotNull', parameters: [] },
        { testDefinition: 'columnValueLengthsToBeBetween', parameters: [{ name: 'minLength', value: '1' }] },
      ];
    case 'unique':
      return [{ testDefinition: 'columnValuesToBeUnique', parameters: [] }];
    case 'accepted_values': {
      const vals = (check.values ?? []).map((v) => String(v).trim()).filter((v) => v.length > 0);
      if (vals.length === 0) return [];
      // OM stores a set param as a JSON-array string under `allowedValues`.
      return [{ testDefinition: 'columnValuesToBeInSet', parameters: [{ name: 'allowedValues', value: JSON.stringify(vals) }] }];
    }
    case 'range': {
      const params: { name: string; value: string }[] = [];
      if (typeof check.min === 'number' && Number.isFinite(check.min)) params.push({ name: 'minValue', value: String(check.min) });
      if (typeof check.max === 'number' && Number.isFinite(check.max)) params.push({ name: 'maxValue', value: String(check.max) });
      if (params.length === 0) return [];
      return [{ testDefinition: 'columnValuesToBeBetween', parameters: params }];
    }
    default:
      return [];
  }
}

// --- FQN helpers (Guard 1 — everything under the OS namespace) ------------------

/** The OS gold-mart OM table FQN — the SAME namespace the metadata sync uses. The
 *  TestSuite (Basic/executable) is bound to THIS table. */
export function osDqTableFqn(d: Dataset): string {
  return `${OS_SERVICE}.${d.domain}.gold_${slug(d.name)}`;
}

/** The Basic TestSuite FQN for a dataset — deterministic + idempotent (Guard 4). OM's
 *  executable test suite for a table is conventionally `<tableFqn>.testSuite`. */
export function osDqSuiteFqn(d: Dataset): string {
  return `${osDqTableFqn(d)}.testSuite`;
}

/** The TestCase FQN for ONE (rule, om-test) pair — `<tableFqn>.<column>.<name>`, so a
 *  not_blank rule (two OM tests) yields two distinct, stable FQNs. */
export function osDqTestCaseFqn(d: Dataset, check: DataCheck, spec: OmTestSpec): string {
  const col = slug(check.column ?? 'col');
  return `${osDqTableFqn(d)}.${col}.os_${slug(check.id)}_${spec.testDefinition}`;
}

// --- The plan (pure — no I/O) --------------------------------------------------

/** A create-or-update of ONE OM DQ entity INSIDE the OS namespace (Guard 1). */
export type OmDqPutOp = {
  kind: 'testSuite' | 'testCase';
  /** OM REST path to PUT to. */
  path: string;
  /** The entity FQN — asserted to live in the OS namespace before any write. */
  fqn: string;
  /** The OS rule id this test case derives from (for the result-append map). Absent on the suite. */
  ruleId?: string;
  body: Record<string, unknown>;
};

export type OmDqPlan = {
  osDatasetId: string;
  osDomain: string;
  osRunId: string;
  /** The bound OS gold-mart table FQN (the suite's executable entity). */
  tableFqn: string;
  /** The Basic TestSuite + one TestCase per (rule, om-test) — ALL under the OS namespace. */
  puts: OmDqPutOp[];
  /** Set when the plan cannot be built safely (nothing executable, or not promoted). */
  rejected?: string;
};

/** The managed-by extension every OS DQ entity carries (Guard 3). */
function dqManagedProps(d: Dataset, runId: string): Record<string, string> {
  return { managedBy: MANAGED_BY, osDatasetId: d.id, osDomain: d.domain, osRunId: runId };
}

/**
 * Build the ADDITIVE DQ sync plan for one OS dataset — NO I/O. Emits ONE Basic
 * (executable) TestSuite bound to the OS gold mart, then one TestCase per (rule, OM-test)
 * referencing the built-in TestDefinition. Only EXECUTABLE rules that map to an OM test
 * are emitted; a legacy free-text intention or an under-specified rule is skipped. A
 * dataset with no built Gold, or one not promoted to an asset/product, is REJECTED (the
 * DQ leg follows the same promotion gate as the metadata sync so the two stay aligned).
 */
export function buildDqSyncPlan(d: Dataset, opts: { runId: string }): OmDqPlan {
  const runId = opts.runId;
  const tableFqn = osDqTableFqn(d);
  const base: OmDqPlan = { osDatasetId: d.id, osDomain: d.domain, osRunId: runId, tableFqn, puts: [] };

  if (!d.versions.gold.built) {
    return { ...base, rejected: 'The Gold layer is not built — no governed table to attach OpenMetadata tests to.' };
  }
  if (d.tier === 'dataset') {
    return { ...base, rejected: 'Only a promoted asset/product syncs DQ to OpenMetadata — promote this dataset to Shared first.' };
  }

  const extension = { ...dqManagedProps(d, runId) } as Record<string, unknown>;

  // Expand rules → (rule, om-test) pairs, skipping anything not executable in OM.
  const cases: OmDqPutOp[] = [];
  for (const check of d.checks ?? []) {
    const specs = mapRuleToOmTests(check);
    for (const spec of specs) {
      const fqn = osDqTestCaseFqn(d, check, spec);
      cases.push({
        kind: 'testCase',
        path: '/api/v1/dataQuality/testCases',
        fqn,
        ruleId: check.id,
        body: {
          name: `os_${slug(check.id)}_${spec.testDefinition}`,
          displayName: ruleLabel(check),
          description: check.description || `SovereignOS rule ${ruleLabel(check)}`,
          // Bind the column-level test to the OS gold table + column via OM's entityLink.
          entityLink: `<#E::table::${tableFqn}::columns::${check.column}>`,
          testDefinition: spec.testDefinition,
          parameterValues: spec.parameters,
          testSuite: osDqSuiteFqn(d),
          extension,
        },
      });
    }
  }

  if (cases.length === 0) {
    return { ...base, rejected: 'No executable data-quality rules to publish — add a rule (not_null/unique/accepted_values/range/not_blank) first.' };
  }

  // Guard 1 — the Basic (executable) TestSuite bound to the OS gold mart.
  const suite: OmDqPutOp = {
    kind: 'testSuite',
    path: '/api/v1/dataQuality/testSuites',
    fqn: osDqSuiteFqn(d),
    body: {
      name: osDqSuiteFqn(d),
      displayName: `SovereignOS DQ — ${d.name}`,
      description: `Sovereign OS data-quality tests for ${d.name} (additive, integrity-safe).`,
      basicEntityReference: tableFqn, // Basic/executable suite: 1:1 with the table.
      extension,
    },
  };

  return { ...base, puts: [suite, ...cases] };
}

// --- The preview (honest diff — no I/O) ----------------------------------------

export type OmDqPreview = {
  ok: boolean;
  osDatasetId: string;
  summary: string;
  lines: string[];
  counts: { suites: number; testCases: number; humanFieldsTouched: 0 };
  rejected?: string;
};

/** Render the honest diff for a DQ plan — ZERO writes (Guard 6). */
export function previewDqSync(plan: OmDqPlan): OmDqPreview {
  if (plan.rejected) {
    return { ok: false, osDatasetId: plan.osDatasetId, summary: plan.rejected, lines: [], counts: { suites: 0, testCases: 0, humanFieldsTouched: 0 }, rejected: plan.rejected };
  }
  const suites = plan.puts.filter((p) => p.kind === 'testSuite').length;
  const testCases = plan.puts.filter((p) => p.kind === 'testCase').length;
  const lines: string[] = [];
  for (const p of plan.puts) {
    if (p.kind === 'testSuite') lines.push(`create/update TestSuite ${p.fqn} (Basic/executable, bound to ${plan.tableFqn}, managedBy=${MANAGED_BY})`);
    else lines.push(`create/update TestCase ${p.fqn} (${String(p.body.testDefinition)})`);
  }
  const summary =
    `Will create ${suites} TestSuite + ${testCases} TestCase${testCases === 1 ? '' : 's'} under ${OS_SERVICE} ` +
    `(managedBy=${MANAGED_BY}) — touch ZERO human fields.`;
  return { ok: true, osDatasetId: plan.osDatasetId, summary, lines, counts: { suites, testCases, humanFieldsTouched: 0 } };
}

// --- The apply (executes the plan through an injected client) ------------------

/** The minimal client surface the DQ apply step needs — injected so the engine is
 *  unit-tested against a FAKE OM with zero network. */
export type OmDqSyncClient = {
  putEntity: (path: string, body: unknown) => Promise<OmWrite>;
  /** The OM version this connection speaks (for the write-range refusal, Guard 7). */
  omVersion?: string;
};

export type OmDqSyncResult = {
  ok: boolean;
  applied: { suites: number; testCases: number };
  errors: string[];
  refused?: string;
};

/**
 * Execute the DQ plan through the injected client — ONLY after governance approval
 * (Guard 6). Provision-order: PUT the TestSuite first (a TestCase references it), then
 * every TestCase. REFUSES wholesale on an out-of-range OM version (Guard 7) or a plan
 * that somehow targets a non-OS-namespace FQN (Guard 1). Idempotent (Guard 4).
 */
export async function applyDqSync(client: OmDqSyncClient, plan: OmDqPlan): Promise<OmDqSyncResult> {
  const result: OmDqSyncResult = { ok: true, applied: { suites: 0, testCases: 0 }, errors: [] };
  if (plan.rejected) return { ...result, ok: false, refused: plan.rejected };
  if (!omVersionWritable(client.omVersion)) {
    return { ...result, ok: false, refused: `OM version ${client.omVersion ?? 'unknown'} is outside the tested write range — refusing to write DQ.` };
  }

  // Guard 1 — hard-assert every DQ entity FQN lives in the OS namespace.
  for (const p of plan.puts) {
    if (!p.fqn.startsWith(`${OS_SERVICE}.`)) {
      return { ...result, ok: false, refused: `DQ plan targets a non-OS-namespace entity (${p.fqn}) — refusing.` };
    }
  }

  // Suite first (a TestCase references the suite), then the cases (idempotent PUTs).
  const ordered = [...plan.puts].sort((a, b) => (a.kind === 'testSuite' ? -1 : 0) - (b.kind === 'testSuite' ? -1 : 0));
  for (const p of ordered) {
    const w = await client.putEntity(p.path, p.body);
    if (w.ok) {
      if (p.kind === 'testSuite') result.applied.suites += 1;
      else result.applied.testCases += 1;
    } else {
      result.errors.push(`PUT ${p.kind} ${p.fqn}: ${w.reason}`);
      result.ok = false;
    }
  }
  return result;
}

// --- Result-append map (which TestCase FQN each rule's verdict lands on) --------

/**
 * The mapping used on each governed DQ run: for a rule id, the OM TestCase FQNs its
 * verdict should be appended to (a not_blank rule fans out to two). Built from the SAME
 * deterministic FQN function the plan uses, so a result always lands on an FQN the plan
 * provisioned. Returns [] for a rule with no executable OM test.
 */
export function osDqTestCaseFqnsForRule(d: Dataset, check: DataCheck): string[] {
  return mapRuleToOmTests(check).map((spec) => osDqTestCaseFqn(d, check, spec));
}
