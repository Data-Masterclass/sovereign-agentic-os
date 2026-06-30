/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { enqueue, type Approval } from '@/lib/approvals';

/**
 * Mock source seeding for `kind` validation. The real sources (Software deploy-
 * review, Agents autonomous-out-of-policy, Data/Connections access + egress,
 * promote/certify) live on parallel branches not yet on `main`; here we STUB
 * them so the Governance gate can be exercised end-to-end. Each seeded item is a
 * faithful card (preview + scope + approver) the real adapters will reconcile to
 * at consolidation. Demo/dev only — gated behind an Admin in the route.
 */
export function seedGovernanceDemo(domain = 'sales'): Approval[] {
  const out: Approval[] = [];

  out.push(
    enqueue({
      kind: 'deploy_review',
      source: 'Software',
      title: 'Deploy renewal-forecaster v3',
      detail: 'First deploy of a scope-broadening change.',
      agent: 'builder:bea',
      domain,
      requestedBy: 'bea',
      tool: 'deploy',
      approverRole: 'builder',
      scope: 'domain',
      rememberable: false,
      payload: { app: 'renewal-forecaster', namespace: 'agentic-os', resources: '0.5 CPU / 512Mi', cost: '€18/mo' },
      preview: {
        what: 'Deploy renewal-forecaster v3 (new egress to CRM API)',
        who: 'Bea Brooks (Builder, sales)',
        why: 'Adds Q3 renewal scoring to the sales desk',
        impact: 'New workload + 1 new egress endpoint; €18/mo',
        scan: 'Trivy: 0 critical, 2 medium (base image)',
        resources: 'requests 0.5 CPU / 512Mi · 1 replica',
        cost: '€18/mo est. (premium model off)',
        diff: '+ deploy.yaml  + egress: crm.internal  ~ values: replicas 1',
      },
    }),
  );

  out.push(
    enqueue({
      kind: 'autonomous_out_of_policy',
      source: 'Agents',
      title: 'Agent tried web_fetch (not granted)',
      detail: 'Blocked autonomous action queued for a decision.',
      agent: 'sales-assistant',
      domain,
      requestedBy: 'sara',
      tool: 'web_fetch',
      approverRole: 'admin',
      scope: 'tenant',
      rememberable: true,
      payload: { action: 'web_fetch https://competitor.example/pricing' },
      preview: {
        what: 'Allow the agent to fetch an external pricing page once',
        who: 'sales-assistant (autonomous run)',
        why: 'Out-of-policy: web_fetch is default-deny',
        impact: 'One external GET; approve once or add a standing policy',
      },
    }),
  );

  out.push(
    enqueue({
      kind: 'access_request',
      source: 'Data',
      title: 'Amir requests access to mart_sales',
      detail: 'Request-access to a governed dataset.',
      agent: 'user:amir',
      domain,
      requestedBy: 'amir',
      tool: 'query',
      approverRole: 'builder',
      scope: 'domain',
      rememberable: true,
      payload: { consumer: 'user:amir', tool: 'query', dataset: 'mart_sales' },
      preview: {
        what: 'Grant Amir read access to mart_sales (query tool)',
        who: 'Amir Hassan (User, sales)',
        why: 'Needs Q1 revenue for a deck',
        impact: 'Row/col DLS applies; consumer can query after grant',
      },
    }),
  );

  out.push(
    enqueue({
      kind: 'egress_request',
      source: 'Connections',
      title: 'New egress endpoint: crm.internal',
      detail: 'Builder→Admin: a new external endpoint.',
      agent: 'builder:bea',
      domain,
      requestedBy: 'bea',
      tool: 'egress',
      approverRole: 'admin',
      scope: 'tenant',
      rememberable: false,
      payload: { endpoint: 'https://crm.internal/api' },
      preview: {
        what: 'Allowlist egress to https://crm.internal/api',
        who: 'Bea Brooks (Builder, sales)',
        why: 'renewal-forecaster writes back renewal dates',
        impact: 'Tenant egress policy change — Admin decision',
      },
    }),
  );

  out.push(
    enqueue({
      kind: 'promote_certify',
      source: 'Knowledge',
      title: 'Certify "Q1 revenue = €1.2M"',
      detail: 'Promote a fact Personal→Shared→Certified.',
      agent: 'builder:bea',
      domain,
      requestedBy: 'bea',
      tool: 'certify',
      approverRole: 'builder',
      scope: 'domain',
      rememberable: true,
      payload: { artifact: 'fact:q1-revenue', stage: 'certified' },
      preview: {
        what: 'Certify the Q1 revenue fact into shared knowledge',
        who: 'Bea Brooks (Builder, sales)',
        why: 'Verified against mart_sales',
        impact: 'Becomes a trusted, cited fact for the domain',
      },
    }),
  );

  return out;
}
