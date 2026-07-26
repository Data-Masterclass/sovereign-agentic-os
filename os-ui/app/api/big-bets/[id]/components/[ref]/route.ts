/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { setComponentPlan, setOverride, removeComponent } from '@/lib/bigbets/store';
import { principal } from '@/lib/bigbets/server';

export const dynamic = 'force-dynamic';

/**
 * PATCH → edit a component reference's plan (start/plannedReady/dependsOn/weight)
 * and/or its owner override (shown beside the derived state, never replacing it).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PATCH = withRoute<{ id: string; ref: string }, any>(async ({ user, params, body: b }) => {
    const { id, ref } = params;
    const p = principal(user);
    if (b.override !== undefined) {
      setOverride(id, p, ref, b.override === null ? null : { note: b.override.note, asserts: b.override.asserts });
    }
    if (b.start || b.plannedReady || b.dependsOn || typeof b.weight === 'number') {
      setComponentPlan(id, p, ref, { start: b.start, plannedReady: b.plannedReady, dependsOn: b.dependsOn, weight: b.weight });
    }
    return NextResponse.json({ ok: true });
}, { parse: true, defaultStatus: 500 });

/** DELETE → remove the component reference (untags the artifact; never deletes it). */
export const DELETE = withRoute<{ id: string; ref: string }>(async ({ user, params }) => {
    const { id, ref } = params;
    removeComponent(id, principal(user), ref);
    return NextResponse.json({ ok: true });
}, { defaultStatus: 500 });
