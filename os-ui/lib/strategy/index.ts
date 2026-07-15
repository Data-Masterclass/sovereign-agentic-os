/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Strategy — the tab's PUBLIC API.
 *
 * Other tabs, API routes and the MCP import this tab through THIS module.
 */

// Pillar lifecycle: list / get / create / update / promote pillars.
export * from './pillars.ts';

// Strategy schema types (ArtifactKind, Pillar, ValueMetric, etc.).
export * from './schema.ts';

// Big-bet bridge: betCatalogue / linkBetStub / STUB_BET_CATALOGUE.
export * from './bets-bridge.ts';

// Adoption analytics: tallyAdoption / DomainAdoption.
export * from './adoption-core.ts';
