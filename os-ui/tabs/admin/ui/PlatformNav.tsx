/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { STRIP_SECTIONS } from '@tabs/admin/lib/sections';



export default function PlatformNav() {
  const pathname = usePathname();
  return (
    <nav className="pa-subnav">
      {STRIP_SECTIONS.map((s) => {
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
