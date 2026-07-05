# Governance — the rules of the OS

## Roles and their rights

There are exactly three roles. Each role is additive.

**Creator** — the default role for any signed-in user. You can create and edit assets in your own domain, run work you own, consume shared assets, and file promotion requests. You cannot approve promotions, certify assets to the marketplace, decide deploys, or take any action that publishes work to others. When you reach a promotion step, you stop and hand off to a Builder.

**Builder** — creator rights plus: approve promotions from Personal to Shared within your domain, approve deploys of software, and manage membership in your domain. A Builder owns the gate between private work and team-visible work.

**Admin** — builder rights tenant-wide plus: certify assets to the Marketplace, approve cross-domain Big Bets, apply policy overrides, and set cost caps. Admins are the final authority on what becomes canonical across the tenant.

## The promotion flow

Promotion is always a two-step split:

1. **Creator** calls `request_promotion` (or equivalent on the pathway). This files a promotion request; the asset remains at its current tier.
2. ⛔ **Builder or Admin** calls `approve_promotion`. Only after this does the asset move to the next tier.

Documentation is a hard prerequisite before a promotion request can be filed. An asset without documentation will return a `bad_request` error at the `request_promotion` step.

## The tier ladder

```
Personal  →[request_promotion]→  pending  →[approve_promotion]→  Shared
Shared    →[request_promotion]→  pending  →[certify]           →  Certified / Marketplace
```

Moving up the ladder never widens row-level access. DLS is enforced independently of tier.

## Scope model

Every tool call is scoped to what you can see:

- **own** — assets you created
- **domain** — assets Shared within your active domain
- **tenant** — Certified or Marketplace assets visible to all

You cannot read beyond your scope. DLS filters are applied at query time; no tool call returns rows you are not permitted to see.

## Run-as-user invariant

Every tool call and every agent run executes as the signed-in user. There is no service-account bypass. OPA evaluates your role and scope on every request. Langfuse records an audit trace for every write. Agents inherit the calling user's identity and grants — they cannot widen their own permissions.

## Typed error contract

All tool errors return a structured object `{code, reason, hint}`. The `code` field is always one of:

| code | meaning | what to do |
|---|---|---|
| `forbidden` | role or scope blocks this action | follow the hint — ask a Builder, or keep the asset Personal |
| `not_found` | asset does not exist in your scope | check scope; the asset may exist but be above your tier |
| `conflict` | asset is already in the requested state | treat as idempotent — you are already there |
| `bad_request` | missing required field or precondition | read the hint for the specific field to fix |
| `error` | unexpected server-side fault | retry once; if it persists, report to your admin |

Always read the `hint` field. It is the fastest path to resolution.

## Creator lockdown restated

A creator cannot: promote their own work, approve anyone else's promotion, certify to the marketplace, decide a software deploy, manage domain members, override policies, or set cost caps. If you are a creator and a tool returns `forbidden`, the correct action is to file a request and hand off — not to retry or find a workaround.
