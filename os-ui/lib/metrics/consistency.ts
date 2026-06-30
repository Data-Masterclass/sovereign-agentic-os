/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Dataset, Measure } from '../data/dataset-schema.ts';
import { transparencyGate, gateReason } from '../data/transparency.ts';
import {
  type AgentMetricProposal,
  type MetricForm,
  measureFromAgent,
  measureFromForm,
  measureFromYaml,
  measureMember,
  sameMeasure,
} from './model.ts';

/**
 * Metric-consistency — "the same number everywhere". Two guarantees:
 *
 *   1. DEFINE-time convergence: form / agent / YAML are three doors to ONE artifact.
 *      {@link convergence} proves they yield the identical Measure + member, so the
 *      define UX can offer all three without ever forking the definition.
 *   2. RESOLVE-time agreement: the explorer, Superset dashboards and the agent `metrics`
 *      tool all read the SAME canonical member. {@link numbersMatch} proves that, for a
 *      member, every consumer returns the identical value (the kind-gate "numbers
 *      match the agent's metrics tool" check, at the unit level).
 *
 * {@link consistencyCheck} is the promotion gate's content (the spec's open question):
 * a metric may only be promoted/certified when it is documented AND resolves AND every
 * consumer would resolve the same member. Pure + tested.
 */

export type CheckRow = { name: string; ok: boolean; detail: string };

// --------------------------------------------------- 1. define-time convergence ---

export type ConvergenceReport = {
  ok: boolean;
  measure: Measure | null;
  member: string | null;
  rows: CheckRow[];
};

/** Prove form/agent/YAML converge on one Measure + member for a dataset. */
export function convergence(
  dataset: Dataset,
  paths: { form: MetricForm; agent: AgentMetricProposal; yaml: string },
): ConvergenceReport {
  const rows: CheckRow[] = [];
  let fromForm: Measure;
  let fromAgent: Measure;
  let fromYaml: Measure;
  try {
    fromForm = measureFromForm(paths.form);
    fromAgent = measureFromAgent(paths.agent);
    fromYaml = measureFromYaml(paths.yaml, paths.form.name);
  } catch (e) {
    return { ok: false, measure: null, member: null, rows: [{ name: 'parse', ok: false, detail: (e as Error).message }] };
  }
  const formEqAgent = sameMeasure(fromForm, fromAgent);
  const formEqYaml = sameMeasure(fromForm, fromYaml);
  rows.push({ name: 'form == agent', ok: formEqAgent, detail: formEqAgent ? 'identical measure' : 'agent proposal diverged from the form' });
  rows.push({ name: 'form == yaml', ok: formEqYaml, detail: formEqYaml ? 'identical measure' : 'hand-edited YAML diverged from the form' });
  const ok = formEqAgent && formEqYaml;
  return {
    ok,
    measure: ok ? fromForm : null,
    member: ok ? measureMember(dataset, fromForm) : null,
    rows,
  };
}

// ----------------------------------------------------- 2. resolve-time agreement ---

/** A named consumer that resolves a member to a number (explorer / dashboard / agent). */
export type MemberResolver = (member: string) => Promise<number | null>;

export type NumbersMatchReport = {
  ok: boolean;
  member: string;
  values: Record<string, number | null>;
  detail: string;
};

/**
 * Prove every consumer returns the SAME value for a member. A null (a consumer that
 * cannot resolve) fails the check — a metric that doesn't resolve everywhere isn't
 * consistent. This is the "BI layer and agents never disagree" invariant, executable.
 */
export async function numbersMatch(
  member: string,
  consumers: Record<string, MemberResolver>,
): Promise<NumbersMatchReport> {
  const values: Record<string, number | null> = {};
  for (const [name, resolve] of Object.entries(consumers)) {
    values[name] = await resolve(member);
  }
  const nums = Object.values(values);
  const allResolved = nums.every((v) => typeof v === 'number');
  const allEqual = allResolved && nums.every((v) => v === nums[0]);
  return {
    ok: allEqual,
    member,
    values,
    detail: !allResolved
      ? `a consumer could not resolve '${member}'`
      : allEqual
        ? `all ${nums.length} consumers return ${nums[0]} for '${member}'`
        : `consumers disagree on '${member}': ${JSON.stringify(values)}`,
  };
}

// ----------------------------------------------------- the promotion gate content ---

export type ConsistencyResult = { ok: boolean; member: string | null; rows: CheckRow[] };

/**
 * The metric promotion/certification gate (consistency-check content). A metric is
 * promotable only when:
 *   • the dataset clears the transparency gate (documented + lineage) — reused from Data;
 *   • the measure exists on the dataset (it was actually defined);
 *   • it RESOLVES on its canonical member (an injected resolver returns a number) — the
 *     same member dashboards + the agent will read, so promoting can't ship a number
 *     that only the form ever saw.
 * `resolve` is optional (offline define-time preview); when absent the resolve row is
 * skipped and the gate rests on documentation + presence.
 */
export async function consistencyCheck(
  dataset: Dataset,
  measure: Measure,
  resolve?: MemberResolver,
): Promise<ConsistencyResult> {
  const rows: CheckRow[] = [];
  const gate = transparencyGate(dataset);
  rows.push({ name: 'documentation', ok: gate.ok, detail: gateReason(gate) });

  const defined = dataset.measures.some((m) => sameMeasure(m, measure));
  rows.push({ name: 'defined on dataset', ok: defined, detail: defined ? `measure '${measure.name}' is on the dataset` : `measure '${measure.name}' is not defined on this dataset` });

  const member = measureMember(dataset, measure);
  if (resolve) {
    const v = await resolve(member);
    const resolved = typeof v === 'number';
    rows.push({ name: 'resolves', ok: resolved, detail: resolved ? `'${member}' = ${v}` : `'${member}' did not resolve` });
  }

  return { ok: rows.every((r) => r.ok), member, rows };
}
