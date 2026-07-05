# Science — golden path

## What this is

The Science tab is the OS's governed door into machine learning predictions. Models are served as governed services: `list_models` shows what YOU can score (the same Personal → Domain → Marketplace tier ladder as every artifact), `get_model` reads one model's card, and `science_predict` runs a prediction as the signed-in user, under OPA policy, with a Langfuse audit trace on every call. There is no raw model endpoint, no bypass, and no way to invoke ML outside of this governed path. In the cross-tab spine, Science is a lateral surface: prediction outputs can be consumed by software pipelines or written back to the Bronze data tier, feeding the analytics column.

## How to build it

The slash command `score_and_wire_prediction` walks this exact sequence.

1. **Discover.** Call `list_models` (or read `sovereign-os://my/science`) — the models you can score, RLS-scoped: your own Personal models, your domain's, and Marketplace-certified ones. The response states honestly whether serving is on (`mlEnabled`); when it is off, predictions 404 until an Admin enables `ml.enabled` — report that, do not work around it. An empty tenant returns an empty list; never invent a model.
2. **Read the card.** Call `get_model` with the registry name — feature names, the default feature vector, score bands/threshold, registry versions with their metrics (AUC), tier (who may call it) and serving status (stage + front doors).
3. **Score.** Call `science_predict` with:
   - `account` — the account or entity to predict for (required when the model is account-scoped)
   - `features` — optional feature override map, using ONLY feature names from the card; if omitted, the OS resolves features from the caller's governed data scope
   The call returns a prediction result scoped to your tier and constrained by your OPA `predict` grant. The Langfuse trace is recorded automatically.
4. **Wire it.** Consume the score through the governed door: grant an agent system the predict tool in its `system.yaml` (`commit_agent_files`), or have an app consume the REST predict door by reference — never an embedded model endpoint or secret.

There is no create, commit, or approve sequence here. The ML model and feature pipeline are managed by the tenant Admin; widening who may CALL a model is the promote ladder (⛔ Builder → Domain, Admin → Marketplace), always a human — an agent can never promote a model.

## What to consider

- **`ml.enabled` must be true.** If the tenant has not enabled the ML subsystem, `science_predict` returns `not_found` with `code: "not_found"` and a hint indicating `ml.enabled=false`. You cannot work around this — contact your Admin to enable it.
- **OPA `predict` grant is required.** A caller without the `predict` grant in their OPA policy receives `forbidden`. This grant is assigned by Admins at the domain or tenant level.
- **Tier scope constrains predictions.** You can only predict for accounts within your DLS-visible scope. Passing an `account` you cannot read returns `not_found` — not `forbidden` — to avoid leaking existence.
- **Feature overrides are validated.** Passing a `features` map with unknown feature keys returns `bad_request`. Use only feature names declared in the tenant's feature schema.
- **Never bypass to a raw model.** Science predictions are the governed path. Calling an external model endpoint directly — from software, from an agent, from anywhere in the OS — violates the audit invariant and will be flagged by OPA policy.

## Governance

| Step | Role required |
|---|---|
| `list_models`, `get_model` | Creator (RLS-scoped — you only see models in your tier scope) |
| `science_predict` | Creator (with OPA `predict` grant) |
| ⛔ Promote model to Domain | Builder (human only) |
| ⛔ Certify model to Marketplace | Admin (human only) |
| Enable ML subsystem | Admin |
| Assign `predict` grant | Admin |

OPA enforces the `predict` grant and tier scope on every call. DLS ensures the caller cannot predict for out-of-scope accounts — and `list_models`/`get_model` apply the SAME scope, so a model you cannot call never appears (a hidden model reads as `not_found`, no existence leak). Langfuse records a full audit trace including the model version, input features, and output for every invocation. There is no role that bypasses this trace.

**Worked example:**

```
list_models({})
→ { mlEnabled: true, models: [{ model: "churn_model", tier: "Domain",
    stage: "Production", frontDoors: ["rest", "mcp"] }] }

get_model({ model: "churn_model" })
→ { model: "churn_model", features: ["recency_days", "order_frequency",
    "monetary_value", "tenure_months"], scoreBands: { high: ">= 0.66", ... },
    metrics: { version: "2", auc: 0.91, certified: true } }

science_predict({ account: "acct_772", features: { "recency_days": 45 } })
→ {
    account: "acct_772",
    prediction: { label: "churn_risk", score: 0.83 },
    modelVersion: "churn-v2.1",
    traceId: "lf_pred_...",
    resolvedAt: "2026-07-04T09:12:00Z"
  }
```

If `ml.enabled` is false:

```
science_predict({ account: "acct_772" })
→ { code: "not_found", reason: "ML subsystem is disabled",
    hint: "Ask your Admin to set ml.enabled=true for this tenant" }
```
