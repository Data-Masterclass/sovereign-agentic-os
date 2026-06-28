/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import { MARKETPLACE, KINDS } from '@/lib/marketplace';

// Server component: the cross-domain catalog of installable components, agents,
// and templates. Static seed for v1 (the OPA-governed registry lands later);
// "installed" items are already wired into this deployment.

export default function MarketplacePage() {
  const installed = MARKETPLACE.filter((m) => m.installed).length;
  return (
    <>
      <PageHeader title="Marketplace" crumb="discover, install & reuse — components · agents · templates" />
      <div className="content">
        <p className="lead">
          The cross-domain catalog: discover agents, components, templates, datasets, and
          connectors shared across the tenant, then enable them in your domain. Publishing
          and access requests are governed by policy and a visibility level.
        </p>

        {KINDS.map((kind) => {
          const items = MARKETPLACE.filter((m) => m.kind === kind);
          if (items.length === 0) return null;
          return (
            <div key={kind}>
              <div className="section-title">
                {kind}s
                <span className="count-pill">{items.length}</span>
              </div>
              <div className="grid">
                {items.map((m) => (
                  <div className="card launch-card" key={m.id}>
                    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                      <h3 style={{ margin: 0 }}>{m.name}</h3>
                      <span className={`badge ${m.installed ? 'ok' : 'muted'}`}>
                        {m.installed ? 'installed' : 'available'}
                      </span>
                    </div>
                    <div className="muted" style={{ marginTop: 6, fontSize: 11.5 }}>
                      {m.publisher}
                    </div>
                    <div className="muted" style={{ marginTop: 8, flex: 1 }}>{m.summary}</div>
                    <div className="sources" style={{ marginTop: 10 }}>
                      {m.tags.map((t) => (
                        <span className="chip" key={t}>{t}</span>
                      ))}
                    </div>
                    <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end', gap: 10 }}>
                      {m.href ? (
                        <Link className="btn ghost" href={m.href}>
                          {m.installed ? 'Open →' : 'Learn more →'}
                        </Link>
                      ) : (
                        <button className="btn ghost" disabled>
                          Learn more
                        </button>
                      )}
                      {!m.installed ? <button className="btn" disabled>Enable</button> : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        <div className="hint" style={{ marginTop: 24 }}>
          {installed} of {MARKETPLACE.length} catalog items are installed in this deployment.
          Enable/publish flows are wired to the registry + OPA visibility model in a later
          iteration.
        </div>
      </div>
    </>
  );
}
