# Big Bets tab — build context

**Purpose:** Initiative roadmaps over real OS components — a problem, a solution, a strategy pillar and a value target, tracked against live datasets / dashboards / agents.

**Tools (MCP `bigbets`):**
- `create_big_bet(problem, owner?, solution?, pillarId?, metricId?, targetValue?, goLive?, domain?)` — frame a bet. A creator files a **draft**; a Builder/Admin owns an **active** bet. Cross-domain bets are Admin-only. Runs as you.

**Golden path:** frame the bet with `create_big_bet` → attach components (datasets, dashboards, agent systems) in the Big Bets tab → track realized value.

**Constraints:** a problem statement is required (the name is derived from it). `pillarId` / `metricId` default to the retention pillar + NRR. Identity + role floor come from your session; audited.
