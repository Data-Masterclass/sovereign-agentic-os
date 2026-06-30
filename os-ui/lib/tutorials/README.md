<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->

# Tutorials system

One illustrated, hands-on tutorial per golden path (ten in all), authored once and
reused by **two entry points that resolve the same registry entry** — so they can
never drift:

- **Home card** → the "How it works" link.
- **Tab header** → the "Tutorial" link.

Each tutorial follows one template: **Hook → 3–5 illustrated steps → "Walk me
through it" (live coach-marks on the real tab) → "You did it" (with next-path
cross-links)**. The walk-through can run in a **safe sandbox** (the tab's existing
personal lane, no governed writes) and then **graduate** to the real, governed UI.

## Layout

```
lib/tutorials/
  types.ts        # the authoring + engine contract (TutorialDef, WalkStep, …)
  anchors.ts      # the stable data-tutorial-anchor contract the tabs expose
  engine.ts       # PURE logic: role framing, sandbox guard, anchor targeting
  engine.test.ts  # node --test proof of the invariants below
  registry.ts     # single registry, keyed by golden path; validates the set
  content/*.ts    # the ten authored tutorials (one default-exported TutorialDef)
components/tutorials/
  TutorialProvider.tsx  # mounted once in the root layout; hosts the overlay
  TutorialOverlay.tsx   # storybook + mode toggle + graduate + you-did-it
  CoachMarks.tsx        # the live walk-through engine (spotlight + tooltip)
  TutorialLink.tsx      # the single trigger (Home card + tab header)
  HomeLauncher.tsx      # the Home ten-card golden-path gallery
  Illustration.tsx      # the cohesive inline-SVG illustration set (16 motifs)
```

## The anchor contract (cross-tab)

Coach-marks target the **real tabs' UI** through stable `data-tutorial-anchor`
attributes declared once in `anchors.ts`. A tab exposes an anchor by spreading
`anchorAttr(id)` onto the element:

```tsx
import { anchorAttr, ANCHORS } from '@/lib/tutorials/anchors';
<button {...anchorAttr(ANCHORS.data.load)}>+ New data product</button>
```

The engine **re-queries the DOM by attribute on every measurement** (it never
caches the node), so React re-renders that swap nodes cannot desync the
highlight — that is the anchor-stability guarantee. If an anchor is absent the
coach-mark **degrades gracefully** to an "open this tab to follow along" card
instead of crashing, so tabs can be wired incrementally (kind: Data + Agents are
wired; the rest reconcile at consolidation without engine changes).

## Two invariants (proven in `engine.test.ts`)

1. **Sandbox writes nothing real.** In practice mode, `walkSteps(def,'sandbox',…)`
   removes every `governedWrite` step and `assertSandboxSafe` throws if one
   survives. The registry asserts this for all ten tutorials at import. Practice
   only ever targets the tab's personal/sandbox lane (`sandboxAnchor`).
2. **Role framing is faithful.** `framingForRole` maps the session role
   (`participant → creator`, `builder/admin → builder`, else `user`); the core
   path is identical, only the verb/hook and builder-only review/promote steps
   change. The engine never bypasses OPA/RLS — on the real tab it only highlights
   an existing governed control; the user still performs the (governed) click.

## Authoring a tutorial

Add `content/<path>.ts` exporting a default `TutorialDef` (see `types.ts`). Rules:

- `key` must equal the path; mirror the Home one-liner in `tagline`.
- `hook` + 3–5 `steps` panels, each with an `IllustrationId` motif.
- `walkthrough`: ordered `WalkStep[]` using ids from `ANCHORS.<path>`. Mark any
  promote/publish/certify/connection-write/deploy step `governedWrite: true`
  (auto-excluded from practice) and `roles: ['builder']` where the doc assigns it
  to a Builder. Give every non-write step a `sandboxAnchor` (usually
  `ANCHORS.<path>.sandbox`). The **first** step opens the lane.
- `framing` for all three roles; `outro.next` cross-links to two paths.

Run `node --test 'lib/tutorials/**/*.test.ts'` — the registry self-check + engine
tests fail loudly on a broken contract.

## Wiring a new tab's anchors

1. Declare the path's anchors in `anchors.ts` (`${path}.${name}`).
2. Spread `anchorAttr(ANCHORS.<path>.<name>)` onto the real controls.
3. Reference those ids from the tutorial's `walkthrough`. Done — no engine change.
