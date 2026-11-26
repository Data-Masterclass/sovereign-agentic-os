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
 * I18N:       converted (wave 2) — texts from `admin.domains.*`. Domain ids, artifact kinds, component ids and
 *             server error / refusal texts render as sent; the typed confirmation phrase is the domain id.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmProvider, useConfirm } from '@core/ui/lifecycle/ConfirmDialog';
import GatewayPanel from '@tabs/admin/ui/GatewayPanel';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import { sectionMinRole } from '@tabs/admin/lib/sections';
import { deleteRunGate, type DeleteRunGate } from '@tabs/admin/lib/domain-delete-view';
import { useTranslations } from '@core/i18n/client';

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
  const t = useTranslations('admin');
  const tc = useTranslations('common');
  const gateWhy = (g: Exclude<DeleteRunGate, { canRun: true }>) =>
    g.reason === 'blockedBy' ? t('domains.plan.blockedBy', { list: g.list })
      : g.reason === 'blockedCount' ? t('domains.plan.blockedCount', { count: g.count })
      : t('domains.plan.nothing');
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
      if (!res.ok) setError(body.error ?? t('domains.errors.load'));
      else setDomains(body.domains ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [t]);

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
      if (!res.ok) setError(body.error ?? t('domains.errors.createHttp', { status: res.status }));
      else { setName(''); setOwner(''); await load(); }
    } catch (e) {
      setError(t('domains.errors.create', { message: (e as Error).message }));
    } finally {
      setBusy('');
    }
  }, [name, owner, load, t]);

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
        setError(b.error ?? t('domains.errors.update'));
      } else await load();
    } finally {
      setBusy('');
    }
  }, [load, t]);

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
      if (!res.ok) { setDelPlan(null); setError(b.error ?? t('domains.errors.planHttp', { status: res.status })); }
      else { setDelBackup(false); setDelPlan({ id: d.id, plan: b.plan }); }
    } catch (e) {
      setDelPlan(null); // never leave an older domain's plan on screen under a failed request
      setError(t('domains.errors.plan', { message: (e as Error).message }));
    } finally {
      setBusy('');
    }
  }, [t]);
  const runDelete = useCallback(async () => {
    if (!delPlan) return;
    const ok = await confirm({
      title: t('domains.deleteConfirm.title', { id: delPlan.id }),
      body: t('domains.deleteConfirm.body', { remove: delPlan.plan.totals.remove, keep: delPlan.plan.totals.keep }),
      confirmLabel: t('domains.deleteConfirm.confirm'),
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
        setDelPlan({ ...delPlan, status: 'error', message: cb.error ?? t('domains.errors.confirm') });
        return;
      }
      // 2. The run, with that token.
      const res = await fetch(`/api/platform-admin/domains/${delPlan.id}/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dryRun: false, token: cb.token, iHaveABackup: delBackup }) });
      const b = await res.json().catch(() => ({}));
      const message = b.status === 'done' ? t('domains.result.done', { count: b.done.length })
        : b.status === 'refused' ? t('domains.result.refused', { reason: String(b.reason) })
        : b.status === 'failed' ? t('domains.result.failed', { label: String(b.failed.label), error: String(b.failed.error), count: b.remaining.length })
        : (b.error ?? t('domains.errors.delete'));
      setDelPlan({ ...delPlan, plan: b.plan ?? delPlan.plan, status: b.status ?? 'error', message });
      await load();
    } catch (e) {
      setDelPlan({ ...delPlan, status: 'error', message: t('domains.errors.deleteWith', { message: (e as Error).message }) });
    } finally {
      setBusy('');
    }
  }, [delPlan, delBackup, confirm, load, t]);

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
      if (!res.ok) setError(body.error ?? t('domains.errors.move'));
      else {
        setMoveMsg(t('domains.moved', { kind: String(body.kind), id: String(body.id), target: String(body.targetDomain) }));
        setMoveId('');
      }
    } finally {
      setBusy('');
    }
  }, [moveKind, moveId, moveTarget, t]);

  const assignUnassigned = useCallback(async () => {
    if (!bulkTarget) return;
    const name = liveDomains.find((d) => d.id === bulkTarget)?.name ?? bulkTarget;
    const ok = await confirm({
      title: t('domains.bulkConfirm.title', { name }),
      body: t('domains.bulkConfirm.body', { name }),
      confirmLabel: t('domains.bulkConfirm.confirm'),
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
      if (!res.ok) setError(body.error ?? t('domains.errors.assign'));
      else {
        const per = Object.entries(body.counts ?? {})
          .filter(([, n]) => (n as number) > 0)
          .map(([k, n]) => `${k}: ${n}`)
          .join(', ');
        const v = { total: Number(body.total ?? 0), target: String(body.targetDomain) };
        setMoveMsg(per ? t('domains.assignedPer', { ...v, per }) : t('domains.assigned', v));
      }
    } finally {
      setBusy('');
    }
  }, [bulkTarget, liveDomains, confirm, t]);

  return (
    <>
      <div>
        <div className="section-title">{t('domains.create.title')}</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input style={{ flex: '1 1 160px' }} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('domains.create.namePlaceholder')} />
            <input style={{ flex: '1 1 140px' }} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder={t('domains.create.ownerPlaceholder')} />
            <button className="btn" onClick={create} disabled={busy === 'create' || !name.trim() || !owner.trim()}>
              {busy === 'create' ? <span className="spin" /> : t('domains.create.submit')}
            </button>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            {t('domains.create.hint')}
          </div>
        </div>

        <div className="section-title">{t('domains.move.title')}</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="hint" style={{ marginBottom: 10 }}>
            {t.rich('domains.move.hint', { strong: (c) => <strong>{c}</strong> })}
          </div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={moveKind} onChange={(e) => setMoveKind(e.target.value)} aria-label={t('domains.move.kindAria')}>
              {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <input
              style={{ flex: '1 1 200px' }}
              value={moveId}
              onChange={(e) => setMoveId(e.target.value)}
              placeholder={t('domains.move.idPlaceholder')}
              autoComplete="off"
            />
            <span className="muted" style={{ fontSize: 12 }}>→</span>
            <select value={moveTarget} onChange={(e) => setMoveTarget(e.target.value)} aria-label={t('domains.move.targetAria')}>
              {liveDomains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <button className="btn" onClick={moveOne} disabled={busy === 'move-one' || !moveKind || !moveId.trim() || !moveTarget}>
              {busy === 'move-one' ? <span className="spin" /> : t('domains.move.submit')}
            </button>
          </div>
        </div>

        <div className="section-title">{t('domains.bulk.title')}</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="hint" style={{ marginBottom: 10 }}>
            {t.rich('domains.bulk.hint', { strong: (c) => <strong>{c}</strong> })}
          </div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={bulkTarget} onChange={(e) => setBulkTarget(e.target.value)} aria-label={t('domains.bulk.targetAria')}>
              {liveDomains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <button className="btn" onClick={assignUnassigned} disabled={busy === 'bulk' || !bulkTarget}>
              {busy === 'bulk' ? <span className="spin" /> : t('domains.bulk.submit')}
            </button>
          </div>
        </div>

        {moveMsg ? <div className="hint" style={{ marginBottom: 12 }}>{moveMsg}</div> : null}
        {error ? <div className="error">{error}</div> : null}

        <div className="section-title">{t('domains.list.title')}<span className="count-pill">{domains.length}</span></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>{t('domains.list.domain')}</th><th>{t('domains.list.owner')}</th><th>{t('domains.list.scienceLayer')}</th><th></th></tr>
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
                          {busy === d.id ? <span className="spin" /> : t('domains.list.save')}
                        </button>
                        <button className="btn ghost" style={{ padding: '3px 8px', fontSize: 12 }} onClick={cancelRename}>
                          {tc('actions.cancel')}
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
                            title={t('domains.list.renameTitle')}
                          >
                            {t('domains.list.rename')}
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
                      title={d.layers.ml ? t('domains.list.layerDisable') : t('domains.list.layerEnable')}
                      onClick={() => patch(d, { op: 'layer', layer: 'ml', enabled: !d.layers.ml })}
                    >
                      <span className="switch-track"><span className="switch-thumb" /></span>
                      <span className="switch-text">{d.layers.ml ? t('domains.list.on') : t('domains.list.off')}</span>
                    </button>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn ghost" style={{ padding: '4px 10px' }} disabled={busy === d.id}
                      onClick={() => patch(d, { op: 'archive', archived: !d.archived })}>
                      {busy === d.id ? <span className="spin" /> : d.archived ? t('domains.list.unarchive') : t('domains.list.archive')}
                    </button>{' '}
                    <button className="btn ghost danger" style={{ padding: '4px 10px' }} disabled={busy === d.id}
                      title={t('domains.list.deleteTitle')}
                      onClick={() => planDelete(d)}>
                      {t('domains.list.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {delPlan ? (
          <div className="card" style={{ marginTop: 16 }} data-testid="domain-delete-plan" ref={delPlanRef}>
            <div className="section-title">{t('domains.plan.title', { id: delPlan.id })}</div>
            <div className="hint">
              {delPlan.plan.totals.blocked
                ? t('domains.plan.summaryBlocked', { remove: delPlan.plan.totals.remove, keep: delPlan.plan.totals.keep, blocked: delPlan.plan.totals.blocked })
                : t('domains.plan.summary', { remove: delPlan.plan.totals.remove, keep: delPlan.plan.totals.keep })}
              {' '}{t.rich('domains.plan.window', { flag: 'polaris.purge.enabled', code: (c) => <code>{c}</code> })}
            </div>
            <table>
              <thead><tr><th>{t('domains.plan.component')}</th><th>{t('domains.plan.remove')}</th><th>{t('domains.plan.kept')}</th></tr></thead>
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
              {t('domains.plan.backup')}
            </label>
            {(() => { const g = deleteRunGate(delPlan.plan); return g.canRun ? null : <div className="error" data-testid="domain-delete-blocked">{gateWhy(g)}</div>; })()}
            {delPlan.message ? <div className={delPlan.status === 'done' ? 'hint' : 'error'}>{delPlan.message}</div> : null}
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button className="btn danger" disabled={busy === delPlan.id || !deleteRunGate(delPlan.plan).canRun} onClick={runDelete}>
                {busy === delPlan.id ? <span className="spin" /> : t('domains.plan.run')}
              </button>
              <button className="btn ghost" onClick={() => setDelPlan(null)}>{t('domains.plan.close')}</button>
            </div>
          </div>
        ) : null}
        <GatewayPanel variant="budgets" />

      </div>
    </>
  );
}
