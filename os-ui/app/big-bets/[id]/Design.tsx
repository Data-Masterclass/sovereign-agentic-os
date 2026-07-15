/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import InterplayCanvas, { type NodeMeta } from '@/components/bigbets/InterplayCanvas';
import SwimlaneCanvas from '@/components/knowledge/SwimlaneCanvas';
import SolutionWizard from './wizard/SolutionWizard';
import type { BetView } from '../types';
import type { ComponentRef, SolutionEdge, InterplayRelation } from '@/lib/bigbets/model';
import type { Workflow } from '@/lib/knowledge/schema';
import type { Gap } from '@/lib/knowledge/gaps';

/**
 * The Design tab — the bet's solution blueprint. For a VIEWER it is read-only: the
 * interplay canvas (how the finished pieces work together at run time) and, when an
 * anchor workflow is set, that workflow rendered read-only via SwimlaneCanvas. For an
 * EDITOR it adds the 3-step Solution wizard (anchor · components · context) and a
 * connect-mode on the canvas to draw interplay edges. All writes go through the
 * edit-gated solution route; a non-editor never sees the wizard or connect controls.
 */

type Solution = {
  anchor: ComponentRef | null;
  nodes: ComponentRef[];
  edges: SolutionEdge[];
  positions: Record<string, { x: number; y: number }>;
};

const RELATIONS: InterplayRelation[] = ['consumes', 'produces', 'triggers', 'feeds', 'monitors'];

export default function Design({ view, onMutate }: { view: BetView; onMutate?: () => void }) {
  const betId = view.bet.id;
  const canEdit = view.canEdit;
  const [sol, setSol] = useState<Solution | null>(null);
  const [error, setError] = useState('');
  const [wf, setWf] = useState<{ workflow: Workflow; gaps: Gap[] } | null>(null);

  // Connect-mode state: the wire gesture's source ref + the pending relation prompt.
  const [connect, setConnect] = useState(false);
  const [wireFrom, setWireFrom] = useState<string | undefined>(undefined);
  const [wireTo, setWireTo] = useState<string | undefined>(undefined);
  const [wireErr, setWireErr] = useState('');
  const [wiring, setWiring] = useState(false);

  // Load the blueprint.
  useEffect(() => {
    let live = true;
    (async () => {
      setError('');
      try {
        const res = await fetch(`/api/big-bets/${betId}/solution`, { cache: 'no-store' });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
        if (live) setSol(body as Solution);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    })();
    return () => { live = false; };
  }, [betId]);

  // When an anchor workflow is set, fetch it for the read-only swimlane. Best-effort:
  // a non-knowledge anchor or an unreadable workflow simply hides the swimlane.
  const anchorArtifactId = sol?.anchor?.tab === 'knowledge' ? sol.anchor.artifactId : null;
  useEffect(() => {
    let live = true;
    if (!anchorArtifactId) { setWf(null); return; }
    (async () => {
      try {
        const res = await fetch(`/api/knowledge/workflows/${anchorArtifactId}`, { cache: 'no-store' });
        if (!res.ok) { if (live) setWf(null); return; }
        const body = await res.json();
        if (live && body?.workflow) setWf({ workflow: body.workflow as Workflow, gaps: (body.gaps ?? []) as Gap[] });
      } catch {
        if (live) setWf(null);
      }
    })();
    return () => { live = false; };
  }, [anchorArtifactId]);

  // refId → live label + derived status, from the bet view the page already holds.
  const meta: Record<string, NodeMeta> = {};
  for (const c of view.components) {
    meta[c.status.refId] = {
      title: c.artifact?.title,
      derived: c.status.derived,
      visible: c.visible,
    };
  }
  const labelFor = (refId: string) => meta[refId]?.title ?? refId;

  // Applying the wizard/route result also refreshes the parent bet view (derived
  // status, roadmap) so the whole page stays consistent after a blueprint change.
  const applySolution = (next: Solution) => {
    setSol(next);
    onMutate?.();
  };

  // Connect-mode click: first click picks the source, second the target → prompt relation.
  const onNodeClick = (refId: string) => {
    setWireErr('');
    if (!wireFrom) { setWireFrom(refId); return; }
    if (refId === wireFrom) { setWireFrom(undefined); return; } // click source again to cancel
    setWireTo(refId);
  };

  const cancelWire = () => { setWireFrom(undefined); setWireTo(undefined); setWireErr(''); };

  const wire = async (relation: InterplayRelation) => {
    if (!wireFrom || !wireTo) return;
    setWiring(true); setWireErr('');
    try {
      const res = await fetch(`/api/big-bets/${betId}/solution`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'wire', from: wireFrom, to: wireTo, relation }),
        cache: 'no-store',
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      applySolution(body as Solution);
      cancelWire();
    } catch (e) {
      setWireErr((e as Error).message);
      setWireTo(undefined); // keep the source so the user can retry a different target
    } finally {
      setWiring(false);
    }
  };

  if (error) return <div className="error" style={{ marginTop: 12 }}>{error}</div>;
  if (!sol) return <div className="stub-page">Loading solution…</div>;

  return (
    <>
      {canEdit ? (
        <>
          <div className="section-title">Build the solution</div>
          <SolutionWizard betId={betId} sol={sol} labelFor={labelFor} onChanged={applySolution} />
        </>
      ) : null}

      <div className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        Solution interplay
        {canEdit && sol.nodes.length >= 2 ? (
          <button
            className="btn ghost sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => { setConnect((v) => !v); cancelWire(); }}
          >
            {connect ? 'Done connecting' : 'Connect pieces'}
          </button>
        ) : null}
      </div>

      {connect && wireTo ? (
        <div className="card" style={{ marginBottom: 8, display: 'grid', gap: 8 }}>
          <span style={{ fontSize: 12.5 }}>
            Connect <strong>{labelFor(wireFrom!)}</strong> → <strong>{labelFor(wireTo)}</strong> as:
          </span>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {RELATIONS.map((r) => (
              <button key={r} className="btn sm" disabled={wiring} onClick={() => wire(r)}>{r}</button>
            ))}
            <button className="btn ghost sm" disabled={wiring} onClick={cancelWire}>Cancel</button>
          </div>
          {wireErr ? <div className="error">{wireErr}</div> : null}
        </div>
      ) : null}

      <div className="card">
        <InterplayCanvas
          anchorId={sol.anchor?.id}
          nodes={sol.nodes}
          edges={sol.edges}
          positions={sol.positions}
          meta={meta}
          connectMode={connect}
          selectedFrom={wireFrom}
          onNodeClick={onNodeClick}
        />
      </div>

      {wf ? (
        <>
          <div className="section-title">Anchor workflow</div>
          <div className="card">
            <SwimlaneCanvas workflow={wf.workflow} gaps={wf.gaps} canEdit={false} />
          </div>
        </>
      ) : null}
    </>
  );
}
