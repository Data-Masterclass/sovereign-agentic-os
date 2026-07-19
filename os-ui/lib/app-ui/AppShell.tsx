/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import * as React from 'react';
import { cx } from './cx.ts';

export type NavItem = {
  /** Visible label. */
  label: React.ReactNode;
  /** Optional leading icon (emoji or node). */
  icon?: React.ReactNode;
  /** Link target — renders an <a>. Provide this OR onClick. */
  href?: string;
  /** Click handler — renders a <button>. Provide this OR href. */
  onClick?: () => void;
  /** Marks the current item (gold rail + tint). */
  active?: boolean;
};

export type AppShellProps = {
  /** Brand mark. String renders the OS two-tone mark; a node is used verbatim. */
  brand?: React.ReactNode;
  /** Small brand sub-label under the mark (only used with a string brand). */
  brandSub?: React.ReactNode;
  /** Optional brand logo node (e.g. an <img>), shown left of the mark. */
  logo?: React.ReactNode;
  /** The app's OWN nav — order preserved. */
  nav: NavItem[];
  /** Page title in the topbar. */
  title?: React.ReactNode;
  /** Sub-title / breadcrumb under the title. */
  crumb?: React.ReactNode;
  /** Top-right topbar slot (e.g. user menu, actions). */
  topbarRight?: React.ReactNode;
  /** Bottom-of-sidebar slot (e.g. user card, sign-out). */
  sidebarFooter?: React.ReactNode;
  /** Page body. */
  children?: React.ReactNode;
  /** Constrain + pad the body with the OS content column. Default true. */
  padded?: boolean;
  /** Extra class on the outer .sb-root .sb-shell element. */
  className?: string;
  /** Extra class on the .sb-content body wrapper. */
  contentClassName?: string;
};

function NavLink({ item }: { item: NavItem }) {
  const cls = cx('sb-nav-item', item.active && 'sb-active');
  const inner = (
    <>
      {item.icon != null && <span className="sb-ico">{item.icon}</span>}
      {item.label}
    </>
  );
  if (item.href != null) {
    return (
      <a className={cls} href={item.href} aria-current={item.active ? 'page' : undefined}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" className={cls} onClick={item.onClick} aria-current={item.active ? 'page' : undefined}>
      {inner}
    </button>
  );
}

/**
 * The OS chrome — a sticky dark sidebar + a black topbar around a padded content
 * column — driven entirely by props. Framework-agnostic (plain <a>/<button>, no
 * router). Pair with `theme.css` for the full OS look; every class is overridable.
 *
 *   <AppShell
 *     brand="Acme App"
 *     nav={[{ label: 'Home', href: '/', active: true }, { label: 'Data', href: '/data' }]}
 *     title="Home"
 *   >
 *     ...page...
 *   </AppShell>
 */
export function AppShell({
  brand,
  brandSub,
  logo,
  nav,
  title,
  crumb,
  topbarRight,
  sidebarFooter,
  children,
  padded = true,
  className,
  contentClassName,
}: AppShellProps) {
  return (
    <div className={cx('sb-root', 'sb-shell', className)}>
      <aside className="sb-sidebar">
        <div className="sb-brand">
          {logo}
          <div>
            {typeof brand === 'string' ? <div className="sb-brand-mark">{brand}</div> : brand}
            {brandSub != null && <div className="sb-brand-sub">{brandSub}</div>}
          </div>
        </div>
        <nav className="sb-nav">
          {nav.map((item, i) => (
            <NavLink key={i} item={item} />
          ))}
        </nav>
        {sidebarFooter != null && <div className="sb-sidebar-foot">{sidebarFooter}</div>}
      </aside>

      <div className="sb-main">
        <div className="sb-topbar">
          <div>
            {title != null && <h1>{title}</h1>}
            {crumb != null && <div className="sb-crumb">{crumb}</div>}
          </div>
          {topbarRight != null && <div className="sb-topbar-actions">{topbarRight}</div>}
        </div>
        <div className={cx(padded && 'sb-content', contentClassName)}>{children}</div>
      </div>
    </div>
  );
}
