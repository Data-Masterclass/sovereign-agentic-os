# Science — golden path

## What this is

The Science tab is the OS's governed door into machine learning — now the WHOLE journey,
not just scoring. You define a model on your own governed data, train and launch it in one
fused step, watch it go live, then score it — all as the signed-in user, under OPA policy,
with a Langfuse audit trace on every mutation and every prediction. There is no raw model
endpoint, no bypass, and no way to invoke ML outside this governed path.

This first runtime is deliberately simple and honest: it trains **classification and
regression** models on **CPU**, and it **chooses the algorithm, optimize metric and
train/test split automatically** — you never tune them. It does **not** do forecasting or
clustering. In the cross-tab spine, Science is a lateral surface: a model's data comes from
the governed Gold data products, and its predictions can be consumed by software pipelines
or agents through the same governed door.

## How to build it

Goal → **create_model** → **train_model** → **get_model_status** → **science_predict** → **promote**.

1. **Discover.** Call `list_models` (or read `sovereign-os://my/science`) — the models you can
   score, RLS-scoped. The response states honestly whether serving is on (`mlEnabled`); when
   it is off, everything here 404s until an Admin enables `ml.enabled` — report that, do not
   work around it. An empty tenant returns an empty list; never invent a model.
2. **Define (create_model).** Call `create_model` with a `name`, a `dataset` id you can see
   (from `list_datasets`), the `target` column to predict, and optionally `features` and a
   `goal`. Pick the `taskType` (`binary_classification` | `multiclass_classification` |
   `regression`; default classification). The server VALIDATES the dataset, target and
   features against your real, DLS-scoped data — a dataset you cannot see or a column that
   doesn't exist is REFUSED by name, never invented — and fills the Simple defaults
   (algorithm/metric/split). Returns the draft model card + the next step.
3. **Train & launch (train_model).** Call `train_model` with the model name. This is the
   FUSED launch: it submits a real per-model training Job AND auto-deploys on success, so
   "train" and "go live" are one action. It returns immediately with a run handle and the
   read → train → publish launch status; it does not block until done.
4. **Poll (get_model_status).** Call `get_model_status` repeatedly until `phase="deployed"`.
   This is the step that lets an agent carry the whole build: it ADVANCES the state machine
   for you — training → trained (registering the version + the real metric), then auto-fuses
   the deploy, then deploying → deployed — and returns the phase, a plain-language reason, the
   launch timeline and the real trained metric (name + value) once a run has produced it.
5. **Score (science_predict).** Once deployed, call `science_predict` with `model` and an
   `account` (or a `features` override map using ONLY names from `get_model`). The prediction
   is scoped to your tier and constrained by your OPA `predict` grant; the Langfuse trace is
   automatic. Every predict is recorded as real per-model usage (visible on `get_model`).
6. **Promote.** Widen who may CALL the model up the ladder — Domain admin → Domain, Admin →
   Company — always a human. Promoting/certifying is the ONLY thing that widens callable
   scope; there is no separate publish step.

## What to consider

- **`ml.enabled` must be true.** With the ML subsystem off, `create_model` / `train_model` /
  `get_model_status` / `science_predict` all return `not_found` hinting `ml.enabled=false`.
  You cannot work around this — contact your Admin.
- **Nothing is fabricated.** A model you cannot see never appears; a hallucinated dataset or
  column is refused with the reason; a metric is stated only once a run actually produced it
  (an unreachable MLflow yields an honest untracked version, never an invented number); an
  unreachable cluster keeps the poll honest rather than faking a "deployed".
- **Only supported learners.** A supplied algorithm the runtime can't train is refused by
  name (naming the supported set), never silently substituted.
- **create/train are edit-scoped.** Only the model owner or an in-domain admin can train it —
  the same rule as the tab. An agent proposes; certify/go-live/promote are always a human.
- **Never bypass to a raw model.** Predictions are the governed path — calling an external
  model endpoint directly violates the audit invariant and will be flagged by OPA.

## Governance

| Step | Role required |
|---|---|
| `list_models`, `get_model`, `get_model_status` | Creator (RLS / edit-scoped — you only see/act on models in your scope) |
| `create_model`, `train_model` | Creator (owner / in-domain admin; runs as you) |
| `science_predict` | Creator (with OPA `predict` grant; the owner may always score their own model) |
| ⛔ Promote model to Domain | Domain admin (human only) |
| ⛔ Certify model to Company | Admin (human only) |
| Enable ML subsystem | Admin |

OPA enforces the `predict` grant and tier scope on every call. DLS ensures create/train/predict
stay within the caller's scope — and `list_models`/`get_model` apply the SAME scope, so a model
you cannot call never appears (a hidden model reads as `not_found`, no existence leak). Langfuse
records a full audit trace for model_create, model_train, model_deploy and every predict.

**Worked example:**

```
create_model({ name: "Churn risk", dataset: "ds_ab12cd", target: "churned",
  features: ["recency_days", "order_frequency", "monetary_value"] })
→ { ok: true, model: { model: "churn_risk", tier: "Personal", buildState: "draft" },
    nextStep: "Call train_model { model: \"churn_risk\" } to train and launch it." }

train_model({ model: "churn_risk" })
→ { ok: true, run: { jobName: "train-churn-risk-...", namespace: "..." },
    launch: { phase: "training", launched: false, steps: [read✓, train⟳, publish…] } }

get_model_status({ model: "churn_risk" })   // poll until phase="deployed"
→ { ok: true, phase: "deployed", reason: "Live — the model is deployed and callable...",
    launch: { launched: true, steps: [read✓, train✓, publish✓] },
    metric: { name: "auc", value: 0.87 } }

science_predict({ model: "churn_risk", account: "acct_772" })
→ { account: "acct_772", prediction: { label: "churn_risk", score: 0.83 },
    modelVersion: "v1", traceId: "lf_pred_..." }
```

If `ml.enabled` is false, every step returns `{ code: "not_found", ... hint: ml.enabled=true }`.
