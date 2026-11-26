/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Sidebar — the left navigation with tab groups, domain switcher and account menu
 * USER STORY: As a signed-in user I want to see only the tabs my role and this deployment allow,
 *             switch domain and sign out from one place so that navigation matches what I can do.
 * ARCHITECTURE:
 *   - Mounted once in `app/layout.tsx`. Tabs come from `TAB_GROUPS` filtered by role and enabled
 *     features (`filterTabGroups`, `@core/kernel/tabs`); nothing shows until `/api/auth/me` resolves.
 *   - Clicking a tab calls `emitTabNav` so a tab already showing a detail view resets to its list.
 *   - Re-exports `ACCOUNT_ITEMS` from `account-menu.ts`; sign-out does a full-page navigation.
 *   - Below the phone breakpoint (`PHONE_QUERY`, `core/ui/mobile-nav.ts`) the same <aside> is an
 *     off-canvas drawer: a fixed menu button opens it, Escape / the backdrop / the close button /
 *     any route change close it, focus is trapped inside while open and the body cannot scroll.
 *     The state transitions are the pure `navReducer`; CSS in app/styles/mobile.css does the rest,
 *     so at ≥ 640 px the button and backdrop are display:none and the rail/sidebar are unchanged.
 */
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useReducer, useRef } from 'react';
import { FOCUSABLE_SELECTOR, PHONE_QUERY, lockScroll, navReducer, nextTrapIndex } from '@core/ui/mobile-nav';
import { TAB_GROUPS, filterTabGroups, type Tab } from '@core/kernel/tabs';
import { useUser } from '@core/ui/useUser';
import { emitTabNav } from '@core/kernel/tab-nav';
import { DomainSwitcher } from '@core/ui/core/DomainSwitcher';
import { DomainStartPrompt } from '@core/ui/core/DomainStartPrompt';
import NotificationBell from '@core/ui/core/NotificationBell';
import { roleAtLeast } from '@core/kernel/session';
import { ACCOUNT_ITEMS } from '@core/ui/account-menu';
// Static import so the brand mark is emitted into .next/static (served in the
// standalone container, where public/ is not copied).
import lotus from '@/components/lotus.svg';

// The account menu's contract lives in a data-only sibling module (so it is
// testable without rendering), but the sidebar owns it — re-exported here so
// callers and the plan's interface see one name.
export { ACCOUNT_ITEMS };
export type { AccountItem } from '@core/ui/account-menu';

export default function Sidebar() {
  const pathname = usePathname();
  const { user, domainChosen } = useUser();
  const multiDomain = (user?.allDomains?.length ?? user?.domains.length ?? 0) > 1;

  // ---- Phone drawer (no effect at ≥ 640 px: the button that opens it is display:none there) ----
  const [navOpen, navDispatch] = useReducer(navReducer, false);
  const asideRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Any navigation closes the drawer (a link inside it was followed).
  useEffect(() => {
    navDispatch('route-change');
  }, [pathname]);

  // Growing past the phone breakpoint (rotation, resize) closes it: no drawer exists there.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(PHONE_QUERY);
    const onChange = () => {
      if (!mq.matches) navDispatch('left-phone');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // While open: lock body scroll, move focus in, trap Tab, close on Escape; restore on close.
  useEffect(() => {
    if (!navOpen) return;
    const aside = asideRef.current;
    const toggle = toggleRef.current;
    const restoreScroll = lockScroll(
      document.body.style,
      window.innerWidth - document.documentElement.clientWidth,
    );
    const focusables = () =>
      aside ? Array.from(aside.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];
    focusables()[0]?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        navDispatch('escape');
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables();
      const idx = list.indexOf(document.activeElement as HTMLElement);
      const next = nextTrapIndex(idx, list.length, e.shiftKey);
      if (next !== null) {
        e.preventDefault();
        list[next]?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      restoreScroll();
      // Hand focus back to the button that opened it (it is still on screen on a phone).
      toggle?.focus();
    };
  }, [navOpen]);

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    // FULL-PAGE navigation so Next's client router cache (which still holds the
    // signed-out user's RSC payloads) is discarded — the logout route already
    // cleared the cookie, so /signin renders clean with no stale identity.
    window.location.assign('/signin');
  }

  // Derive the visible tab groups once per render. filterTabGroups uses the
  // machine-readable minRole on each tab — no string parsing, no edge cases.
  const visibleGroups = filterTabGroups(
    TAB_GROUPS,
    user?.role ?? null,

    // Until /api/auth/me resolves the enabled set is unknown: show nothing rather
    // than flash the base default for a deployment configured differently.
    new Set(user?.enabledFeatures ?? []),
  );

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
    <>
    {/* The first-login domain prompt is a fixed full-screen dialog. It sits OUTSIDE the <aside>:
        on a phone the aside is a transformed, hidden drawer, which would both hide the prompt and
        become its containing block. */}
    {user && multiDomain && !domainChosen ? (
      <DomainStartPrompt allDomains={user.allDomains ?? user.domains} />
    ) : null}
    {/* Phone-only (CSS hides both at ≥ 640 px): the menu button and the drawer backdrop. */}
    <button
      ref={toggleRef}
      type="button"
      className="mnav-toggle"
      aria-controls="os-main-nav"
      aria-expanded={navOpen}
      aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
      onClick={() => navDispatch('toggle')}
    >
      <span aria-hidden className="mnav-bars" />
    </button>
    <div
      className={`mnav-backdrop${navOpen ? ' is-open' : ''}`}
      aria-hidden
      onClick={() => navDispatch('backdrop')}
    />
    <aside
      ref={asideRef}
      id="os-main-nav"
      className={`sidebar${navOpen ? ' is-open' : ''}`}
      aria-label="Main navigation"
      {...(navOpen ? { role: 'dialog', 'aria-modal': true } : {})}
    >
      <button
        type="button"
        className="mnav-close"
        aria-label="Close navigation"
        onClick={() => navDispatch('close')}
      >
        ×
      </button>
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
          group.heading ? (
            <details key={group.heading} className="nav-group nav-section" open>
              <summary className="nav-heading nav-heading-toggle">
                {group.heading}
              </summary>
              {group.tabs.map(renderTab)}
            </details>
          ) : (
            <div key={`group-${i}`} className="nav-group nav-entry">
              {group.tabs.map(renderTab)}
            </div>
          )
        ))}
      </nav>

      <div className="sidebar-foot">
        {user ? (
          <>
            <div className="who">
              <span className="who-name">{user.name}</span>
              <span className={`badge ${user.role === 'admin' ? 'ok' : 'muted'}`}>{user.role}</span>
              <NotificationBell />
            </div>
            {multiDomain ? (
              <DomainSwitcher
                allDomains={user.allDomains ?? user.domains}
                activeDomain={user.activeDomain ?? null}
              />
            ) : (
              <div className="who-domain">
                {'Domain: '}
                <strong>{user.domains.join(', ')}</strong>
              </div>
            )}
            {/* Account menu: the three PERSONAL surfaces. They sit under the
                signed-in user's own name, below the tab list and behind the
                footer's border, so nobody reads them as a 14th tab. Role-gated
                with the same roleAtLeast floor the tabs use. */}
            <div
              className="nav-group nav-entry account-menu"
              // Pull the nav-items back to the sidebar's nav gutter (the foot
              // pads 18px, the nav 8px), same inline-layout style the Sign out
              // button below already uses.
              style={{ marginTop: 8, marginInline: -10 }}
            >
              {ACCOUNT_ITEMS.filter((item) => roleAtLeast(user.role, item.minRole)).map((item) => (
                <Link
                  key={item.id}
                  href={item.href}
                  className={`nav-item${pathname.startsWith(item.href) ? ' active' : ''}`}
                  onClick={() => emitTabNav(item.href)}
                >
                  <span className="ico">{item.icon}</span>
                  {item.label}
                </Link>
              ))}
            </div>
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
    </>
  );
}
