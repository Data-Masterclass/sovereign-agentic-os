'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { TAB_GROUPS, type Tab } from '@/lib/tabs';
import { useUser } from '@/lib/useUser';
// Static import so the brand mark is emitted into .next/static (served in the
// standalone container, where public/ is not copied).
import lotus from './lotus.svg';

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user } = useUser();

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/signin');
    router.refresh();
  }

  // Hide role-gated tabs from users who can't act on them, so participants
  // never walk into a permission wall. Builders keep Builder tabs; only admins
  // see Administrator-only surfaces (e.g. Users).
  function canSeeTab(tab: Tab): boolean {
    if (!tab.role || !user) return true;
    const r = tab.role.toLowerCase();
    if (r === 'administrator') return user.role === 'admin';
    if (r.includes('builder')) return user.role === 'admin' || user.role === 'builder';
    return true;
  }

  function renderTab(tab: Tab) {
    if (!canSeeTab(tab)) return null;
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
        {TAB_GROUPS.map((group, i) => (
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
