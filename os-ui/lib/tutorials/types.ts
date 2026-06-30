/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Tutorials system — shared types (the authoring + engine contract).
 *
 * One tutorial per golden path, authored once, reused by both the Home card
 * ("How it works") and the tab header ("Tutorial") — a single source so the two
 * entry points never drift. Content is authored (not generated); the engine only
 * renders it and drives a lightweight coach-mark walk-through over the REAL tab.
 */

/** The ten golden paths. The registry is keyed by these. */
export type GoldenPathKey =
  | 'data'
  | 'knowledge'
  | 'connections'
  | 'agents'
  | 'software'
  | 'science'
  | 'metrics'
  | 'dashboards'
  | 'big-bets'
  | 'marketplace';

/**
 * Framing role — derived from the session Role, drives the verb + emphasis.
 * The CORE path is identical for everyone; only framing shifts.
 *   - user    → "use / consume"
 *   - creator → "create" (drafts)
 *   - builder → also "review / promote"
 */
export type FramingRole = 'user' | 'creator' | 'builder';

/**
 * The cohesive illustration set. A small, fixed motif vocabulary keeps the ten
 * tutorials feeling like one set (no stock clip-art, no per-tutorial drift).
 * Rendered by `components/tutorials/Illustration.tsx` as inline brand-palette SVG.
 */
export type IllustrationId =
  | 'load'
  | 'clean'
  | 'document'
  | 'publish'
  | 'connect'
  | 'agent'
  | 'knowledge'
  | 'build'
  | 'model'
  | 'metric'
  | 'dashboard'
  | 'bet'
  | 'marketplace'
  | 'sandbox'
  | 'governance'
  | 'celebrate';

/** A storybook panel: one illustration + a caption. Optionally role-tinted. */
export interface Panel {
  illustration: IllustrationId;
  title: string;
  body: string;
  /** Optional per-role caption override (framing only — same panel). */
  byRole?: Partial<Record<FramingRole, { title?: string; body?: string }>>;
}

/**
 * A single coach-mark step on the REAL tab.
 *
 * `anchor` is a stable `data-tutorial-anchor` id the tab exposes. In practice
 * (sandbox) mode the engine targets `sandboxAnchor` instead, so a newcomer
 * clicks through the tab's existing personal/sandbox lane — never governed data.
 */
export interface WalkStep {
  /** Stable UI anchor (data-tutorial-anchor value) on the real tab. */
  anchor: string;
  title: string;
  body: string;
  /** Anchor used in practice mode (defaults to `anchor`). */
  sandboxAnchor?: string;
  /**
   * True if this step performs a GOVERNED WRITE (promote / publish / certify /
   * connection-write). These are EXCLUDED in sandbox mode — practice never
   * writes to real products. The engine asserts this invariant at runtime.
   */
  governedWrite?: boolean;
  /** Restrict this step to certain roles (default: all roles see it). */
  roles?: FramingRole[];
  /** Tab route the anchor lives on (for the cross-tab "open this tab" fallback). */
  route?: string;
}

/** Role framing: the verb + a one-line hook emphasis for this role. */
export interface RoleFraming {
  /** Action verb, e.g. "Create", "Review & promote", "Use". */
  verb: string;
  /** One-line framing shown on the hook for this role. */
  hook: string;
}

/** The walk-through can run in two modes. */
export type WalkMode = 'sandbox' | 'real';

/** A complete authored tutorial for one golden path. */
export interface TutorialDef {
  key: GoldenPathKey;
  /** Tab route, e.g. "/data". */
  route: string;
  title: string;
  /** One-liner echoing the Home card. */
  tagline: string;
  /** Hook panel — "what you'll make" + the payoff. */
  hook: Panel;
  /** 3–5 illustrated step panels mirroring the golden-path doc. */
  steps: Panel[];
  /** The interactive walk-through, ordered. */
  walkthrough: WalkStep[];
  /** The tab's existing personal/sandbox lane (reused — no new infra). */
  sandbox: {
    /** Human label, e.g. "My data — personal DuckDB lane". */
    lane: string;
    /** Anchor that opens/selects the sandbox lane on the tab. */
    anchor: string;
    note: string;
  };
  /** "You did it" close + next paths to try. */
  outro: {
    title: string;
    body: string;
    /** Cross-links to next golden paths. */
    next: GoldenPathKey[];
    /** Deeper docs (golden-path doc filename) for the curious. */
    doc: string;
  };
  /** Role framing for verb + hook emphasis (core path is shared). */
  framing: Record<FramingRole, RoleFraming>;
}
