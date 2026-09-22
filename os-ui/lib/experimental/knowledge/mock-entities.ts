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
 * A fresh tenant has no entities, so the index is empty. The live
 * OpenMetadata/registry wiring replaces the body without touching the pure
 * `gaps.ts` logic or the UI.
 */
export async function resolveEntityIndex(_domain: string): Promise<EntityIndex> {
  void _domain;
  return {
    data: new Set<string>(),
    app: new Set<string>(),
    agent: new Set<string>(),
    file: new Set<string>(),
  };
}
