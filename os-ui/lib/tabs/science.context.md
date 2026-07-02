# Science tab — build context

**Purpose:** Serve and score governed ML models (e.g. churn) through the predict door; train/register via the model service.

**Tools (MCP `science`):**
- `science_predict(account?, features?)` — score the deployed churn model. Enforces tier scope + OPA `predict` grant, then a Langfuse trace. Requires `ml.enabled`.

**Golden path:** pick a model → `science_predict` on an account (or feature overrides) → read score/threshold → wire it into an agent/app through the governed door.

**Constraints:** predict only through the governed serve path (never the raw model); OPA `predict` grant + tier scope required; returns 404 when `ml.enabled=false`.
