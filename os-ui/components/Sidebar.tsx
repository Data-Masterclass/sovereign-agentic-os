'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { TAB_GROUPS, filterTabGroups, type Tab } from '@/lib/tabs';
import { useUser } from '@/lib/useUser';
import { emitTabNav } from '@/lib/tab-nav';
// Static import so the brand mark is emitted into .next/static (served in the
// standalone container, where public/ is not copied).
import lotus from './lotus.svg';

export default function Sidebar() {
  const pathname = usePathname();
  const { user } = useUser();

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    // FULL-PAGE navigation so Next's client router cache (which still holds the
    // signed-out user's RSC payloads) is discarded — the logout route already
    // cleared the cookie, so /signin renders clean with no stale identity.
    window.location.assign('/signin');
  }

  // Derive the visible tab groups once per render. filterTabGroups uses the
  // machine-readable minRole on each tab — no string parsing, no edge cases.
  const visibleGroups = filterTabGroups(TAB_GROUPS, user?.role ?? null);

  function renderTab(tab: Tab) {
    if (!tab.href) {
      return (
        <div key={tab.label} className="nav-item stub" title={tab.role}>
          <span className="ico">{tab.icon}</span>
          {tab.label}
          <span className="soon">soon</span>
        </div>
      );
    }
    const active =
      tab.href === '/' ? pathname === '/' : pathname.startsWith(tab.href);
    return (
      <Link
        key={tab.label}
        href={tab.href}
        className={`nav-item${active ? ' active' : ''}`}
        title={tab.role}
        // Broadcast the nav so a tab already showing a detail sub-view resets back
        // to its list — client-navigating to the same route wouldn't re-mount it.
        onClick={() => emitTabNav(tab.href!)}
      >
        <span className="ico">{tab.icon}</span>
        {tab.label}
      </Link>
    );
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="logo"
          src={lotus.src}
          alt="Sovereign Agentic OS"
          width={34}
          height={34}
        />
        <div>
          <div className="mark">
            Sovereign <span className="accent">Agentic</span> OS
          </div>
          <div className="sub">Data Masterclass</div>
        </div>
      </div>

      <nav className="nav">
        {visibleGroups.map((group, i) => (
          <div key={group.heading ?? `group-${i}`} className="nav-group">
            {group.heading ? <div className="nav-heading">{group.heading}</div> : null}
            {group.tabs.map(renderTab)}
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        {user ? (
          <>
            <div className="who">
              <span className="who-name">{user.name}</span>
              <span className={`badge ${user.role === 'admin' ? 'ok' : 'muted'}`}>{user.role}</span>
            </div>
            {user.domains.length > 1 ? 'Domains: ' : 'Domain: '}
            <strong>{user.domains.join(', ')}</strong>
            <button className="btn ghost" style={{ marginTop: 10, width: '100%', padding: '5px 10px' }} onClick={signOut}>
              Sign out
            </button>
          </>
        ) : (
          <Link className="btn ghost" href="/signin" style={{ width: '100%', padding: '5px 10px' }}>
            Sign in
          </Link>
        )}
      </div>
    </aside>
  );
}
