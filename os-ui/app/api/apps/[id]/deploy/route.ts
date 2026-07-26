/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { startPreview, requestDeploy, reconcileDeployStatus } from '@/lib/software/review';

export const dynamic = 'force-dynamic';

/**
 * Live runner status. Polls the app's REAL in-cluster Deployment and reconciles
 * the served URL + `deploying → running → failed` transition off actual pod
 * state (not a timer). The client can poll this after a preview/go-live to watch
 * the app come up. Offline (no cluster) it reports `offline` and mutates nothing.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const { app, status } = await reconcileDeployStatus(id, user);
  return NextResponse.json({ app, status });
}, { defaultStatus: 500 });

/**
 * Deploy surface (Software golden path §C/§D). `?action=preview` starts the free
 * private sandbox preview; the default action requests a domain deploy, which
 * opens the Builder review gate (or auto-deploys a routine in-envelope change).
 */
export const POST = withRoute<{ id: string }, { target?: { epicId?: string; storyId?: string } }>(async ({ user, params, req, body }) => {
  const { id } = params;
  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  // The Build stage carries the selected EPIC/story the build targets (Wave 1a).
  // Threaded through but not yet consumed — the backend build/deploy is unchanged.
  // TODO(Wave 2): scope the scaffold/deploy to `target` (FE+BE generation is deferred).
  void body.target;
  if (action === 'preview') {
    const { app, runnerNote } = await startPreview(id, user);
    return NextResponse.json({ app, runnerNote });
  }
  const result = await requestDeploy(id, user);
  return NextResponse.json(result);
}, { parse: true, defaultStatus: 500 });
