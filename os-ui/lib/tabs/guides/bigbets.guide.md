# Big Bets — golden path

## What this is

Big Bets is the strategic capstone of the OS. A Big Bet is a named initiative that anchors to a pillar, declares a north-star metric, and references real running OS components — datasets, dashboards, and agent systems — as evidence of execution. It is not a slide deck or a planning document; it is a live, governed record of what the organization is betting on and how progress is measured. In the cross-tab spine, big bets sit at the terminus of the analytics column: data → metrics → dashboards → big bets.

## How to build it

1. **Read your current state.** Before creating a big bet, inventory the components you will reference. Call `list_datasets` to confirm your Gold datasets exist, `list_dashboards` to confirm your metrics are visualized, and `list_agent_systems` to confirm any agents are built and operational.
2. **Create the bet.** Call `create_big_bet` with:
   - `problem` — a crisp statement of the problem being solved (the bet's name is derived from it)
   - `owner` — who owns the problem
   - `solution` — optional solution idea
   - `pillarId` / `metricId` — the strategic pillar and north-star metric the bet anchors to
   - `targetValue` / `goLive` — the € value target and planned go-live date
3. **Attach the real components.** Call `attach_component` with the bet id, a `kind` (`dataset` | `dashboard` | `agent-system`) and the component id — every id is re-resolved through its own visibility gate, so you can only attach components you can actually see. The bet records a reference, never a copy.
4. **Operate.** Call `get_big_bet` to read the full bet back — progress is DERIVED live from the attached components' real lifecycle, and the realized value resolves RLS-scoped to the viewer. Call `update_big_bet` to record the solution, status (draft | active | shipped | archived), value basis or the owner-declared realized value.

A creator files the bet as a **DRAFT**. Moving a bet to **Active** requires a Builder or Admin owner. Cross-domain bets require Admin approval.

## What to consider

- **Reference real components.** A big bet referencing non-existent dataset or dashboard IDs returns `not_found`. Build and verify all components before filing. `list_big_bets` first to avoid duplicate bets on the same problem.
- **One north-star metric.** A bet with multiple north-star metrics has no clear definition of winning. Pick one governed metric; use dashboards to track supporting indicators.
- **Draft → Active is a Builder gate.** A creator filing a bet does not activate it. The bet must be claimed by a Builder or Admin who owns the outcome commitment.
- **Cross-domain bets are Admin-only.** If the bet spans more than one domain (e.g. references datasets from `analytics` and `ops`), only an Admin can activate it.
- **Component dependencies are live.** If a referenced dashboard is archived, the bet surfaces a warning. Keep components operational — the bet's credibility depends on it.

## Governance

| Step | Role required |
|---|---|
| `list_datasets`, `list_dashboards`, `list_agent_systems`, `list_big_bets`, `get_big_bet` | Creator |
| `create_big_bet` (DRAFT), `attach_component`, `update_big_bet` (own bet) | Creator |
| ⛔ Activate a bet | Builder or Admin |
| ⛔ Cross-domain bet | Admin |

OPA enforces that all referenced components are within the caller's read scope. A creator cannot activate a bet or approve cross-domain scope. Langfuse traces all bet state transitions.

**Worked example:**

```
list_datasets({ domain: "analytics", tier: "gold" })
→ [{ id: "ds_01J...", name: "orders_v1" }]

list_dashboards({ domain: "analytics" })
→ [{ id: "db_88G...", name: "Sales Overview" }]

list_agent_systems({ domain: "ops" })
→ [{ id: "as_11C...", name: "invoice-reconciler", state: "built" }]

list_big_bets({ domain: "analytics" })
→ [] — no existing bet on this problem

create_big_bet({
  problem: "Revenue leakage from unreconciled invoices costs 3% of gross margin",
  owner: "ops-lead", targetValue: 250000
})
→ { id: "bet_99h...", status: "draft" }

attach_component({ betId: "bet_99h...", kind: "dataset", id: "ds_01J...", plannedReady: "2026-09-01" })
attach_component({ betId: "bet_99h...", kind: "dashboard", id: "db_88G..." })
attach_component({ betId: "bet_99h...", kind: "agent-system", id: "as_11C..." })

get_big_bet({ betId: "bet_99h..." })
→ { status: "draft", completion: { done: 0, total: 3, pct: 0 },
    value: { basis: "uplift", target: 250000, realized: ... },
    components: [{ artifactId: "ds_01J...", status: { derived: "in-progress" } }, ...] }
```

A Builder or Admin owner then activates the bet — `update_big_bet({ betId, status: "active" })` — and records value as it realizes.
