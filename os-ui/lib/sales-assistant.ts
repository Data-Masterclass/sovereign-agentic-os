/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import {
  authorize,
  trace,
  metricsTool,
  retrieveTool,
  SALES,
  type ToolName,
  type Effect,
} from '@/lib/agent-governed';
import { appendTurn, getThread, proposeFact, recall } from '@/lib/agent-memory';
import { enqueue, type Approval } from '@/lib/approvals';

/**
 * Sales Assistant — the vertical slice (golden path §10 + §11). A LangGraph-style
 * SUPERVISOR routes one user request to specialist SUB-AGENTS, each of which calls
 * a single governed tool through the OPA + Langfuse spine:
 *
 *   supervisor ─┬─▶ data-analyst   → metrics  (Cube `daily_revenue` — same as BI)
 *               ├─▶ librarian      → retrieve (ACME contract + Discount Policy)
 *               └─▶ crm-liaison    → connection_crm_write (PAUSED for approval)
 *
 * Short-term memory (the thread) carries context across turns; long-term memory
 * records an episodic fact per run. Every step is OPA-authorized + traced; a CRM
 * write returns `requires_approval`, lands in the Governance queue, and is applied
 * only after a Builder clears it.
 *
 * Routing is deterministic so it validates repeatably against the offline mock
 * model (no live LLM needed for the gate).
 */

export type Step = {
  node: string; // sub-agent name
  tool: ToolName | 'supervisor';
  decision: Effect;
  policy: string;
  summary: string;
  traceId?: string;
  costUsd: number;
};

export type RunResult = {
  threadId: string;
  agent: string;
  domain: string;
  answer: string;
  kpi: { label: string; value: number; source: string; measure: string };
  steps: Step[];
  approvals: Approval[];
  memoryRecalled: { kind: string; text: string }[];
  factStored: string | null;
  costUsd: number;
  turns: number;
};

const COST = { metrics: 0.0008, retrieve: 0.0006, generate: 0.0021, write: 0.0003 } as const;

function wantsCrmWrite(msg: string): boolean {
  return /\b(update|write|send|push|sync|log|record)\b.*\b(crm|account|salesforce|hubspot|renewal date|opportunity)\b/i.test(
    msg,
  ) || /\bupdate the crm\b|\bsend (the|this) email\b|\bpush to crm\b/i.test(msg);
}

/** Run one turn of the Sales Assistant supervisor graph. */
export async function runSalesAssistant(input: {
  user: { id: string; role: string };
  threadId: string;
  message: string;
}): Promise<RunResult> {
  const { user, threadId, message } = input;
  const agent = SALES.principal;
  const domain = SALES.domain;
  const steps: Step[] = [];
  let cost = 0;

  // --- working memory (short-term checkpointer) -----------------------------
  appendTurn(domain, agent, threadId, { role: 'user', content: message });
  const history = getThread(domain, agent, threadId);
  const recalled = recall(domain, agent).map((f) => ({ kind: f.kind, text: f.text }));

  async function runNode(
    node: string,
    tool: ToolName,
    input: unknown,
    exec: () => Promise<{ output: unknown; summary: string }>,
    costUsd: number,
  ): Promise<{ ok: boolean; decision: Effect; output?: unknown; summary: string; traceId?: string }> {
    const authz = await authorize(agent, tool);
    if (authz.effect === 'deny') {
      const tr = await trace({ principal: agent, tool, input, output: { denied: authz.reason }, decision: 'deny' });
      steps.push({ node, tool, decision: 'deny', policy: authz.policy, summary: `OPA denied ${tool}: ${authz.reason}`, traceId: tr.id, costUsd: 0 });
      return { ok: false, decision: 'deny', summary: authz.reason };
    }
    if (authz.effect === 'requires_approval') {
      const tr = await trace({ principal: agent, tool, input, output: { held: authz.reason }, decision: 'requires_approval' });
      steps.push({ node, tool, decision: 'requires_approval', policy: authz.policy, summary: `Held for approval: ${authz.reason}`, traceId: tr.id, costUsd: 0 });
      return { ok: false, decision: 'requires_approval', summary: authz.reason, traceId: tr.id };
    }
    const { output, summary } = await exec();
    cost += costUsd;
    const tr = await trace({ principal: agent, tool, input, output, decision: 'allow', costUsd });
    steps.push({ node, tool, decision: 'allow', policy: authz.policy, summary, traceId: tr.id, costUsd });
    return { ok: true, decision: 'allow', output, summary, traceId: tr.id };
  }

  // --- node 1: data-analyst sub-agent → metrics tool ------------------------
  const wantOrders = /\borders?\b/i.test(message) && !/revenue/i.test(message);
  const measure = wantOrders ? SALES.ordersMeasure : SALES.revenueMeasure;
  const metricsNode = await runNode(
    'data-analyst',
    'metrics',
    { measure, range: [SALES.lastQuarter.start, SALES.lastQuarter.end] },
    async () => {
      const r = await metricsTool(measure);
      return {
        output: r,
        summary: `${SALES.account} ${wantOrders ? 'orders' : 'revenue'} for ${SALES.lastQuarter.label} = ${r.value} (Cube ${SALES.cube}, source=${r.source})`,
      };
    },
    COST.metrics,
  );
  const kpiResult = (metricsNode.output as { value: number; source: string; measure: string }) ?? {
    value: SALES.seed.revenue,
    source: 'seed-offline',
    measure,
  };

  // --- node 2: librarian sub-agent → retrieve tool --------------------------
  const passages: { source: string; title: string; text: string; certified: boolean }[] = [];
  const retrieveNode = await runNode(
    'librarian',
    'retrieve',
    { query: `${SALES.account} contract renewal terms and discount policy` },
    async () => {
      const ps = await retrieveTool(`${SALES.account} contract renewal terms discount policy`);
      passages.push(...ps);
      return { output: ps, summary: `Retrieved ${ps.length} governed passage(s): ${ps.map((p) => p.title).join('; ')}` };
    },
    COST.retrieve,
  );
  void retrieveNode;

  // --- node 3: generate (the model drafts within policy bands) --------------
  const policyPassage = passages.find((p) => p.certified);
  const draftEmail = [
    `Subject: Your ${SALES.account} renewal`,
    ``,
    `Hi ${SALES.account} team,`,
    ``,
    `Thanks for a great quarter — your ${SALES.lastQuarter.label} revenue with us came to €${kpiResult.value.toLocaleString('en-US')}.`,
    `As we approach renewal, I'd like to offer a ${SALES.discountBands.renewal} loyalty discount on your renewal` +
      ` (within our standard ${policyPassage ? 'Certified ' : ''}policy band), or ${SALES.discountBands.multiYear} on a multi-year commitment.`,
    ``,
    `Happy to walk through the details whenever suits you.`,
    ``,
    `Best regards,`,
    `The Sales Team`,
  ].join('\n');
  cost += COST.generate;
  const genTrace = await trace({
    principal: agent,
    tool: 'generate',
    input: { history: history.length, passages: passages.length, kpi: kpiResult.value },
    output: draftEmail,
    decision: 'allow',
    costUsd: COST.generate,
  });
  steps.push({
    node: 'supervisor',
    tool: 'supervisor',
    decision: 'allow',
    policy: 'opa-allow',
    summary: `Drafted renewal email within the ${SALES.discountBands.renewal} policy band, grounded on ${passages.length} passage(s).`,
    traceId: genTrace.id,
    costUsd: COST.generate,
  });

  // --- node 4: crm-liaison sub-agent → connection write (approval-gated) -----
  const approvals: Approval[] = [];
  if (wantsCrmWrite(message)) {
    const crmNode = await runNode(
      'crm-liaison',
      'connection_crm_write',
      { account: SALES.account, field: 'last_renewal_touch', value: new Date().toISOString().slice(0, 10) },
      async () => ({ output: { applied: true }, summary: 'CRM updated' }),
      COST.write,
    );
    if (crmNode.decision === 'requires_approval') {
      const ap = enqueue({
        kind: 'connection_write',
        title: `Update ${SALES.account} CRM record`,
        detail: `Sales Assistant wants to write last_renewal_touch + log the drafted renewal email to the ${SALES.account} CRM account (connection write — external side effect).`,
        agent,
        domain,
        requestedBy: user.id,
        tool: 'connection_crm_write',
        payload: { account: SALES.account, field: 'last_renewal_touch', value: new Date().toISOString().slice(0, 10), email: draftEmail },
        traceId: crmNode.traceId,
      });
      approvals.push(ap);
    }
  }

  // --- long-term memory: store an episodic fact (propose-then-store) ---------
  const fact = proposeFact({
    domain,
    agent,
    kind: 'episodic',
    text: `Drafted a ${SALES.lastQuarter.label} renewal email for ${SALES.account}; revenue €${kpiResult.value.toLocaleString('en-US')}; offered ${SALES.discountBands.renewal}.`,
    provenance: `thread:${threadId}`,
  });

  // --- compose the answer ---------------------------------------------------
  const heldNote = approvals.length
    ? `\n\nI prepared a CRM update, but writing to the connected CRM is a governed side effect — it's now waiting for a Builder to approve in the Governance tab (approval ${approvals[0].id}).`
    : '';
  const answer =
    `${draftEmail}\n\n— grounded on ${SALES.account}'s ${SALES.lastQuarter.label} revenue of €${kpiResult.value.toLocaleString('en-US')} ` +
    `(the same Cube metric the Sales dashboard shows; source=${kpiResult.source}) and the Certified Discount Policy.${heldNote}`;

  appendTurn(domain, agent, threadId, { role: 'assistant', content: answer });

  return {
    threadId,
    agent,
    domain,
    answer,
    kpi: { label: `${SALES.account} ${SALES.lastQuarter.label} ${wantOrders ? 'orders' : 'revenue'}`, value: kpiResult.value, source: kpiResult.source, measure: kpiResult.measure },
    steps,
    approvals,
    memoryRecalled: recalled,
    factStored: fact.text,
    costUsd: Number(cost.toFixed(4)),
    turns: getThread(domain, agent, threadId).length,
  };
}
