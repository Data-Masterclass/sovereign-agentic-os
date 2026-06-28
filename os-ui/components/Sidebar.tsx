'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { TAB_GROUPS, type Tab } from '@/lib/tabs';
// Static import so the brand mark is emitted into .next/static (served in the
// standalone container, where public/ is not copied).
import lotus from './lotus.svg';

export default function Sidebar() {
  const pathname = usePathname();

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
        Domain: <strong>data-masterclass</strong>
        <br />
        Role: Administrator
      </div>
    </aside>
  );
}
