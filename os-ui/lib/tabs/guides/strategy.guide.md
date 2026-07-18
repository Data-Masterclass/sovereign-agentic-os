# Strategy — golden path

The Strategy tab is the **value spine**: pillars are the strategic objectives the
whole org rolls up to, and every Big Bet contributes value to a pillar. This
surface is the headless mirror of that tab — everything doable in the UI is doable
here, governed identically.

## What a pillar is
A pillar has a **scope** — **personal** (My — your private spine), **domain**
(Domain scope), or **tenant** (Company-wide) — an optional **value metric**
and a way its number is kept: `describe` (named only), `governed` (a Cube metric set
up in Metrics, RLS-scoped), or `manual` (monthly entries). Contributing Big Bets are
linked to it; the pillar's value is distributed down to those bets (and their
components), masked to the domains YOU are entitled to see. A personal pillar keeps
a home domain so a later My → Domain promote knows where it lands.

## Tool sequence
1. `whoami` — your role decides what you can do. A **personal** (My) pillar is open
   to any member; a **domain** pillar needs a Builder/Admin in that domain; a
   **tenant** pillar needs a platform Admin.
2. `list_pillars` — the pillars you can see (tenant + your domain + your own). Reuse
   first. Archived pillars are hidden from the default list.
3. `get_pillar` — one pillar's value metric, the RLS-scoped roll-up (total → bets),
   the value history series, and the audit tail (the tail lists versions).
4. `create_pillar` — frame a new pillar at `scope: personal | domain | tenant`
   (optionally describe its value metric). A creator can always create a **personal**
   pillar and hand off a promote for wider reach.
5. `update_pillar` — patch name/description or the value metric (name, one-liner,
   mode).
6. `set_pillar_target` — set the headline target (value · metricType · horizon).
7. `link_bet_to_pillar` — attach (or unlink) a Big Bet so it contributes to the
   roll-up. Shares re-normalise so the decomposition reconciles.
8. `record_value_entry` — record a manual monthly value (switches the metric to
   manual mode); the newest entry is the headline total.

## Lifecycle
- `promote_pillar` — raise a pillar ONE tier up the ladder My → Domain → Company.
  The owner (or an Admin) initiates; promoting **to** Domain needs a Builder+ in the
  owning domain, promoting **to** Company needs an Admin. Already at Company →
  `bad_request`.
- `archive_pillar` / `unarchive_pillar` — reversible soft-hide out of / back into
  the working list, history retained.
- `delete_pillar` — irreversible physical delete. A pillar that still has **linked
  bets** is blocked (`conflict`/409) — unlink them first (the bets live on in Big
  Bets); a delete never strands the bets that deliver it.
- `restore_pillar_version` — roll editable content back to an earlier version
  (itself reversible — the live state is snapshotted first). Scope/domain/linked
  bets are governed relationships and are NOT moved by a restore, so it can never
  bypass the promote gate.

## Governance
- Reads (`list_pillars`, `get_pillar`) are **creator**-visible but scoped by
  `canViewPillar` — a pillar outside your domain never appears.
- `create_pillar` floors at **creator** (a personal pillar is open to any member)
  and re-gates in-lib via `canCreatePillar`: My → any member, Domain → Builder+,
  Company → Admin. A creator asking for a domain/tenant pillar is refused
  (`forbidden`) — create it personal and hand off a promote.
- Every other write and lifecycle tool (`update_pillar`, `set_pillar_target`,
  `link_bet_to_pillar`, `record_value_entry`, `archive_pillar`, `unarchive_pillar`,
  `delete_pillar`, `promote_pillar`, `restore_pillar_version`) floors at **builder**
  and re-gates via `canEditPillar` / `canPromotePillar`: Builder for a domain
  pillar, Admin for a tenant pillar; a My pillar's own owner still edits/archives
  their own.

## Honesty
`link_bet_to_pillar` validates the bet id against a **stub bet catalogue** today
(the same stub the UI links against) — real Big Bet ids resolve when the bridge
lands. An unknown bet is a typed `not_found`.
