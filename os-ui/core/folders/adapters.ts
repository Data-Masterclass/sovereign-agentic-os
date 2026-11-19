/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Folder adapter bootstrap — one import that registers every tab's ArtifactAdapter
 * USER STORY: As a user archiving, moving or deleting a folder in any tab I want the folder's items
 *             to follow it so that nothing is left behind in the old folder.
 * ARCHITECTURE:
 *   - Side-effect module: each `tabs/<tab>/lib/folder-adapter` self-registers into the kernel
 *     registry (`@core/kernel/artifact-adapter`) when imported.
 *   - Imported by `app/api/folders/[id]/route.ts`, so `getArtifactAdapter(tab)` resolves before
 *     `folder-lifecycle.ts` runs a cascade.
 *   - Adding a foldered tab means adding its adapter file and one import line here.
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

