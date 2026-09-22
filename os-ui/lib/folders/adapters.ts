/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * ADAPTER BOOTSTRAP — importing this module registers every tab's `ArtifactAdapter`
 * into the shared core registry (each adapter module self-registers at import). Any
 * server boundary that runs the folder LIFECYCLE (the `/api/<tab>/folders/*` cascade
 * handlers) imports this ONCE so `getArtifactAdapter(tab)` always resolves.
 *
 * This mirrors the warehouse provider registry: one place that wires the per-tab
 * modules together, so adding a foldered tab is "add its adapter file + one import
 * here" — no shared switch to fight over.
 */
import '../experimental/files/folder-adapter.ts';
import '../experimental/data/folder-adapter.ts';
import '../experimental/knowledge/folder-adapter.ts';
import '../experimental/metrics/folder-adapter.ts';
// Wave-2 parity rollout — every artifact tab is foldered.
import '../experimental/dashboards/folder-adapter.ts';
import '../experimental/science/folder-adapter.ts';
import '../agents/folder-adapter.ts';
import '../experimental/software/folder-adapter.ts';
import '../experimental/connections/folder-adapter.ts';
import '../experimental/bigbets/folder-adapter.ts';
import '../experimental/strategy/folder-adapter.ts';
import '../experimental/knowledge/workflow-folder-adapter.ts';
