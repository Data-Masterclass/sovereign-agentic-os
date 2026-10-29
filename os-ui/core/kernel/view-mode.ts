/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The OS-wide BUILDER VIEW MODE — Simple ⇄ Developer. Generalised from the Agents
 * tab's per-user toggle (components/agents/SystemView.tsx): `simple` is the guided
 * staged flow (the front door for non-coders); `developer` is a raw/technical
 * surface the host tab provides (code/files + console). The segmented control skin
 * is components/core/BuilderModeToggle.tsx. Pure + client-safe — the seed other
 * tabs reuse in Wave 2.
 */

/** The two builder surfaces. */
export type ViewMode = 'simple' | 'developer';
