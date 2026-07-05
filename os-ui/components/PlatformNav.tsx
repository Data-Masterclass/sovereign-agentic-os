/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** The Platform-Admin sub-navigation (the tenant control room's section strip). */
const SECTIONS: { label: string; href: string }[] = [
  { label: 'Overview', href: '/platform' },
  { label: 'Domains', href: '/platform/domains' },
  { label: 'Users & Access', href: '/platform/access' },
  { label: 'Roles & Permissions', href: '/platform/roles' },
  { label: 'Cost & Billing', href: '/platform/billing' },
  { label: 'Models & Providers', href: '/platform/models' },
  { label: 'Components & System', href: '/platform/components' },
  { label: 'Security & Egress', href: '/platform/security' },
  { label: 'Backups & Restore', href: '/platform/backups' },
  { label: 'Plugins', href: '/platform/plugins' },
  { label: 'MCPs & APIs', href: '/platform/mcp-apis' },
  { label: 'Settings', href: '/platform/settings' },
];

export default function PlatformNav() {
  const pathname = usePathname();
  return (
    <nav className="pa-subnav">
      {SECTIONS.map((s) => {
        const active = s.href === '/platform' ? pathname === '/platform' : pathname.startsWith(s.href);
        return (
          <Link key={s.href} href={s.href} className={`pa-subnav-item${active ? ' active' : ''}`}>
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
