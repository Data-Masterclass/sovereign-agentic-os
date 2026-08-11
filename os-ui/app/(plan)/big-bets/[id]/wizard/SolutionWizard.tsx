/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ComponentRef, SolutionEdge, InterplayRelation, Tab } from '@/lib/bigbets/model';

/**
 * The 3-step Solution wizard — the editor's write path over the bet's blueprint.
 * It guides an editor through the solution the same way the read-only canvas shows
 * it: Step 1 the BUSINESS PROCESS (the anchor Workflow, internally `anchor-workflow`),
 * Step 2 the solution COMPONENTS + their interplay, Step 3 the CONTEXT the solution
 * reads from. Every mutation is a thin POST to the solution route (which wraps the
 * store's edit-gated setters); every "create new" deep-links to the artifact's home
 * tab. A PLACEHOLDER (named stand-in) can be added to any step and later turned into
 * a real artifact with "Create real <kind>".
 *
 * The wizard owns no governance: the route re-resolves each id through its tab's
 * canView gate and the store owns the edit gate. This is a guided surface, not a
 * back door — a non-editor never sees it (Design only mounts it when canEdit).
 */

type Solution = {
  anchor: ComponentRef | null;
  nodes: ComponentRef[];
  edges: SolutionEdge[];
  positions: Record<string, { x: number; y: number }>;
};

type PickerOption = { id: string; title: string; lifecycle: string };

const RELATIONS: InterplayRelation[] = ['consumes', 'produces', 'triggers', 'feeds', 'monitors'];

const TAB_LABEL: Record<Tab, string> = {
  data: 'Data product', metric: 'Metric', dashboard: 'Dashboard', software: 'Software app',
  agent: 'Agent', ml: 'ML model', knowledge: 'Knowledge', files: 'Files', connection: 'Connection',
};

// Each tab's home surface, so a "create new" deep-links there and references back.
const TAB_HOME: Record<Tab, string> = {
  data: '/data', metric: '/metrics', dashboard: '/dashboards', software: '/software',
  agent: '/agents', ml: '/science', knowledge: '/workflows', files: '/unstructured', connection: '/connections',
};

// Step 2's solution component kinds; Step 3's context kinds. (The Business Process
// anchor is a knowledge workflow.)
const COMPONENT_KINDS: Tab[] = ['agent', 'software', 'ml', 'dashboard'];
const CONTEXT_KINDS: Tab[] = ['data', 'metric', 'knowledge', 'files', 'connection'];

// Software now lists via the async gate in the available route; only connection stays
// deferred (its governed list gate isn't wired into the picker route yet).
const PICKER_DEFERRED: Tab[] = ['connection'];

async function post(betId: string, body: Record<string, unknown>): Promise<Solution> {
  const res = await fetch(`/api/big-bets/${betId}/solution`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as Solution;
}

export default function SolutionWizard({
  betId,
  sol,
  labelFor,
  onChanged,
}: {
  betId: string;
  sol: Solution;
  /** refId → live title (from the bet view the page already holds). */
  labelFor: (refId: string) => string;
  /** Called with the fresh blueprint after any mutation so the page re-renders. */
  onChanged: (next: Solution) => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<Solution>) => {
    setErr(''); setBusy(true);
    try { onChanged(await fn()); } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  // Turn a placeholder into a real artifact: the route scaffolds a governed draft in
  // its tab + rebinds the ref, then we deep-link the user to that tab (prefilled with
  // the name) to finish the real work. WIRED end-to-end — the rebind already happened
  // server-side; the deep-link is just the "finish it" hand-off.
  const createReal = async (refId: string, tab: Tab, name: string) => {
    setErr(''); setBusy(true);
    try {
      const res = await fetch(`/api/big-bets/${betId}/solution`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'createFromPlaceholder', refId }),
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      onChanged(data as Solution);
      const created = (data as { created?: { tab: Tab; artifactId: string } }).created;
      // Deep-link to the new artifact's tab, carrying the name so the create/edit
      // surface can prefill it. Best-effort — the rebind stands even if the nav is a no-op.
      const home = TAB_HOME[created?.tab ?? tab];
      router.push(`${home}?name=${encodeURIComponent(name)}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const anchorSet = Boolean(sol.anchor);
  const knowledgeNodes = sol.nodes.filter((n) => n.tab === 'knowledge');
  const componentNodes = sol.nodes.filter((n) => COMPONENT_KINDS.includes(n.tab));
  const contextNodes = sol.nodes.filter((n) => CONTEXT_KINDS.includes(n.tab) && n.id !== sol.anchor?.id);

  return (
    <div className="card" style={{ display: 'grid', gap: 14 }}>
      <div className="bb-seg" role="tablist" aria-label="Solution wizard step">
        <button type="button" className={step === 1 ? 'active' : ''} onClick={() => setStep(1)}>
          1 · Business Process{anchorSet ? ' ✓' : ''}
        </button>
        <button type="button" className={step === 2 ? 'active' : ''} onClick={() => setStep(2)}>
          2 · Components{componentNodes.length ? ` · ${componentNodes.length}` : ''}
        </button>
        <button type="button" className={step === 3 ? 'active' : ''} onClick={() => setStep(3)}>
          3 · Context{contextNodes.length ? ` · ${contextNodes.length}` : ''}
        </button>
      </div>

      {err ? <div className="error">{err}</div> : null}

      {step === 1 ? (
        <StepAnchor
          betId={betId}
          anchor={sol.anchor}
          knowledgeNodes={knowledgeNodes}
          labelFor={labelFor}
          busy={busy}
          run={run}
        />
      ) : step === 2 ? (
        <StepComponents
          betId={betId}
          sol={sol}
          componentNodes={componentNodes}
          labelFor={labelFor}
          busy={busy}
          run={run}
          createReal={createReal}
        />
      ) : (
        <StepContext
          betId={betId}
          contextNodes={contextNodes}
          labelFor={labelFor}
          busy={busy}
          run={run}
          createReal={createReal}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Step 1 ------

function StepAnchor({
  betId, anchor, knowledgeNodes, labelFor, busy, run,
}: {
  betId: string;
  anchor: ComponentRef | null;
  knowledgeNodes: ComponentRef[];
  labelFor: (refId: string) => string;
  busy: boolean;
  run: (fn: () => Promise<Solution>) => Promise<void>;
}) {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        The <strong>Business Process</strong> is the one operating procedure this solution runs on — a
        <strong> Workflow</strong> from the Workflows tab. Link an existing workflow below (or create one),
        then set it as the Business Process.
      </p>

      {anchor ? (
        <div className="row" style={{ gap: 8, alignItems: 'center', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--panel)' }}>
          <span style={{ flex: 1, fontSize: 13 }}>❦ {labelFor(anchor.id)}</span>
          <span className="chip" style={{ fontSize: 10 }}>business process</span>
          <button className="btn ghost sm" disabled={busy} onClick={() => run(() => post(betId, { action: 'setAnchor' }))}>
            Clear
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {knowledgeNodes.length === 0 ? (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>No workflow linked yet — link one below to make it the Business Process.</p>
          ) : (
            knowledgeNodes.map((n) => (
              <div key={n.id} className="row" style={{ gap: 8, alignItems: 'center', padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 6 }}>
                <span style={{ flex: 1, fontSize: 13 }}>❦ {labelFor(n.id)}</span>
                <button className="btn sm" disabled={busy} onClick={() => run(() => post(betId, { action: 'setAnchor', refId: n.id }))}>
                  Set as Business Process
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <AttachPicker
        betId={betId}
        kind="knowledge"
        label="Workflow"
        home="/workflows"
        busy={busy}
        run={run}
        blurb="Link the operating Workflow this solution automates."
      />
    </div>
  );
}

// ---------------------------------------------------------------- Step 2 ------

function StepComponents({
  betId, sol, componentNodes, labelFor, busy, run, createReal,
}: {
  betId: string;
  sol: Solution;
  componentNodes: ComponentRef[];
  labelFor: (refId: string) => string;
  busy: boolean;
  run: (fn: () => Promise<Solution>) => Promise<void>;
  createReal: (refId: string, tab: Tab, name: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<Tab>('agent');
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        The <strong>solution components</strong> do the work — the agents, apps, models and dashboards.
        Attach them, then wire the interplay (use the canvas Connect button above, or the quick-wire below).
      </p>

      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 11.5, alignSelf: 'center' }}>Add a component:</span>
        <div className="bb-seg">
          {COMPONENT_KINDS.map((k) => (
            <button key={k} type="button" className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
              {TAB_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      <AttachPicker betId={betId} kind={kind} busy={busy} run={run} />

      {componentNodes.length > 0 ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <span className="muted" style={{ fontSize: 11 }}>Attached components</span>
          {componentNodes.map((n) => (
            <NodeRow key={n.id} betId={betId} node={n} labelFor={labelFor} busy={busy} run={run} createReal={createReal} />
          ))}
        </div>
      ) : null}

      {componentNodes.length >= 2 ? (
        <QuickWire betId={betId} sol={sol} labelFor={labelFor} busy={busy} run={run} />
      ) : (
        <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>Attach at least two pieces to wire an interplay between them.</p>
      )}

      {sol.edges.length > 0 ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <span className="muted" style={{ fontSize: 11 }}>Interplay edges</span>
          {sol.edges.map((e) => (
            <div key={e.id} className="row" style={{ gap: 8, alignItems: 'center', fontSize: 12.5 }}>
              <span style={{ flex: 1 }}>
                {labelFor(e.from)} <span className="muted">— {e.relation} →</span> {labelFor(e.to)}
              </span>
              <button className="btn ghost sm" disabled={busy} onClick={() => run(() => post(betId, { action: 'unwire', edgeId: e.id }))}>
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function QuickWire({
  betId, sol, labelFor, busy, run,
}: {
  betId: string;
  sol: Solution;
  labelFor: (refId: string) => string;
  busy: boolean;
  run: (fn: () => Promise<Solution>) => Promise<void>;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [relation, setRelation] = useState<InterplayRelation>('feeds');
  const valid = from && to && from !== to;
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center', padding: '10px', border: '1px dashed var(--border-strong)', borderRadius: 6 }}>
      <select value={from} onChange={(e) => setFrom(e.target.value)} style={{ maxWidth: 180 }}>
        <option value="">from…</option>
        {sol.nodes.map((n) => <option key={n.id} value={n.id}>{labelFor(n.id)}</option>)}
      </select>
      <select value={relation} onChange={(e) => setRelation(e.target.value as InterplayRelation)}>
        {RELATIONS.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      <select value={to} onChange={(e) => setTo(e.target.value)} style={{ maxWidth: 180 }}>
        <option value="">to…</option>
        {sol.nodes.map((n) => <option key={n.id} value={n.id}>{labelFor(n.id)}</option>)}
      </select>
      <button
        className="btn sm"
        disabled={busy || !valid}
        onClick={() => run(async () => {
          const next = await post(betId, { action: 'wire', from, to, relation });
          setFrom(''); setTo('');
          return next;
        })}
      >
        Wire
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- Step 3 ------

function StepContext({
  betId, contextNodes, labelFor, busy, run, createReal,
}: {
  betId: string;
  contextNodes: ComponentRef[];
  labelFor: (refId: string) => string;
  busy: boolean;
  run: (fn: () => Promise<Solution>) => Promise<void>;
  createReal: (refId: string, tab: Tab, name: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<Tab>('data');
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        The <strong>context</strong> is what the solution reads from — the data, metrics, knowledge, files and
        connections. Attach them so the interplay canvas shows the full picture.
      </p>

      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 11.5, alignSelf: 'center' }}>Add context:</span>
        <div className="bb-seg">
          {CONTEXT_KINDS.map((k) => (
            <button key={k} type="button" className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
              {TAB_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      <AttachPicker betId={betId} kind={kind} busy={busy} run={run} />

      {contextNodes.length > 0 ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <span className="muted" style={{ fontSize: 11 }}>Attached context</span>
          {contextNodes.map((n) => (
            <NodeRow key={n.id} betId={betId} node={n} labelFor={labelFor} busy={busy} run={run} createReal={createReal} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One attached-component row in the wizard. A PLACEHOLDER row is drawn distinctly (a
 * dashed marker + label) and offers "Create real <kind>" — which scaffolds the real
 * artifact and rebinds this ref (via the parent's createReal). A real ref just shows
 * its name + a Remove.
 */
function NodeRow({
  betId, node, labelFor, busy, run, createReal,
}: {
  betId: string;
  node: ComponentRef;
  labelFor: (refId: string) => string;
  busy: boolean;
  run: (fn: () => Promise<Solution>) => Promise<void>;
  createReal: (refId: string, tab: Tab, name: string) => Promise<void>;
}) {
  const isPlaceholder = node.placeholder === true;
  const name = isPlaceholder ? (node.placeholderName ?? labelFor(node.id)) : labelFor(node.id);
  return (
    <div
      className="row"
      style={{
        gap: 8, alignItems: 'center', fontSize: 12.5,
        ...(isPlaceholder
          ? { padding: '7px 10px', border: '1px dashed var(--border-strong)', borderRadius: 6, opacity: 0.9 }
          : {}),
      }}
    >
      <span style={{ flex: 1 }}>
        {TAB_LABEL[node.tab]} · {name}
        {isPlaceholder ? <span className="chip" style={{ fontSize: 9.5, marginLeft: 6 }}>placeholder</span> : null}
      </span>
      {isPlaceholder ? (
        <button
          className="btn sm"
          disabled={busy}
          title={`Create a real ${TAB_LABEL[node.tab]} from this placeholder and open its tab to finish it`}
          onClick={() => createReal(node.id, node.tab, name)}
        >
          Create real {TAB_LABEL[node.tab]}
        </button>
      ) : null}
      <button className="btn ghost sm" disabled={busy} onClick={() => run(() => post(betId, { action: 'detach', refId: node.id }))}>
        Remove
      </button>
    </div>
  );
}

// -------------------------------------------- the attach-existing / create-new picker --

function AttachPicker({
  betId, kind, busy, run, blurb, label, home,
}: {
  betId: string;
  kind: Tab;
  busy: boolean;
  run: (fn: () => Promise<Solution>) => Promise<void>;
  blurb?: string;
  /** Display noun override (e.g. "Workflow" for the knowledge-backed Business Process). */
  label?: string;
  /** "Create new" deep-link override (defaults to the tab's home surface). */
  home?: string;
}) {
  const [options, setOptions] = useState<PickerOption[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [placeholderName, setPlaceholderName] = useState('');
  const deferred = PICKER_DEFERRED.includes(kind);
  const noun = label ?? TAB_LABEL[kind];
  const createHome = home ?? TAB_HOME[kind];

  useEffect(() => {
    if (deferred) { setOptions([]); return; }
    let live = true;
    setLoading(true); setSearch('');
    fetch(`/api/big-bets/${betId}/components/available?tab=${kind}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data: { artifacts?: PickerOption[] }) => { if (live) setOptions(data.artifacts ?? []); })
      .catch(() => { if (live) setOptions([]); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [betId, kind, deferred]);

  const filtered = search.trim() ? options.filter((o) => o.title.toLowerCase().includes(search.toLowerCase())) : options;

  const addPlaceholder = () => {
    const name = placeholderName.trim();
    if (!name) return;
    run(async () => {
      const next = await post(betId, { action: 'addPlaceholder', kind, name });
      setPlaceholderName('');
      return next;
    });
  };

  return (
    <div style={{ border: '1px dashed var(--border-strong)', borderRadius: 6, padding: 12, display: 'grid', gap: 8 }}>
      {blurb ? <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>{blurb}</p> : null}

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Link an existing {noun}</span>
        <Link href={createHome} style={{ color: 'var(--teal)', fontSize: 11.5 }}>
          Create a new {noun} →
        </Link>
      </div>

      {deferred ? (
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          {noun} listing is coming — attach it from its own tab for now, or paste its id via the MCP <span className="mono">attach_bet_component</span>.
        </p>
      ) : (
        <>
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${noun.toLowerCase()}s…`} />
          <div style={{ border: '1px solid var(--border)', borderRadius: 6, maxHeight: 170, overflowY: 'auto', background: 'var(--panel)' }}>
            {loading ? (
              <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>
                {options.length === 0 ? `No ${noun.toLowerCase()}s visible to you yet — create one, or add a placeholder below.` : 'No matches.'}
              </div>
            ) : (
              filtered.map((o, i) => (
                <button
                  key={o.id}
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => post(betId, { action: 'attach', kind, artifactId: o.id }))}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
                    padding: '7px 12px', background: 'none', border: 'none',
                    borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none',
                    cursor: busy ? 'default' : 'pointer', textAlign: 'left', gap: 8,
                  }}
                >
                  <span style={{ fontSize: 13, color: 'var(--text)' }}>{o.title}</span>
                  <span className="chip" style={{ fontSize: 10 }}>{o.lifecycle}</span>
                </button>
              ))
            )}
          </div>
        </>
      )}

      {/* Placeholder: a named stand-in for a {noun} that doesn't exist yet. Turn it
          into a real artifact later with "Create real {noun}" on the component row. */}
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <input
          type="text"
          value={placeholderName}
          onChange={(e) => setPlaceholderName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPlaceholder(); } }}
          placeholder={`…or add a placeholder ${noun.toLowerCase()} (name it now, build it later)`}
          style={{ flex: 1 }}
        />
        <button className="btn ghost sm" disabled={busy || !placeholderName.trim()} onClick={addPlaceholder}>
          + Placeholder
        </button>
      </div>
    </div>
  );
}
