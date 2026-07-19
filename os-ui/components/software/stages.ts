/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The SOFTWARE guided path as a shared-core staged model — Define · Design · Build ·
 * Preview · Operate (Builder Framework Wave 1a). Pure and framework-free (mirrors the
 * Agents `PHASES` and Dashboards `DASH_STAGES` arrays) so the gating and ✓ rules are
 * unit-testable on their own; the React skin is components/software/SoftwareBuilder.tsx,
 * riding components/core/StageShell.tsx.
 *
 * `enabled(ctx)` gates which stages are reachable off REAL app state — you must state a
 * purpose before you Build, can't Preview before the repo is scaffolded (≥1 commit),
 * can't Operate a build that never went live. `completed(ctx)` is each stage's LIVE
 * condition; a stage shows a ✓ only when the user ALSO worked it this session (tracked
 * by the StageState in the component). So a freshly-opened app shows no pre-marked
 * checks, opens on the FIRST INCOMPLETE stage (Define for a new app — never Preview),
 * and a check clears if the user later invalidates it.
 */

import type { StageDef } from '@/lib/core/stages';

export type SwStageId = 'define' | 'design' | 'build' | 'preview' | 'operate';

/** The live state the software stage gates/✓-conditions read — derived fresh each render. */
export type SwCtx = {
  /** The app has a name (a scaffolded app always does). */
  named: boolean;
  /** A purpose has been stated (Define's ✓ condition). */
  hasPurpose: boolean;
  /** ≥1 epic with ≥1 story exists (Design's ✓ condition). */
  hasDesign: boolean;
  /** The repo is scaffolded with at least one commit (pipeline `forgejo` = ok). */
  committed: boolean;
  /** A preview pod is running (a served URL), OR the viewer acknowledged no cluster. */
  previewed: boolean;
  /** At least one successful go-live — the release counter (`deploy.releases` > 0). */
  deployed: boolean;
  /** The app is live right now (`deploy.state` === 'live'). */
  live: boolean;
};

/**
 * The five stages. Define captures purpose + grants (always reachable — the front
 * door). Design needs a purpose; Build needs a purpose too (so a brief exists before
 * the build machinery runs); Preview needs a scaffolded repo; Operate merges the old
 * Publish + Operate — it needs a scaffolded repo to review/publish, then reports the
 * live status. Each gate reads ACTUAL app state (`app.purpose`, `app.epics`,
 * `app.pipeline`, release count) — never a timer, never faked.
 */
export const SW_STAGES: StageDef<SwStageId, SwCtx>[] = [
  { id: 'define', title: 'Define', hint: 'Name it, state its purpose, and grant the governed context it may use.', completed: (c) => c.hasPurpose },
  { id: 'design', title: 'Design', hint: 'Shape the work as EPICs and user stories with technical, UX and governance requirements.', enabled: (c) => c.hasPurpose, completed: (c) => c.hasDesign },
  { id: 'build', title: 'Build', hint: 'Pick a story, then build with the delivery team or the build chat; watch commits land.', enabled: (c) => c.hasPurpose, completed: (c) => c.committed },
  { id: 'preview', title: 'Preview', hint: 'Provision a private runner and open the app — the URL appears once the pod is ready.', enabled: (c) => c.committed, completed: (c) => c.previewed },
  { id: 'operate', title: 'Operate', hint: 'Review, request go-live, then watch the live pod, call its tools, and manage lifecycle.', enabled: (c) => c.committed, completed: (c) => c.live },
];
