# Strategy — golden path

The Strategy tab is the **value spine**: pillars are the strategic objectives the
whole org rolls up to, and every Big Bet contributes value to a pillar. This
surface is the headless mirror of that tab — everything doable in the UI is doable
here, governed identically.

## What a pillar is
A pillar has a **scope** (tenant or domain), an optional **value metric** and a way
its number is kept — `describe` (named only), `governed` (a Cube metric set up in
Metrics, RLS-scoped), or `manual` (monthly entries). Contributing Big Bets are
linked to it; the pillar's value is distributed down to those bets (and their
components), masked to the domains YOU are entitled to see.

## Tool sequence
1. `whoami` — your role decides what you can do. A **domain** pillar needs a
   Builder/Admin in that domain; a **tenant** pillar needs a platform Admin.
2. `list_pillars` — the pillars you can see (tenant + your domain). Reuse first.
3. `get_pillar` — one pillar's value metric, the RLS-scoped roll-up (total → bets),
   the value history series, and the audit tail.
4. `create_pillar` — frame a new pillar (optionally describe its value metric).
5. `update_pillar` — patch name/description or the value metric (name, one-liner,
   mode).
6. `link_bet_to_pillar` — attach (or unlink) a Big Bet so it contributes to the
   roll-up. Shares re-normalise so the decomposition reconciles.
7. `record_value_entry` — record a manual monthly value (switches the metric to
   manual mode); the newest entry is the headline total.

## Governance
- Reads (`list_pillars`, `get_pillar`) are **creator**-visible but scoped by
  `canViewPillar` — a pillar outside your domain never appears.
- Writes (`create_pillar`, `update_pillar`, `link_bet_to_pillar`,
  `record_value_entry`) re-gate in-lib via `canCreatePillar` / `canEditPillar`:
  Builder for a domain pillar, Admin for a tenant pillar. A creator is refused
  (`forbidden`) — file the intent to a Builder.

## Honesty
`link_bet_to_pillar` validates the bet id against a **stub bet catalogue** today
(the same stub the UI links against) — real Big Bet ids resolve when the bridge
lands. An unknown bet is a typed `not_found`.

Excluded from this surface (deliberate): deleting a pillar and bulk target-setting
live in the tab UI; the headless surface focuses on the value-tracking loop.
