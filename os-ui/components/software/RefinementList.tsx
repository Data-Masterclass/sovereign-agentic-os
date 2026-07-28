/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import {
  dimensionLabel,
  kindLabel,
  stateLabel,
  refinementState,
  isBuildable,
  isDesignable,
  type Improvement,
} from '@/lib/software/improvements';
import {
  actionsFor,
  lanesFor,
  buildableBatch,
  buildBatchCapped,
  stateBadgeClass,
  dimensionTag,
  REFINE_BUILD_CAP,
} from './refinement-view';

/**
 * RefinementList — the ONE refinement-lifecycle surface, rendered IDENTICALLY across the
 * Test · Design · Build stages so a refinement wears the same Proposed → Designed → Built
 * badge (dimension-tagged) wherever it appears. The same underlying list is passed in each
 * stage; `variant` only changes which lane leads and which batch action is offered:
 *
 *   • test   — read-only findings, each a Proposed card (its dimension + target story).
 *   • design — "Refinements to design": per-item Design (+ Design & Build accelerator) and
 *              a "Design all refinements" batch. A designed item STAYS listed, now showing
 *              the spec it designed inline.
 *   • build  — "Refinements to build": only buildable (rebuild-proposed / designed) items
 *              build; a proposed design-kind is gated (design-before-build) and links to
 *              Design. Per-item Build + "Build all" (capped at REFINE_BUILD_CAP).
 *
 * The parent owns the list + the real design/build work (reasoning draft, codegen); this
 * component only renders the lanes, fires the per-item / batch callbacks, and expands a row
 * to its detail (drafted spec + what was built). Done items are ALWAYS kept visible. Styled
 * with existing OS primitives (grant-block · badge · row · hint) + inline layout only.
 */

export type RefineHandlers = {
  /** Draft a spec for a design-kind refinement → advances it to 'designed' (shows the spec). */
  onDesign?: (imp: Improvement) => Promise<void> | void;
  /** Build one buildable refinement → advances it to 'built'. */
  onBuild?: (imp: Improvement) => Promise<void> | void;
  /** Accelerator: design THEN build one item, still surfacing the design output. */
  onDesignAndBuild?: (imp: Improvement) => Promise<void> | void;
  /** Batch: design every designable refinement. */
  onDesignAll?: () => Promise<void> | void;
  /** Batch: build every buildable refinement (capped at REFINE_BUILD_CAP). */
  onBuildAll?: () => Promise<void> | void;
  /** Batch: design & build all — chains both, still surfacing each design output. */
  onDesignAndBuildAll?: () => Promise<void> | void;
  /** Dismiss a refinement (once addressed / rejected). */
  onDismiss?: (id: string) => void;
};

export default function RefinementList({
  refinements,
  storyTitle,
  variant,
  handlers = {},
  onGoDesign,
}: {
  refinements: Improvement[];
  /** Resolve a story-id → its human title (for the "· story" attribution). */
  storyTitle: (storyId: string) => string;
  variant: 'test' | 'design' | 'build';
  handlers?: RefineHandlers;
  /** Jump to the Design stage (the gated-item pointer in the Build variant). */
  onGoDesign?: () => void;
}) {
  if (refinements.length === 0) return null;

  const lanes = lanesFor(refinements);
  const designCount = lanes.toDesign.length;
  const buildCount = lanes.toBuild.length;
  const doneCount = lanes.done.length;
  const total = refinements.length;
  const cappedBatch = buildableBatch(refinements).length;
  const overCap = buildBatchCapped(refinements);
  const readOnly = variant === 'test';

  const header =
    variant === 'design' ? { label: 'Refinements to design', count: designCount }
      : variant === 'build' ? { label: 'Refinements to build', count: buildCount }
        : { label: 'Refinements found', count: total };

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div className="comp-label" style={{ margin: 0 }}>
          {header.label} <span className="muted">({header.count})</span>
        </div>
        <div className="row" style={{ gap: 6, alignItems: 'center' }} aria-hidden="true">
          <span className="badge muted" style={{ fontSize: 10 }}>proposed</span>
          <span className="muted" style={{ opacity: 0.5 }}>→</span>
          <span className="badge warn" style={{ fontSize: 10 }}>designed</span>
          <span className="muted" style={{ opacity: 0.5 }}>→</span>
          <span className="badge ok" style={{ fontSize: 10 }}>built</span>
        </div>
      </div>

      {/* Batch actions — the transparent two-step leads; Design & build all is the accelerator. */}
      {!readOnly ? (
        <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {variant === 'design' && handlers.onDesignAll ? (
            <BatchButton
              label={`Design all refinements${designCount ? ` (${designCount})` : ''}`}
              title="Draft a spec for every refinement that needs one — each stays listed with its design"
              disabled={designCount === 0}
              run={handlers.onDesignAll}
              primary
            />
          ) : null}
          {variant === 'build' && handlers.onBuildAll ? (
            <BatchButton
              label={`Build all${cappedBatch ? ` (${cappedBatch})` : ''}`}
              title={overCap ? `Builds ${REFINE_BUILD_CAP} at a time so each batch stays reviewable — press again for the rest` : 'Build every buildable refinement'}
              disabled={buildCount === 0}
              run={handlers.onBuildAll}
              primary
            />
          ) : null}
          {handlers.onDesignAndBuildAll && (designCount > 0 || buildCount > 0) ? (
            <BatchButton
              label="Design & build all"
              title="Accelerator: design every refinement that needs it, then build all — still showing each design"
              disabled={designCount === 0 && buildCount === 0}
              run={handlers.onDesignAndBuildAll}
            />
          ) : null}
          {overCap ? <span className="muted" style={{ fontSize: 11.5 }}>{REFINE_BUILD_CAP} per batch — {buildCount - REFINE_BUILD_CAP} more after this.</span> : null}
        </div>
      ) : null}

      <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {refinements.map((imp) => (
          <RefinementRow
            key={imp.id}
            imp={imp}
            storyTitle={storyTitle(imp.storyId)}
            readOnly={readOnly}
            handlers={handlers}
            onGoDesign={onGoDesign}
          />
        ))}
      </ul>

      {variant !== 'test' ? (
        <p className="hint" style={{ marginTop: 10 }}>
          {doneCount > 0 ? `${doneCount} built — kept visible for transparency. ` : ''}
          The two-step (Design → Build) is the default; <em>Design &amp; Build</em> chains both while still showing what it designed.
        </p>
      ) : null}
    </div>
  );
}

/** A batch button that shows a spinner while its async action runs. */
function BatchButton({
  label, title, disabled, run, primary,
}: {
  label: string;
  title: string;
  disabled: boolean;
  run: () => Promise<void> | void;
  primary?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={primary ? 'btn sm' : 'btn ghost sm'}
      disabled={disabled || busy}
      title={title}
      onClick={async () => { setBusy(true); try { await run(); } finally { setBusy(false); } }}
    >
      {busy ? <span className="spin" /> : label}
    </button>
  );
}

/**
 * One refinement row — the state badge + dimension tag + note + its lane-appropriate
 * actions. Expands to show the drafted spec (once designed) and a "what was built" note
 * (once built), so clicking any refinement reveals its detail.
 */
function RefinementRow({
  imp, storyTitle, readOnly, handlers, onGoDesign,
}: {
  imp: Improvement;
  storyTitle: string;
  readOnly: boolean;
  handlers: RefineHandlers;
  onGoDesign?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'design' | 'build' | 'designAndBuild' | null>(null);
  const state = refinementState(imp);
  const actions = readOnly ? [] : actionsFor(imp);
  const hasDetail = !!imp.draftedSpec || state === 'built';

  const fire = async (kind: 'design' | 'build' | 'designAndBuild', fn?: (i: Improvement) => Promise<void> | void) => {
    if (!fn || busy) return;
    setBusy(kind);
    try { await fn(imp); setOpen(true); } finally { setBusy(null); }
  };

  // Gated: a proposed design-kind shown in the Build lane can't build — point to Design.
  const gated = !readOnly && isDesignable(imp) && actions.length === 0;

  return (
    <li
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '6px 10px',
        background: 'var(--panel)',
        opacity: state === 'built' ? 0.72 : 1,
      }}
    >
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="row"
          onClick={() => (hasDetail ? setOpen((v) => !v) : undefined)}
          title={hasDetail ? 'Show detail' : undefined}
          style={{ gap: 6, alignItems: 'center', background: 'none', border: 'none', padding: 0, cursor: hasDetail ? 'pointer' : 'default' }}
        >
          <span className={stateBadgeClass(state)} style={{ fontSize: 10 }}>{stateLabel(state)}</span>
          {imp.dimension ? (
            <span className="badge muted" title={dimensionLabel(imp.dimension)} style={{ fontSize: 10 }}>{dimensionTag(imp.dimension)}</span>
          ) : (
            <span className="badge muted" title="How this refinement is routed" style={{ fontSize: 10 }}>{kindLabel(imp.kind)}</span>
          )}
        </button>
        <span style={{ flex: 1, minWidth: 120, fontSize: 12.5 }}>
          {imp.note}
          <span className="muted"> · {storyTitle || 'story'}</span>
        </span>

        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          {actions.includes('design') ? (
            <button className="btn ghost sm" disabled={busy !== null} title="Draft this refinement's spec (reasoning) — then it becomes buildable" onClick={() => fire('design', handlers.onDesign)}>
              {busy === 'design' ? <span className="spin" /> : 'Design'}
            </button>
          ) : null}
          {actions.includes('build') ? (
            <button className="btn sm" disabled={busy !== null} title="Build this refinement — commits real code" onClick={() => fire('build', handlers.onBuild)}>
              {busy === 'build' ? <span className="spin" /> : 'Build'}
            </button>
          ) : null}
          {actions.includes('designAndBuild') ? (
            <button className="btn ghost sm" disabled={busy !== null} title="Accelerator: design then build — still shows what it designed" onClick={() => fire('designAndBuild', handlers.onDesignAndBuild)}>
              {busy === 'designAndBuild' ? <span className="spin" /> : 'Design & Build'}
            </button>
          ) : null}
          {gated && onGoDesign ? (
            <button className="btn ghost sm" title="This changes the spec — design it first" onClick={onGoDesign}>Refine in Design</button>
          ) : null}
          {readOnly && isBuildable(imp) ? <span className="muted" style={{ fontSize: 11 }}>ready to build</span> : null}
          {readOnly && isDesignable(imp) ? <span className="muted" style={{ fontSize: 11 }}>needs design</span> : null}
          {handlers.onDismiss ? (
            <button className="icon-btn" title="Dismiss" onClick={() => handlers.onDismiss?.(imp.id)}>✕</button>
          ) : null}
        </div>
      </div>

      {open && hasDetail ? (
        <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          {imp.draftedSpec ? (
            <div>
              <div className="section-title" style={{ fontSize: 11, marginBottom: 4 }}>Designed spec</div>
              <pre className="answer mono" style={{ margin: 0, fontSize: 11.5, whiteSpace: 'pre-wrap' }}>{imp.draftedSpec}</pre>
            </div>
          ) : null}
          {state === 'built' ? (
            <p className="hint" style={{ margin: imp.draftedSpec ? '8px 0 0' : 0 }}>
              Built — its code lives under <span className="mono">epics/&lt;epic&gt;/&lt;story&gt;/</span> for this story.
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
