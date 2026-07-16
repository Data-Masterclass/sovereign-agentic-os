# Governance tab — build context

**Purpose:** The approval queue + the promotion/certification ladder + the read-only policy & cost planes. This is how every gated golden path becomes an agent-completable loop.

**Tools (MCP `governance`):**
- `list_approvals(status?, kind?, mine?)` — your scoped queue (own always; +domain if Builder+; tenant-wide if Admin).
- `get_request(requestId)` — one approval's status, effect summary, who can approve.
- `decide_approval(requestId, decision, remember?)` — approve (runs the effect NOW) or deny. Builder+ AND re-gated per item (certification needs Admin).
- `request_promotion(kind, id)` — file a Personal→Domain promotion (owner-only). `approve_promotion(approvalId)` applies it.
- `request_certification(kind, id, mode?)` — file a Domain→Company certification (to the cross-domain Marketplace) (Builder/Domain-admin in-domain) → Admin decides.
- `get_lineage(ref)` — normalized lineage graph for any artifact.
- `import_product(listingId, mode?)` — governed marketplace grant.
- `get_policy_view()` — read-only policy plane (role grants + access grants + egress + standing), gated on the policy.view right (Builder+).
- `get_cost()` — spend caps in scope + near/over alerts (creator sees own domain).

**Golden path** (slash command `work_the_queue`): `list_approvals` → `get_request` → `decide_approval`.

**Constraints:** identity is always the session; every gate re-checks the rank-aware canSee/canApprove. A creator files + polls but never decides. Standing policy (`remember`) is in-process only today.
