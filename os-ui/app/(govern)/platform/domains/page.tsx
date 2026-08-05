/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import { ConfirmProvider, useConfirm } from '@/components/lifecycle/ConfirmDialog';

type Domain = {
  id: string;
  name: string;
  owner: string;
  archived: boolean;
  layers: { ml: boolean };
  createdAt: string;
};

export default function DomainsPage() {
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
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Create failed');
      else { setName(''); setOwner(''); await load(); }
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
      <PageHeader title="Domains" crumb="platform · structural map of the tenant" />
      <div className="content">
        <p className="lead">
          Domains are the tenant&apos;s <strong>structural map</strong> — each is a bounded space with an
          owner, optional compute layers, and its own people and artifacts. Create them here; everything
          downstream (access, governance, spend) hangs off this shape.
        </p>

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
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
