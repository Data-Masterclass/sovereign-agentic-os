# Governance — the rules of the OS

## The core rule: My is yours

Every artifact starts in **My** (personal) scope. **In My scope you have FULL rights and there is NO approval** — you (and the agents you build, which run AS you) create, write, edit, and re-build your own personal data, files, knowledge, metrics, connections, dashboards, agents, software and science directly, no gate. Approval only ever enters the picture when you push work UP a scope:

- **Domain** artifacts require **domain-admin** approval.
- **Company** artifacts require **tenant-admin (`admin`)** approval.

Both go through **Policies & Approvals**. **Ownership:** you can only change what you originally built — you cannot edit another person's artifact even in a shared scope (a domain/company admin can administer, but authorship stays with the builder).

## Roles and their rights

There are exactly four roles, lowest → highest. Each is additive; you cannot self-elevate.

**creator** — the default. Create, edit and run your OWN work in My scope with no approval; consume Domain/Company assets; FILE promotion requests (`request_promotion`). Cannot approve, publish, certify or decide deploys — at a promotion step a creator files a request and hands off.

**builder** — creator rights PLUS approve My → Domain in your domain (`approve_promotion`, `publish_knowledge`, `promote_connection`, `decide_deploy`). An approver, not a people-admin. (The builder who filed a promotion is not its approver — a separate domain-admin decides.)

**domain_admin** — builder rights PLUS administer users in your OWN domain(s) (invite, edit, deactivate; assign roles up to builder only) and every domain-scoped approval.

**admin** (tenant-admin) — everything tenant-wide PLUS certify My/Domain → Company, cross-domain Big Bets, policy overrides, cost caps, and appointing domain admins. The only role that mints a domain_admin.

## The scope ladder

```
My  →[Promote to Domain: domain-admin gate]→  Domain  →[Promote to Company: admin gate]→  Company
```

Documentation is a hard prerequisite before a promotion request can be filed — an undocumented asset returns `bad_request` at `request_promotion`. Moving up the ladder never widens row-level access — DLS is enforced independently of scope.

## How agents inherit this — the scope-aware write gate

An agent system runs **AS its builder**, so it has exactly the builder's rights and no more. The write gate is **scope-aware**, not a blanket hold:

- A **My (personal)** write is exactly what the builder could do by hand with no approval, so the agent performs it **directly** (run-as-user, OPA/DLS-checked) — it is never held.
- A **Domain / Company** write is a governance escalation (My→Domain / Domain→Company), so it is **held in Policies & Approvals** for the right admin.

A `read+propose` grant (`Write-approval`) additionally drafts every write for a human to run. Sub-agent grants are always a strict subset of the system's grants; nothing an agent does can exceed the builder's own entitlements or role.

## Scope model

Every tool call is scoped to what you can see:

- **My** — assets you created (owner-only)
- **Domain** — assets promoted to Domain, visible to your domain members
- **Company** — assets certified to Company, visible tenant-wide

You cannot read beyond your scope. DLS filters apply at query time; no tool call returns rows you are not permitted to see.

## Run-as-user invariant

Every tool call and every agent run executes as the signed-in user. There is no service-account bypass. OPA evaluates your role and scope on every request; Langfuse records an audit trace for every write. Agents inherit the calling user's identity and grants and cannot widen their own permissions.

## Typed error contract

All tool errors return a structured `{code, reason, hint}`. The `code` is one of:

| code | meaning | what to do |
|---|---|---|
| `forbidden` | role or scope blocks this action | follow the hint — ask a domain admin, or keep the asset in My |
| `not_found` | asset does not exist in your scope | check scope; it may exist but be out of your reach |
| `conflict` | asset is already in the requested state | treat as idempotent — you are already there |
| `bad_request` | missing required field or precondition | read the hint for the specific field to fix |
| `error` | unexpected server-side fault | retry once; if it persists, report to your admin |

Always read the `hint` — it is the fastest path to resolution.

## Creator lockdown restated

A creator cannot: promote their own work to Domain/Company, approve anyone's promotion, certify to Company, decide a software deploy, manage domain members, override policies, or set cost caps. But a creator has **full, unapproved rights over everything in their own My scope**. If a creator hits `forbidden`, the correct move is to file a request (`request_promotion`) and hand off — or keep the work in My.
