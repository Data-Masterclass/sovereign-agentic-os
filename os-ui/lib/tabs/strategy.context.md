# Strategy tab — build context

**Purpose:** The value spine — strategy pillars (tenant/domain) that Big Bets roll value up to. Define pillars, link bets, track realized value.

**Tools (MCP `strategy`):**
- `list_pillars()` — pillars you can see (tenant + your domain), scoped by canViewPillar. Also `sovereign-os://my/pillars`.
- `get_pillar(pillarId)` — one pillar: value metric, RLS-scoped roll-up (total → bets, masked to your domains), value history, audit tail.
- `create_pillar(name, scope?, domain?, valueMetric?)` — frame a pillar. Builder (domain) / Admin (tenant).
- `update_pillar(pillarId, name?, description?, valueMetric?)` — patch framing or value metric (mode: describe/governed/manual; `metricType` ebit/revenue/time-back-hours/risks-mitigated/custom drives target formatting).
- `set_pillar_target(pillarId, value, metricType?, horizon?)` — set the card's HEADLINE target (big number): value + metric type + horizon (year-end · 6/12/24/36-month; end date derived, year-end = Dec 31 this year). Monetary types format in the tenant currency; hours → "h", risks → count.
- `link_bet_to_pillar(pillarId, betId, action?)` — link/unlink a Big Bet; shares re-normalise.
- `record_value_entry(pillarId, value, month?)` — record a manual monthly value = the "so far" achieved figure under the target (switches to manual mode).

**Golden path** (slash command `frame_strategy`): `whoami` → `list_pillars` → `create_pillar` → `set_pillar_target` → `link_bet_to_pillar` → `record_value_entry` → `get_pillar` to read the roll-up.

**Currency:** tenant-wide, set in Admin (`lib/platform-admin/settings.ts` → Settings → Currency, default EUR); the Strategy card READS it to format monetary targets. The Strategy tab never picks currency locally.

**Constraints:** writes re-gate via canCreate/canEditPillar (Builder domain / Admin tenant); a creator files intent and hands off. `link_bet_to_pillar` validates bet ids against a STUB catalogue today. Deleting pillars + bulk targets live in the tab UI.
