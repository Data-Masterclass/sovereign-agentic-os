/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The SOFTWARE guided path as a shared-core staged model — Describe · Build ·
 * Preview · Publish · Operate. Pure and framework-free (mirrors the Agents `PHASES`
 * and Dashboards `DASH_STAGES` arrays) so the gating and ✓ rules are unit-testable on
 * their own; the React skin is components/software/SoftwareBuilder.tsx, riding
 * components/core/StageShell.tsx.
 *
 * `enabled(ctx)` gates which stages are reachable off REAL app state — you can't Build
 * an unnamed app, can't Preview before the repo is scaffolded (≥1 commit), can't Publish
 * before a preview exists (or was explicitly acknowledged offline), can't Operate a build
 * that never went live. `completed(ctx)` is each stage's LIVE condition; a stage shows a ✓
 * only when the user ALSO worked it this session (tracked by the StageState in the
 * component). So a freshly-opened app shows no pre-marked checks, and a check clears if the
 * user later invalidates it.
 */

import type { StageDef } from '@/lib/core/stages';

export type SwStageId = 'describe' | 'build' | 'preview' | 'publish' | 'operate';

/** The live state the software stage gates/✓-conditions read — derived fresh each render. */
export type SwCtx = {
  /** The app has a name (a scaffolded app always does — gates Build). */
  named: boolean;
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
 * The five stages. Build needs a named app; Preview needs a scaffolded repo; Publish needs
 * a preview (or an explicit offline acknowledgement); Operate needs a real go-live. Each
 * gate reads ACTUAL app state (`app.pipeline`, runner status, release count) — never a
 * timer, never faked.
 */
export const SW_STAGES: StageDef<SwStageId, SwCtx>[] = [
  { id: 'describe', title: 'Describe', hint: 'Name it, brief the build, declare its surface and the resources it may use.', completed: (c) => c.named },
  { id: 'build', title: 'Build', hint: 'Build with the delivery team or the build chat; edit code and watch commits land.', enabled: (c) => c.named, completed: (c) => c.committed },
  { id: 'preview', title: 'Preview', hint: 'Provision a private runner and open the app — the URL appears once the pod is ready.', enabled: (c) => c.committed, completed: (c) => c.previewed },
  { id: 'publish', title: 'Publish', hint: 'Request go-live — the security scan, requested resources, footprint and diff are Builder-reviewed.', enabled: (c) => c.previewed, completed: (c) => c.deployed },
  { id: 'operate', title: 'Operate', hint: 'Watch the live pod, call its governed tools, and manage promotion and lifecycle.', enabled: (c) => c.deployed, completed: (c) => c.live },
];
