/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * Inline SVG illustration set for the Tutorials system.
 * 16 motifs, one cohesive rounded-lineart style.
 * Brand colours are hardcoded (not CSS vars) so the SVG works
 * outside the CSS cascade (cards, exported thumbnails, etc.).
 */

import type { IllustrationId } from '@/lib/tutorials/types';
import type { ReactNode } from 'react';

/* ── Brand palette ───────────────────────────────────────────────────────── */
const G   = '#c8a24a'; // --gold
const GL  = '#e7cd86'; // --gold-light
const GD  = '#a07a2c'; // --gold-deep
const T   = '#1f8f88'; // --teal
const N   = '#0f406d'; // --navy
const M   = '#ff0099'; // --magenta
const INK = '#1a1813'; // --text (near-black)

/* ── Shared background tile ──────────────────────────────────────────────── */
function Tile() {
  return (
    <rect
      x={6} y={6} width={84} height={84} rx={18}
      fill="rgba(200,162,74,0.09)"
      stroke="rgba(200,162,74,0.26)"
      strokeWidth={1}
    />
  );
}

/* ── Component ───────────────────────────────────────────────────────────── */

/**
 * Renders one of the 16 fixed tutorial illustration motifs as a brand-palette
 * inline SVG. Server-safe (no hooks, no window).
 */
export default function Illustration({
  id,
  size = 96,
  className,
}: {
  id: IllustrationId;
  size?: number;
  className?: string;
}) {
  const sw  = 2;
  const lc  = 'round' as const;
  const lj  = 'round' as const;

  let motif: ReactNode = null;

  switch (id) {

    /* ── LOAD — down-arrow into an open tray ─────────────────────────────── */
    case 'load':
      motif = (
        <g strokeLinecap={lc} strokeLinejoin={lj} fill="none">
          {/* Tray */}
          <rect x={26} y={60} width={44} height={13} rx={4}
            fill="rgba(200,162,74,0.16)" stroke={G} strokeWidth={sw} />
          {/* Arrow shaft + head */}
          <line x1={48} y1={20} x2={48} y2={52} stroke={INK} strokeWidth={sw} />
          <polyline points="38,44 48,56 58,44" stroke={INK} strokeWidth={sw} />
          {/* Tiny data lines above the arrow (files to load) */}
          <line x1={32} y1={30} x2={42} y2={30} stroke={T} strokeWidth={1.5} />
          <line x1={32} y1={37} x2={38} y2={37} stroke={T} strokeWidth={1.5} />
        </g>
      );
      break;

    /* ── CLEAN — four-point sparkle ──────────────────────────────────────── */
    case 'clean':
      motif = (
        <g strokeLinecap={lc} strokeLinejoin={lj} fill="none">
          <path
            d="M48,22 L51.5,42 L70,48 L51.5,54 L48,74 L44.5,54 L26,48 L44.5,42 Z"
            fill="rgba(231,205,134,0.30)" stroke={G} strokeWidth={sw}
          />
          <circle cx={70} cy={26} r={3.5} fill={G}  stroke="none" />
          <circle cx={26} cy={28} r={2.5} fill={T}  stroke="none" />
          <circle cx={71} cy={66} r={2}   fill={G}  stroke="none" />
          <circle cx={25} cy={64} r={1.5} fill={T}  stroke="none" />
        </g>
      );
      break;

    /* ── DOCUMENT — page with folded top-right corner ────────────────────── */
    case 'document':
      motif = (
        <g strokeLinecap={lc} strokeLinejoin={lj} fill="none">
          <path
            d="M28,18 L52,18 L68,34 L68,76 L28,76 Z"
            fill="rgba(200,162,74,0.07)" stroke={INK} strokeWidth={sw}
          />
          {/* Fold flap */}
          <path d="M52,18 L68,34 L52,34 Z" fill={GL} stroke={GD} strokeWidth={1.5} />
          {/* Text lines */}
          <line x1={36} y1={45} x2={60} y2={45} stroke={T}   strokeWidth={1.5} />
          <line x1={36} y1={53} x2={60} y2={53} stroke={INK} strokeWidth={1.5} strokeOpacity={0.30} />
          <line x1={36} y1={61} x2={50} y2={61} stroke={INK} strokeWidth={1.5} strokeOpacity={0.30} />
        </g>
      );
      break;

    /* ── PUBLISH — upward arrow launched from a send-base ────────────────── */
    case 'publish':
      motif = (
        <g strokeLinecap={lc} strokeLinejoin={lj} fill="none">
          {/* Base platform */}
          <rect x={28} y={60} width={40} height={14} rx={4}
            fill="rgba(31,143,136,0.15)" stroke={T} strokeWidth={sw} />
          <circle cx={48} cy={67} r={3} fill={T} stroke="none" />
          {/* Arrow */}
          <line x1={48} y1={56} x2={48} y2={26} stroke={INK} strokeWidth={sw} />
          <polyline points="38,36 48,24 58,36" stroke={INK} strokeWidth={sw} />
        </g>
      );
      break;

    /* ── CONNECT — two nodes joined by a link ────────────────────────────── */
    case 'connect':
      motif = (
        <g strokeLinecap={lc} strokeLinejoin={lj} fill="none">
          <circle cx={24} cy={48} r={13} fill="rgba(200,162,74,0.16)" stroke={G} strokeWidth={sw} />
          <circle cx={72} cy={48} r={13} fill="rgba(31,143,136,0.16)" stroke={T} strokeWidth={sw} />
          {/* Link line */}
          <line x1={37} y1={48} x2={59} y2={48} stroke={INK} strokeWidth={sw} />
          {/* Midpoint node */}
          <circle cx={48} cy={48} r={3.5} fill={G} stroke="none" />
          {/* Inner detail on nodes */}
          <line x1={17} y1={43} x2={31} y2={43} stroke={G} strokeWidth={1.5} />
          <line x1={17} y1={53} x2={31} y2={53} stroke={G} strokeWidth={1.5} />
          <line x1={65} y1={43} x2={79} y2={43} stroke={T} strokeWidth={1.5} />
          <line x1={65} y1={53} x2={79} y2={53} stroke={T} strokeWidth={1.5} />
        </g>
      );
      break;

    /* ── AGENT — friendly bot face with antenna ──────────────────────────── */
    case 'agent':
      motif = (
        <g strokeLinecap={lc} strokeLinejoin={lj} fill="none">
          {/* Antenna */}
          <line x1={48} y1={26} x2={48} y2={16} stroke={INK} strokeWidth={sw} />
          <circle cx={48} cy={13} r={4} fill={G} stroke={GD} strokeWidth={1.5} />
          {/* Head */}
          <rect x={20} y={26} width={56} height={46} rx={12}
            fill="rgba(200,162,74,0.10)" stroke={INK} strokeWidth={sw} />
          {/* Eyes */}
          <circle cx={36} cy={44} r={6} fill={T}     stroke="none" />
          <circle cx={60} cy={44} r={6} fill={T}     stroke="none" />
          <circle cx={37.5} cy={42.5} r={2} fill="white" stroke="none" />
          <circle cx={61.5} cy={42.5} r={2} fill="white" stroke="none" />
          {/* Smile */}
          <path d="M36,55 Q48,64 60,55" stroke={INK} strokeWidth={2} />
        </g>
      );
      break;

    /* ── KNOWLEDGE — open book, spine centred ────────────────────────────── */
    case 'knowledge':
      motif = (
        <g strokeLinecap={lc} strokeLinejoin={lj} fill="none">
          {/* Left page */}
          <path d="M48,22 L20,28 L20,70 L48,74 Z"
            fill="rgba(231,205,134,0.26)" stroke={INK} strokeWidth={sw} />
          {/* Right page */}
          <path d="M48,22 L76,28 L76,70 L48,74 Z"
            fill="rgba(200,162,74,0.10)" stroke={INK} strokeWidth={sw} />
          {/* Spine */}
          <line x1={48} y1={22} x2={48} y2={74} stroke={GD} strokeWidth={2.5} />
          {/* Left-page text lines */}
          <line x1={26} y1={38} x2={44} y2={36} stroke={INK} strokeWidth={1.5} strokeOpacity={0.35} />
          <line x1={26} y1={46} x2={44} y2={44} stroke={INK} strokeWidth={1.5} strokeOpacity={0.35} />
          <line x1={26} y1={54} x2={40} y2={52} stroke={INK} strokeWidth={1.5} strokeOpacity={0.35} />
          {/* Right-page text lines (teal accent) */}
          <line x1={52} y1={36} x2={70} y2={38} stroke={T}   strokeWidth={1.5} strokeOpacity={0.65} />
          <line x1={52} y1={44} x2={70} y2={46} stroke={T}   strokeWidth={1.5} strokeOpacity={0.65} />
          <line x1={52} y1={52} x2={66} y2={54} stroke={T}   strokeWidth={1.5} strokeOpacity={0.65} />
        </g>
      );
      break;

    /* ── BUILD — three stacked blocks, gold → teal → navy ───────────────── */
    case 'build':
      motif = (
        <g strokeLinecap={lc} strokeLinejoin={lj} fill="none">
          <rect x={26} y={64} width={44} height={13} rx={3} fill={G}  stroke={GD} strokeWidth={sw} />
          <rect x={32} y={49} width={32} height={13} rx={3} fill={T}  stroke="rgba(31,143,136,0.70)"  strokeWidth={sw} />
          <rect x={38} y={34} width={20} height={13} rx={3} fill={N}  stroke="rgba(15,64,109,0.70)"   strokeWidth={sw} />
          {/* Sparkle above top block */}
          <circle cx={62} cy={28} r={3}   fill={G}  stroke="none" />
          <line x1={62} y1={23} x2={62} y2={33} stroke={G} strokeWidth={1.5} strokeOpacity={0.50} />
          <line x1={57} y1={28} x2={67} y2={28} stroke={G} strokeWidth={1.5} strokeOpacity={0.50} />
        </g>
      );
      break;

    /* ── MODEL — three-layer neural network ──────────────────────────────── */
    case 'model':
      motif = (
        <g strokeLinecap={lc} strokeLinejoin={lj} fill="none">
          {/* Input → Hidden edges */}
          <line x1={24} y1={36} x2={48} y2={28} stroke={INK} strokeWidth={1.5} strokeOpacity={0.22} />
          <line x1={24} y1={36} x2={48} y2={48} stroke={INK} strokeWidth={1.5} strokeOpacity={0.22} />
          <line x1={24} y1={36} x2={48} y2={68} stroke={INK} strokeWidth={1.5} strokeOpacity={0.22} />
          <line x1={24} y1={60} x2={48} y2={28} stroke={INK} strokeWidth={1.5} strokeOpacity={0.22} />
          <line x1={24} y1={60} x2={48} y2={48} stroke={INK} strokeWidth={1.5} strokeOpacity={0.22} />
          <line x1={24} y1={60} x2={48} y2={68} stroke={INK} strokeWidth={1.5} strokeOpacity={0.22} />
          {/* Hidden → Output edges */}
          <line x1={48} y1={28} x2={72} y2={48} stroke={T}   strokeWidth={1.5} strokeOpacity={0.45} />
          <line x1={48} y1={48} x2={72} y2={48} stroke={T}   strokeWidth={1.5} strokeOpacity={0.45} />
          <line x1={48} y1={68} x2={72} y2={48} stroke={T}   strokeWidth={1.5} strokeOpacity={0.45} />
          {/* Input nodes */}
          <circle cx={24} cy={36} r={8} fill="rgba(200,162,74,0.18)" stroke={G} strokeWidth={sw} />
          <circle cx={24} cy={60} r={8} fill="rgba(200,162,74,0.18)" stroke={G} strokeWidth={sw} />
          {/* Hidden nodes */}
          <circle cx={48} cy={28} r={7} fill="rgba(31,143,136,0.18)" stroke={T} strokeWidth={sw} />
          <circle cx={48} cy={48} r={7} fill="rgba(31,143,136,0.18)" stroke={T} strokeWidth={sw} />
          <circle cx={48} cy={68} r={7} fill="rgba(31,143,136,0.18)" stroke={T} strokeWidth={sw} />
          {/* Output node (solid gold) */}
          <circle cx={72} cy={48} r={8} fill={G} stroke={GD} strokeWidth={sw} />
        </g>
      );
      break;

    /* ── METRIC — semicircle gauge with needle ───────────────────────────── */
    case 'metric':
      motif = (
        <g strokeLinecap={lc} strokeLinejoin={lj} fill="none">
          {/* Background arc */}
          <path d="M18,62 A30,30 0 0 1 78,62" stroke={INK} strokeWidth={2} strokeOpacity={0.18} />
          {/* Teal zone (left third) */}
          <path d="M18,62 A30,30 0 0 1 38,36" stroke={T}   strokeWidth={5} strokeLinecap="round" />
          {/* Gold zone (right two-thirds) */}
          <path d="M38,36 A30,30 0 0 1 78,62" stroke={G}   strokeWidth={5} strokeLinecap="round" />
          {/* Needle */}
          <line x1={48} y1={62} x2={66} y2={36} stroke={INK} strokeWidth={2.5} />
          {/* Hub */}
          <circle cx={48} cy={62} r={5} fill={G} stroke={GD} strokeWidth={1.5} />
          {/* Tick marks */}
          <line x1={18} y1={62} x2={22} y2={62} stroke={INK} strokeWidth={2} />
          <line x1={78} y1={62} x2={74} y2={62} stroke={INK} strokeWidth={2} />
          <line x1={48} y1={32} x2={48} y2={36} stroke={INK} strokeWidth={2} />
        </g>
      );
      break;

    /* ── DASHBOARD — dark title bar + bar chart + sparkline ─────────────── */
    case 'dashboard':
      motif = (
        <g strokeLinecap={lc} strokeLinejoin={lj} fill="none">
          {/* Panel */}
          <rect x={14} y={18} width={68} height={60} rx={7}
            fill="rgba(200,162,74,0.06)" stroke={INK} strokeWidth={sw} />
          {/* Title bar fill (two-rect trick for rounded-top only) */}
          <rect x={14} y={18} width={68} height={16} rx={7}
            fill="rgba(200,162,74,0.22)" stroke="none" />
          <rect x={14} y={26} width={68} height={8}
            fill="rgba(200,162,74,0.22)" stroke="none" />
          {/* Traffic-light dots */}
          <circle cx={23} cy={26} r={2.5} fill={GD} stroke="none" />
          <circle cx={31} cy={26} r={2.5} fill={G}  stroke="none" />
          <circle cx={39} cy={26} r={2.5} fill={GL} stroke="none" />
          {/* Bar chart */}
          <rect x={20} y={55} width={8}  height={18} rx={2} fill={T}  stroke="none" />
          <rect x={31} y={47} width={8}  height={26} rx={2} fill={G}  stroke="none" />
          <rect x={42} y={51} width={8}  height={22} rx={2} fill={T}  stroke="none" />
          {/* Sparkline */}
          <polyline points="56,66 63,55 70,59 78,44" stroke={G} strokeWidth={2} />
          <circle cx={56} cy={66} r={2} fill={G} stroke="none" />
          <circle cx={63} cy={55} r={2} fill={G} stroke="none" />
          <circle cx={70} cy={59} r={2} fill={G} stroke="none" />
          <circle cx={78} cy={44} r={2} fill={G} stroke="none" />
        </g>
      );
      break;

    /* ── BET — concentric target rings + magenta arrow ───────────────────── */
    case 'bet':
      motif = (
        <g strokeLinecap={lc} strokeLinejoin={lj} fill="none">
          {/* Rings */}
          <circle cx={48} cy={48} r={30} stroke={INK} strokeWidth={sw} strokeOpacity={0.18} />
          <circle cx={48} cy={48} r={20} stroke={G}   strokeWidth={sw} />
          <circle cx={48} cy={48} r={10} stroke={T}   strokeWidth={sw} />
          <circle cx={48} cy={48} r={4}  fill={G}     stroke="none" />
          {/* Crosshair guides */}
          <line x1={18} y1={48} x2={30} y2={48} stroke={INK} strokeWidth={1} strokeOpacity={0.22} />
          <line x1={66} y1={48} x2={78} y2={48} stroke={INK} strokeWidth={1} strokeOpacity={0.22} />
          <line x1={48} y1={18} x2={48} y2={30} stroke={INK} strokeWidth={1} strokeOpacity={0.22} />
          <line x1={48} y1={66} x2={48} y2={78} stroke={INK} strokeWidth={1} strokeOpacity={0.22} />
          {/* Incoming arrow */}
          <line x1={72} y1={24} x2={54} y2={42} stroke={M} strokeWidth={2.5} />
          <polygon points="48,48 58,38 64,44" fill={M} stroke="none" />
        </g>
      );
      break;

    /* ── MARKETPLACE — storefront with gold awning ───────────────────────── */
    case 'marketplace':
      motif = (
        <g strokeLinecap={lc} strokeLinejoin={lj} fill="none">
          {/* Building */}
          <rect x={16} y={36} width={64} height={42} rx={4}
            fill="rgba(200,162,74,0.07)" stroke={INK} strokeWidth={sw} />
          {/* Awning triangle */}
          <path d="M12,38 L48,20 L84,38 Z" fill={G} stroke={GD} strokeWidth={1.5} />
          {/* Door */}
          <rect x={36} y={56} width={24} height={22} rx={3}
            fill="rgba(31,143,136,0.15)" stroke={T} strokeWidth={sw} />
          <circle cx={57} cy={68} r={2} fill={T} stroke="none" />
          {/* Windows */}
          <rect x={18} y={44} width={14} height={12} rx={2}
            fill="rgba(200,162,74,0.18)" stroke={G} strokeWidth={1.5} />
          <rect x={64} y={44} width={14} height={12} rx={2}
            fill="rgba(200,162,74,0.18)" stroke={G} strokeWidth={1.5} />
          {/* Window panes */}
          <line x1={25} y1={44} x2={25} y2={56} stroke={G} strokeWidth={1} strokeOpacity={0.50} />
          <line x1={18} y1={50} x2={32} y2={50} stroke={G} strokeWidth={1} strokeOpacity={0.50} />
          <line x1={71} y1={44} x2={71} y2={56} stroke={G} strokeWidth={1} strokeOpacity={0.50} />
          <line x1={64} y1={50} x2={78} y2={50} stroke={G} strokeWidth={1} strokeOpacity={0.50} />
        </g>
      );
      break;

    /* ── SANDBOX — sand tray with flag + shovel ──────────────────────────── */
    case 'sandbox':
      motif = (
        <g strokeLinecap={lc} strokeLinejoin={lj} fill="none">
          {/* Tray */}
          <rect x={14} y={56} width={68} height={22} rx={8}
            fill="rgba(231,205,134,0.24)" stroke={G} strokeWidth={sw} />
          {/* Sand texture */}
          <line x1={22} y1={65} x2={38} y2={65} stroke={GD} strokeWidth={1.5} strokeOpacity={0.50} />
          <line x1={44} y1={65} x2={58} y2={65} stroke={GD} strokeWidth={1.5} strokeOpacity={0.50} />
          <line x1={28} y1={71} x2={48} y2={71} stroke={GD} strokeWidth={1.5} strokeOpacity={0.35} />
          {/* Shovel handle + head */}
          <line x1={60} y1={58} x2={44} y2={30} stroke={INK} strokeWidth={sw} />
          <ellipse cx={42} cy={28} rx={9} ry={6}
            transform="rotate(-20 42 28)"
            fill={T} stroke={T} strokeWidth={1.5} />
          {/* Flag on pole */}
          <line x1={24} y1={58} x2={24} y2={34} stroke={INK} strokeWidth={sw} />
          <path d="M24,34 L40,41 L24,48 Z" fill={G} stroke="none" />
        </g>
      );
      break;

    /* ── GOVERNANCE — shield with teal checkmark ─────────────────────────── */
    case 'governance':
      motif = (
        <g strokeLinecap={lc} strokeLinejoin={lj} fill="none">
          {/* Shield */}
          <path
            d="M48,16 L74,26 L74,52 Q74,68 48,78 Q22,68 22,52 L22,26 Z"
            fill="rgba(200,162,74,0.12)" stroke={G} strokeWidth={sw}
          />
          {/* Inner shield inset */}
          <path
            d="M48,23 L68,31 L68,52 Q68,63 48,71 Q28,63 28,52 L28,31 Z"
            fill="none" stroke="rgba(200,162,74,0.32)" strokeWidth={1}
          />
          {/* Checkmark */}
          <polyline
            points="34,50 44,60 62,38"
            stroke={T} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round"
          />
        </g>
      );
      break;

    /* ── CELEBRATE — radial burst + confetti ─────────────────────────────── */
    case 'celebrate':
      motif = (
        <g strokeLinecap={lc} strokeLinejoin={lj}>
          {/* Burst rays */}
          <line x1={48} y1={48} x2={48} y2={22} stroke={G}  strokeWidth={2} />
          <line x1={48} y1={48} x2={70} y2={32} stroke={G}  strokeWidth={2} />
          <line x1={48} y1={48} x2={74} y2={56} stroke={GL} strokeWidth={2} />
          <line x1={48} y1={48} x2={56} y2={74} stroke={G}  strokeWidth={2} />
          <line x1={48} y1={48} x2={28} y2={70} stroke={GL} strokeWidth={2} />
          <line x1={48} y1={48} x2={22} y2={52} stroke={G}  strokeWidth={2} />
          <line x1={48} y1={48} x2={26} y2={32} stroke={G}  strokeWidth={2} />
          {/* Confetti pieces */}
          <rect x={44} y={17} width={8} height={6} rx={1.5} fill={G}  stroke="none" transform="rotate(15 48 20)" />
          <rect x={67} y={26} width={7} height={5} rx={1}   fill={T}  stroke="none" transform="rotate(-20 70 29)" />
          <rect x={69} y={51} width={7} height={5} rx={1}   fill={M}  stroke="none" transform="rotate(10 72 54)" />
          <rect x={52} y={69} width={6} height={5} rx={1}   fill={G}  stroke="none" transform="rotate(30 55 72)" />
          <rect x={23} y={64} width={7} height={5} rx={1}   fill={T}  stroke="none" transform="rotate(-15 27 67)" />
          <rect x={18} y={46} width={6} height={5} rx={1}   fill={N}  stroke="none" transform="rotate(25 21 49)" />
          <rect x={22} y={27} width={5} height={5} rx={1}   fill={G}  stroke="none" transform="rotate(-30 25 30)" />
          {/* Dot bursts at ray tips */}
          <circle cx={48} cy={22} r={3.5} fill={GL} stroke="none" />
          <circle cx={70} cy={32} r={3}   fill={T}  stroke="none" />
          <circle cx={74} cy={56} r={3}   fill={G}  stroke="none" />
          <circle cx={26} cy={32} r={2.5} fill={M}  stroke="none" />
        </g>
      );
      break;

    /* ── Fallback (unknown id) ────────────────────────────────────────────── */
    default:
      motif = (
        <g fill="none" strokeLinecap={lc}>
          <circle cx={48} cy={48} r={20} stroke={G} strokeWidth={sw} />
          <line x1={48} y1={34} x2={48} y2={52} stroke={G} strokeWidth={sw} />
          <circle cx={48} cy={60} r={2.5} fill={G} stroke="none" />
        </g>
      );
  }

  return (
    <svg
      viewBox="0 0 96 96"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
    >
      <Tile />
      {motif}
    </svg>
  );
}
