/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { principal, actor } from '@/lib/bigbets/server';
import {
  getSolution,
  setBetWorkflow,
  wireComponents,
  unwireComponents,
  savePositions,
  addComponent,
  addPlaceholder,
  createFromPlaceholder,
  removeComponent,
  ensureHydrated,
} from '@/lib/bigbets/store';
import { INTERPLAY_RELATIONS, type InterplayRelation, type Tab } from '@/lib/bigbets';
import { resolveLinkedComponent } from '@/lib/bigbets/attach-server';

export const dynamic = 'force-dynamic';

const isRelation = (v: unknown): v is InterplayRelation =>
  typeof v === 'string' && INTERPLAY_RELATIONS.includes(v as InterplayRelation);

/**
 * GET → the bet's solution BLUEPRINT (view-gated): the anchor-workflow ref, every
 * ComponentRef (with its `role`), the interplay edges and the saved canvas positions.
 * The exact shape the store's `getSolution` returns — the Design tab reads it directly.
 */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const solution = getSolution(id, principal(user));
    return NextResponse.json(solution);
}, { hydrate: ensureHydrated, defaultStatus: 500 });

/**
 * POST → the write path for the wizard + canvas (ALL edit-gated in the store):
 *   - action:'setAnchor'   { refId }              → set/clear the anchor workflow
 *   - action:'attach'      { kind, id | scaffold, plannedReady? } → attach a component,
 *                            re-resolving the id through its own tab's canView gate
 *   - action:'detach'      { refId }              → remove a component reference
 *   - action:'wire'        { from, to, relation } → wire an interplay edge
 *   - action:'unwire'      { edgeId }             → remove an interplay edge
 *   - action:'positions'   { positions }          → persist canvas node positions
 * Every branch is a THIN wrapper over the existing store setter — the store owns the
 * edit gate, the invariants and the audit. Returns the fresh blueprint so the canvas
 * can re-render from one round trip.
 */
export const POST = withRoute<{ id: string }, Record<string, unknown>>(async ({ user, params, body }) => {
    const { id } = params;
    const p = principal(user);

    switch (body.action) {
      case 'setAnchor': {
        const refId = typeof body.refId === 'string' && body.refId.trim() ? body.refId.trim() : undefined;
        setBetWorkflow(id, refId, p);
        break;
      }
      case 'attach': {
        // Re-resolve the target through its own tab's canView gate BEFORE attaching —
        // a forged/unseen id is a typed not_found/forbidden, never a silent link.
        const kind = String(body.kind ?? '') as Tab;
        const scaffold =
          body.scaffold && typeof body.scaffold === 'object'
            ? { title: String((body.scaffold as { title?: unknown }).title ?? '').trim() }
            : undefined;
        const artifactId = typeof body.artifactId === 'string' ? body.artifactId.trim() : '';
        const plannedReady =
          typeof body.plannedReady === 'string' && body.plannedReady.trim()
            ? body.plannedReady.trim()
            : new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);
        if (scaffold?.title) {
          addComponent(id, actor(user), { tab: kind, scaffold, plannedReady });
        } else {
          if (!artifactId) return NextResponse.json({ error: 'attach needs an artifactId or a scaffold title' }, { status: 400 });
          // Governed resolve + reference-card registration (shared with the MCP tool).
          const card = await resolveLinkedComponent(kind, artifactId, user);
          addComponent(id, actor(user), { tab: card.tab, artifactId: card.id, plannedReady });
        }
        break;
      }
      case 'addPlaceholder': {
        // A named stand-in for an artifact that doesn't exist yet — no real artifact
        // is created. Turned into a real one later via action:'createFromPlaceholder'.
        const kind = String(body.kind ?? '') as Tab;
        const name = String(body.name ?? '').trim();
        if (!name) return NextResponse.json({ error: 'addPlaceholder needs a name' }, { status: 400 });
        const plannedReady =
          typeof body.plannedReady === 'string' && body.plannedReady.trim()
            ? body.plannedReady.trim()
            : new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);
        addPlaceholder(id, actor(user), { tab: kind, name, plannedReady });
        break;
      }
      case 'createFromPlaceholder': {
        // Scaffold the real artifact and rebind the placeholder ref to it. Returns the
        // fresh blueprint PLUS the new artifact's tab+id so the UI can deep-link there.
        const refId = String(body.refId ?? '').trim();
        if (!refId) return NextResponse.json({ error: 'createFromPlaceholder needs a refId' }, { status: 400 });
        const { artifactId, tab } = createFromPlaceholder(id, actor(user), refId);
        return NextResponse.json({ ...getSolution(id, p), created: { refId, tab, artifactId } });
      }
      case 'detach': {
        const refId = String(body.refId ?? '').trim();
        if (!refId) return NextResponse.json({ error: 'detach needs a refId' }, { status: 400 });
        removeComponent(id, p, refId);
        break;
      }
      case 'wire': {
        const from = String(body.from ?? '').trim();
        const to = String(body.to ?? '').trim();
        const relation = body.relation;
        if (!from || !to) return NextResponse.json({ error: 'wire needs from + to ref ids' }, { status: 400 });
        if (!isRelation(relation)) {
          return NextResponse.json({ error: `relation must be one of ${INTERPLAY_RELATIONS.join(' | ')}` }, { status: 400 });
        }
        wireComponents(id, from, to, relation, p);
        break;
      }
      case 'unwire': {
        const edgeId = String(body.edgeId ?? '').trim();
        if (!edgeId) return NextResponse.json({ error: 'unwire needs an edgeId' }, { status: 400 });
        unwireComponents(id, edgeId, p);
        break;
      }
      case 'positions': {
        const positions = (body.positions ?? {}) as Record<string, { x: number; y: number }>;
        savePositions(id, positions, p);
        break;
      }
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
    // Return the fresh blueprint so the caller re-renders from one round trip.
    return NextResponse.json(getSolution(id, p));
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });
