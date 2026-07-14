/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { canPromote } from '@/lib/core/session';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import {
  type Artifact,
  type ArtifactType,
  type Visibility,
  badgeClass,
  TYPE_LABELS,
} from '@/lib/core/artifact-model';

export type SpecField = {
  key: string;
  label: string;
  placeholder?: string;
  textarea?: boolean;
  mono?: boolean;
};

type Group = { key: string; heading: string; sub?: string; items: Artifact[] };

/** One row of an artifact's version history (from GET …/versions). */
type VersionRow = { version: number; at: string; author: string; summary: string };

/**
 * Reusable workspace panel for one artifact type. Renders the caller's scoped
 * list — their Personal items, their domains' Shared items GROUPED BY DOMAIN,
 * and any Certified copies added from the Marketplace — plus a create form
 * (with a domain picker when the user spans multiple domains), visibility
 * badges + filter, and role-gated promote actions (builder → Shared, admin →
 * Certified). Every authoring tab mounts this so the lifecycle is identical.
 */
export default function ArtifactPanel({
  type,
  intro,
  createLabel,
  specFields = [],
  renderSpec,
}: {
  type: ArtifactType;
  intro?: ReactNode;
  createLabel?: string;
  specFields?: SpecField[];
  renderSpec?: (a: Artifact) => ReactNode;
}) {
  const { user } = useUser();
  const [items, setItems] = useState<Artifact[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'All' | Visibility>('All');
  const [busyId, setBusyId] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  // inline edit (alter name + description in place)
  const [editId, setEditId] = useState('');
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // inline version history (per artifact)
  const [historyId, setHistoryId] = useState('');
  const [versionsList, setVersionsList] = useState<VersionRow[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const [confirmDemoteId, setConfirmDemoteId] = useState('');

  // create form
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [spec, setSpec] = useState<Record<string, string>>({});
  const [domain, setDomain] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (user && !domain) setDomain(user.domains[0] ?? '');
  }, [user, domain]);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch(`/api/artifacts?type=${type}${showArchived ? '&archived=1' : ''}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load');
      else setItems(body.items ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [type, showArchived]);

  useEffect(() => {
    load();
  }, [load]);

  const create = useCallback(async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/artifacts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, name, description, spec, domain }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Create failed');
      else {
        setName('');
        setDescription('');
        setSpec({});
        await load();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }, [name, description, spec, domain, type, creating, load]);

  const act = useCallback(
    async (a: Artifact, path: string, method: string) => {
      setBusyId(a.id);
      setError('');
      try {
        const res = await fetch(path, { method });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? 'Action failed');
        } else await load();
      } finally {
        setBusyId('');
      }
    },
    [load],
  );

  // POST a body-carrying action (archive/unarchive/restore) then reload.
  const post = useCallback(
    async (a: Artifact, path: string, payload: unknown) => {
      setBusyId(a.id);
      setError('');
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? 'Action failed');
        } else await load();
      } finally {
        setBusyId('');
      }
    },
    [load],
  );

  const fetchHistory = useCallback(async (id: string) => {
    setLoadingHistory(true);
    setError('');
    try {
      const res = await fetch(`/api/artifacts/${id}/versions`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.error ?? 'Failed to load history');
      else setVersionsList(body.versions ?? []);
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  // Open (or close) the inline version-history panel for one artifact.
  const toggleHistory = useCallback(
    async (a: Artifact) => {
      if (historyId === a.id) { setHistoryId(''); return; }
      setHistoryId(a.id);
      setVersionsList([]);
      await fetchHistory(a.id);
    },
    [historyId, fetchHistory],
  );

  const restoreVersion = useCallback(
    async (a: Artifact, version: number) => {
      await post(a, `/api/artifacts/${a.id}/versions`, { version });
      await fetchHistory(a.id); // reflect the new "restore of vN" entry
    },
    [post, fetchHistory],
  );

  const beginEdit = useCallback((a: Artifact) => {
    setEditId(a.id);
    setEditName(a.name);
    setEditDesc(a.description);
    setError('');
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editId || savingEdit) return;
    setSavingEdit(true);
    setError('');
    try {
      const res = await fetch(`/api/artifacts/${editId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: editName, description: editDesc }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.error ?? 'Update failed');
      else {
        setEditId('');
        await load();
      }
    } finally {
      setSavingEdit(false);
    }
  }, [editId, editName, editDesc, savingEdit, load]);

  const counts = useMemo(() => {
    const c = { Personal: 0, Shared: 0, Certified: 0 } as Record<Visibility, number>;
    for (const a of items) c[a.origin === 'certified-copy' ? 'Certified' : a.visibility]++;
    return c;
  }, [items]);

  // Grouped, ordered view: Personal → Shared (per domain) → Certified copies.
  const groups = useMemo<Group[]>(() => {
    const personal = items.filter((a) => a.origin === 'authored' && a.visibility === 'Personal');
    const certified = items.filter((a) => a.origin === 'certified-copy');
    const sharedByDomain = new Map<string, Artifact[]>();
    for (const a of items.filter((x) => x.origin === 'authored' && x.visibility === 'Shared')) {
      const list = sharedByDomain.get(a.domain) ?? [];
      list.push(a);
      sharedByDomain.set(a.domain, list);
    }
    const out: Group[] = [];
    if (filter === 'All' || filter === 'Personal') {
      if (personal.length) out.push({ key: 'personal', heading: 'Personal', sub: 'only you', items: personal });
    }
    if (filter === 'All' || filter === 'Shared') {
      for (const [d, list] of [...sharedByDomain.entries()].sort()) {
        out.push({ key: `shared-${d}`, heading: `Shared · ${d}`, sub: `everyone in ${d}`, items: list });
      }
    }
    if (filter === 'All' || filter === 'Certified') {
      if (certified.length) out.push({ key: 'certified', heading: 'Certified (from Marketplace)', sub: 'added by you', items: certified });
    }
    return out;
  }, [items, filter]);

  function card(a: Artifact) {
    const isCert = a.origin === 'certified-copy';
    const canShare = !isCert && a.visibility === 'Personal' && user && canPromote(user.role, 'Personal') && user.domains.includes(a.domain);
    const canCertify = !isCert && a.visibility === 'Shared' && user && canPromote(user.role, 'Shared') && user.domains.includes(a.domain);
    const canModify = user && canManageArtifact(user, { owner: a.owner, domain: a.domain });
    // Revoke sharing (demote), mirroring who could have promoted it: Certified→Shared
    // is admin-only; Shared→Personal is the owner or an in-domain builder/admin.
    const inDomain = user && user.domains.includes(a.domain);
    const canRevokeCert = !isCert && a.visibility === 'Certified' && user && user.role === 'admin' && inDomain;
    const canUnshare = !isCert && a.visibility === 'Shared' && user &&
      canManageArtifact(user, { owner: a.owner, domain: a.domain });
    if (editId === a.id) {
      return (
        <div className="card" key={a.id}>
          <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Name…" />
          <textarea rows={3} style={{ marginTop: 10 }} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Description…" />
          <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn ghost" style={{ padding: '5px 12px' }} onClick={() => setEditId('')} disabled={savingEdit}>Cancel</button>
            <button className="btn" style={{ padding: '5px 12px' }} onClick={saveEdit} disabled={savingEdit || !editName.trim()}>
              {savingEdit ? <span className="spin" /> : 'Save'}
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="card" key={a.id}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <h3 style={{ margin: 0 }}>{a.name}</h3>
          <div className="row" style={{ gap: 6, alignItems: 'center' }}>
            {a.archived ? <span className="badge" style={{ opacity: 0.75 }}>Archived</span> : null}
            <span className={isCert ? badgeClass('Certified') : badgeClass(a.visibility)}>
              {isCert ? 'Certified' : a.visibility === 'Shared' ? 'Shared in Domain' : a.visibility}
            </span>
          </div>
        </div>
        {a.description ? <div className="muted" style={{ marginTop: 8, whiteSpace: 'normal' }}>{a.description}</div> : null}
        {renderSpec ? <div style={{ marginTop: 8 }}>{renderSpec(a)}</div> : null}
        <div className="muted mono" style={{ marginTop: 8, fontSize: 11 }}>
          {a.owner} · {a.domain}{isCert ? ' · via Marketplace' : ''}
        </div>
        {a.tags.length ? (
          <div className="sources" style={{ marginTop: 8 }}>
            {a.tags.map((t) => <span className="chip" key={t}>{t}</span>)}
          </div>
        ) : null}
        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end', gap: 8 }}>
          {canShare ? (
            <button className="btn" style={{ padding: '5px 12px' }} disabled={busyId === a.id} onClick={() => act(a, `/api/artifacts/${a.id}/promote`, 'POST')}>
              {busyId === a.id ? <span className="spin" /> : 'Promote to Shared'}
            </button>
          ) : null}
          {canCertify ? (
            <button className="btn" style={{ padding: '5px 12px' }} disabled={busyId === a.id} onClick={() => act(a, `/api/artifacts/${a.id}/promote`, 'POST')}>
              {busyId === a.id ? <span className="spin" /> : 'Certify → Marketplace'}
            </button>
          ) : null}
          {(canRevokeCert || canUnshare) ? (
            confirmDemoteId === a.id ? (
              <>
                <button className="btn" style={{ padding: '5px 12px', background: 'var(--danger, #b42318)' }} disabled={busyId === a.id}
                  onClick={() => { setConfirmDemoteId(''); act(a, `/api/artifacts/${a.id}/demote`, 'POST'); }}>
                  {busyId === a.id ? <span className="spin" /> : (canRevokeCert ? 'Confirm revoke → Shared' : 'Confirm unshare → Personal')}
                </button>
                <button className="btn ghost" style={{ padding: '5px 12px' }} disabled={busyId === a.id} onClick={() => setConfirmDemoteId('')}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn ghost" style={{ padding: '5px 12px' }} disabled={busyId === a.id} onClick={() => setConfirmDemoteId(a.id)}>
                {canRevokeCert ? 'Revoke from Marketplace' : 'Unshare'}
              </button>
            )
          ) : null}
          {canModify && !a.archived ? (
            <button className="btn ghost" style={{ padding: '5px 12px' }} disabled={busyId === a.id} onClick={() => beginEdit(a)}>
              Edit
            </button>
          ) : null}
          <button className="btn ghost" style={{ padding: '5px 12px' }} disabled={busyId === a.id} onClick={() => toggleHistory(a)}>
            {historyId === a.id ? 'Hide history' : 'History'}
          </button>
          {canModify ? (
            a.archived ? (
              <button className="btn ghost" style={{ padding: '5px 12px' }} disabled={busyId === a.id} onClick={() => post(a, `/api/artifacts/${a.id}`, { action: 'unarchive' })}>
                {busyId === a.id ? <span className="spin" /> : 'Restore'}
              </button>
            ) : (
              <button className="btn ghost" style={{ padding: '5px 12px' }} disabled={busyId === a.id} onClick={() => post(a, `/api/artifacts/${a.id}`, { action: 'archive' })}>
                Archive
              </button>
            )
          ) : null}
          {canModify ? (
            confirmDeleteId === a.id ? (
              <>
                <button className="btn" style={{ padding: '5px 12px', background: 'var(--danger, #b42318)' }} disabled={busyId === a.id} onClick={() => act(a, `/api/artifacts/${a.id}`, 'DELETE')}>
                  {busyId === a.id ? <span className="spin" /> : 'Confirm delete'}
                </button>
                <button className="btn ghost" style={{ padding: '5px 12px' }} disabled={busyId === a.id} onClick={() => setConfirmDeleteId('')}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn ghost" style={{ padding: '5px 12px' }} disabled={busyId === a.id} onClick={() => setConfirmDeleteId(a.id)}>
                Delete
              </button>
            )
          ) : null}
        </div>
        {historyId === a.id ? (
          <div className="card" style={{ marginTop: 10, background: 'var(--surface-2, rgba(0,0,0,0.02))' }}>
            <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>Version history — restore any prior version (creates a new version).</div>
            {loadingHistory ? (
              <div className="muted">Loading…</div>
            ) : versionsList.length === 0 ? (
              <div className="muted">No prior versions yet — the first edit captures one.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {versionsList.map((v) => (
                  <div className="row" key={v.version} style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div className="muted mono" style={{ fontSize: 11 }}>
                      v{v.version} · {v.summary} · {v.author} · {new Date(v.at).toLocaleString()}
                    </div>
                    {canModify ? (
                      <button className="btn ghost" style={{ padding: '3px 10px', fontSize: 12 }} disabled={busyId === a.id} onClick={() => restoreVersion(a, v.version)}>
                        Restore
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
        {!isCert && a.visibility === 'Personal' && user && !canPromote(user.role, 'Personal') ? (
          <div className="hint" style={{ marginTop: 6, fontSize: 11 }}>Promotion to Shared is for builders/admins.</div>
        ) : null}
        {!isCert && a.visibility === 'Shared' && user && !canPromote(user.role, 'Shared') ? (
          <div className="hint" style={{ marginTop: 6, fontSize: 11 }}>Certifying to the Marketplace is admin-only.</div>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      {intro}

      {/* Create */}
      <div className="section-title">New {TYPE_LABELS[type].toLowerCase()}</div>
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input style={{ flex: '1 1 220px' }} value={name} onChange={(e) => setName(e.target.value)} placeholder={`${TYPE_LABELS[type]} name…`} />
          {user && user.domains.length > 1 ? (
            <select value={domain} onChange={(e) => setDomain(e.target.value)} title="Domain to create in">
              {user.domains.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          ) : null}
        </div>
        <textarea rows={2} style={{ marginTop: 10 }} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe / document this artifact…" />
        {specFields.map((f) => (
          <div key={f.key} style={{ marginTop: 10 }}>
            <div className="hint" style={{ marginTop: 0, marginBottom: 4 }}>{f.label}</div>
            {f.textarea ? (
              <textarea rows={4} className={f.mono ? 'mono' : undefined} spellCheck={false} value={spec[f.key] ?? ''} onChange={(e) => setSpec((s) => ({ ...s, [f.key]: e.target.value }))} placeholder={f.placeholder} />
            ) : (
              <input className={f.mono ? 'mono' : undefined} value={spec[f.key] ?? ''} onChange={(e) => setSpec((s) => ({ ...s, [f.key]: e.target.value }))} placeholder={f.placeholder} />
            )}
          </div>
        ))}
        <div className="row" style={{ marginTop: 12, justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="hint" style={{ marginTop: 0 }}>
            Created as <span className={badgeClass('Personal')}>Personal</span> in{' '}
            <strong>{domain || (user?.domains[0] ?? '…')}</strong>.
          </div>
          <button className="btn" onClick={create} disabled={creating || !name.trim()}>
            {creating ? <span className="spin" /> : (createLabel ?? `Create ${TYPE_LABELS[type].toLowerCase()}`)}
          </button>
        </div>
      </div>

      {/* Filter */}
      <div className="section-title">
        My workspace
        <span className="count-pill">{items.length}</span>
        <div className="row" style={{ marginLeft: 'auto', gap: 10, alignItems: 'center' }}>
          <button
            className="btn ghost"
            style={{ padding: '4px 10px', fontSize: 12, opacity: 1 }}
            onClick={() => setShowArchived((v) => !v)}
            title="Archived artifacts are hidden by default"
          >
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
          <div className="tabstrip" style={{ marginBottom: 0 }}>
            {(['All', 'Personal', 'Shared', 'Certified'] as const).map((f) => (
              <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                {f === 'Shared' ? 'Shared in Domain' : f}{f !== 'All' ? ` (${counts[f]})` : ''}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error ? <div className="error">{error}</div> : null}

      {loading ? (
        <div className="stub-page">Loading…</div>
      ) : groups.length === 0 ? (
        <div className="stub-page">Nothing here yet. Create one above{filter !== 'All' ? `, or clear the “${filter}” filter.` : '.'}</div>
      ) : (
        groups.map((g) => (
          <div key={g.key} style={{ marginBottom: 18 }}>
            <div className="group-head">
              <span className="group-heading">{g.heading}</span>
              {g.sub ? <span className="group-sub">{g.sub}</span> : null}
              <span className="count-pill">{g.items.length}</span>
            </div>
            <div className="grid">{g.items.map(card)}</div>
          </div>
        ))
      )}
    </div>
  );
}
