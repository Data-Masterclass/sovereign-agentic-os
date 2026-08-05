# Science tab — build context

**Purpose:** Build, train, launch and score governed ML models end-to-end — from an
agent as well as from the UI. This CPU runtime trains **classification and regression**
only; the algorithm, optimize metric and train/test split are **chosen automatically**
(Simple-first — you never tune them). No forecasting or clustering yet.

**Tools (MCP `science`):**
- `create_model(name, dataset, target, features?, goal?, taskType?)` — define a model as a
  draft in your domain. The dataset/target/features are VALIDATED against your real,
  RLS-scoped data — a dataset you can't see or a column that doesn't exist is refused by name.
- `train_model(model)` — the fused "Train & launch": submits training AND auto-deploys on
  success. Returns a run handle + the read → train → publish launch status (does not block).
- `get_model_status(model)` — the poll that carries the journey: it ADVANCES the state
  machine (training→trained→deploying→deployed) and returns the phase, a plain-language
  reason and the real trained metric once available. Lets an agent drive the whole build.
- `list_models()` — the models YOU can score (tier-scoped: My · Domain · Company); honest
  about `ml.enabled`. Also `sovereign-os://my/science`.
- `get_model(model)` — one model's full card: features, score bands, versions + metric
  (name + value), build state, real usage (count/denied/last called), last errors, tier, serving status.
- `science_predict(model?, account?, features?)` — score a DEPLOYED model. Enforces tier
  scope + OPA `predict` grant, then a Langfuse trace. Requires `ml.enabled`.

**Golden path:** `list_models` / `get_model` to discover → `create_model` (define on your
data) → `train_model` (fused launch) → `get_model_status` until phase="deployed" →
`science_predict` → `promote` (widen who may call it — Domain admin → Domain, Admin → Company;
always a human).

**Constraints:** predict only through the governed serve path (never the raw model); OPA
`predict` grant + tier scope required; returns 404 when `ml.enabled=false`. create/train run
as YOU under the same edit-scope gate as the tab; a supplied unsupported algorithm is refused,
never substituted; a metric is stated only once a run actually produced it.
