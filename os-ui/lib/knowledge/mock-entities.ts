/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { type EntityIndex } from './gaps.ts';

/**
 * Mock entity resolver (kind-only). The real resolver would query OpenMetadata
 * (data products), the app-registry (Software tab), the agent store (Agents tab)
 * and the files index (Unstructured tab) to learn which step-link targets exist.
 *
 * Here we return a small, deterministic seed so the gap-flagging + jump-to-build
 * flow is demonstrable on a laptop. `app://bank-portal` is deliberately ABSENT so
 * the "Bank submission" validation gate shows a flagged gap with a jump-to-build.
 *
 * Kept behind one function so the live OpenMetadata/registry wiring can replace
 * the body without touching the pure `gaps.ts` logic or the UI.
 */
export async function resolveEntityIndex(_domain: string): Promise<EntityIndex> {
  void _domain;
  return {
    data: new Set([
      'sales.gold.customer_applications',
      'sales.gold.orders_fact',
      'sales.silver.orders',
    ]),
    app: new Set([
      // 'app://bank-portal' intentionally MISSING → a flagged gap.
      'app://crm',
    ]),
    agent: new Set(['sys_verify_agent', 'sys_research_desk']),
    file: new Set(['file:acme-contract.pdf']),
  };
}
