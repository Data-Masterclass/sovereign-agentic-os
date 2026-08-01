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
import '../files/folder-adapter.ts';
import '../data/folder-adapter.ts';
import '../knowledge/folder-adapter.ts';
import '../metrics/folder-adapter.ts';
// Wave-2 parity rollout — every artifact tab is foldered.
import '../dashboards/folder-adapter.ts';
import '../science/folder-adapter.ts';
import '../agents/folder-adapter.ts';
import '../software/folder-adapter.ts';
import '../connections/folder-adapter.ts';
import '../bigbets/folder-adapter.ts';
import '../strategy/folder-adapter.ts';
import '../knowledge/workflow-folder-adapter.ts';
