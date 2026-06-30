<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->

# Home — the welcoming launcher + cockpit

The first screen after you pick a domain. Home's job is to **orient, motivate, and
route** — not to be a deep dashboard (Monitoring and Strategy own those). It is a
**read + route** surface: it triggers each tab's governed flows and **never
recomputes a number a tab already owns, and never bypasses governance.**

Two things sit on the page:

1. **The illustrated golden-path launcher** (centerpiece) — one card per path
   (Data · Knowledge · Connections · Agents · Software · Science · Metrics ·
   Dashboards · Big Bets · Marketplace), each with a custom on-brand
   illustration, a one-line explainer, a **role-aware primary action** that
   deep-links into that tab's flow, and a **"How it works"** tutorial link.
2. **The cockpit** — six personalized modules around it (What needs me · My WIP ·
   Domain pulse · Health & cost · Recent activity · Quick start + ask), whose
   content **and ordering shift by the viewer's persona**.

Everything is **OPA/RLS-scoped**: Home never shows what the viewer isn't entitled
to.

## The two adapters

### 1. Launcher adapter — `launcher.ts` (pure)

The static path catalog → `persona → action` deep-link + tutorial-link resolver.
Dependency-free and unit-tested, so it renders in a Server Component with no
round-trip.

- **`PATHS`** — the ten golden paths (gallery order), each with its one-line
  blurb, owning tab, Creator-tier action label, an `actRank` (min persona rank to
  perform the primary action), and an illustration key.
- **`personaFor(role, hasAuthored)`** — maps the OS auth role
  (`participant | builder | admin`) + authoring activity to one of the design's
  **four personas** (`user | creator | builder | admin`). A `participant` who has
  authored ≥1 artifact/app is acting as a **Creator**; one who hasn't is a
  **User**. The security model is unchanged — this only drives emphasis.
- **`launcherFor(persona)`** — the resolved gallery: per card, the role-aware
  `actionLabel` (User → *Explore*, Creator → the create verb, Marketplace →
  *Browse*), the deep-link `href`, `canAct` (else **explained-but-dimmed**), and
  the `tutorialHref` (single tutorial-registry key per path; Home's "How it works"
  and the tab header's "Tutorial" resolve the same key).

Connections and Big Bets are Builder/Admin authoring surfaces (`actRank = 2`), so
they are **explained-but-dimmed** for a User/Creator and actionable for a
Builder/Admin — the load-bearing "Creator vs Builder see different emphasis"
signal, alongside cockpit ordering.

### 2. home-feed adapter — `feed.ts` (server) + `scope.ts` (pure)

A thin per-viewer/OPA aggregator that **reuses the existing per-tab data sources
and never duplicates their logic**:

| Cockpit module        | Source                         | Status (kind) |
|-----------------------|--------------------------------|---------------|
| What needs me         | `lib/approvals` (Governance)   | **LIVE**      |
| My WIP                | `lib/artifacts` + `lib/apps`   | **LIVE**      |
| Recent activity       | `lib/artifacts` (registry/OM)  | **LIVE**      |
| Domain pulse          | `lib/home/stubs` (Strategy)    | **MOCK**      |
| Health & cost         | `lib/home/stubs` (Monitoring)  | **MOCK**      |
| Ask anything          | `lib/home/assistant`           | **LIVE**      |

`feed.ts` fetches the raw rows **scoped to the caller's identity**, then hands
them to the **pure** `scope.ts` shapers, which apply the **same RLS predicates
the owning tabs enforce**:

- **`whatNeedsMe`** — approvals are only ever visible inside the viewer's domains;
  a Builder/Admin sees the queue as **actionable**, a User/Creator sees **only the
  approvals they themselves requested**, as informational. Plus drafts-ready-to-
  promote (own Personal artifacts; an Admin also sees in-domain Shared ready to
  certify).
- **`myWip`** — the viewer's **own Personal** artifacts + non-Certified apps only.
- **`recentActivity`** — in-domain **Shared** items + cross-domain **Certified**
  products (discovery); Personal never appears.
- **`cockpitOrder(persona)`** — same modules, different emphasis: a User leads
  with *use + ask*; a Creator with *drafts/WIP*; a Builder with *approvals + domain
  pulse*; an Admin with the *action inbox + health/cost*.

Because the shapers are pure, the **entitlement boundary is directly unit-tested**
(`scope.test.ts`) with a second role — the validation gate.

## Ask anything — the governed assistant (`assistant.ts` + `intents.ts`)

The prompt box routes to the domain assistant, which is **two-mode and governed**:

- **Answer** — explain a path / point at the right tab.
- **Scaffold** — "build / create a `<type>` …" → a real **Personal draft** created
  through the **same `createArtifact` flow the tab uses** (RLS: owned by the
  asker, in their domain), then a deep-link to finish. It never finishes for you.
- **Human-gate** — "promote / certify / publish …" is **refused** and routed to
  the governed flow. **Promote/certify stay human.**

`intents.ts` is pure + deterministic (air-gapped — no live LLM in the gate); it
treats the prompt as **data, never authority**. A scaffold can only ever produce a
*Personal* draft owned by the asker — it cannot broaden visibility or skip the
human gate (`createArtifact` enforces `Personal` + `owner = caller` regardless of
the prompt). Every turn is **Langfuse-traced** (`lib/agent-governed.trace`) so the
ask box is auditable in Monitoring like any other governed action.

## Mock feeds + no-drift (`stubs.ts`)

Strategy and Monitoring are built on parallel branches. Per the build plan, Home
**stubs their feeds behind the adapter now and reconciles at consolidation.** The
stubs are the **single source** of those numbers for Home and are returned with an
explicit **`source: 'mock'`** marker, so:

- the UI is **honest** that the figure is a local stand-in (a small `stub` badge),
  never a fake "live"; and
- there is **no recomputation drift** — Home renders exactly what the adapter
  returns and never re-derives it (`stubs.test.ts` asserts identical output for
  identical scope).

**Consolidation seam:** swap the two functions in `stubs.ts` for
`import { domainPulse } from '@/lib/strategy'` /
`import { healthCost } from '@/lib/monitoring'` returning the **same shape**. The
Home page, components and tests do not change.

## Routes

- `GET /api/home/feed` — the viewer's full Home feed, OPA/RLS-scoped.
- `POST /api/home/ask` `{ prompt }` — the governed assistant (answer / scaffold /
  human-gate), Langfuse-traced.

The page (`app/page.tsx`) is a Server Component that calls `homeFeed(user)`
directly (no API round-trip for first paint); only the ask box is a Client
Component. Middleware guards the route (unauthenticated → `/signin`).

## Taste

Home is the platform's front door, so it has its **own warm look**, scoped under
`.home` (the rest of the OS keeps its Oswald/dark chrome): warm cream surface, a
**Fraunces** display hero (self-hosted woff2, offline-safe), a cohesive **custom
illustration set** (`components/home/illustrations.tsx` — hand-authored geometry
in the brand palette, not clip-art), and flat illustrated tiles (no
cards-in-cards, no generic centered hero, no purple gradients). Polished with the
Impeccable `/polish` pass.

## Tests

`node --test 'lib/home/**/*.test.ts'` — 21 tests across the four pure modules:

- `launcher.test.ts` — the ten paths, persona derivation, role-aware verbs,
  dimmed-but-explained Builder-gated paths, every card has a deep-link + tutorial.
- `intents.test.ts` — scaffold classification; **promote/certify always
  human-gated**; answers; draft-name derivation.
- `scope.test.ts` — the **OPA/RLS proof**: a Builder vs a Creator see different
  inboxes; cross-domain never leaks; WIP is owner-scoped; cockpit ordering differs
  by persona.
- `stubs.test.ts` — feeds marked `mock`; **no-drift** single-source; scoped +
  bounded.
