/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { PathId } from '@/lib/home/launcher';

/**
 * Custom, on-brand illustration set for the Home launcher (home-golden-path.md
 * §Taste — "the platform's front door"). One cohesive system: a soft warm wash,
 * a single 2.4px rounded line language, and the brand palette (gold / teal /
 * navy with a sparing magenta spark). Hand-authored geometry — distinct per
 * path, NOT stock clip-art. Decorative, so aria-hidden.
 */

const GOLD = '#c8a24a';
const GOLD_LT = '#e7cd86';
const TEAL = '#1f8f88';
const NAVY = '#0f406d';
const INK = '#2a2620';
const MAGENTA = '#ff5fb0';

function Frame({ wash, children }: { wash: string; children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 88 64" className="home-illus" role="img" aria-hidden="true" fill="none">
      <rect x="0.5" y="0.5" width="87" height="63" rx="13" fill="#fbf7ee" stroke="#ece2cd" />
      <circle cx="63" cy="20" r="22" fill={wash} opacity="0.5" />
      <g
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        transform="translate(20 12)"
      >
        {children}
      </g>
    </svg>
  );
}

const ILLUS: Record<PathId, React.ReactNode> = {
  // Data — layered governed strata + a rising spark.
  data: (
    <Frame wash="#f4e6c2">
      <ellipse cx="24" cy="6" rx="18" ry="6" fill="#fff" stroke={GOLD} />
      <path d="M6 6v14c0 3.3 8 6 18 6s18-2.7 18-6V6" stroke={GOLD} />
      <path d="M6 13c0 3.3 8 6 18 6s18-2.7 18-6" stroke={GOLD_LT} />
      <path d="M2 34l9-8 7 5 12-13" stroke={TEAL} />
      <circle cx="30" cy="18" r="2.4" fill={MAGENTA} stroke="none" />
    </Frame>
  ),
  // Knowledge — an open book + bookmark.
  knowledge: (
    <Frame wash="#dff0ec">
      <path d="M24 8c-5-4-13-4-18-2v26c5-2 13-2 18 2 5-4 13-4 18-2V6c-5-2-13-2-18 2z" fill="#fff" stroke={TEAL} />
      <path d="M24 8v28" stroke={TEAL} />
      <path d="M11 14h7M11 20h7M30 14h7M30 20h7" stroke={GOLD} />
      <path d="M36 2v10l3-3 3 3V2" fill="#fff" stroke={MAGENTA} />
    </Frame>
  ),
  // Connections — nodes joined by a governed cable with a plug.
  connections: (
    <Frame wash="#e9e1f2">
      <circle cx="6" cy="10" r="5" fill="#fff" stroke={NAVY} />
      <circle cx="42" cy="30" r="5" fill="#fff" stroke={NAVY} />
      <circle cx="40" cy="6" r="3.4" fill="#fff" stroke={GOLD} />
      <path d="M10 13c10 4 8 14 28 16" stroke={TEAL} />
      <path d="M11 9l5-3M14 12l5-3" stroke={GOLD} />
    </Frame>
  ),
  // Agents — a friendly governed bot with an orbiting signal.
  agents: (
    <Frame wash="#f4e6c2">
      <path d="M22 2v4" stroke={GOLD} />
      <circle cx="22" cy="1.5" r="2" fill={MAGENTA} stroke="none" />
      <rect x="8" y="6" width="28" height="22" rx="7" fill="#fff" stroke={NAVY} />
      <circle cx="17" cy="17" r="2.6" fill={TEAL} stroke="none" />
      <circle cx="27" cy="17" r="2.6" fill={TEAL} stroke="none" />
      <path d="M17 23h10" stroke={GOLD} />
      <path d="M2 30c12 6 30 6 40 0" stroke={GOLD_LT} />
    </Frame>
  ),
  // Software — a build window with braces (chat-to-app).
  software: (
    <Frame wash="#dff0ec">
      <rect x="4" y="4" width="38" height="28" rx="5" fill="#fff" stroke={NAVY} />
      <path d="M4 11h38" stroke={NAVY} />
      <circle cx="9" cy="7.5" r="1.4" fill={MAGENTA} stroke="none" />
      <circle cx="14" cy="7.5" r="1.4" fill={GOLD} stroke="none" />
      <path d="M19 17c-3 0-3 3-3 4.5s0 4.5 3 4.5M27 17c3 0 3 3 3 4.5s0 4.5-3 4.5" stroke={TEAL} />
    </Frame>
  ),
  // Science — an orbital model + nucleus (ML).
  science: (
    <Frame wash="#e9e1f2">
      <ellipse cx="22" cy="17" rx="20" ry="8" stroke={TEAL} />
      <ellipse cx="22" cy="17" rx="20" ry="8" stroke={GOLD} transform="rotate(60 22 17)" />
      <ellipse cx="22" cy="17" rx="20" ry="8" stroke={NAVY} transform="rotate(120 22 17)" />
      <circle cx="22" cy="17" r="3.4" fill={MAGENTA} stroke="none" />
    </Frame>
  ),
  // Metrics — a gauge dial + needle (the agreed KPI).
  metrics: (
    <Frame wash="#f4e6c2">
      <path d="M4 28a20 20 0 0140 0" stroke={GOLD} />
      <path d="M9 28a15 15 0 0130 0" stroke={GOLD_LT} />
      <path d="M24 28l9-11" stroke={TEAL} />
      <circle cx="24" cy="28" r="3" fill={NAVY} stroke="none" />
      <path d="M24 8v4M40 28h-3M8 28H5" stroke={GOLD} />
    </Frame>
  ),
  // Dashboards — a panel with bars + a trend line.
  dashboards: (
    <Frame wash="#dff0ec">
      <rect x="3" y="3" width="40" height="30" rx="5" fill="#fff" stroke={NAVY} />
      <path d="M11 27v-7M19 27v-12M27 27v-5M35 27v-15" stroke={TEAL} />
      <path d="M9 12l8-4 8 5 10-7" stroke={GOLD} />
      <circle cx="35" cy="6" r="2" fill={MAGENTA} stroke="none" />
    </Frame>
  ),
  // Big Bets — a flag planted on a rising arc (the initiative).
  'big-bets': (
    <Frame wash="#e9e1f2">
      <path d="M2 32c10-2 18-12 22-20" stroke={GOLD_LT} />
      <path d="M24 12V2l14 4-14 4" fill="#fff" stroke={MAGENTA} />
      <path d="M24 12v20" stroke={NAVY} />
      <path d="M14 32h26" stroke={GOLD} />
      <circle cx="24" cy="2" r="1.8" fill={TEAL} stroke="none" />
    </Frame>
  ),
  // Marketplace — a storefront awning over a tile grid (certified reuse).
  marketplace: (
    <Frame wash="#f4e6c2">
      <path d="M4 12l3-8h30l3 8" fill="#fff" stroke={GOLD} />
      <path d="M4 12c2 3 6 3 8 0s6 3 8 0 6 3 8 0 6 3 8 0" stroke={TEAL} />
      <rect x="7" y="14" width="30" height="18" rx="3" fill="#fff" stroke={NAVY} />
      <path d="M22 14v18M7 23h30" stroke={GOLD_LT} />
      <circle cx="14.5" cy="18.5" r="1.6" fill={MAGENTA} stroke="none" />
    </Frame>
  ),
};

export default function PathIllustration({ id }: { id: PathId }) {
  return <>{ILLUS[id]}</>;
}
