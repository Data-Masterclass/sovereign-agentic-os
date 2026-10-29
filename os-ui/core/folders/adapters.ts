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
import '@tabs/files/lib/folder-adapter';
import '@tabs/data/lib/folder-adapter';
import '@tabs/knowledge/lib/folder-adapter';
import '@tabs/metrics/lib/folder-adapter';
// Wave-2 parity rollout — every artifact tab is foldered.
import '@tabs/dashboards/lib/folder-adapter';
import '@tabs/agents/lib/folder-adapter';
import '@tabs/software/lib/folder-adapter';
import '@tabs/connections/lib/folder-adapter';
import '@tabs/knowledge/lib/workflow-folder-adapter';

