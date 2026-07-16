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
