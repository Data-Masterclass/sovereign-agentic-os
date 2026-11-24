/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * TAB:        admin
 * FEATURE:    Domains — the tenant’s structural map, as a Platform tab
 * USER STORY: As a platform admin I want to create domains, toggle their optional layers and
 *             reassign an artifact's domain without leaving the Platform page I came from.
 * ARCHITECTURE:
 *   - Markup carried over unchanged from app/(govern)/platform/domains/page.tsx (2026-10-30 move
 *     to one route with tabs on top, not a redesign). That route is now a redirect to
 *     /platform?section=domains, so old links and bookmarks still work.
 *   - The page's `.content` wrapper moved up to platform/page.tsx, which renders it once around
 *     the strip and the active tab; the leftover plain <div> is the former wrapper.
 *   - FAIL-CLOSED gate: Platform is minRole 'builder' (only Overview & Health is builder-readable),
 *     and every section now lives at /platform, so the old pathname gate in platform/layout.tsx no
 *     longer protects this surface. The gate is therefore HERE as well as in the strip: the inner
 *     component — which holds every hook and every fetch — is not mounted until useUser() resolves a
 *     role that clears sectionMinRole('domains'). A builder who hand-crafts ?section=domains gets nothing,
 *     and nothing is requested on their behalf. Hiding is not the boundary: /api/platform-admin/* is
 *     adminCtx()-gated server-side, which is the real enforcement.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmProvider, useConfirm } from '@core/ui/lifecycle/ConfirmDialog';
import GatewayPanel from '@tabs/admin/ui/GatewayPanel';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import { sectionMinRole } from '@tabs/admin/lib/sections';
import { deleteRunGate } from '@tabs/admin/lib/domain-delete-view';

type Domain = {
  id: string;
  name: string;
  owner: string;
  archived: boolean;
  layers: { ml: boolean };
  createdAt: string;
};

export default function DomainsAdmin() {
  const { user, loading } = useUser();
  const role = user?.role ?? null;
  // Fail closed: mount nothing (so fetch nothing) until the role clears the floor.
  if (loading || role === null || !roleAtLeast(role, sectionMinRole('domains'))) return null;
  return (
    <ConfirmProvider>
      <DomainsInner />
    </ConfirmProvider>
  );
}

function DomainsInner() {
  const confirm = useConfirm();
  const [domains, setDomains] = useState<Domain[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  // Create form state
  const [name, setName] = useState('');
  const [owner, setOwner] = useState('');

  // Inline rename state: domain id → draft name
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);

  // Governance: cross-domain artifact move.
  const [kinds, setKinds] = useState<string[]>([]);
  const [moveKind, setMoveKind] = useState('');
  const [moveId, setMoveId] = useState('');
  const [moveTarget, setMoveTarget] = useState('');
  const [bulkTarget, setBulkTarget] = useState('');
  const [moveMsg, setMoveMsg] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/platform-admin/domains', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load');
      else setDomains(body.domains ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = useCallback(async () => {
    if (!name.trim() || !owner.trim()) return;
    setBusy('create');
    setError('');
    try {
      const res = await fetch('/api/platform-admin/domains', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, owner }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.error ?? `Create failed (HTTP ${res.status})`);
      else { setName(''); setOwner(''); await load(); }
    } catch (e) {
      setError(`Create failed: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  }, [name, owner, load]);

  const patch = useCallback(async (d: Domain, body: Record<string, unknown>) => {
    setBusy(d.id);
    setError('');
    try {
      const res = await fetch(`/api/platform-admin/domains/${d.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? 'Update failed');
      } else await load();
    } finally {
      setBusy('');
    }
  }, [load]);

  // Delete domain: a dry run first (the plan), then a typed-confirmation run. Admin-only, audited.
  type DelItem = { kind: string; label: string; reason?: string };
  type DelPlan = { totals: { remove: number; keep: number; blocked: number }; components: { component: string; remove: DelItem[]; keep: DelItem[]; blocked?: DelItem[] }[] };
  const [delPlan, setDelPlan] = useState<{ id: string; plan: DelPlan; status?: string; message?: string } | null>(null);
  const [delBackup, setDelBackup] = useState(false);
  // The plan card renders below the domains table: bring it into view when it opens, so a click on
  // "Delete…" never looks like nothing happened.
  const delPlanRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (delPlan) delPlanRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [delPlan?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const planDelete = useCallback(async (d: Domain) => {
    setBusy(d.id);
    setError('');
    try {
      const res = await fetch(`/api/platform-admin/domains/${d.id}/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dryRun: true }) });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) { setDelPlan(null); setError(b.error ?? `Could not plan the delete (HTTP ${res.status})`); }
      else { setDelBackup(false); setDelPlan({ id: d.id, plan: b.plan }); }
    } catch (e) {
      setError(`Could not plan the delete: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  }, []);
  const runDelete = useCallback(async () => {
    if (!delPlan) return;
    const ok = await confirm({
      title: `Delete domain “${delPlan.id}” and everything in it?`,
      body: `${delPlan.plan.totals.remove} objects are removed from every component, for every owner. ${delPlan.plan.totals.keep} are kept because something outside the domain still maps to them. This cannot be undone except from a backup.`,
      confirmLabel: 'Delete domain',
      danger: true,
      confirmPhrase: delPlan.id,
    });
    if (!ok) return;
    setBusy(delPlan.id);
    try {
      // 1. The typed id → a short-lived, single-use token bound to this signed-in session.
      const c = await fetch(`/api/platform-admin/domains/${delPlan.id}/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'confirm', confirm: delPlan.id }) });
      const cb = await c.json().catch(() => ({}));
      if (!c.ok || !cb.token) {
        setDelPlan({ ...delPlan, status: 'error', message: cb.error ?? 'Confirmation failed' });
        return;
      }
      // 2. The run, with that token.
      const res = await fetch(`/api/platform-admin/domains/${delPlan.id}/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dryRun: false, token: cb.token, iHaveABackup: delBackup }) });
      const b = await res.json().catch(() => ({}));
      const message = b.status === 'done' ? `Deleted: ${b.done.length} objects removed.`
        : b.status === 'refused' ? `Refused: ${b.reason}`
        : b.status === 'failed' ? `Stopped at ${b.failed.label}: ${b.failed.error}. ${b.remaining.length} left — run again to resume.`
        : (b.error ?? 'Delete failed');
      setDelPlan({ ...delPlan, plan: b.plan ?? delPlan.plan, status: b.status ?? 'error', message });
      await load();
    } catch (e) {
      setDelPlan({ ...delPlan, status: 'error', message: `Delete failed: ${(e as Error).message}` });
    } finally {
      setBusy('');
    }
  }, [delPlan, delBackup, confirm, load]);

  const startRename = useCallback((d: Domain) => {
    setRenaming(d.id);
    setRenameDraft(d.name);
    // Focus the input on next tick once it renders
    setTimeout(() => renameRef.current?.focus(), 0);
  }, []);

  const commitRename = useCallback(async (d: Domain) => {
    const next = renameDraft.trim();
    if (!next || next === d.name) { setRenaming(null); return; }
    await patch(d, { op: 'rename', name: next });
    setRenaming(null);
  }, [renameDraft, patch]);

  const cancelRename = useCallback(() => setRenaming(null), []);

  // Load the movable artifact kinds once (admin-gated GET).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/platform-admin/domain-move', { cache: 'no-store' });
        if (!res.ok) return;
        const body = await res.json();
        const ks: string[] = body.kinds ?? [];
        setKinds(ks);
        if (ks.length) setMoveKind((k) => k || ks[0]);
      } catch {
        /* non-fatal: the move controls just stay empty */
      }
    })();
  }, []);

  // Default the target pickers to the first live domain once domains load.
  const liveDomains = domains.filter((d) => !d.archived);
  useEffect(() => {
    if (liveDomains.length) {
      setMoveTarget((t) => t || liveDomains[0].id);
      setBulkTarget((t) => t || liveDomains[0].id);
    }
  }, [liveDomains.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const moveOne = useCallback(async () => {
    if (!moveKind || !moveId.trim() || !moveTarget) return;
    setBusy('move-one');
    setMoveMsg('');
    setError('');
    try {
      const res = await fetch('/api/platform-admin/domain-move', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: moveKind, id: moveId.trim(), targetDomain: moveTarget }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.error ?? 'Move failed');
      else {
        setMoveMsg(`Moved ${body.kind} "${body.id}" to ${body.targetDomain}.`);
        setMoveId('');
      }
    } finally {
      setBusy('');
    }
  }, [moveKind, moveId, moveTarget]);

  const assignUnassigned = useCallback(async () => {
    if (!bulkTarget) return;
    const name = liveDomains.find((d) => d.id === bulkTarget)?.name ?? bulkTarget;
    const ok = await confirm({
      title: `Assign all unassigned artifacts to “${name}”?`,
      body: `Every artifact with no domain — datasets, files, dashboards, agents, models, knowledge, connections, apps, workflows, pillars and big bets — will be reassigned to “${name}”. Artifacts that already have a domain are left untouched. This is auditable but not one-click reversible.`,
      confirmLabel: 'Assign all',
      danger: true,
      confirmPhrase: bulkTarget,
    });
    if (!ok) return;
    setBusy('bulk');
    setMoveMsg('');
    setError('');
    try {
      const res = await fetch('/api/platform-admin/domain-move', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'bulk-unassigned', targetDomain: bulkTarget }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.error ?? 'Assign failed');
      else {
        const per = Object.entries(body.counts ?? {})
          .filter(([, n]) => (n as number) > 0)
          .map(([k, n]) => `${k}: ${n}`)
          .join(', ');
        setMoveMsg(`Assigned ${body.total} unassigned artifact(s) to ${body.targetDomain}${per ? ` (${per})` : ''}.`);
      }
    } finally {
      setBusy('');
    }
  }, [bulkTarget, liveDomains, confirm]);

  return (
    <>
      <div>
        <div className="section-title">Create domain</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input style={{ flex: '1 1 160px' }} value={name} onChange={(e) => setName(e.target.value)} placeholder="domain name (e.g. Sales Analytics)" />
            <input style={{ flex: '1 1 140px' }} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="owner (login)" />
            <button className="btn" onClick={create} disabled={busy === 'create' || !name.trim() || !owner.trim()}>
              {busy === 'create' ? <span className="spin" /> : 'Create domain'}
            </button>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            A new domain starts with the Science layer off — toggle it on per domain below when a team does data science.
          </div>
        </div>

        <div className="section-title">Reassign artifact domain</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="hint" style={{ marginBottom: 10 }}>
            Move an artifact to a different domain. This changes <strong>who can see it</strong> (domain
            scoping), so it is admin-only and audited.
          </div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={moveKind} onChange={(e) => setMoveKind(e.target.value)} aria-label="Artifact kind">
              {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <input
              style={{ flex: '1 1 200px' }}
              value={moveId}
              onChange={(e) => setMoveId(e.target.value)}
              placeholder="artifact id"
              autoComplete="off"
            />
            <span className="muted" style={{ fontSize: 12 }}>→</span>
            <select value={moveTarget} onChange={(e) => setMoveTarget(e.target.value)} aria-label="Target domain">
              {liveDomains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <button className="btn" onClick={moveOne} disabled={busy === 'move-one' || !moveKind || !moveId.trim() || !moveTarget}>
              {busy === 'move-one' ? <span className="spin" /> : 'Move'}
            </button>
          </div>
        </div>

        <div className="section-title">Assign unassigned artifacts</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="hint" style={{ marginBottom: 10 }}>
            Bulk-assign <strong>every artifact with no domain</strong> to one domain. Artifacts that already
            have a domain are never touched. Type-to-confirm; audited.
          </div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={bulkTarget} onChange={(e) => setBulkTarget(e.target.value)} aria-label="Target domain for unassigned">
              {liveDomains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <button className="btn" onClick={assignUnassigned} disabled={busy === 'bulk' || !bulkTarget}>
              {busy === 'bulk' ? <span className="spin" /> : 'Assign all unassigned'}
            </button>
          </div>
        </div>

        {moveMsg ? <div className="hint" style={{ marginBottom: 12 }}>{moveMsg}</div> : null}
        {error ? <div className="error">{error}</div> : null}

        <div className="section-title">Domains<span className="count-pill">{domains.length}</span></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Domain</th><th>Owner</th><th>Science layer</th><th></th></tr>
            </thead>
            <tbody>
              {domains.map((d) => (
                <tr key={d.id} className={d.archived ? 'muted' : undefined}>
                  <td>
                    {renaming === d.id ? (
                      <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                        <input
                          ref={renameRef}
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(d);
                            if (e.key === 'Escape') cancelRename();
                          }}
                          style={{ width: 160, padding: '3px 7px', fontSize: 13 }}
                          autoComplete="off"
                        />
                        <button className="btn" style={{ padding: '3px 10px', fontSize: 12 }}
                          onClick={() => commitRename(d)} disabled={busy === d.id || !renameDraft.trim()}>
                          {busy === d.id ? <span className="spin" /> : 'Save'}
                        </button>
                        <button className="btn ghost" style={{ padding: '3px 8px', fontSize: 12 }} onClick={cancelRename}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                        <span>
                          <strong>{d.name}</strong>
                          <div className="mono muted" style={{ fontSize: 11 }}>{d.id}</div>
                        </span>
                        {!d.archived && (
                          <button
                            className="btn ghost"
                            style={{ padding: '2px 8px', fontSize: 11 }}
                            onClick={() => startRename(d)}
                            disabled={busy === d.id}
                            title="Rename domain"
                          >
                            Rename
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                  <td>{d.owner}</td>
                  <td>
                    <button
                      className={'switch' + (d.layers.ml ? ' on' : '')}
                      disabled={busy === d.id || d.archived}
                      title={`${d.layers.ml ? 'Disable' : 'Enable'} the Science layer for this domain`}
                      onClick={() => patch(d, { op: 'layer', layer: 'ml', enabled: !d.layers.ml })}
                    >
                      <span className="switch-track"><span className="switch-thumb" /></span>
                      <span className="switch-text">{d.layers.ml ? 'ON' : 'OFF'}</span>
                    </button>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn ghost" style={{ padding: '4px 10px' }} disabled={busy === d.id}
                      onClick={() => patch(d, { op: 'archive', archived: !d.archived })}>
                      {busy === d.id ? <span className="spin" /> : d.archived ? 'Unarchive' : 'Archive'}
                    </button>{' '}
                    <button className="btn ghost danger" style={{ padding: '4px 10px' }} disabled={busy === d.id}
                      title="Plan (dry run) the deletion of this domain and everything in it"
                      onClick={() => planDelete(d)}>
                      Delete…
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {delPlan ? (
          <div className="card" style={{ marginTop: 16 }} data-testid="domain-delete-plan" ref={delPlanRef}>
            <div className="section-title">Delete “{delPlan.id}” — plan (dry run)</div>
            <div className="hint">
              {delPlan.plan.totals.remove} to remove, {delPlan.plan.totals.keep} kept
              {delPlan.plan.totals.blocked ? `, ${delPlan.plan.totals.blocked} blocked (no delete path: the run is refused)` : ''}.
            </div>
            <table>
              <thead><tr><th>Component</th><th>Remove</th><th>Kept, and why</th></tr></thead>
              <tbody>
                {delPlan.plan.components.filter((c) => c.remove.length || c.keep.length || c.blocked?.length).map((c) => (
                  <tr key={c.component}>
                    <td className="mono">{c.component}</td>
                    <td title={c.remove.map((i) => i.label).join('\n')}>{c.remove.length}</td>
                    <td>{[...c.keep, ...(c.blocked ?? [])].map((k) => <div key={k.label} className="mono" style={{ fontSize: 11 }}>{k.label} — {k.reason}</div>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <label className="row" style={{ gap: 6, marginTop: 8 }}>
              <input type="checkbox" checked={delBackup} onChange={(e) => setDelBackup(e.target.checked)} />
              I have a backup (skip the check for a Velero backup from the last 2 hours)
            </label>
            {(() => { const g = deleteRunGate(delPlan.plan); return g.canRun ? null : <div className="error" data-testid="domain-delete-blocked">{g.why}</div>; })()}
            {delPlan.message ? <div className={delPlan.status === 'done' ? 'hint' : 'error'}>{delPlan.message}</div> : null}
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button className="btn danger" disabled={busy === delPlan.id || !deleteRunGate(delPlan.plan).canRun} onClick={runDelete}>
                {busy === delPlan.id ? <span className="spin" /> : 'Delete domain…'}
              </button>
              <button className="btn ghost" onClick={() => setDelPlan(null)}>Close</button>
            </div>
          </div>
        ) : null}
        <GatewayPanel variant="budgets" />

      </div>
    </>
  );
}
